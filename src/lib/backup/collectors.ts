// Collectors — the half of the backup that talks to the outside world.
//
// One function per source, each of them: list what is there, compare against the
// manifest, transfer ONLY what differs, and fold the result into the store.
//
// This module is deliberately NOT unit-tested. Every bug this session's backup
// work uncovered lived in the real behaviour of the boxes — /root at 0700 on one
// callbox and readable on another, symlinks that `find -type f` hides, an API
// that answers 200 to the wrong paging vocabulary — and a mock SSH server would
// have reproduced my assumptions, not theirs. The pure logic these functions sit
// on (store.ts, status.ts) is unit-tested instead, and this file is verified
// live against .101, .106, .122 and .95.
//
// SHELL SCRIPTS BELOW CONTAIN NO BACKSLASH ESCAPES, ON PURPOSE.
//
// A backslash inside a JS template literal is a hazard that has already broken
// this codebase twice: `\(` collapses to a bare paren (shell syntax error) and
// `\t` becomes a real tab rather than the two characters `printf` needs. So the
// scripts here use `echo` (which supplies its own newline) and `|` as a field
// separator, and never printf with escapes. Keep it that way.

import { withSsh } from '../configFidelity/ssh';
import {
  loadInventory, getSystem, uesimApiOptsForSystem, isUesimLike,
  type Inventory, type InventorySystem, type SystemType,
} from '../inventory';
import { listTestcases, exportTestcaseConfig } from '../uesimClient';
import {
  upsertFile, touchSeen, storedHash, hasStoredBytes,
  type BackupCategory, type Manifest, type UpsertOutcome,
} from './store';

/** Defensive cap, same as the manual gNB backup uses. Config files are orders
 *  of magnitude under this; anything bigger is a log or a core dump. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** Files fetched per SSH round-trip. Keeps one command line sane on a box with
 *  250+ configs while still being far cheaper than a round-trip per file. */
const FETCH_BATCH = 25;

/**
 * What a stored testcase file currently contains. Bump this whenever the shape
 * changes, and the next cycle re-fetches every testcase once instead of leaving
 * the old ones behind the lastModifiedOn shortcut.
 *
 * v1 = the GUI's own export ({ test_case_details: [...] }, config only). What it
 * replaced was the raw GET /testcases/{id} record, which carried execution
 * results — status, validationStatus, lastExecution, executionHistory — inside
 * what was supposed to be a config backup.
 */
const TESTCASE_EXPORT_FORMAT = 'gui-export-v1';

export interface CollectResult {
  added: number;
  updated: number;
  unchanged: number;
  /** Things worth surfacing that are not failures — a directory this box does
   *  not have, a file too large to store. */
  notes: string[];
}

const empty = (): CollectResult => ({ added: 0, updated: 0, unchanged: 0, notes: [] });

function tally(r: CollectResult, outcome: UpsertOutcome): void {
  if (outcome === 'added') r.added += 1;
  else if (outcome === 'updated') r.updated += 1;
  else r.unchanged += 1;
}

function merge(into: CollectResult, from: CollectResult): CollectResult {
  into.added += from.added;
  into.updated += from.updated;
  into.unchanged += from.unchanged;
  into.notes.push(...from.notes);
  return into;
}

const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
const clip = (s: string, n = 200) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * Run a script on the box, privileged if we can, unprivileged if we cannot.
 *
 * The `sudo -n … || plain` shape is not belt-and-braces, it is required:
 * /root is 0700 on .122 and readable on .106. Without the sudo attempt the 0700
 * box returns an empty listing, which reads exactly like "this machine has no
 * configs" — the misdiagnosis that cost an afternoon earlier in this work.
 *
 * stderr from BOTH attempts is carried into the thrown error, because
 * swallowing it is what made "permission denied" and "empty directory"
 * indistinguishable in the first place.
 */
async function runPrivileged(sys: InventorySystem, script: string): Promise<string> {
  return withSsh(sys, async (ssh) => {
    const inner = `sh -c ${q(script)}`;
    // A key-auth box has no password to feed sudo -S, so it gets sudo -n and
    // falls through to the unprivileged attempt if NOPASSWD is not configured.
    const pwd = sys.sudoPassword ?? (sys.authMode !== 'privateKey' ? sys.password : undefined);
    const sudoCmd = pwd ? `echo ${q(pwd)} | sudo -S -p '' ${inner}` : `sudo -n ${inner}`;

    const viaSudo = await ssh.execCommand(sudoCmd);
    if (viaSudo.code === 0) return viaSudo.stdout;

    const plain = await ssh.execCommand(inner);
    if (plain.code === 0) return plain.stdout;

    throw new Error(
      `remote read failed on ${sys.host} — sudo: ${clip(viaSudo.stderr || viaSudo.stdout) || `exit ${viaSudo.code}`}`
      + `; unprivileged: ${clip(plain.stderr || plain.stdout) || `exit ${plain.code}`}`,
    );
  });
}

interface RemoteFile { name: string; bytes: number; mtimeEpoch: number; sha256: string }

/**
 * List one remote directory with a hash per entry.
 *
 * A plain glob rather than `find`: it covers regular files AND symlinks with no
 * predicate to get wrong. `find -type f` would hide enb.cfg / mme.cfg / ims.cfg,
 * which are symlinks — and those are precisely the entries that record which
 * config is currently active.
 *
 * `stat -L` and `sha256sum` both follow symlinks, so a link is stored as a copy
 * of whatever it points at today. That is what makes the backup useful: it
 * captures the config that was live, not a dangling name.
 */
async function listRemoteDir(sys: InventorySystem, dir: string): Promise<{ files: RemoteFile[]; missing: boolean }> {
  const script = [
    `D=${q(dir)}`,
    'if [ ! -d "$D" ]; then echo "SIMQA_NODIR"; exit 0; fi',
    'for f in "$D"/*; do',
    '  if [ ! -e "$f" ]; then continue; fi',
    '  if [ -d "$f" ]; then continue; fi',
    '  n=$(basename "$f")',
    '  s=$(stat -Lc %s "$f" 2>/dev/null || echo 0)',
    '  m=$(stat -Lc %Y "$f" 2>/dev/null || echo 0)',
    '  h=$(sha256sum "$f" 2>/dev/null | cut -c1-64)',
    '  echo "$n|$s|$m|$h"',
    'done',
  ].join('\n');

  const out = await runPrivileged(sys, script);
  if (out.includes('SIMQA_NODIR')) return { files: [], missing: true };

  const files: RemoteFile[] = [];
  for (const line of out.split('\n')) {
    const row = line.trim();
    if (!row || !row.includes('|')) continue;
    // Split from the right: size, mtime and hash are the last three fields, so
    // a filename containing '|' cannot shift the numbers.
    const parts = row.split('|');
    const sha256 = (parts.pop() ?? '').trim();
    const mtimeEpoch = Number(parts.pop()) || 0;
    const bytes = Number(parts.pop()) || 0;
    const name = parts.join('|');
    if (name) files.push({ name, bytes, mtimeEpoch, sha256 });
  }
  return { files, missing: false };
}

/** Fetch the named files as base64, in batches. Same marker format the manual
 *  gNB backup uses, so binary content (.pem, .der) round-trips intact. */
async function fetchRemoteFiles(sys: InventorySystem, dir: string, names: string[]): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  for (let i = 0; i < names.length; i += FETCH_BATCH) {
    const batch = names.slice(i, i + FETCH_BATCH);
    // Each file produces exactly three lines: the marker, the base64 (one line,
    // because -w0), and a status line. The status line is what distinguishes a
    // ZERO-BYTE file — whose base64 is legitimately the empty string — from a
    // read that failed. Without it an empty cfg looks like an unreadable one,
    // which is how ims.cfg on .122 first reported itself as untransferable.
    const script = [
      `D=${q(dir)}`,
      `for n in ${batch.map(q).join(' ')}; do`,
      '  echo "===SIMQA_FILE===$n"',
      '  if base64 -w0 "$D/$n"; then echo ""; echo "===SIMQA_OK==="; else echo ""; echo "===SIMQA_ERR==="; fi',
      'done',
    ].join('\n');

    const raw = await runPrivileged(sys, script);
    const lines = raw.split('\n');
    for (let k = 0; k < lines.length; k++) {
      const m = lines[k].match(/^===SIMQA_FILE===(.+)$/);
      if (!m) continue;
      const name = m[1].trim();
      const b64 = (lines[k + 1] ?? '').trim();
      const status = (lines[k + 2] ?? '').trim();
      if (status === '===SIMQA_OK===') out.set(name, Buffer.from(b64, 'base64'));
      k += 2;
    }
  }
  return out;
}

/** Shared body of every directory-backed collector. */
async function collectDir(
  sys: InventorySystem,
  manifest: Manifest,
  dir: string,
  category: BackupCategory,
  now: string,
): Promise<CollectResult> {
  const res = empty();
  const { files, missing } = await listRemoteDir(sys, dir);
  if (missing) {
    // Not an error: a callbox that runs eNB but no MME genuinely has no
    // /root/mme/config, and calling that a failure would hold the system
    // permanently red over a directory it was never supposed to have.
    res.notes.push(`${dir} does not exist on ${sys.host}`);
    return res;
  }

  const toFetch: string[] = [];
  for (const f of files) {
    if (f.bytes > MAX_FILE_BYTES) {
      res.notes.push(`${f.name} skipped (${(f.bytes / 1048576).toFixed(1)} MB over the ${MAX_FILE_BYTES / 1048576} MB cap)`);
      continue;
    }
    // The remote hash is what makes this incremental: if it matches what we
    // hold, the bytes cannot have changed and nothing is transferred at all.
    // hasStoredBytes is not redundant with storedHash — a manifest entry whose
    // file is missing would otherwise match on hash forever and never re-fetch.
    if (f.sha256 && storedHash(manifest, category, f.name) === f.sha256 && hasStoredBytes(manifest, category, f.name)) {
      if (touchSeen(manifest, category, f.name, now)) { res.unchanged += 1; continue; }
    }
    toFetch.push(f.name);
  }

  if (toFetch.length) {
    const fetched = await fetchRemoteFiles(sys, dir, toFetch);
    for (const name of toFetch) {
      const src = files.find((f) => f.name === name);
      const buf = fetched.get(name);
      if (!buf) {
        // An empty hash in the listing already told us sha256sum could not read
        // it, which for these directories almost always means a symlink whose
        // target is gone — enb.cfg and friends are links, so a stale one is a
        // normal thing to find. Saying which it is beats "could not be read".
        res.notes.push(src && !src.sha256
          ? `${dir}/${name} is unreadable on ${sys.host} (broken symlink, or denied even under sudo) — not backed up`
          : `${dir}/${name} could not be transferred from ${sys.host}`);
        continue;
      }
      tally(res, upsertFile(manifest, category, name, buf, {
        now,
        sourceMtime: src?.mtimeEpoch ? new Date(src.mtimeEpoch * 1000).toISOString() : undefined,
      }));
    }
  }
  return res;
}

// ───────────────────────── the three sources ─────────────────────────

/** UESIM: /root/ue/config → UE_config */
export function collectUeConfig(sys: InventorySystem, manifest: Manifest, now: string): Promise<CollectResult> {
  return collectDir(sys, manifest, '/root/ue/config', 'UE_config', now);
}

/** Callbox: /root/enb/config → enb_config, /root/mme/config → mme_config */
export async function collectCallboxConfigs(sys: InventorySystem, manifest: Manifest, now: string): Promise<CollectResult> {
  const res = empty();
  merge(res, await collectDir(sys, manifest, '/root/enb/config', 'enb_config', now));
  merge(res, await collectDir(sys, manifest, '/root/mme/config', 'mme_config', now));
  return res;
}

/** A basename store.ts will accept, derived from a testcase name. */
function safeStem(s: string): string {
  const cleaned = (s || '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '').slice(0, 120);
  return cleaned || 'testcase';
}

/**
 * Simnovator: every testcase as its own JSON file.
 *
 * Paging here uses `offset` as a PAGE INDEX, which is what GET /v2/testcases
 * actually means by it — unlike POST /v2/testcases/search, which pages on
 * pageNumber/pageSize. The box does not reject the wrong vocabulary; it answers
 * 200 with page 1 again, which is how an earlier version of the testcase backup
 * filled itself with the same 50 rows repeated and still reported success. The
 * `fresh === 0` bail-out below is the guard that would have caught that.
 *
 * Duplicate ids inside a single page are real product behaviour too (491 unique
 * of 500 on .95), hence the id map rather than a plain array.
 */
export async function collectTestcases(
  sys: InventorySystem,
  inv: Inventory,
  manifest: Manifest,
  now: string,
): Promise<CollectResult> {
  const res = empty();
  const target = uesimApiOptsForSystem(inv, sys.id);
  if (!target) { res.notes.push(`${sys.name} is not UESIM-capable — no testcases to back up`); return res; }
  const opts = { host: target.host, username: target.username, password: target.password };

  const pageSize = 50;
  const maxPages = 200;
  const seen = new Map<string, any>();
  for (let page = 0; page < maxPages; page++) {
    const r = await listTestcases(opts, pageSize, page);
    const items = r.items ?? [];
    if (!items.length) break;
    let fresh = 0;
    for (const t of items) {
      const id = String((t as any)?.id ?? '');
      if (!id || seen.has(id)) continue;
      seen.set(id, t);
      fresh += 1;
    }
    if (fresh === 0) break;             // a page adding nothing means we are re-reading
    if (items.length < pageSize) break;
  }

  // Filenames are assigned before any fetching so they cannot depend on the
  // order the box happened to return rows in: a name shared by more than one
  // testcase gets the id appended for ALL of its holders, not just the later
  // ones, so a given testcase keeps the same backup filename every cycle.
  const byStem = new Map<string, string[]>();
  for (const [id, summary] of seen) {
    const stem = safeStem(String(summary?.name ?? id));
    byStem.set(stem, [...(byStem.get(stem) ?? []), id]);
  }
  const fileNameOf = new Map<string, string>();
  for (const [stem, ids] of byStem) {
    for (const id of ids) fileNameOf.set(id, ids.length > 1 ? `${stem}-${safeStem(id)}.json` : `${stem}.json`);
  }

  // A format change has to reach files that are already stored, and those are
  // exactly the ones the lastModifiedOn shortcut would skip. One re-fetch pass,
  // then the stamp at the end of this function keeps it from happening again.
  const staleFormat = manifest.testcaseFormat !== TESTCASE_EXPORT_FORMAT;
  if (staleFormat && Object.keys(manifest.files).length) {
    res.notes.push(`re-exporting all ${seen.size} testcases once: stored format ${manifest.testcaseFormat ?? 'pre-v1'} -> ${TESTCASE_EXPORT_FORMAT}`);
  }

  for (const [id, summary] of seen) {
    const name = fileNameOf.get(id)!;
    // lastModifiedOn arrives with the listing, so an unchanged testcase costs
    // nothing beyond the page that already fetched it.
    const modified = String(summary?.metadata?.lastModifiedOn ?? '');
    const known = manifest.files[`Testcases/${name}`];
    if (!staleFormat && modified && known?.sourceMtime === modified
        && hasStoredBytes(manifest, 'Testcases', name) && touchSeen(manifest, 'Testcases', name, now)) {
      res.unchanged += 1;
      continue;
    }
    try {
      // The GUI's own download, not GET /testcases/{id}: the latter returns the
      // testcase mixed together with what happened when it last ran (status,
      // validationStatus, metadata.lastExecution, metadata.executionHistory).
      // A backup of a testcase should be the testcase.
      const body = Buffer.from(await exportTestcaseConfig(opts, id, String(summary?.name ?? id)), 'utf8');
      tally(res, upsertFile(manifest, 'Testcases', name, body, { now, sourceMtime: modified || undefined }));
    } catch (e: any) {
      // Some rows come back from the listing with an id the box then refuses as
      // malformed — on .95, a handful of ~876 have a NAME where the id should be
      // and the box answers 400 "Invalid testCaseId format". Their config is
      // genuinely unreachable, so the listing row is all there is to keep;
      // storing it marked beats storing nothing and losing the record that the
      // testcase exists at all.
      const reason = clip(e?.message ?? String(e), 160);
      res.notes.push(`testcase ${id}: ${reason}`);
      // Same top-level shape as a real export, and carrying ONLY identity —
      // spreading the listing row here would drag metadata.executionHistory and
      // metadata.lastExecution back into a file that is supposed to be config.
      const partial = Buffer.from(JSON.stringify({
        _simqa: 'listing-only — the box refused to export this testcase',
        _error: reason,
        test_case_details: [{
          Test_Id: summary?.id ?? id,
          Test_Name: summary?.name ?? '',
          Test_Description: summary?.description ?? '',
        }],
      }, null, 2), 'utf8');
      try {
        tally(res, upsertFile(manifest, 'Testcases', name, partial, { now, sourceMtime: modified || undefined }));
      } catch { /* the note above already says what happened */ }
    }
  }

  // Every testcase has been attempted in this format, so record it. Written even
  // if some failed: those already got a listing-only file rewritten this pass,
  // and re-running the whole migration every five minutes would be worse.
  manifest.testcaseFormat = TESTCASE_EXPORT_FORMAT;
  return res;
}

// ───────────────────────── what runs where ─────────────────────────

export type CollectorKind = 'ue' | 'callbox' | 'testcases';

/**
 * Which collectors a system type calls for.
 *
 * UE_config is UESIM-ONLY, deliberately. An earlier version also pointed the UE
 * collector at SIMNOVATOR / SIMNOVATOR_GUI boxes, reasoning that they expose the
 * UESIM REST API (isUesimLike) and so might hold ue.cfg too. They do not: every
 * Simnovator box in the lab answered "/root/ue/config does not exist", so all
 * they contributed was permanently-empty rows in the UE_Config picker — a system
 * list offering boxes that had nothing to offer. Testcases are what a Simnovator
 * holds; UE config belongs to a UESIM.
 *
 * APPSERVER holds no config we back up, so it is absent here — skipped, never
 * failed. The same now applies to a system typed 'UE': it is not listed, so it is
 * not backed up at all. There are none in the inventory today and UE_config was
 * asked for as strictly UESIM, but adding 'UE' below is the one-line change if a
 * UE-typed host ever needs covering.
 */
export function collectorsFor(type: SystemType): CollectorKind[] {
  switch (type) {
    case 'UESIM':
      return ['ue'];
    case 'CALLBOX': case 'ENB': case 'GNB': case 'MME': case 'IMS':
      return ['callbox'];
    case 'SIMNOVATOR': case 'SIMNOVATOR_GUI':
      return ['testcases'];
    default:
      return [];
  }
}

export interface BackupTarget {
  ip: string;
  /** The inventory entry used for SSH — the one at this host that has creds. */
  sys: InventorySystem;
  /** Every inventory id sharing this host, recorded in the manifest. */
  systemIds: string[];
  /** Label for the UI: the types registered at this host. */
  systemType: string;
  kinds: CollectorKind[];
}

/**
 * The systems a cycle should visit, one entry per HOST.
 *
 * The same machine is routinely registered twice — a SIMNOVATOR entry for the
 * Cockpit install target and a SIMNOVATOR_GUI entry for the product GUI, both
 * on one IP. Backups are keyed by IP, so visiting both would open two SSH
 * sessions to the same box and write into the same directory. Grouping by host
 * and unioning their collectors does the same work once.
 */
export function backupTargets(inv: Inventory = loadInventory()): BackupTarget[] {
  const byHost = new Map<string, BackupTarget>();
  for (const s of inv.systems) {
    if (!s.host) continue;
    const kinds = collectorsFor(s.type);
    if (!kinds.length) continue;
    const cur = byHost.get(s.host);
    if (!cur) {
      byHost.set(s.host, { ip: s.host, sys: s, systemIds: [s.id], systemType: s.type, kinds: [...kinds] });
      continue;
    }
    cur.systemIds.push(s.id);
    if (!cur.systemType.split('/').includes(s.type)) cur.systemType += `/${s.type}`;
    for (const k of kinds) if (!cur.kinds.includes(k)) cur.kinds.push(k);
    // Prefer an entry that can actually authenticate over one that cannot.
    const curCreds = !!(cur.sys.password || cur.sys.privateKey);
    const newCreds = !!(s.password || s.privateKey);
    if (!curCreds && newCreds) cur.sys = s;
  }
  return [...byHost.values()].sort((a, b) => a.ip.localeCompare(b.ip));
}

/** Run every collector this target calls for, folding all of them into one
 *  manifest and one result. */
export async function collectTarget(
  t: BackupTarget,
  inv: Inventory,
  manifest: Manifest,
  now: string,
): Promise<CollectResult> {
  const res = empty();
  for (const kind of t.kinds) {
    if (kind === 'ue') merge(res, await collectUeConfig(t.sys, manifest, now));
    else if (kind === 'callbox') merge(res, await collectCallboxConfigs(t.sys, manifest, now));
    else {
      // Testcases go through the REST API, which needs the UESIM-capable entry
      // at this host — not necessarily the one we SSH as.
      const api = t.systemIds.map((id) => getSystem(inv, id)).find((s): s is InventorySystem => !!s && isUesimLike(s)) ?? t.sys;
      merge(res, await collectTestcases(api, inv, manifest, now));
    }
  }
  return res;
}

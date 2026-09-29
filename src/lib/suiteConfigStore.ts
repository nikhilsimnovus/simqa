// Reading a suite row's real configuration off the lab boxes, and keeping it.
//
// Layout, one folder per suite and one per row inside it, exactly as an
// operator would arrange it by hand:
//
//   data/suite-configs/<suite name>/<testcase name>/v1/enb.cfg
//                                                     mme.cfg
//                                                     ims.cfg
//                                                     db.cfg
//                                                     ots.cfg
//                                                     ue.cfg
//                                                     manifest.json
//
// v1 is what the row first ran with; v2 appears the next time the files differ
// — because somebody edited a cfg, or the row was pointed at another one. Old
// versions are never touched, so a run's result can always be read against the
// files it actually had.
//
// The capture is best-effort per file: a callbox with no SSH credentials, or a
// UE that is not registered, leaves that entry out rather than failing a run.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { withSsh } from './configFidelity/ssh';
import type { InventorySystem } from './inventory';
import {
  SNAPSHOT_FILES, diffSnapshot, hashText, latestVersion, nextVersion, safeFolder,
  type SnapshotEntry, type SnapshotFile, type SnapshotManifest, type SnapshotDiff,
} from './suiteSnapshotCore';

export type { SnapshotDiff } from './suiteSnapshotCore';

const ROOT = () => path.join(process.cwd(), 'data', 'suite-configs');

const rowDir = (suiteName: string, rowName: string) =>
  path.join(ROOT(), safeFolder(suiteName), safeFolder(rowName));

/** Single-quoted shell arg. */
const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/** One file, read over an ALREADY OPEN session.
 *
 *  A row's six files used to be a dozen `readCommand` calls, and each of those
 *  opens an SSH connection of its own — a dozen handshakes per row, on the
 *  same box, for reads that take milliseconds. They all share one session now.
 *
 *  /root is 0700 on some callboxes and readable on others, so sudo first with
 *  the unprivileged read as the fallback — the rule every reader here follows. */
async function readCfgOn(ssh: any, dir: string, link: string): Promise<{ source?: string; text: string } | null> {
  try {
    const p = q(`${dir}/${link}`);
    const t = await ssh.execCommand(`sudo -n readlink ${p} 2>/dev/null || readlink ${p} 2>/dev/null || true`);
    const target = String(t.stdout ?? '').trim();
    const source = target.split('/').filter(Boolean).pop() || link;
    // base64, not cat: execCommand trims trailing whitespace off stdout, so a
    // config ending in "}\n\n" came back as "}" — two bytes short of the file
    // on the box. That was invisible while these copies were only a record,
    // and is not once they are pushed back to a callbox as the source of a
    // run. One base64 token survives the trimming intact.
    const c = await ssh.execCommand(`sudo -n base64 -w0 ${p} 2>/dev/null || base64 -w0 ${p} 2>/dev/null`);
    const b64 = String(c.stdout ?? '').trim();
    if (!b64) return null;
    const text = Buffer.from(b64, 'base64').toString('utf8');
    if (!text) return null;
    return { source, text };
  } catch {
    return null;
  }
}

/**
 * Every file an MME config pulls in through an `include` line.
 *
 * There is rarely just one. A working demo-mme.cfg here names five —
 * 1000UE.mme.cfg, demo-1000ue_db-ims-volte.cfg, ue_db_1000_xor.json, 1-db.cfg
 * and xcap-ue-db.cfg — and the MME will not start with any of them absent.
 * Picking "the DB" out of that list was a guess, and it guessed wrong: the
 * first name matching db|subscriber|ue is 1000UE.mme.cfg, because it contains
 * "ue", so the real subscriber DB was never captured at all. They are all
 * taken now, under the names the config uses.
 */
async function includesOf(ssh: any, mmeCfgName: string): Promise<string[]> {
  try {
    const p = q(`/root/mme/config/${mmeCfgName}`);
    const r = await ssh.execCommand(
      `sudo -n grep -E '^[[:space:]]*include' ${p} 2>/dev/null || grep -E '^[[:space:]]*include' ${p} 2>/dev/null || true`);
    return String(r.stdout ?? '')
      .split('\n')
      .map((l: string) => l.trim())
      .filter((l: string) => l.startsWith('include'))
      .map((l: string) => /include\s+"([^"]+)"/.exec(l)?.[1])
      .filter((n: unknown): n is string => !!n)
      // Only plain names — an include with a path is not ours to copy around.
      .filter((n: string) => !n.includes('/'));
  } catch {
    return [];
  }
}

/** Which subscriber DB an MME config pulls in — the first include that looks
 *  like one, kept for the versioned snapshots, whose layout names a "db.cfg". */
async function dbIncludedBy(ssh: any, mmeCfgName: string): Promise<string | undefined> {
  try {
    const p = q(`/root/mme/config/${mmeCfgName}`);
    const r = await ssh.execCommand(
      `sudo -n grep -E '^[[:space:]]*include' ${p} 2>/dev/null || grep -E '^[[:space:]]*include' ${p} 2>/dev/null || true`);
    return String(r.stdout ?? '')
      .split('\n')
      .map((l: string) => l.trim())
      .filter((l: string) => l.startsWith('include'))
      .map((l: string) => /include\s+"([^"]+)"/.exec(l)?.[1])
      .filter((n: unknown): n is string => !!n)
      // Only the subscriber/PLMN databases, not every include (configs also
      // pull in 1000UE.mme.cfg-style fragments).
      .find((n: string) => /db|subscriber|ue/i.test(n));
  } catch {
    return undefined;
  }
}

/**
 * The six files this row runs against, read from the boxes as they are now.
 *
 * `callbox` carries the radio, core and ots configs; `ueSystem` carries
 * ue.cfg. The DB is whatever the live mme.cfg includes — it is not chosen
 * anywhere, so it is discovered rather than passed in.
 */
export async function captureRowConfigs(
  callbox?: InventorySystem,
  ueSystem?: InventorySystem,
  /**
   * The files this row CHOSE, read by name instead of through the live
   * symlinks.
   *
   * enb.cfg / mme.cfg / ims.cfg on a callbox point at whatever ran last, which
   * on a shared box is usually somebody else's row. Reading the links is right
   * during a run — they point at this row by then — and wrong at any other
   * time: a suite saved while a colleague's test was linked captured their
   * config as this row's. Given the names, the files are read directly.
   */
  chosen?: { enb?: string; mme?: string; ims?: string },
): Promise<{
  files: Partial<Record<SnapshotFile, SnapshotEntry>>;
  contents: Partial<Record<SnapshotFile, string>>;
  /** Everything the MME config includes, keyed by its real filename. */
  includes: Record<string, string>;
}> {
  const files: Partial<Record<SnapshotFile, SnapshotEntry>> = {};
  const contents: Partial<Record<SnapshotFile, string>> = {};
  const includes: Record<string, string> = {};
  const put = (name: SnapshotFile, got: { source?: string; text: string } | null) => {
    if (!got) return;
    files[name] = { source: got.source, sha256: hashText(got.text), bytes: Buffer.byteLength(got.text) };
    contents[name] = got.text;
  };

  if (callbox) {
    // One connection for all five — see readCfgOn.
    await withSsh(callbox, async (ssh) => {
      put('enb.cfg', await readCfgOn(ssh, '/root/enb/config', chosen?.enb ?? 'enb.cfg'));
      const mme = await readCfgOn(ssh, '/root/mme/config', chosen?.mme ?? 'mme.cfg');
      put('mme.cfg', mme);
      put('ims.cfg', await readCfgOn(ssh, '/root/mme/config', chosen?.ims ?? 'ims.cfg'));
      put('ots.cfg', await readCfgOn(ssh, '/root/ots/config', 'ots.cfg'));
      // Everything the MME config pulls in, under its own name. The MME will
      // not start with any of them missing, so a copy that holds only some is
      // not a copy this row could run from.
      if (mme?.source) {
        for (const name of await includesOf(ssh, mme.source)) {
          const got = await readCfgOn(ssh, '/root/mme/config', name);
          if (got) includes[name] = got.text;
        }
        // The versioned snapshots keep naming one of them db.cfg.
        const db = await dbIncludedBy(ssh, mme.source);
        if (db) put('db.cfg', await readCfgOn(ssh, '/root/mme/config', db));
      }
    }).catch(() => { /* a box we cannot reach records nothing, and fails nothing */ });
  }
  if (ueSystem) {
    await withSsh(ueSystem, async (ssh) => {
      put('ue.cfg', await readCfgOn(ssh, '/root/ue/config', 'ue.cfg'));
    }).catch(() => { /* same */ });
  }

  return { files, contents, includes };
}

function versionsOf(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

/** The manifest of the newest saved version for a row, if it has ever run. */
export function latestManifest(suiteName: string, rowName: string): SnapshotManifest | null {
  const dir = rowDir(suiteName, rowName);
  const v = latestVersion(versionsOf(dir));
  if (!v) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, v, 'manifest.json'), 'utf8')) as SnapshotManifest;
  } catch {
    return null;
  }
}

/**
 * Compare a row's saved configuration with the boxes as they are now.
 *
 * `null` means the row has never been captured — the first run has nothing to
 * disagree with, and says so rather than reporting everything as new.
 */
export async function checkRowConfigs(
  suiteName: string,
  rowName: string,
  callbox?: InventorySystem,
  ueSystem?: InventorySystem,
): Promise<{ diff: SnapshotDiff | null; capturedAt?: string; version?: number }> {
  const saved = latestManifest(suiteName, rowName);
  if (!saved) return { diff: null };
  const { files } = await captureRowConfigs(callbox, ueSystem);
  return { diff: diffSnapshot(saved.files, files), capturedAt: saved.capturedAt, version: saved.version };
}

/**
 * Keep what this row just ran with.
 *
 * Writes a new version ONLY when the content differs from the newest saved one
 * — a suite re-run on untouched configs does not litter the folder with
 * identical copies, and a version therefore marks a real change.
 */
export async function saveRowConfigs(opts: {
  suiteId: string;
  suiteName: string;
  rowId: string;
  rowName: string;
  callbox?: InventorySystem;
  ueSystem?: InventorySystem;
  capturedBy?: string;
  /** The Simnovator this row executed on. */
  uesimHost?: string;
}): Promise<{ version: string; changed: boolean; changedFiles?: SnapshotFile[]; files: SnapshotFile[] } | null> {
  const { files, contents } = await captureRowConfigs(opts.callbox, opts.ueSystem);
  if (Object.keys(files).length === 0) return null;   // nothing readable — nothing to claim

  const dir = rowDir(opts.suiteName, opts.rowName);
  const saved = latestManifest(opts.suiteName, opts.rowName);
  if (saved && diffSnapshot(saved.files, files).same) {
    return { version: `v${saved.version}`, changed: false, files: Object.keys(files) as SnapshotFile[] };
  }

  // What moved since the previous version, kept with the version itself so
  // the panel can say "Configuration changed · enb.cfg, db.cfg" without
  // re-reading and re-comparing every earlier one.
  const changedFiles = saved
    ? diffSnapshot(saved.files, files).changed
        .filter((c) => c.state === 'changed' || c.state === 'added')
        .map((c) => c.file)
    : [];

  const version = nextVersion(versionsOf(dir));
  const out = path.join(dir, version);
  fs.mkdirSync(out, { recursive: true });
  for (const name of SNAPSHOT_FILES) {
    const text = contents[name];
    if (text != null) fs.writeFileSync(path.join(out, name), text, 'utf8');
  }
  const manifest: SnapshotManifest = {
    suiteId: opts.suiteId,
    suiteName: opts.suiteName,
    rowId: opts.rowId,
    rowName: opts.rowName,
    version: Number(version.slice(1)),
    capturedAt: new Date().toISOString(),
    capturedBy: opts.capturedBy,
    callboxHost: opts.callbox?.host,
    ueHost: opts.ueSystem?.host,
    uesimHost: opts.uesimHost,
    files,
    reason: saved ? 'changed' : 'original',
    changedFiles: saved ? changedFiles : undefined,
  };
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return { version, changed: !!saved, changedFiles, files: Object.keys(files) as SnapshotFile[] };
}

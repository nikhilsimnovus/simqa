// On-disk store for the automatic backups.
//
// Layout:
//
//   data/backups/<ip>/UE_config/…
//                     enb_config/…
//                     mme_config/…
//                     Testcases/…
//                     manifest.json
//
// The one rule that governs everything here: THIS MODULE NEVER DELETES A
// BACKED-UP FILE. A file that disappears from the source keeps its copy and its
// manifest entry; only `lastSeen` stops advancing. That is deliberate — the
// whole point of the backup is to still have the cfg someone overwrote or
// removed. There is no prune path in this file, and adding one would defeat it.
//
// IMPORTS: node builtins ONLY, on purpose.
//
// The tests run under `node --test`, whose ESM resolver will not follow an
// extensionless relative import (`from './inventory'`) or the `@/` tsconfig
// alias. Keeping this module free of project imports is what makes it directly
// testable without a bundler or a new test framework. Anything needing SSH or
// the Simnovator API belongs in collectors.ts, not here.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

export type BackupCategory = 'UE_config' | 'enb_config' | 'mme_config' | 'Testcases';

export const BACKUP_CATEGORIES: BackupCategory[] = ['UE_config', 'enb_config', 'mme_config', 'Testcases'];

/** What we know about one stored file. `sha256` is what change detection
 *  compares; size and mtime are recorded for display and for cheap remote
 *  pre-filtering before a hash is even computed. */
export interface ManifestEntry {
  /** The file's name ON THE SOURCE. This is the identity: it is what the UI
   *  shows and what a download is requested by. */
  name: string;
  /**
   * The name actually used on disk, present only when it had to differ.
   *
   * SimQA runs on Windows, whose filesystem is case-insensitive; the lab boxes
   * are Linux, whose is not. /root/ue/config on .101 holds BOTH `UE.cfg` and
   * `ue.cfg`, and writing them under their own names means the second silently
   * overwrites the first — two manifest entries, one file, one of them holding
   * the wrong bytes. Observed on the very first live cycle. So the loser of a
   * case collision is stored under a disambiguated name, decided once and
   * recorded here so it stays stable across cycles.
   */
  diskName?: string;
  category: BackupCategory;
  bytes: number;
  sha256: string;
  /** Source mtime as an ISO string, when the source reported one. */
  sourceMtime?: string;
  /** Last cycle in which the source still had this file. */
  lastSeen: string;
  /** Last cycle in which the stored bytes actually changed. */
  lastChanged: string;
}

export interface Manifest {
  ip: string;
  /** Inventory id at capture time. Recorded so a system whose IP was reused is
   *  visible as a mismatch instead of silently merging two boxes' history. */
  systemId?: string;
  systemType?: string;
  /**
   * Which format the stored Testcases were written in.
   *
   * Testcases are normally skipped when their lastModifiedOn has not moved, so a
   * change to WHAT we store would otherwise never reach the ~1100 files already
   * on disk — they would sit in the old format until somebody edited each one on
   * the box. When this does not match what the collector writes today, that
   * cycle re-fetches every testcase once and then stamps the new value.
   */
  testcaseFormat?: string;
  updatedAt: string;
  files: Record<string, ManifestEntry>;
}

export type UpsertOutcome = 'added' | 'updated' | 'unchanged';

/** Root of the backup tree. Overridable so the tests can point at a temp dir
 *  without touching the real one. */
export function backupRoot(): string {
  return process.env.SIMQA_BACKUP_ROOT || path.join(process.cwd(), 'data', 'backups');
}

/**
 * Reject anything that is not a plain file name.
 *
 * Names arrive from a remote `find` and from query strings, so `../../etc/passwd`
 * and `/etc/passwd` both have to be impossible — otherwise a download endpoint
 * becomes an arbitrary file read, and a collector could write outside the
 * backup tree.
 */
export function isSafeName(name: string): boolean {
  if (!name || name.length > 255) return false;
  if (name === '.' || name === '..') return false;
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return false;
  return path.basename(name) === name;
}

function assertSafe(name: string): void {
  if (!isSafeName(name)) throw new Error(`unsafe backup file name: ${JSON.stringify(name)}`);
}

function ipDir(ip: string): string {
  assertSafe(ip);
  return path.join(backupRoot(), ip);
}

export function categoryDir(ip: string, category: BackupCategory): string {
  return path.join(ipDir(ip), category);
}

function manifestPath(ip: string): string {
  return path.join(ipDir(ip), 'manifest.json');
}

export function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

export function readManifest(ip: string): Manifest {
  try {
    const raw = fs.readFileSync(manifestPath(ip), 'utf8');
    const m = JSON.parse(raw) as Manifest;
    if (!m.files) m.files = {};
    return m;
  } catch {
    return { ip, updatedAt: new Date(0).toISOString(), files: {} };
  }
}

export function writeManifest(m: Manifest): void {
  fs.mkdirSync(ipDir(m.ip), { recursive: true });
  m.updatedAt = new Date().toISOString();
  // Write-then-rename: a crash mid-write must not leave a manifest that cannot
  // be parsed, because an unreadable manifest makes every file look new and
  // triggers a full re-download on the next cycle.
  const tmp = manifestPath(m.ip) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(m, null, 2));
  fs.renameSync(tmp, manifestPath(m.ip));
}

/** Key used inside the manifest — category-scoped, so the same file name under
 *  enb_config and mme_config are distinct entries. */
function key(category: BackupCategory, name: string): string {
  return `${category}/${name}`;
}

/**
 * The name to store `name` under, avoiding a case-insensitive collision.
 *
 * Only the second and later claimants of a lowercased name are renamed, so the
 * common case keeps its real filename and only a genuine collision produces
 * something odd-looking. The decision is recorded in the manifest, so once
 * `ue.cfg` has become `ue~6b86b2.cfg` it stays that on every later cycle
 * regardless of what order the box lists the directory in.
 */
function resolveDiskName(manifest: Manifest, category: BackupCategory, name: string): string {
  const others = Object.values(manifest.files).filter((e) => e.category === category && e.name !== name);

  // Keep whatever this entry is already stored as, PROVIDED no other entry now
  // claims that same name case-insensitively. The early version returned here
  // unconditionally, which meant a collision that predated this function could
  // never heal: Test1.json and test1.json both existed in the manifest with no
  // diskName between them, one file on disk, and every later cycle took this
  // branch and left it that way.
  const existing = manifest.files[key(category, name)];
  const current = existing?.diskName ?? existing?.name;
  if (current && !others.some((e) => (e.diskName ?? e.name).toLowerCase() === current.toLowerCase())) {
    return current;
  }

  // Resolving fresh. Which sibling keeps the plain name is decided by sort order,
  // not by which one happened to be written first, so the answer is the same on
  // every cycle regardless of the order the box lists them in.
  const lower = name.toLowerCase();
  const siblings = others.filter((e) => e.name.toLowerCase() === lower).map((e) => e.name);
  siblings.push(name);
  siblings.sort();
  if (siblings[0] === name) return name;

  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  return `${stem}~${sha256(name).slice(0, 6)}${ext}`;
}

/**
 * Do we actually hold this file's bytes?
 *
 * A manifest entry is not proof of a backup. If the entry says sha256 X and the
 * file behind it is missing — clobbered by a case-collision, a failed rename, or
 * someone tidying data/backups by hand — then the hash comparison says
 * "unchanged", nothing is transferred, and the gap never closes. Checking the
 * bytes exist is what turns that into a re-fetch on the next cycle.
 */
export function hasStoredBytes(manifest: Manifest, category: BackupCategory, name: string): boolean {
  const disk = diskNameOf(manifest, category, name);
  try {
    // realpathSync.native, NOT existsSync. This runs on Windows, where
    // existsSync('test1.cfg') answers true when the file on disk is actually
    // Test1.cfg — the very collision this check exists to detect, reported as
    // healthy. .native resolves to the filesystem's real casing, so comparing
    // basenames gives the case-SENSITIVE answer the Linux sources need.
    const real = fs.realpathSync.native(path.join(categoryDir(manifest.ip, category), disk));
    return path.basename(real) === disk;
  } catch {
    return false;
  }
}

/** Where a file's bytes live, given the name it has on the source. */
function diskNameOf(manifest: Manifest, category: BackupCategory, name: string): string {
  const e = manifest.files[key(category, name)];
  return e?.diskName ?? e?.name ?? name;
}

/**
 * Store one file, if its bytes differ from what is already stored.
 *
 * Returns 'unchanged' WITHOUT touching the file on disk when the hash matches —
 * callers rely on that to avoid rewriting (and re-dating) hundreds of unchanged
 * cfgs every five minutes.
 */
export function upsertFile(
  manifest: Manifest,
  category: BackupCategory,
  name: string,
  content: Buffer,
  opts: { sourceMtime?: string; now?: string } = {},
): UpsertOutcome {
  assertSafe(name);
  const now = opts.now ?? new Date().toISOString();
  const k = key(category, name);
  const prev = manifest.files[k];
  const hash = sha256(content);

  // The hash matching is not enough on its own — the stored file has to be there.
  // See hasStoredBytes: a manifest entry pointing at nothing would otherwise
  // report 'unchanged' forever and never be repaired.
  if (prev && prev.sha256 === hash && hasStoredBytes(manifest, category, name)) {
    // Seen again, unchanged: record the sighting, leave the bytes alone.
    prev.lastSeen = now;
    if (opts.sourceMtime) prev.sourceMtime = opts.sourceMtime;
    return 'unchanged';
  }

  const diskName = resolveDiskName(manifest, category, name);
  const dir = categoryDir(manifest.ip, category);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${diskName}.tmp`);
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, path.join(dir, diskName));

  manifest.files[k] = {
    name, category,
    diskName: diskName === name ? undefined : diskName,
    bytes: content.length,
    sha256: hash,
    sourceMtime: opts.sourceMtime,
    lastSeen: now,
    lastChanged: now,
  };
  return prev ? 'updated' : 'added';
}

/**
 * Record that a file we already hold was seen again, without re-reading it.
 *
 * The testcase collector needs this: the box tells us metadata.lastModifiedOn
 * cheaply, so when that has not moved there is no reason to fetch the testcase
 * body at all — but we still want lastSeen to advance, or the file would look
 * like it had vanished from the source.
 *
 * Returns false when we do not actually hold the file, so a caller cannot skip
 * a fetch on the strength of a touch that did nothing.
 */
export function touchSeen(
  manifest: Manifest,
  category: BackupCategory,
  name: string,
  now = new Date().toISOString(),
): boolean {
  const e = manifest.files[key(category, name)];
  if (!e) return false;
  e.lastSeen = now;
  return true;
}

/** Hash of what is already stored, or undefined if we do not have it. Lets a
 *  collector skip transferring a file whose remote hash already matches. */
export function storedHash(manifest: Manifest, category: BackupCategory, name: string): string | undefined {
  return manifest.files[key(category, name)]?.sha256;
}

export interface StoredFile {
  name: string;
  bytes: number;
  lastSeen: string;
  lastChanged: string;
  /** True when the last cycle that ran did not find this on the source any
   *  more. The file is KEPT; this only tells the UI it is now history. */
  missingFromSource: boolean;
}

/**
 * Files held for a system + category, newest change first.
 *
 * Driven by the manifest, because that is what knows a file's real name on the
 * source — a directory listing would show `ue~6b86b2.cfg` rather than the
 * `ue.cfg` the box actually has. Anything on disk WITHOUT a manifest entry is
 * appended anyway, so a file that survived a manifest loss is still offered for
 * download rather than becoming invisible.
 *
 * `m` lets a caller that already has the manifest avoid re-parsing it. That is
 * not just an optimisation: countByCategory shares this exact function so the
 * number in the system picker cannot drift from the number of rows underneath
 * it. It did — the picker counted manifest entries while the list counted
 * entries WITH bytes on disk, and the two differed by however many entries had
 * lost their file.
 */
export function listFiles(ip: string, category: BackupCategory, lastCycleAt?: string, m?: Manifest): StoredFile[] {
  const dir = categoryDir(ip, category);
  let onDisk: string[];
  try {
    onDisk = fs.readdirSync(dir).filter((n) => !n.startsWith('.'));
  } catch {
    return [];
  }

  const manifest = m ?? readManifest(ip);
  const out: StoredFile[] = [];
  const claimed = new Set<string>();

  for (const e of Object.values(manifest.files)) {
    if (e.category !== category) continue;
    const disk = e.diskName ?? e.name;
    if (!onDisk.includes(disk)) continue;   // manifest entry with no bytes behind it
    claimed.add(disk);
    out.push({
      name: e.name,
      bytes: e.bytes,
      lastSeen: e.lastSeen,
      lastChanged: e.lastChanged,
      missingFromSource: !!(lastCycleAt && e.lastSeen < lastCycleAt),
    });
  }

  for (const name of onDisk) {
    if (claimed.has(name)) continue;
    let bytes = 0;
    try { bytes = fs.statSync(path.join(dir, name)).size; } catch { /* keep 0 */ }
    out.push({ name, bytes, lastSeen: '', lastChanged: '', missingFromSource: false });
  }

  out.sort((a, b) => (b.lastChanged || '').localeCompare(a.lastChanged || '') || a.name.localeCompare(b.name));
  return out;
}

/** One stored file's bytes, for the download endpoint. `name` is the name on
 *  the SOURCE; the manifest translates it to whatever it is stored as. */
export function readFile(ip: string, category: BackupCategory, name: string): Buffer {
  assertSafe(name);
  const disk = diskNameOf(readManifest(ip), category, name);
  assertSafe(disk);
  return fs.readFileSync(path.join(categoryDir(ip, category), disk));
}

/**
 * How many files are held per category, from ONE manifest read.
 *
 * Deliberately implemented as listFiles().length rather than as its own count.
 * The picker showed "226 file(s)" over a list of 224 rows because this counted
 * manifest entries while the list counted entries whose bytes were actually on
 * disk. Two definitions of "a file we hold" is one too many; there is now one.
 */
export function countByCategory(ip: string): Record<BackupCategory, number> {
  const m = readManifest(ip);
  const counts = {} as Record<BackupCategory, number>;
  for (const c of BACKUP_CATEGORIES) counts[c] = listFiles(ip, c, undefined, m).length;
  return counts;
}

/** Every system directory that holds a backup — including systems no longer in
 *  System Management, because removing a system must not hide its history. */
export function listBackedUpIps(): string[] {
  try {
    return fs.readdirSync(backupRoot(), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

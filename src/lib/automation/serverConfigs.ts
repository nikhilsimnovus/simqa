// The Automation Server's own copy of what every suite row runs with.
//
//   /root/automation_configs/
//   └── <Suite Name>/
//       └── <Test Case Name>/
//           ├── test.json      the testcase definition, as the Simnovator holds it
//           ├── enb.cfg        the radio config the row links on the callbox
//           ├── mme.cfg        the core config
//           ├── ims.cfg        the IMS config
//           ├── db             the subscriber DB the MME config includes
//           ├── ots.cfg        the box's own ots config
//           └── ue.cfg         the UE simulator's config
//
// Why a real directory and not just a record in the app's data folder: the
// files a run uses were scattered — the cfgs on the callbox, the DB inside an
// include line, the testcase only ever in the Simnovator's database — so
// "what does this row actually run" could not be answered from one place, let
// alone opened in vi. This is that place, on the machine SimQA runs on,
// readable by anyone with root.
//
// Writing is best-effort by design: a callbox that is down must not stop a
// suite from being saved. Every function here reports what it managed rather
// than throwing.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { safeFolder } from '../suiteSnapshotCore';

/** The files a test case folder holds, in the order they are listed. */
export const SERVER_FILES = ['test.json', 'enb.cfg', 'mme.cfg', 'ims.cfg', 'db', 'ots.cfg', 'ue.cfg'] as const;
export type ServerFile = typeof SERVER_FILES[number];

/** Where the tree lives. SIMQA_AUTOMATION_CONFIGS overrides it — the default
 *  path is a Linux one, and a developer machine has no /root. */
export const DEFAULT_ROOT = '/root/automation_configs';

let cachedRoot: string | undefined;

/**
 * The root to write into.
 *
 * /root/automation_configs when it exists and this process can write there —
 * the installer creates it owned by the service user — and a folder under the
 * app's own data directory otherwise, so a developer box and a server that has
 * not been updated both keep working. Resolved once: the answer cannot change
 * without a restart, and every suite save would otherwise stat the same path.
 */
export function automationRoot(): string {
  if (cachedRoot) return cachedRoot;
  const wanted = process.env.SIMQA_AUTOMATION_CONFIGS?.trim() || DEFAULT_ROOT;
  cachedRoot = usable(wanted) ? wanted : path.join(process.cwd(), 'data', 'automation_configs');
  return cachedRoot;
}

/** Can we create directories here? Tries to make the root if it is missing,
 *  which is the normal case the first time on a fresh machine. */
function usable(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK | fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** True when the tree is where the spec wants it rather than the fallback. */
export function rootIsCanonical(): boolean {
  return automationRoot() === (process.env.SIMQA_AUTOMATION_CONFIGS?.trim() || DEFAULT_ROOT);
}

export const suiteDir = (suiteName: string) => path.join(automationRoot(), safeFolder(suiteName));
export const testCaseDir = (suiteName: string, rowName: string) =>
  path.join(suiteDir(suiteName), safeFolder(rowName));

/**
 * Make sure a suite has a folder, and one inside it per test case.
 *
 * Called when a suite is saved, so the tree matches the app before anything
 * has run. Folders for rows that no longer exist are left alone: a row removed
 * by accident should not take its history with it, and nothing reads them.
 */
export function ensureSuiteTree(suiteName: string, rowNames: string[]): { root: string; created: string[] } {
  const created: string[] = [];
  try {
    fs.mkdirSync(suiteDir(suiteName), { recursive: true });
    for (const row of rowNames) {
      const dir = testCaseDir(suiteName, row);
      if (!fs.existsSync(dir)) created.push(dir);
      fs.mkdirSync(dir, { recursive: true });
    }
  } catch { /* unwritable root: the fallback already handled it, nothing else to do */ }
  return { root: automationRoot(), created };
}

/**
 * Write a test case's files.
 *
 * Only the entries actually supplied are written — a callbox that could not be
 * read leaves its files as they were rather than blanking them, which matters
 * because these are what the next execution uses.
 */
export function writeTestCaseFiles(
  suiteName: string,
  rowName: string,
  /**
   * The row's files. The six known roles, plus whatever the MME config
   * includes — those arrive under their own names (ue_db_1000_xor.json,
   * 1-db.cfg …), because that is what the config asks for and what has to be
   * put back. Calling one of them "db" hid which file it was and, when the
   * guess was wrong, hid that it was the wrong file.
   */
  files: Record<string, string | undefined>,
): { dir: string; written: string[]; error?: string } {
  const dir = testCaseDir(suiteName, rowName);
  const written: string[] = [];
  // Known roles first so a listing reads in a sensible order, then the rest.
  const order = [...SERVER_FILES.filter(n => files[n] != null),
    ...Object.keys(files).filter(n => !(SERVER_FILES as readonly string[]).includes(n))];
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const name of order) {
      const text = files[name];
      if (text == null) continue;
      // A name from a config file is not a path: keep it to one component.
      if (name !== path.basename(name) || name.startsWith('.')) continue;
      // Written through a temp file in the same directory: a half-written
      // config that an execution then picks up is worse than an old one.
      const tmp = path.join(dir, `.${name}.tmp`);
      fs.writeFileSync(tmp, text, 'utf8');
      fs.renameSync(tmp, path.join(dir, name));
      written.push(name);
    }
  } catch (e: any) {
    return { dir, written, error: e?.message ?? String(e) };
  }
  return { dir, written };
}

/**
 * Point a role name at the file the row actually picked.
 *
 *   enb.cfg -> SA-1Cell.cfg_June2026
 *
 * Relative, with a bare basename, which is how /root/enb/config reads on the
 * callbox and how operators write it by hand. Whatever sits at the role name
 * already — an older plain copy, a link at something else — is replaced, so
 * this is also what repairs a folder written by an earlier version.
 *
 * Symlinks are not universally available: Windows needs a privilege most
 * accounts lack, and a config folder can sit on a filesystem that has none.
 * A copy is made instead, which is exactly the old behaviour, and the caller
 * is told which happened rather than being left to guess from the folder.
 */
export function linkRoleToFile(
  suiteName: string,
  rowName: string,
  role: string,
  realName: string,
): { role: string; target: string; how: 'symlink' | 'copy' | 'same' | 'missing' | 'failed'; error?: string } {
  const out = (how: 'symlink' | 'copy' | 'same' | 'missing' | 'failed', error?: string) =>
    ({ role, target: realName, how, ...(error ? { error } : {}) });
  // Both are names, not paths — the pick comes from a config file and from an
  // upload, and neither is trusted to stay inside the folder.
  if (role !== path.basename(role) || realName !== path.basename(realName)) return out('failed', 'not a filename');
  if (role.startsWith('.') || realName.startsWith('.')) return out('failed', 'not a filename');
  if (role === realName) return out('same');

  const dir = testCaseDir(suiteName, rowName);
  if (!insideRoot(dir)) return out('failed', 'outside the configs root');
  const linkPath = path.join(dir, role);
  const realPath = path.join(dir, realName);
  // Nothing to point at. A dangling link reads as "saved" and fails at run
  // time with the core refusing to start, which is the worst of both.
  if (!fs.existsSync(realPath)) return out('missing');

  try {
    fs.rmSync(linkPath, { force: true });
  } catch (e: any) {
    return out('failed', e?.message ?? String(e));
  }
  try {
    fs.symlinkSync(realName, linkPath);
    return out('symlink');
  } catch {
    // No symlink here. Fall back to the copy the folder used to hold, so the
    // row is still runnable from it.
    try {
      fs.copyFileSync(realPath, linkPath);
      return out('copy');
    } catch (e: any) {
      return out('failed', e?.message ?? String(e));
    }
  }
}

/** Remove one file from a test case folder — a name an older version wrote
 *  that nothing uses any more. Guarded like every other delete here. */
export function dropStaleFile(suiteName: string, rowName: string, file: string): boolean {
  if (file !== path.basename(file)) return false;
  const dir = testCaseDir(suiteName, rowName);
  if (!insideRoot(dir)) return false;
  try {
    fs.rmSync(path.join(dir, file), { force: true });
    return true;
  } catch {
    return false;
  }
}

/** Every file in a test case folder, by name — what a run puts back. */
export function readAllTestCaseFiles(suiteName: string, rowName: string): Record<string, string> {
  const out: Record<string, string> = {};
  const dir = testCaseDir(suiteName, rowName);
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      // isFile() is false for a symlink, and the role names are links now —
      // enb.cfg -> SA-1Cell.cfg_June2026. Read through them: what the folder
      // holds under a name is that name's content, however it got there.
      if (entry.name.startsWith('.') || (!entry.isFile() && !entry.isSymbolicLink())) continue;
      try { out[entry.name] = fs.readFileSync(path.join(dir, entry.name), 'utf8'); } catch { /* a dangling link, or unreadable */ }
    }
  } catch { /* nothing captured yet */ }
  return out;
}

/** One file's contents, or undefined when it is not there. This is what an
 *  execution reads: the folder is the source, not a record of one. */
export function readTestCaseFile(suiteName: string, rowName: string, file: string): string | undefined {
  try {
    return fs.readFileSync(path.join(testCaseDir(suiteName, rowName), file), 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Inside the tree and not the tree itself.
 *
 * Everything below deletes directories on the Automation Server, so each path
 * is checked against the root first: a suite named "../.." must not reach
 * outside it, and the root itself is never a candidate.
 */
function insideRoot(dir: string): boolean {
  const root = path.resolve(automationRoot());
  const target = path.resolve(dir);
  return target !== root && target.startsWith(root + path.sep);
}

/** Take a suite's folder away, with everything in it. Called when the suite is
 *  deleted in the app: the tree mirrors what exists, so a folder for a suite
 *  nobody has any more is just something to trip over later. */
export function removeSuiteTree(suiteName: string): { removed: boolean; dir: string } {
  const dir = suiteDir(suiteName);
  if (!insideRoot(dir)) return { removed: false, dir };
  try {
    if (!fs.existsSync(dir)) return { removed: false, dir };
    fs.rmSync(dir, { recursive: true, force: true });
    return { removed: true, dir };
  } catch {
    return { removed: false, dir };
  }
}

/** Drop the folders of test cases the suite no longer has — a row deleted or
 *  renamed in the app. Only ever inside this suite's own folder. */
export function pruneTestCases(suiteName: string, keep: string[]): string[] {
  const dir = suiteDir(suiteName);
  if (!insideRoot(dir)) return [];
  const wanted = new Set(keep.map(safeFolder));
  const removed: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || wanted.has(entry.name)) continue;
      const victim = path.join(dir, entry.name);
      if (!insideRoot(victim)) continue;
      fs.rmSync(victim, { recursive: true, force: true });
      removed.push(entry.name);
    }
  } catch { /* nothing there yet */ }
  return removed;
}

/** Follow a rename: move the folder rather than leaving the old one behind and
 *  building a second tree beside it. */
export function renameSuiteTree(from: string, to: string): boolean {
  if (safeFolder(from) === safeFolder(to)) return false;
  const src = suiteDir(from);
  const dst = suiteDir(to);
  if (!insideRoot(src) || !insideRoot(dst)) return false;
  try {
    if (!fs.existsSync(src) || fs.existsSync(dst)) return false;
    fs.renameSync(src, dst);
    return true;
  } catch {
    return false;
  }
}

/**
 * The hash of what SimQA last wrote into this row's folder, file by file.
 *
 * Kept in a dot-file so it is invisible to every reader here — they all skip
 * names starting with "." — and so an operator working in the folder does not
 * trip over it. It exists so a config edited by hand can be told apart from
 * one SimQA put there, which is the whole of the rule in handEdits.ts.
 */
const MANIFEST = '.simqa-written.json';

export function readWrittenManifest(suiteName: string, rowName: string): Record<string, string> {
  try {
    const raw = fs.readFileSync(path.join(testCaseDir(suiteName, rowName), MANIFEST), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    // Only string→string survives: a hand-mangled manifest must degrade to
    // "nothing recorded", which is the old overwrite-everything behaviour,
    // rather than throwing in the middle of a save.
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(([, v]) => typeof v === 'string'),
    ) as Record<string, string>;
  } catch {
    return {};
  }
}

export function writeWrittenManifest(suiteName: string, rowName: string, manifest: Record<string, string>): void {
  try {
    const dir = testCaseDir(suiteName, rowName);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `${MANIFEST}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2), 'utf8');
    fs.renameSync(tmp, path.join(dir, MANIFEST));
  } catch { /* losing the manifest costs protection, never a save */ }
}

/** What a test case folder holds right now, for the UI and for verification. */
export function listTestCaseFiles(
  suiteName: string, rowName: string,
): Array<{ name: string; bytes: number; modified: string; linkTo?: string }> {
  const dir = testCaseDir(suiteName, rowName);
  const out: Array<{ name: string; bytes: number; modified: string; linkTo?: string }> = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || (!entry.isFile() && !entry.isSymbolicLink())) continue;
      const full = path.join(dir, entry.name);
      // statSync follows the link, so a role name reports the size of the
      // config it points at rather than the length of the path.
      let st: import('node:fs').Stats;
      try { st = fs.statSync(full); } catch { continue; }   // dangling — not a file this row has
      // Said out loud, because "enb.cfg -> SA-1Cell.cfg_June2026" is the
      // whole answer to which config this row runs.
      let linkTo: string | undefined;
      if (entry.isSymbolicLink()) { try { linkTo = fs.readlinkSync(full); } catch { /* unreadable link */ } }
      out.push({ name: entry.name, bytes: st.size, modified: new Date(st.mtimeMs).toISOString(), ...(linkTo ? { linkTo } : {}) });
    }
  } catch { /* nothing captured yet */ }
  return out;
}

/**
 * Which rows cannot be run from the folder alone, and what each one lacks.
 *
 * The folder is what a run on ANOTHER setup is built from: the test case comes
 * from test.json, and the callbox gets its enb/mme/ims from here under the
 * names the row picked. A row missing one of those can only run where that
 * file already happens to sit on the callbox — which is precisely what moving
 * to a different setup takes away.
 *
 * Only what the row actually asks for is required: a uesim-only row needs no
 * callbox files, and a row with no IMS config is not missing one.
 */
export function rowsMissingServerFiles(
  suiteName: string,
  rows: Array<{
    name: string; callboxCfg?: string; mmeCfg?: string; imsCfg?: string;
    dbCfg?: string; otsCfg?: string;
  }>,
): Array<{ row: string; missing: string[] }> {
  const out: Array<{ row: string; missing: string[] }> = [];
  for (const row of rows) {
    const have = readAllTestCaseFiles(suiteName, row.name);
    const missing: string[] = [];
    if (!have['test.json']) missing.push('test.json');
    if (row.callboxCfg && !have['enb.cfg']) missing.push('enb.cfg');
    if (row.mmeCfg && !have['mme.cfg']) missing.push('mme.cfg');
    if (row.imsCfg && !have['ims.cfg']) missing.push('ims.cfg');
    // ots is kept under the role name like the three above; the subscriber
    // database keeps its own, because that is the name the MME config
    // includes it by and the name it has to exist under on the callbox.
    if (row.otsCfg && !have['ots.cfg']) missing.push('ots.cfg');
    if (row.dbCfg && !have[row.dbCfg]) missing.push(row.dbCfg);
    if (missing.length) out.push({ row: row.name, missing });
  }
  return out;
}

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
// alone opened in vi. This is that place, on the machine QA KA BAAP runs on,
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

/** Every file in a test case folder, by name — what a run puts back. */
export function readAllTestCaseFiles(suiteName: string, rowName: string): Record<string, string> {
  const out: Record<string, string> = {};
  const dir = testCaseDir(suiteName, rowName);
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || entry.name.startsWith('.')) continue;
      try { out[entry.name] = fs.readFileSync(path.join(dir, entry.name), 'utf8'); } catch { /* skip */ }
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

/** What a test case folder holds right now, for the UI and for verification. */
export function listTestCaseFiles(suiteName: string, rowName: string): Array<{ name: string; bytes: number; modified: string }> {
  const dir = testCaseDir(suiteName, rowName);
  const out: Array<{ name: string; bytes: number; modified: string }> = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || entry.name.startsWith('.')) continue;
      const st = fs.statSync(path.join(dir, entry.name));
      out.push({ name: entry.name, bytes: st.size, modified: new Date(st.mtimeMs).toISOString() });
    }
  } catch { /* nothing captured yet */ }
  return out;
}

// configBackup.ts — back up + restore simqa's persisted configuration.
//
// What gets backed up:
//   • inventory.yaml         — systems, suites, topology profiles (the bulk)
//   • .env.local             — port + any other persistent env preferences
//   • data/ui-tests/baselines/*.json  — saved UI-test baselines for diff
//
// What does NOT:
//   • node_modules, .next/   — reinstallable via `npm ci`
//   • data/builds/, data/runs/, data/ui-tests/run-*/  — run history, large + churns
//   • .token, login.json     — auth cache, regenerable
//   • src/, scripts/         — code, comes from git/tarball, not user state
//
// Format: a single JSON document. Text-only files, simple to read, no tar/zip
// dependency. Round-trips losslessly between Linux/macOS/Windows.
//
// Safety properties of restore:
//   1. Strict path whitelist (regex). Anything else in the backup is rejected.
//   2. Every existing target is copied to <path>.bak-<ts> before overwriting.
//   3. inventory.yaml is YAML-parsed BEFORE being written. Malformed bails out
//      entirely (no partial restore that leaves an unparseable config).
//   4. Restore touches ONLY the whitelisted paths. data/builds/, data/runs/,
//      etc. are never overwritten or deleted.
//   5. Defence-in-depth path-traversal guard: every resolved target must be
//      inside ROOT.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as YAML from 'yaml';

const ROOT = process.cwd();

/** Paths included in a fresh backup. Files always; dirs recursively. */
const INCLUDE_FILES = ['inventory.yaml', '.env.local'] as const;
const INCLUDE_DIRS  = ['data/ui-tests/baselines'] as const;

/** Whitelist that restore matches every incoming path against. Anything not
 *  matching is silently rejected (and surfaced in the response so the user
 *  knows what got skipped). Keep this in sync with INCLUDE_FILES / DIRS. */
const RESTORE_WHITELIST = /^(inventory\.yaml|\.env\.local|data\/ui-tests\/baselines\/[A-Za-z0-9_.\-]+\.json)$/;

export interface BackupManifest {
  version: 1;
  createdAt: string;
  hostname: string;
  files: string[];
}

export interface ConfigBackup {
  manifest: BackupManifest;
  /** Map of relative path (POSIX-separated) → utf-8 file content. */
  contents: Record<string, string>;
}

export interface RestoreResult {
  restoredFiles: string[];
  backedUpFiles: string[];
  rejectedFiles: string[];
  errors: string[];
}

// ───────────── Create ─────────────

export function createBackup(): ConfigBackup {
  const contents: Record<string, string> = {};
  const collected: string[] = [];

  for (const rel of INCLUDE_FILES) {
    const p = path.join(ROOT, rel);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) {
      contents[rel] = fs.readFileSync(p, 'utf-8');
      collected.push(rel);
    }
  }

  for (const dir of INCLUDE_DIRS) {
    const fullDir = path.join(ROOT, dir);
    if (!fs.existsSync(fullDir) || !fs.statSync(fullDir).isDirectory()) continue;
    walkDir(fullDir, (full) => {
      const rel = path.relative(ROOT, full).split(path.sep).join('/');
      // Only include text files — refuse to read anything > 5 MB as a
      // defensive sanity check (baselines should be <50 KB each).
      const stat = fs.statSync(full);
      if (stat.size > 5 * 1024 * 1024) return;
      contents[rel] = fs.readFileSync(full, 'utf-8');
      collected.push(rel);
    });
  }

  return {
    manifest: {
      version: 1,
      createdAt: new Date().toISOString(),
      hostname: os.hostname(),
      files: collected,
    },
    contents,
  };
}

/** Suggested filename for the download (includes timestamp). */
export function backupFilename(now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `simqa-backup-${stamp}.json`;
}

// ───────────── Restore ─────────────

export function restoreBackup(raw: unknown): RestoreResult {
  const result: RestoreResult = {
    restoredFiles: [],
    backedUpFiles: [],
    rejectedFiles: [],
    errors: [],
  };

  // 1. Shape validation
  if (!raw || typeof raw !== 'object') {
    result.errors.push('backup is not an object');
    return result;
  }
  const backup = raw as ConfigBackup;
  if (!backup.manifest || backup.manifest.version !== 1) {
    result.errors.push(`unsupported backup version: ${(backup.manifest as any)?.version ?? '(missing)'}`);
    return result;
  }
  if (!backup.contents || typeof backup.contents !== 'object') {
    result.errors.push('backup has no contents object');
    return result;
  }

  // 2. Pre-flight: parse inventory.yaml if present. Refuse to restore at all
  //    if it's malformed — better to bail with the existing file intact than
  //    leave the user with a half-restored, unparseable config.
  if (typeof backup.contents['inventory.yaml'] === 'string') {
    try {
      const parsed = YAML.parse(backup.contents['inventory.yaml']);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed.systems)) {
        result.errors.push('inventory.yaml in backup parses but has no systems[] array');
        return result;
      }
    } catch (e: any) {
      result.errors.push(`inventory.yaml in backup is not valid YAML: ${e?.message ?? e}`);
      return result;
    }
  }

  // 3. Filter to whitelist + path-traversal guard. Build the worklist first
  //    so we don't write anything until validation passes.
  const work: Array<{ rel: string; abs: string; content: string }> = [];
  for (const [rawPath, content] of Object.entries(backup.contents)) {
    if (typeof content !== 'string') {
      result.rejectedFiles.push(`${rawPath} (non-string content)`);
      continue;
    }
    const normalized = path.posix.normalize(rawPath.replace(/\\/g, '/'));
    if (!RESTORE_WHITELIST.test(normalized)) {
      result.rejectedFiles.push(normalized);
      continue;
    }
    const abs = path.resolve(ROOT, normalized);
    const rootAbs = path.resolve(ROOT);
    // After resolution the target MUST live inside ROOT. Defends against
    // crafted absolute paths or `../` escapes that slipped past the regex.
    if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
      result.rejectedFiles.push(`${normalized} (escapes project root)`);
      continue;
    }
    work.push({ rel: normalized, abs, content });
  }

  if (work.length === 0) {
    result.errors.push('no matching files to restore (after whitelist + validation)');
    return result;
  }

  // 4. Apply: for each entry, copy existing to .bak-<ts>, then write.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  for (const { rel, abs, content } of work) {
    try {
      if (fs.existsSync(abs)) {
        const bak = `${abs}.bak-${stamp}`;
        fs.copyFileSync(abs, bak);
        result.backedUpFiles.push(path.relative(ROOT, bak).split(path.sep).join('/'));
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, 'utf-8');
      result.restoredFiles.push(rel);
    } catch (e: any) {
      result.errors.push(`${rel}: ${e?.message ?? e}`);
    }
  }

  return result;
}

// ───────────── Internals ─────────────

function walkDir(dir: string, fn: (file: string) => void): void {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    let stat: fs.Stats;
    try { stat = fs.statSync(full); } catch { continue; }
    if (stat.isDirectory()) walkDir(full, fn);
    else if (stat.isFile()) fn(full);
  }
}

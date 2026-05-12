// Version discovery — server-only. Cached for the lifetime of the Node
// process. Discovery order:
//
//   1. SIMQA_VERSION env var — explicit override.
//   2. SIMQA_VERSION.txt at project root — written by release.cjs at
//      tarball-pack time. Survives renames of the qakabaap-<sha>/ dir.
//   3. process.cwd() basename — matches qakabaap-<YYYYMMDD>-<sha> pattern
//      when the user runs the unrenamed extracted tarball.
//   4. `git rev-parse --short HEAD` — works in a git checkout (dev).
//   5. "dev (unknown)" fallback.
//
// Why so many fallbacks: the version string drives the "am I on the latest
// tarball?" diagnostic in the UI. Every install path needs to surface
// something useful, including:
//   • the tarball install (basename or SIMQA_VERSION.txt),
//   • a `git clone` checkout (git rev-parse),
//   • a docker/k8s deployment where cwd is /app (env var or version.txt).

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

export interface SimqaVersion {
  /** Composite version like "20260512-d391445". */
  version: string;
  /** ISO timestamp built/released (when available). */
  builtAt?: string;
  /** Short git sha (or 'unknown'). */
  sha: string;
  /** Date stamp (or 'unknown'). */
  date: string;
  /** Discovery method used (for diagnostic). */
  source: 'env' | 'version-file' | 'cwd' | 'git' | 'fallback';
}

let cached: SimqaVersion | undefined;

const ROOT = process.cwd();
const VERSION_TXT = path.join(ROOT, 'SIMQA_VERSION.txt');
const VERSION_RE = /^(qakabaap-)?(\d{8})-([a-f0-9]{7,40})$/i;

export function getSimqaVersion(): SimqaVersion {
  if (cached) return cached;

  // 1. Env override.
  const envV = process.env.SIMQA_VERSION?.trim();
  if (envV) {
    cached = parseFromString(envV, 'env');
    return cached;
  }

  // 2. SIMQA_VERSION.txt at project root.
  try {
    if (fs.existsSync(VERSION_TXT)) {
      const raw = fs.readFileSync(VERSION_TXT, 'utf-8').trim();
      // The file can be either "20260512-d391445" or JSON with more detail.
      if (raw.startsWith('{')) {
        const j = JSON.parse(raw) as Partial<SimqaVersion>;
        cached = {
          version: j.version ?? `${j.date ?? 'unknown'}-${j.sha ?? 'unknown'}`,
          builtAt: j.builtAt,
          sha:     j.sha ?? 'unknown',
          date:    j.date ?? 'unknown',
          source:  'version-file',
        };
        return cached;
      }
      cached = parseFromString(raw, 'version-file');
      return cached;
    }
  } catch { /* fall through */ }

  // 3. cwd basename — matches qakabaap-<date>-<sha>.
  const cwdBase = path.basename(ROOT);
  const m = cwdBase.match(VERSION_RE);
  if (m) {
    cached = { version: `${m[2]}-${m[3]}`, date: m[2], sha: m[3], source: 'cwd' };
    return cached;
  }

  // 4. git rev-parse — for dev checkouts.
  try {
    const sha = execSync('git rev-parse --short HEAD', { cwd: ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (sha) {
      const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      cached = { version: `${date}-${sha} (git)`, date, sha, source: 'git' };
      return cached;
    }
  } catch { /* fall through */ }

  // 5. Last resort.
  cached = { version: 'dev', date: 'unknown', sha: 'unknown', source: 'fallback' };
  return cached;
}

function parseFromString(s: string, source: SimqaVersion['source']): SimqaVersion {
  const m = s.match(VERSION_RE);
  if (m) return { version: `${m[2]}-${m[3]}`, date: m[2], sha: m[3], source };
  return { version: s, date: 'unknown', sha: 'unknown', source };
}

// Where the API document and the run reports live.
//
// Two locations on purpose:
//   • the document shipped with SimQA, under assets/, which a deploy replaces;
//   • everything the operator changes at run time, under data/, which the
//     installer excludes from its rsync so uploads, rollbacks and reports
//     survive every deploy.
//
// An uploaded document therefore wins over the bundled one until it is rolled
// back, and upgrading SimQA never silently swaps the document a lab is testing
// against.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Spec } from './spec.ts';

const DATA_ROOT = process.env.SIMQA_API_VALIDATION_DIR
  ?? path.join(process.cwd(), 'data', 'api-validation');
const BUNDLED = path.join(process.cwd(), 'assets', 'api-validation', 'openapi.yaml');

export const ACTIVE = path.join(DATA_ROOT, 'openapi.yaml');
export const HISTORY_DIR = path.join(DATA_ROOT, 'specs');
export const REPORTS_DIR = path.join(DATA_ROOT, 'reports');
export const SAVED_NAME = /^openapi-\d{8}-\d{6}\.yaml$/;

export function ensureDirs(): void {
  for (const d of [DATA_ROOT, HISTORY_DIR, REPORTS_DIR]) fs.mkdirSync(d, { recursive: true });
}

/** The document in force: an uploaded one if there is one, else the bundled. */
export function activeSpecPath(): string {
  return fs.existsSync(ACTIVE) ? ACTIVE : BUNDLED;
}

export function readActiveText(): string {
  return fs.readFileSync(activeSpecPath(), 'utf8');
}

let cached: { fingerprint: string; spec: Spec } | null = null;

/** The parsed document, re-read when the file changes. Parsing 588 KB of
 *  YAML takes about half a second, which is too long to repeat per request. */
export function activeSpec(): Spec {
  const text = readActiveText();
  const spec = cached && cached.fingerprint === fingerprintOf(text) ? cached.spec : new Spec(text);
  cached = { fingerprint: spec.fingerprint, spec };
  return spec;
}

export function invalidateSpec(): void {
  cached = null;
}

function fingerprintOf(text: string): string {
  // Cheap equality check; Spec computes the real sha256 fingerprint itself.
  let h = 0;
  for (let i = 0; i < text.length; i += 997) h = (h * 31 + text.charCodeAt(i)) | 0;
  return `${text.length}:${h}`;
}

// ---------------------------------------------------------------- reports --

export function runDir(runId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error('bad run id');
  return path.join(REPORTS_DIR, runId);
}

export interface SavedRunSummary {
  id: string;
  started?: string;
  finished?: string;
  host?: string;
  runAs?: string;
  user?: string;
  suite?: boolean;
  total?: number;
  counts?: Record<string, number>;
  passRate?: number;
}

/** Recent runs, newest first, read from the results.json each one wrote. */
export function listRuns(limit = 50): SavedRunSummary[] {
  ensureDirs();
  let names: string[];
  try {
    names = fs.readdirSync(REPORTS_DIR).filter(n => fs.existsSync(path.join(REPORTS_DIR, n, 'results.json')));
  } catch {
    return [];
  }
  names.sort().reverse();
  const out: SavedRunSummary[] = [];
  for (const id of names.slice(0, limit)) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, id, 'results.json'), 'utf8'));
      out.push({
        id,
        started: data.meta?.started,
        finished: data.meta?.finished,
        host: data.meta?.host,
        runAs: data.meta?.run_as,
        user: data.meta?.user,
        suite: !!data.meta?.suite,
        total: data.summary?.total,
        counts: data.summary?.counts,
        passRate: data.summary?.pass_rate,
      });
    } catch { /* a half-written run is simply not listed */ }
  }
  return out;
}

export function readRunFile(runId: string, file: 'results.json' | 'report.html'): string | null {
  try {
    const p = path.join(runDir(runId), file);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  } catch {
    return null;
  }
}

// File-backed store for per-suite run history.
//
// Layout: data/automation-runs/<runId>.json
//   plus an index file data/automation-runs/_index.json that maps
//   suiteId → [runId]. The split keeps "list runs for suite X" O(small)
//   and "load one run" O(1) without scanning the whole tree.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SuiteRunResult } from './runner';

const ROOT = () => path.join(process.cwd(), 'data', 'automation-runs');
const INDEX = () => path.join(ROOT(), '_index.json');

export interface RunRecord extends SuiteRunResult {
  /** Server-assigned ULID-style id (timestamp-prefixed for sort-by-time). */
  runId: string;
  /** Who submitted this job. Attribution only — see src/lib/identity.ts.
   *  Absent for runs triggered outside a browser session (cron, curl, the
   *  scratchpad runner), which is honest rather than guessed. */
  submittedBy?: string;
  /** Captured at run start from /v2/version on the box, if reachable. */
  buildVersion?: string;
  /** Optional perf-qa job id + host so the run record points at the
   *  diagnostic bundle that perf-qa stashed. */
  diagnostics?: {
    perfQaUrl: string;
    jobId: string;
    triggeredAt: string;
    /** Soft note — populated when the perf-qa job has finished and we
     *  know the bundle filename. */
    bundle?: string;
  };
}

interface IndexShape { bySuite: Record<string, string[]> }

function readIndex(): IndexShape {
  try {
    const j = JSON.parse(fs.readFileSync(INDEX(), 'utf8'));
    if (j && typeof j === 'object' && j.bySuite) return j as IndexShape;
  } catch { /* file missing */ }
  return { bySuite: {} };
}

function writeIndex(idx: IndexShape): void {
  fs.mkdirSync(ROOT(), { recursive: true });
  fs.writeFileSync(INDEX(), JSON.stringify(idx, null, 2));
}

export function newRunId(): string {
  // Sortable by time + a short random tail so concurrent runs don't collide.
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 8);
  return `run-${stamp}-${rand}`;
}

export function saveRun(rec: RunRecord): string {
  fs.mkdirSync(ROOT(), { recursive: true });
  fs.writeFileSync(path.join(ROOT(), `${rec.runId}.json`), JSON.stringify(rec, null, 2));
  const idx = readIndex();
  const arr = idx.bySuite[rec.suiteId] ?? [];
  if (!arr.includes(rec.runId)) arr.unshift(rec.runId);     // newest first
  idx.bySuite[rec.suiteId] = arr;
  writeIndex(idx);
  return rec.runId;
}

export function getRun(runId: string): RunRecord | null {
  try {
    const text = fs.readFileSync(path.join(ROOT(), `${runId}.json`), 'utf8');
    return JSON.parse(text) as RunRecord;
  } catch { return null; }
}

export function listRunsForSuite(suiteId: string): RunRecord[] {
  const idx = readIndex();
  const ids = idx.bySuite[suiteId] ?? [];
  const out: RunRecord[] = [];
  for (const id of ids) {
    const r = getRun(id);
    if (r) out.push(r);
  }
  return out;
}

/** Soft delete — removes from index + the .json file. Used by the
 *  /api/automation/suites/[id] DELETE so a suite's history doesn't
 *  leak after its parent is gone. */
export function deleteRunsForSuite(suiteId: string): number {
  const idx = readIndex();
  const ids = idx.bySuite[suiteId] ?? [];
  let removed = 0;
  for (const id of ids) {
    try { fs.unlinkSync(path.join(ROOT(), `${id}.json`)); removed += 1; } catch { /* missing */ }
  }
  delete idx.bySuite[suiteId];
  writeIndex(idx);
  return removed;
}

/** Patch a single field on an existing run (used when the perf-qa
 *  bundle name lands later). No-op if the run isn't found. */
export function patchRun(runId: string, patch: Partial<RunRecord>): boolean {
  const r = getRun(runId);
  if (!r) return false;
  const merged = { ...r, ...patch };
  fs.writeFileSync(path.join(ROOT(), `${runId}.json`), JSON.stringify(merged, null, 2));
  return true;
}

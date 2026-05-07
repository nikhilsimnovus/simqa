// Run records persisted under data/runs/<runId>.json (summary) plus
// data/runs/<runId>/<file> (per-run evidence — generated cfgs, summary,
// execution metadata).

import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';

const RUNS_DIR = path.join(process.cwd(), 'data', 'runs');

export interface RunStep {
  name: string;
  ok: boolean;
  detail?: string;
  ms?: number;
}

export type RunStatus = 'queued' | 'running' | 'passed' | 'failed' | 'cancelled';

export interface RunRecord {
  id: string;
  testcaseId: string;
  topology?: string;            // profile id
  startedAt: string;
  finishedAt?: string;
  status: RunStatus;
  /** Phases: preflight / generate / deploy / trigger / poll / collect / teardown */
  steps: RunStep[];
  /** Summary returned by the cfg generator - RAT, cells, ueCount, notes, etc. */
  generatorSummary?: unknown;
  /** Files written under the run dir (relative names). */
  evidenceFiles?: string[];
  /** True if the run was a dry-run (no SSH push, no execution trigger). */
  dryRun?: boolean;
  /** Set when this run is part of an automation suite batch. Lets the UI group them. */
  batchId?: string;
  /** Suite id this run was spawned from (when applicable). */
  suiteId?: string;
  /** Snapshot of the box's reported software version at run time (for diffing across runs). */
  boxVersion?: { version?: string; build?: string };
  /** Verification report produced after the run reached a terminal state. */
  verification?: import('./verification').VerificationReport;
}

export function newBatchId(): string {
  return 'batch-' + newRunId();
}

export function listRunsInBatch(batchId: string): RunRecord[] {
  return listRuns(1000).filter((r) => r.batchId === batchId);
}

export function newRunId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const ts =
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  return `${ts}-${randomBytes(3).toString('hex')}`;
}

function ensureDirs(): void {
  fs.mkdirSync(RUNS_DIR, { recursive: true });
}

function safeSegment(s: string): string {
  return s.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
}

export function runDir(runId: string): string {
  return path.join(RUNS_DIR, safeSegment(runId));
}

export function runJsonPath(runId: string): string {
  return path.join(RUNS_DIR, `${safeSegment(runId)}.json`);
}

export function saveRun(run: RunRecord): void {
  ensureDirs();
  const tmp = runJsonPath(run.id) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(run, null, 2), 'utf8');
  fs.renameSync(tmp, runJsonPath(run.id));
}

export function loadRun(runId: string): RunRecord | null {
  try {
    return JSON.parse(fs.readFileSync(runJsonPath(runId), 'utf8')) as RunRecord;
  } catch (e: any) {
    if (e?.code === 'ENOENT') return null;
    throw e;
  }
}

export function listRuns(limit = 100): RunRecord[] {
  ensureDirs();
  const files = fs.readdirSync(RUNS_DIR).filter((f) => f.endsWith('.json'));
  const stat = files.map((f) => ({ f, mtime: fs.statSync(path.join(RUNS_DIR, f)).mtimeMs }));
  stat.sort((a, b) => b.mtime - a.mtime);
  const top = stat.slice(0, limit);
  const out: RunRecord[] = [];
  for (const { f } of top) {
    try { out.push(JSON.parse(fs.readFileSync(path.join(RUNS_DIR, f), 'utf8')) as RunRecord); }
    catch { /* skip malformed */ }
  }
  return out;
}

export function ensureRunDir(runId: string): string {
  const d = runDir(runId);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function writeRunFile(runId: string, name: string, content: string | Buffer): string {
  const d = ensureRunDir(runId);
  const dest = path.join(d, name);
  fs.writeFileSync(dest, content);
  return dest;
}

export function readRunFile(runId: string, name: string): string | null {
  const p = path.join(runDir(runId), name);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

export function listRunFiles(runId: string): string[] {
  const d = runDir(runId);
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d);
}

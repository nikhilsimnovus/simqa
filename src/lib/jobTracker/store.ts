// Job persistence.
//
// One directory per job under data/jobs/<JOB-nnn>/:
//   job.json    the record (rewritten on every update)
//   log.ndjson  append-only log lines from every phase
//
// Modelled on runStore: jobs outlive the request that made them (a build
// install runs for minutes and the user may navigate away), so nothing lives in
// memory only.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Job, JobLogEntry, JobStatus, JobStepName, JobStepState } from './types';
import { emptySteps } from './types';

const ROOT = () => path.join(process.cwd(), 'data', 'jobs');
const jobDir = (key: string) => path.join(ROOT(), key);

function ensureRoot(): void {
  fs.mkdirSync(ROOT(), { recursive: true });
}

/**
 * Next display id. Scans existing directories and takes max+1 rather than
 * keeping a counter file — a counter can drift out of sync with what is
 * actually on disk, and this cannot produce an id that already exists.
 *
 * Not safe against two truly simultaneous creates; createJob re-checks and
 * bumps if the directory it picked already exists.
 */
function nextId(): { id: string; key: string } {
  ensureRoot();
  let max = 0;
  for (const name of fs.readdirSync(ROOT(), { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    const m = /^JOB-(\d+)$/.exec(name.name);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  let n = max + 1;
  // Belt and braces: never hand back a key whose directory exists.
  while (fs.existsSync(jobDir(`JOB-${String(n).padStart(3, '0')}`))) n += 1;
  const id = `JOB-${String(n).padStart(3, '0')}`;
  return { id, key: id };
}

export interface CreateJobInput {
  user?: string;
  setupHost: string;
  setupSystemId?: string;
  setupName?: string;
  buildUrl: string;
  buildName?: string;
  /** Run against the build already on the station instead of installing one.
   *  The build step is marked complete-by-skip so the rest of the workflow
   *  unlocks, but it is never reported as a successful installation. */
  skipBuild?: boolean;
}

export function createJob(input: CreateJobInput): Job {
  const { id, key } = nextId();
  const now = new Date().toISOString();
  const job: Job = {
    id,
    key,
    status: 'pending',
    user: input.user,
    setupHost: input.setupHost,
    setupSystemId: input.setupSystemId,
    setupName: input.setupName,
    build: {
      buildUrl: input.buildUrl,
      buildName: input.buildName,
      skipped: input.skipBuild || undefined,
    },
    testcases: [],
    steps: emptySteps(),
    createdAt: now,
  };
  if (input.skipBuild) {
    job.steps.build = {
      status: 'ok',
      startedAt: now,
      finishedAt: now,
      detail: 'Skipped — using the build already installed on this station',
    };
  }
  fs.mkdirSync(jobDir(key), { recursive: true });
  saveJob(job);
  return job;
}

export function saveJob(job: Job): void {
  try {
    fs.mkdirSync(jobDir(job.key), { recursive: true });
    // temp + rename so a crash mid-write cannot truncate the record.
    const tmp = path.join(jobDir(job.key), 'job.json.tmp');
    fs.writeFileSync(tmp, JSON.stringify(job, null, 2));
    fs.renameSync(tmp, path.join(jobDir(job.key), 'job.json'));
  } catch {
    // Never let bookkeeping take down a running install.
  }
}

export function getJob(key: string): Job | undefined {
  // Guard against a key escaping the jobs directory.
  if (!/^[A-Za-z0-9_-]+$/.test(key)) return undefined;
  try {
    const raw = fs.readFileSync(path.join(jobDir(key), 'job.json'), 'utf8');
    return JSON.parse(raw) as Job;
  } catch {
    return undefined;
  }
}

/** Newest first. */
/** Jobs for the Job Tracker.
 *
 *  SUBMITTED jobs only. The Job Tracker means "jobs that were actually
 *  submitted" — a row for something still being configured (or a wizard someone
 *  abandoned) makes the list useless for the question it exists to answer.
 *  Filtering here rather than in the page means every reader gets the same
 *  guarantee, including any caller that creates a job by another route.
 *
 *  Older records predate `submittedAt`; those with a terminal or running status
 *  plainly did run, so they are kept rather than disappearing from history. */
export function listJobs(limit = 200, opts: { includeDrafts?: boolean } = {}): Job[] {
  ensureRoot();
  const out: Job[] = [];
  for (const e of fs.readdirSync(ROOT(), { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const j = getJob(e.name);
    if (!j) continue;
    if (!opts.includeDrafts) {
      const ranAnyway = j.status !== 'pending' && j.status !== 'ready';
      if (!j.submittedAt && !ranAnyway) continue;
    }
    out.push(j);
  }
  return out
    .sort((a, b) => String(b.submittedAt ?? b.createdAt).localeCompare(String(a.submittedAt ?? a.createdAt)))
    .slice(0, limit);
}

/** Read-modify-write helper so callers never race on a stale copy. */
export function updateJob(key: string, fn: (j: Job) => void): Job | undefined {
  const job = getJob(key);
  if (!job) return undefined;
  fn(job);
  saveJob(job);
  return job;
}

export function setStatus(key: string, status: JobStatus): Job | undefined {
  return updateJob(key, (j) => { j.status = status; });
}

export function setStep(key: string, step: JobStepName, state: Partial<JobStepState>): Job | undefined {
  return updateJob(key, (j) => {
    j.steps[step] = { ...j.steps[step], ...state };
  });
}

// ── Logs ───────────────────────────────────────────────────────────────────

const logPath = (key: string) => path.join(jobDir(key), 'log.ndjson');

export function appendLog(key: string, entry: Omit<JobLogEntry, 'ts'> & { ts?: number }): void {
  try {
    fs.mkdirSync(jobDir(key), { recursive: true });
    const e: JobLogEntry = { ts: entry.ts ?? Date.now(), phase: entry.phase, level: entry.level, line: entry.line };
    fs.appendFileSync(logPath(key), JSON.stringify(e) + '\n');
  } catch {
    // Logging must never break the thing being logged.
  }
}

export function appendLogs(key: string, entries: Array<Omit<JobLogEntry, 'ts'> & { ts?: number }>): void {
  if (!entries.length) return;
  try {
    fs.mkdirSync(jobDir(key), { recursive: true });
    const body = entries
      .map((e) => JSON.stringify({ ts: e.ts ?? Date.now(), phase: e.phase, level: e.level, line: e.line }))
      .join('\n') + '\n';
    fs.appendFileSync(logPath(key), body);
  } catch { /* ignore */ }
}

/**
 * Read a job's log. `tail` caps how many lines come back — a 30-minute install
 * can produce tens of thousands, and shipping all of them to the browser would
 * make the log view unusable.
 */
export function readLog(key: string, tail = 5000): { entries: JobLogEntry[]; total: number; truncated: boolean } {
  if (!/^[A-Za-z0-9_-]+$/.test(key)) return { entries: [], total: 0, truncated: false };
  let lines: string[] = [];
  try {
    lines = fs.readFileSync(logPath(key), 'utf8').split('\n').filter(Boolean);
  } catch {
    return { entries: [], total: 0, truncated: false };
  }
  const total = lines.length;
  const slice = tail > 0 && total > tail ? lines.slice(total - tail) : lines;
  const entries: JobLogEntry[] = [];
  for (const l of slice) {
    try { entries.push(JSON.parse(l)); } catch { /* skip a torn line */ }
  }
  return { entries, total, truncated: slice.length < total };
}

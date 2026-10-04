// Live progress for an in-flight suite run.
//
// A suite run is one long synchronous POST (a 4-row suite takes ~20 minutes),
// so the client cannot learn anything from the response until it is over. The
// runner reports as it goes; this module holds that report so a cheap GET can
// serve it to the page.
//
// Two things this has to survive, because both were losing runs:
//
//   * MODULE RE-EVALUATION. State used to live in a module-level Map. A dev
//     recompile — or any second instance of this module — gave the /run route
//     and the /progress route a Map each: the run kept reporting into one while
//     the page polled the other and was told nothing was running. Refreshing
//     mid-run then showed an idle Run Suite button and an empty Status column.
//     So state lives on globalThis, like stationMonitor's poller.
//
//   * A SERVER RESTART. A deploy or a crash takes the run with it, and an
//     in-memory record simply vanishes — the page goes quiet and never says the
//     run died. Progress is therefore also written to disk, stamped with the id
//     of the process that wrote it. A record from an older process is reported
//     as INTERRUPTED rather than running: the run is not coming back, and
//     saying so is the whole point.
//
// A finished run still belongs in the run store; this is only the live view.

import * as fs from 'node:fs';
import * as path from 'node:path';

export type ItemStatus = 'running' | 'passed' | 'failed' | 'skipped' | 'pending';

export interface SuiteProgress {
  suiteId: string;
  suiteName: string;
  startedAt: string;
  /** Rows finished so far. */
  done: number;
  total: number;
  /** Display name of the row currently executing, if any. */
  current?: string;
  /** Per-row outcome, keyed by the row's display name. Rows absent from this
   *  map have not been reached yet. */
  statuses: Record<string, ItemStatus>;
  /** The box's own words for rows that have finished — its execution status
   *  and verdict, keyed by row name. Carried live so a row reads the same
   *  while the run is in flight as it will once the run is saved: without it
   *  a finished-and-failed row showed 'Not Executed · Error' until a reload,
   *  because SimQA's ok was all the live view had. */
  boxes?: Record<string, { status?: string; verdict?: string; stopped?: boolean }>;
  finished?: boolean;
  /** Set when the process that was running this is gone — a deploy or a crash
   *  ended it. The run did not finish and nothing was saved for it. */
  interrupted?: boolean;
  /** Which process reported this. Not shown; used to spot the above. */
  bootId?: string;
}

const FILE = () => path.join(process.cwd(), 'data', 'automation-progress.json');

interface Store {
  live: Map<string, SuiteProgress>;
  aborters: Map<string, AbortController>;
  bootId: string;
}

/** One store per PROCESS, not per module copy — see the header. */
function store(): Store {
  const g = globalThis as any;
  if (!g.__simqaSuiteProgress__) {
    g.__simqaSuiteProgress__ = {
      live: new Map<string, SuiteProgress>(),
      aborters: new Map<string, AbortController>(),
      // Random per process start: what tells a record left by a run this
      // process is still driving from one left by a process that is gone.
      bootId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    } satisfies Store;
  }
  return g.__simqaSuiteProgress__ as Store;
}

/** Everything on disk, keyed by suite id. Absent or unreadable reads as empty:
 *  progress is a convenience, never a reason to fail a request. */
function readFile(): Record<string, SuiteProgress> {
  try {
    const j = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

function writeFile(all: Record<string, SuiteProgress>): void {
  try {
    fs.mkdirSync(path.dirname(FILE()), { recursive: true });
    fs.writeFileSync(FILE(), JSON.stringify(all, null, 2), 'utf8');
  } catch { /* read-only data dir: the in-memory view still works */ }
}

/** Keep one suite's record on disk, so any module copy — and the next process
 *  — sees the same thing the runner is reporting. */
function persist(p: SuiteProgress | null, suiteId: string): void {
  const all = readFile();
  if (p) all[suiteId] = p; else delete all[suiteId];
  // Records from processes that are gone are cleared as we pass by, so the
  // file cannot grow forever with runs nobody will ever ask about again.
  for (const [id, entry] of Object.entries(all)) {
    if (id !== suiteId && entry?.finished) delete all[id];
  }
  writeFile(all);
}

export function startProgress(
  suiteId: string, suiteName: string, total: number, itemNames: string[],
  abort?: AbortController,
): void {
  const s = store();
  const statuses: Record<string, ItemStatus> = {};
  for (const n of itemNames) statuses[n] = 'pending';
  const p: SuiteProgress = {
    suiteId, suiteName, total, done: 0,
    startedAt: new Date().toISOString(),
    statuses,
    bootId: s.bootId,
  };
  s.live.set(suiteId, p);
  persist(p, suiteId);
  if (abort) s.aborters.set(suiteId, abort);
}

/** Ask an in-flight run to stop after the current row. Returns false when
 *  nothing is running for that suite. */
export function abortRun(suiteId: string): boolean {
  const s = store();
  const a = s.aborters.get(suiteId);
  if (!a) return false;
  a.abort();
  const p = s.live.get(suiteId);
  if (p) { p.current = undefined; persist(p, suiteId); }
  return true;
}

export function markRunning(suiteId: string, done: number, current?: string): void {
  const s = store();
  const p = s.live.get(suiteId);
  if (!p) return;
  p.done = done;
  p.current = current;
  if (current) p.statuses[current] = 'running';
  persist(p, suiteId);
}

export function markStep(
  suiteId: string,
  name: string,
  ok: boolean,
  box?: { status?: string; verdict?: string; stopped?: boolean },
): void {
  const s = store();
  const p = s.live.get(suiteId);
  if (!p) return;
  p.statuses[name] = ok ? 'passed' : 'failed';
  // Only when the box actually said something. An empty object would claim a
  // status the Simnovator never gave.
  if (box && (box.status || box.verdict || box.stopped)) {
    p.boxes = { ...(p.boxes ?? {}), [name]: box };
  }
  persist(p, suiteId);
}

/** Mark the run over. Rows never reached are 'skipped' — with stopOnFail a
 *  failure ends the run, and "skipped" says that more honestly than "pending". */
export function finishProgress(suiteId: string): void {
  const s = store();
  s.aborters.delete(suiteId);
  const p = s.live.get(suiteId);
  if (!p) { persist(null, suiteId); return; }
  p.finished = true;
  p.current = undefined;
  for (const k of Object.keys(p.statuses)) {
    if (p.statuses[k] === 'pending' || p.statuses[k] === 'running') p.statuses[k] = 'skipped';
  }
  persist(p, suiteId);
  // Keep it briefly so the last poll can render the final state, then drop it.
  setTimeout(() => { s.live.delete(suiteId); persist(null, suiteId); }, 60_000).unref?.();
}

export function getProgress(suiteId: string): SuiteProgress | null {
  const s = store();
  const mem = s.live.get(suiteId);
  if (mem) return mem;

  // Not in this process's memory. Either another copy of this module holds it,
  // or the process that did is gone — the record on disk says which.
  const saved = readFile()[suiteId];
  if (!saved) return null;
  if (saved.bootId && saved.bootId !== s.bootId && !saved.finished) {
    return {
      ...saved,
      finished: true,
      interrupted: true,
      current: undefined,
      statuses: Object.fromEntries(Object.entries(saved.statuses ?? {}).map(
        ([k, v]) => [k, v === 'running' || v === 'pending' ? 'skipped' : v])) as Record<string, ItemStatus>,
    };
  }
  return saved;
}

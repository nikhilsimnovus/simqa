// Live progress for an in-flight suite run.
//
// A suite run is one long synchronous POST (a 4-row suite takes ~20 minutes),
// so the client cannot learn anything from the response until it is over. The
// runner reports as it goes; this module holds that report in memory so a cheap
// GET can serve it to the page.
//
// In-memory on purpose: progress is only meaningful while the process that owns
// the run is alive. A finished run belongs in the run store, not here.

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
  finished?: boolean;
}

const live = new Map<string, SuiteProgress>();
/** Abort handle for each in-flight run, so a Stop request can end the suite
 *  rather than only the testcase the box happens to be executing. */
const aborters = new Map<string, AbortController>();

export function startProgress(
  suiteId: string, suiteName: string, total: number, itemNames: string[],
  abort?: AbortController,
): void {
  const statuses: Record<string, ItemStatus> = {};
  for (const n of itemNames) statuses[n] = 'pending';
  live.set(suiteId, {
    suiteId, suiteName, total, done: 0,
    startedAt: new Date().toISOString(),
    statuses,
  });
  if (abort) aborters.set(suiteId, abort);
}

/** Ask an in-flight run to stop after the current row. Returns false when
 *  nothing is running for that suite. */
export function abortRun(suiteId: string): boolean {
  const a = aborters.get(suiteId);
  if (!a) return false;
  a.abort();
  const p = live.get(suiteId);
  if (p) p.current = undefined;
  return true;
}

export function markRunning(suiteId: string, done: number, current?: string): void {
  const p = live.get(suiteId);
  if (!p) return;
  p.done = done;
  p.current = current;
  if (current) p.statuses[current] = 'running';
}

export function markStep(suiteId: string, name: string, ok: boolean): void {
  const p = live.get(suiteId);
  if (!p) return;
  p.statuses[name] = ok ? 'passed' : 'failed';
}

/** Mark the run over. Rows never reached are 'skipped' — with stopOnFail a
 *  failure ends the run, and "skipped" says that more honestly than "pending". */
export function finishProgress(suiteId: string): void {
  aborters.delete(suiteId);
  const p = live.get(suiteId);
  if (!p) return;
  p.finished = true;
  p.current = undefined;
  for (const k of Object.keys(p.statuses)) {
    if (p.statuses[k] === 'pending' || p.statuses[k] === 'running') p.statuses[k] = 'skipped';
  }
  // Keep it briefly so the last poll can render the final state, then drop it.
  setTimeout(() => live.delete(suiteId), 60_000).unref?.();
}

export function getProgress(suiteId: string): SuiteProgress | null {
  return live.get(suiteId) ?? null;
}

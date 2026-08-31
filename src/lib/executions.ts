// Which testcase, if any, a box is currently executing.
//
// The box enforces a system-wide execution mutex: one testcase at a time per
// simulator. A simulator reports availability=BUSY while a run is in flight,
// and its per-simulator status carries the execution id — which is both how we
// warn "already running" before triggering and how we find what to stop.

import { listSimulators, getSimulatorStatus, getTestcase, type ApiOpts } from './uesimClient';

export interface BusyExecution {
  simulatorId: string;
  simulatorName?: string;
  executionId?: string;
  testCaseId?: string;
  /** Human name of the running testcase — the box only reports its id. */
  testCaseName?: string;
  /** When the simulator last changed state. The box exposes no start time for
   *  an in-flight execution, so this is the closest stand-in. */
  lastUpdated?: string;
}

/** The first simulator reporting BUSY, with the execution it is running. */
export async function findBusy(opts: ApiOpts): Promise<BusyExecution | null> {
  const sims = await listSimulators(opts);
  for (const s of sims.items ?? []) {
    // The list response is enough to spot BUSY, but currentExecutionId only
    // comes back from the per-simulator status call.
    if (String(s.availability ?? '').toUpperCase() !== 'BUSY') continue;
    let st: any = {};
    try { st = await getSimulatorStatus(opts, s.id); } catch { /* fall back to list data */ }
    // Resolve the name: the status payload carries only an id, and a UUID is
    // useless in a message telling someone which test to wait for.
    let testCaseName: string | undefined;
    if (st?.testCaseId) {
      try { testCaseName = (await getTestcase(opts, st.testCaseId))?.name; } catch { /* id-only fallback */ }
    }
    return {
      simulatorId: String(s.id),
      simulatorName: s.name,
      executionId: st?.currentExecutionId,
      testCaseId: st?.testCaseId,
      testCaseName,
      lastUpdated: st?.lastUpdated,
    };
  }
  return null;
}

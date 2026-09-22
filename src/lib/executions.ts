// Which testcase, if any, is running on the simulator a given login owns.
//
// The box hosts several UE simulators and assigns each operator one of them
// (see simulatorScope.ts). Three people therefore execute three different
// testcases at the same time on one Simnovator — so "is the box busy?" is the
// wrong question, and answering it box-wide is what refused user B a start
// because user A was running.
//
// The scope follows the credentials: an operator token only ever sees its own
// simulator, and an admin token is narrowed by assignment.

import { listSimulators, getSimulatorStatus, getTestcase, type ApiOpts } from './uesimClient';
import { pickUserSimulator, isBusy, type ScopedSimulator } from './simulatorScope';

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
  /** False when the blocker is on someone else's simulator — only reported by
   *  findBusyAnywhere(), never by the guard in front of a trigger. */
  mine?: boolean;
}

/**
 * The simulator these credentials execute on, or null when the box cannot tell
 * us (no assignment, or an admin token assigned to several with no default).
 *
 * Callers pass the id to the box on every trigger: builds since 4.0.0_260609
 * reject a start without one ("No default simulator found").
 */
export async function resolveUserSimulator(opts: ApiOpts): Promise<ScopedSimulator | null> {
  const sims = await listSimulators(opts);
  return pickUserSimulator((sims.items ?? []) as any, opts.username);
}

/** Fill in the execution behind a BUSY simulator — the list response says only
 *  that it is busy; the id and testcase come from the per-simulator status. */
async function describe(opts: ApiOpts, sim: { id: string | number; name?: string; lastUpdated?: string }): Promise<BusyExecution> {
  let st: any = {};
  try { st = await getSimulatorStatus(opts, String(sim.id)); } catch { /* fall back to list data */ }
  // Resolve the name: the status payload carries only an id, and a UUID is
  // useless in a message telling someone which test to wait for.
  let testCaseName: string | undefined;
  if (st?.testCaseId) {
    try { testCaseName = (await getTestcase(opts, st.testCaseId))?.name; } catch { /* id-only fallback */ }
  }
  return {
    simulatorId: String(sim.id),
    simulatorName: sim.name,
    executionId: st?.currentExecutionId,
    testCaseId: st?.testCaseId,
    testCaseName,
    lastUpdated: st?.lastUpdated ?? (sim as any).lastUpdated,
  };
}

/**
 * What THIS login's simulator is running, or null if it is free.
 *
 * Deliberately not box-wide: another operator's execution is not a reason to
 * refuse this one. When the simulator cannot be resolved the old behaviour
 * stands — scan everything the token can see — because on a single-simulator
 * box that is the same answer, and on an unrecognised build a false "busy"
 * beats triggering blind into a run already in flight.
 */
export async function findBusy(opts: ApiOpts): Promise<BusyExecution | null> {
  const sims = await listSimulators(opts);
  const items = (sims.items ?? []) as any[];
  const mine = pickUserSimulator(items, opts.username);

  if (mine) {
    return isBusy(mine) ? { ...(await describe(opts, mine)), mine: true } : null;
  }

  const busy = items.find((s) => isBusy(s));
  return busy ? { ...(await describe(opts, busy)), mine: undefined } : null;
}

/**
 * Every busy simulator the token can see, whoever owns it.
 *
 * For status displays only — the dashboard should still show that a box has
 * work in flight. Never use it to gate a trigger.
 */
export async function findBusyAnywhere(opts: ApiOpts): Promise<BusyExecution[]> {
  const sims = await listSimulators(opts);
  const items = (sims.items ?? []) as any[];
  const mine = pickUserSimulator(items, opts.username);
  const out: BusyExecution[] = [];
  for (const s of items) {
    if (!isBusy(s)) continue;
    out.push({ ...(await describe(opts, s)), mine: mine ? String(s.id) === mine.id : undefined });
  }
  return out;
}

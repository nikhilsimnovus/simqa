// Is this execution record ours, or the one that was already there?
//
// A suite row owns ONE testcase on the Simnovator and runs it again and
// again, so `metadata.lastExecution` usually holds that row's OWN previous
// execution — terminal, with a verdict, and indistinguishable from a run that
// has just finished unless you remember what was there before you triggered.
//
// It was not remembered, and the poll accepted "any terminal status will do".
// NSA_3cell_Mobility_UDP_1UEs_automation was therefore reported COMPLETED /
// PASS twice on 13 October from the execution it actually ran on 9 October:
// same executionId, same 105s duration, and the testcase's lastModifiedOn
// never moved. The box takes tens of seconds to start an execution while the
// poll begins 1.5 seconds after the trigger, so the first read is reliably
// the old record.
//
// Two ways to know which is ours, in order of certainty:
//
//   the id our own POST returned, when the trigger gave us one;
//   otherwise, anything that is NOT the id that was already there.
//
// Neither is "whatever is terminal". A run whose execution never appears
// times out and says so, which is the honest answer and far better than
// inheriting a verdict from four days ago.
//
// Pure, imports nothing, so node --test loads it directly.

/** Just the part of an execution record this needs. */
export interface HasExecutionId {
  executionId?: string;
}

/**
 * Whether `seen` is the execution this run started.
 *
 * `triggerExecId` is what our POST returned, when it returned one.
 * `priorExecId` is what lastExecution held before we triggered.
 */
export function isOurExecution(
  seen: HasExecutionId | null | undefined,
  triggerExecId?: string,
  priorExecId?: string,
): boolean {
  const id = seen?.executionId;
  if (triggerExecId) return id === triggerExecId;
  // No id from the trigger: anything that is not the one already on record.
  // An execution with no id at all cannot be shown to be ours, so it is not
  // treated as ours — the run waits, and times out saying nothing started.
  if (!id) return false;
  return id !== priorExecId;
}

/**
 * Whether a record may be reported as this run's outcome once the wait is
 * over.
 *
 * Deliberately the same rule. The poll used to hand back whatever it last saw
 * when its window expired, which is how a stale record became a verdict even
 * on the paths that were otherwise careful.
 */
export function mayReport(
  seen: HasExecutionId | null | undefined,
  triggerExecId?: string,
  priorExecId?: string,
): boolean {
  if (!seen) return false;
  return isOurExecution(seen, triggerExecId, priorExecId);
}

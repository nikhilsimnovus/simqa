// Telling "the box is running it" from "the box never started it".
//
// A trigger is answered in one of three ways, and only two of them used to be
// distinguishable. The box either refuses (said so, at once), or starts and
// answers in ~20-26s with an executionId — or holds the connection, answers
// nothing, and never creates an execution at all. The third is what
// AIO_NB_IoT_standalone_2Cells_automation did on 21 October:
//
//   08:49:17  testcase created, validation 5/5 pass
//   08:49:24  callbox up, lte active
//   ~08:49:40 triggered
//   08:59:37  simulator AVAILABLE, status Not Executed, lastExecution null
//   09:05:13  run gives up: "triggered but no terminal state within 785s"
//
// postTrigger treats a timeout as "assume it started", on purpose: the box
// really does hold the connection while it brings a test up, so a timeout is
// usually a slow start rather than a failure. But nothing ever revisited that
// assumption, so the run then polled for the row's whole duration plus a
// 180s margin — 785s of waiting for an execution that did not exist, and
// sixteen minutes before the operator was told anything.
//
// The box answers this question itself, if asked two things at once:
//
//   * is there an execution of OURS?   lastExecution was null throughout
//   * is the simulator busy?          AVAILABLE throughout
//
// A test that is genuinely running holds the simulator, so "no execution of
// ours AND nothing running" can only mean the start did not take. Both have
// to agree, several times, well after the slowest start the box has shown —
// because aborting a test that IS running would be far worse than waiting.
//
// Pure, imports nothing, so node --test can load this directly.

/** Don't even ask before this. The slowest observed start is ~26s; this is
 *  more than four times that, so a slow box is never mistaken for a dead
 *  start. */
export const START_GRACE_SEC = 120;

/** How many agreeing looks before giving up. At the poll's 2s cadence the
 *  caller spaces these out; three is enough that a single bad read — a
 *  dropped request, a simulator caught between states — cannot decide it. */
export const START_CONFIRMATIONS = 3;

export interface StartProbe {
  /** Seconds since the trigger was sent. */
  sinceTriggerSec: number;
  /** True when the box reports an execution belonging to THIS run. */
  haveOurExecution: boolean;
  /** True when any simulator on the box is busy. Unknown counts as busy:
   *  a box we cannot read is not evidence that nothing is running. */
  simulatorBusy: boolean;
}

/** Does this look like a start that never took? One look, no memory. */
export function looksUnstarted(p: StartProbe, graceSec: number = START_GRACE_SEC): boolean {
  if (p.sinceTriggerSec < graceSec) return false;   // too early to tell
  if (p.haveOurExecution) return false;             // it did start
  if (p.simulatorBusy) return false;                // something is running
  return true;
}

/**
 * Agreeing looks in a row, so one bad read cannot abort a running test.
 *
 * `streak` is what this returned last time, starting at 0. Any look that does
 * not agree resets it — the evidence has to be current, not cumulative.
 */
export function confirmUnstarted(streak: number, p: StartProbe, graceSec: number = START_GRACE_SEC): number {
  return looksUnstarted(p, graceSec) ? streak + 1 : 0;
}

/** Enough agreeing looks to act on. */
export function givenUp(streak: number, needed: number = START_CONFIRMATIONS): boolean {
  return streak >= needed;
}

/** What to put in the row's detail, in the box's terms rather than ours. */
export function unstartedDetail(sinceTriggerSec: number): string {
  return `the Simnovator never started it: ${Math.round(sinceTriggerSec)}s after the trigger it still `
    + 'reports no execution for this test case and its simulator is idle. The test case was created '
    + 'and validated, so this is the box declining to start rather than anything missing here.';
}

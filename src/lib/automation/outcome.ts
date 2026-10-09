// The two words a suite row is allowed to say about itself — and they are the
// Simnovator's words, not ours.
//
// The Status and Verdict columns exist so an operator can compare a suite row
// against the box's own screen. That only works if they say the same thing, so
// both maps below are transcribed from the box's SPA bundle, where it turns
// `metadata.lastExecution.status` and `.result` into the labels its own test
// list shows:
//
//   status  IN_PROGRESS  -> In Progress     result  PASS         -> PASS
//           COMPLETED    -> Completed               FAIL         -> FAIL
//           STOPPED      -> Stopped                 INCOMPLETE   -> Incomplete
//           STOPPING     -> Stopping                NOT_EXECUTED -> Not Executed
//           STARTING     -> Starting                ERROR        -> Error
//           ABORTED      -> Aborted
//           NOT_EXECUTED -> Not Executed
//           AVAILABLE    -> Available
//           (no execution at all) -> Not Executed
//
// SimQA used to invent its own pair — "Passed" for PASS, "Uncompleted" for
// INCOMPLETE, and "Error" for its OWN failures, which the box never saw. A row
// could then read "Completed / Uncompleted" in SimQA while the Simnovator's
// own list said "Completed / Incomplete" for the same execution, and a row
// SimQA never managed to run read "Not Executed / Error" as though the box had
// judged it and found an error.
//
// So: these columns now report the box and nothing else. A row SimQA could not
// get as far as running is "Not Executed" with no verdict — which is exactly
// what the Simnovator says about a testcase that has never run — and the
// reason SimQA could not run it lives in the row's detail, where it was
// already written in full.
//
// Pure, imports nothing, so node --test can load it directly.

/** The box's status labels, plus the empty string for a row still waiting. */
export type StatusLabel =
  | 'Completed' | 'In Progress' | 'Not Executed' | 'Aborted'
  | 'Stopped' | 'Stopping' | 'Starting' | 'Available' | 'Unknown';

/** The box's result labels. '' when the box reported no result — which is the
 *  normal state of an execution that has not finished. */
export type VerdictLabel = 'PASS' | 'FAIL' | 'Incomplete' | 'Not Executed' | 'Error' | 'Unknown' | '';

/** What the run recorded for one row. Everything is optional: a row that never
 *  reached the box has none of it. */
export interface RowOutcome {
  /** The box's execution status, in its own spelling (COMPLETED, ABORTED, …). */
  boxStatus?: string;
  /** The box's execution result, in its own spelling (PASS, INCOMPLETE, …).
   *  Recorded since the columns became the box's own; older runs have only
   *  `verdict`, which this falls back to. */
  boxResult?: string;
  /** What the runner derived from the box's reply. Kept for runs recorded
   *  before boxResult existed, and never preferred over it. */
  verdict?: string;
  /** SimQA stopped the execution when the duration window ran out. Reported in
   *  the row's detail, not in these two columns: whether SimQA asked it to
   *  wrap up does not change what the box says happened. */
  stopped?: boolean;
  /** SimQA's own pass/fail for the row. Not shown here — it is what drives the
   *  tick in the suite's own summary — but kept so callers can pass the whole
   *  outcome object. */
  ok?: boolean;
  /** The row is executing right now. */
  running?: boolean;
  /** The row has no saved outcome at all. */
  neverRun?: boolean;
}

const up = (s?: string) => (s ?? '').trim().toUpperCase();

/** The box's own status map. */
const STATUS: Record<string, StatusLabel> = {
  IN_PROGRESS: 'In Progress',
  COMPLETED: 'Completed',
  STOPPED: 'Stopped',
  STOPPING: 'Stopping',
  STARTING: 'Starting',
  ABORTED: 'Aborted',
  NOT_EXECUTED: 'Not Executed',
  AVAILABLE: 'Available',
  UNKNOWN: 'Unknown',
  // Spellings seen in the wild from older builds and from SimQA's own derived
  // verdict, folded onto the same labels rather than falling through to
  // Unknown.
  PASSED: 'Completed',
  FAILED: 'Completed',
  COMPLETE: 'Completed',
};

/** The box's own result map. */
const RESULT: Record<string, VerdictLabel> = {
  PASS: 'PASS',
  FAIL: 'FAIL',
  INCOMPLETE: 'Incomplete',
  NOT_EXECUTED: 'Not Executed',
  ERROR: 'Error',
  // Same tolerance as above, for runs recorded before the raw result was kept.
  PASSED: 'PASS',
  FAILED: 'FAIL',
};

/**
 * How the box says the execution ended.
 *
 * "In Progress" while SimQA is running the row, because the box has not been
 * asked yet and the operator can see for themselves that it is going. Anything
 * the box never ran is "Not Executed", which is the box's own word for it.
 */
export function statusLabel(o: RowOutcome): StatusLabel {
  if (o.running) return 'In Progress';
  if (o.neverRun) return 'Not Executed';
  const mapped = STATUS[up(o.boxStatus)];
  if (mapped) return mapped;
  // No status from the box: either SimQA never got that far, or this is an old
  // record that only kept the derived verdict.
  const fromVerdict = STATUS[up(o.verdict)];
  if (fromVerdict) return fromVerdict;
  return 'Not Executed';
}

/**
 * What the box judged it to be.
 *
 * Empty when the box reported no result — a row that never ran, or one that
 * ran and was cut off before it reached a judgement. Empty is the honest
 * answer there; the reason is in the row's detail.
 */
export function verdictLabel(o: RowOutcome): VerdictLabel {
  if (o.running || o.neverRun) return '';
  const mapped = RESULT[up(o.boxResult)];
  if (mapped) return mapped;
  // Older runs kept only the derived verdict, which folded the box's STATUS in
  // alongside its result — so ABORTED and STOPPED arrive here as a "verdict".
  // Those are statuses, and the box shows no result for them.
  const v = up(o.verdict);
  if (RESULT[v]) return RESULT[v];
  return '';
}

/**
 * Statuses that mean the box has stopped working on an execution.
 *
 * Compared case-insensitively on purpose. The box answers in CAPITALS —
 * "COMPLETED", "STOPPED" — while this list was written in title case, so a
 * finished test never matched: the runner kept polling until its whole window
 * expired and only then stopped and read the verdict. The Simnovator showed
 * Completed while SimQA sat there for minutes.
 */
const TERMINAL = new Set(['completed', 'failed', 'aborted', 'stopped', 'passed', 'incomplete']);

export function isTerminalStatus(status?: string): boolean {
  return TERMINAL.has((status ?? '').trim().toLowerCase());
}

/** Tailwind colour for a verdict — green for the good one, red for the bad
 *  ones, amber for a test that ran without reaching a judgement. */
export function verdictClass(v: VerdictLabel): string {
  if (v === 'PASS') return 'text-emerald-700 font-semibold';
  if (v === 'FAIL' || v === 'Error') return 'text-red-700 font-semibold';
  if (v === 'Incomplete') return 'text-amber-700 font-semibold';
  return 'text-slate-400';
}

/** Dot and colour for a status. */
export function statusStyle(s: StatusLabel): { dot: string; cls: string } {
  switch (s) {
    case 'Completed':    return { dot: '🟢', cls: 'text-slate-700' };
    case 'In Progress':
    case 'Starting':     return { dot: '🟡', cls: 'text-amber-700' };
    case 'Aborted':      return { dot: '🔴', cls: 'text-red-700' };
    case 'Stopped':
    case 'Stopping':     return { dot: '🟠', cls: 'text-slate-700' };
    default:             return { dot: '⚪', cls: 'text-slate-400' };
  }
}

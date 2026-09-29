// The two words a suite row is allowed to say about itself.
//
// The box reports a status and a result in its own spelling (COMPLETED, PASS,
// Aborted, INCOMPLETE, …), SimQA adds failures of its own — a testcase the box
// refused to create, a trigger it rejected — and the run also knows whether
// SimQA stopped the execution at the end of the duration window. Left as they
// come, the column showed whichever vocabulary happened to win.
//
// Two fixed sets instead, so a row reads the same way every time:
//
//   Status   Completed · In Progress · Not Executed · Aborted · Stopped
//   Verdict  Passed · Uncompleted · Failed · Error
//
// Status answers "did it run, and how did it end". Verdict answers "what did
// it come to" — Error being SimQA's own failures, the ones the box never saw,
// and Uncompleted a test that ran without reaching a judgement.
//
// Pure, imports nothing, so node --test can load it directly.

export type StatusLabel = 'Completed' | 'In Progress' | 'Not Executed' | 'Aborted' | 'Stopped';
export type VerdictLabel = 'Passed' | 'Uncompleted' | 'Failed' | 'Error';

/** What the run recorded for one row. Everything is optional: a row that never
 *  reached the box has none of it. */
export interface RowOutcome {
  /** The box's execution status, in its own spelling. */
  boxStatus?: string;
  /** The box's verdict, as the runner derived it (PASS/FAIL/ABORTED/…). */
  verdict?: string;
  /** SimQA stopped the execution when the duration window ran out. */
  stopped?: boolean;
  /** SimQA's own pass/fail for the row. */
  ok?: boolean;
  /** The row is executing right now. */
  running?: boolean;
  /** The row has no saved outcome at all. */
  neverRun?: boolean;
}

const up = (s?: string) => (s ?? '').trim().toUpperCase();

/**
 * How the row ended.
 *
 * Order matters: running beats history, and a row the box never judged is Not
 * Executed however SimQA feels about it — "Completed" has to mean the box ran
 * it to the end, or the column is worthless for spotting rows that never
 * started.
 */
export function statusLabel(o: RowOutcome): StatusLabel {
  if (o.running) return 'In Progress';
  if (o.neverRun) return 'Not Executed';

  const s = up(o.boxStatus);
  const v = up(o.verdict);
  if (s === 'ABORTED' || v === 'ABORTED') return 'Aborted';
  // The BOX decides. SimQA sending a stop when the duration window runs out
  // used to make the row read "Stopped" while the Simnovator's own screen said
  // COMPLETED — two tools disagreeing about the same execution. A test the box
  // carried to the end is Completed, whoever asked it to wrap up; Stopped is
  // for the box saying so itself.
  if (s === 'STOPPED' || v === 'STOPPED') return 'Stopped';
  if (s) return 'Completed';
  // Nothing from the box, but SimQA stopped something: it ran and was cut off.
  if (o.stopped) return 'Stopped';
  // No status from the box: it never ran this one.
  return 'Not Executed';
}

/**
 * What it came to.
 *
 * A row the box judged carries its verdict. A row that ran without reaching a
 * judgement is Uncompleted. A row that failed before the box could judge it —
 * SimQA could not create the testcase, could not trigger it, threw — is Error,
 * which is a different problem from a test that ran and failed.
 */
export function verdictLabel(o: RowOutcome): VerdictLabel | '' {
  if (o.running || o.neverRun) return '';

  const v = up(o.verdict);
  if (v === 'PASS' || v === 'PASSED') return 'Passed';
  if (v === 'FAIL' || v === 'FAILED') return 'Failed';
  if (v === 'ERROR' || v === 'TIMEOUT') return 'Error';
  // INCOMPLETE, ABORTED, STOPPED and anything else the box says: it ran, it
  // just never reached a verdict.
  if (v) return 'Uncompleted';

  // Nothing from the box at all. SimQA's own failure, or a row that somehow
  // passed without a verdict.
  if (o.boxStatus) return 'Uncompleted';
  return o.ok ? 'Passed' : 'Error';
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
 *  two, slate for "it ran but said nothing". */
export function verdictClass(v: VerdictLabel | ''): string {
  if (v === 'Passed') return 'text-emerald-700 font-semibold';
  if (v === 'Failed' || v === 'Error') return 'text-red-700 font-semibold';
  if (v === 'Uncompleted') return 'text-amber-700 font-semibold';
  return 'text-slate-400';
}

/** Dot and colour for a status. */
export function statusStyle(s: StatusLabel): { dot: string; cls: string } {
  switch (s) {
    case 'Completed':    return { dot: '🟢', cls: 'text-slate-700' };
    case 'In Progress':  return { dot: '🟡', cls: 'text-amber-700' };
    case 'Aborted':      return { dot: '🔴', cls: 'text-red-700' };
    case 'Stopped':      return { dot: '🟠', cls: 'text-slate-700' };
    default:             return { dot: '⚪', cls: 'text-slate-400' };
  }
}

// A row never stops at "In Progress".
//
// The Status and Verdict columns are supposed to be the Simnovator's own
// words about the execution (see outcome.ts). They are — right up until the
// run stops watching. If the poll ran out of budget, the run was stopped, or
// SimQA lost the box for a moment, whatever status was last seen is written
// into history and left there. The box carries the execution to a conclusion
// a minute later and nobody updates the row.
//
// AIO_SA_1cell_4x2_64UEs_RTSP_Upload_automation is the case in point:
//
//   run-20261019053638-0bnyp7  (finished 05:36:38)
//     SimQA:  In Progress / Not Executed        <- frozen, forever
//     box:    ABORTED / INCOMPLETE at 05:35:11  <- inside that run's window
//
// Two older runs are frozen the same way, so it is not a one-off. A finished
// run claiming a row is still going is worse than a wrong verdict: it reads
// as hardware still busy, and it never resolves.
//
// So before a run is recorded, every row left mid-flight is asked about
// again, and the box's answer is adopted. Only when the box is talking about
// THIS row's execution: matching on executionId, because a later run of the
// same testcase would otherwise hand this row somebody else's verdict.
//
// Pure, imports nothing, so node --test can load this directly.

/** States the box will not move on from. Everything else is in flight. */
const TERMINAL = new Set(['COMPLETED', 'ABORTED', 'STOPPED', 'ERROR', 'NOT_EXECUTED']);

/** True when the box has said its last word about this execution. */
export function isTerminal(boxStatus: string | undefined): boolean {
  return TERMINAL.has(String(boxStatus ?? '').trim().toUpperCase());
}

/** Just the parts of a recorded row this needs. */
export interface RecordedRow {
  /** The testcase on the box this row executed. Nothing to ask without it. */
  boxTestcaseId?: string;
  /** The execution this row started. The box's answer only counts if it is
   *  about this one. */
  executionId?: string;
  boxStatus?: string;
  boxResult?: string;
  kind?: 'note';
}

/** What the box says now about that testcase's last execution. */
export interface BoxExecution {
  executionId?: string;
  status?: string;
  result?: string;
}

/** Should this row be asked about again before the run is written down? */
export function needsReconcile(row: RecordedRow): boolean {
  if (row.kind === 'note') return false;              // not a test case
  if (!row.boxTestcaseId || !row.executionId) return false; // never reached the box
  return !isTerminal(row.boxStatus);
}

export interface Reconciled {
  boxStatus?: string;
  boxResult?: string;
  /** For the row's detail, so the change is visible rather than silent. */
  note: string;
}

/**
 * The row as the box now describes it, or null to leave it alone.
 *
 * Null when the box has nothing, when it is describing a different execution,
 * or when it still has not finished — in that last case the row keeps saying
 * "In Progress", which is then the truth rather than a leftover.
 */
export function reconcileRow(row: RecordedRow, box: BoxExecution | null | undefined): Reconciled | null {
  if (!needsReconcile(row) || !box) return null;
  // A different execution — a later run of the same testcase, or another
  // login's. Adopting it would put somebody else's verdict on this row.
  if (box.executionId && row.executionId && box.executionId !== row.executionId) return null;
  if (!isTerminal(box.status)) return null;           // genuinely still going
  const was = row.boxStatus ? `"${row.boxStatus}"` : 'nothing';
  return {
    boxStatus: box.status,
    boxResult: box.result,
    note: `status: the run stopped watching at ${was} — the Simnovator finished this execution as `
      + `${box.status}${box.result ? `/${box.result}` : ''}, which is what this row now reports`,
  };
}

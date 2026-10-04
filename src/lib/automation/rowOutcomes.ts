// Each row's MOST RECENT outcome: SimQA's pass/fail, and — the part an
// operator actually compares against the box — the Simnovator's own execution
// status and verdict, the same two fields its GUI shows.
//
// Shared by suites and campaigns. A campaign runs as a throwaway suite whose
// id is the campaign's, so both read the same run records by the same key, and
// a campaign's Status column means exactly what a suite's does.
//
// Newest run wins per ROW, not per run: executing a single testcase records
// only that one, and the other rows' earlier results are still the truth about
// them.

import { listRunsForSuite } from './runStore';
import type { SuiteRunStep } from './runner';

export interface RowOutcomes {
  /** SimQA's own pass/fail per row name. */
  statuses: Record<string, boolean>;
  /** One line saying why, for the cell's tooltip. */
  details: Record<string, string>;
  lastRunAt: Record<string, string>;
  /** The box's own words: status (COMPLETED, ABORTED, …) and verdict. */
  box: Record<string, { status?: string; verdict?: string; stopped?: boolean; boxTestcaseId?: string }>;
}

/**
 * A one-line, human reason for a row's outcome — the thing shown on hover.
 *
 * It names the SOURCE, which is the actual question an operator has when a row
 * says "Failed": was it the Simnovator's own testcase verdict (the same PASS/
 * FAIL the box GUI shows), or did SimQA fail before the box ever judged it —
 * couldn't start the execution, couldn't reach/authenticate the box, or a
 * callbox cfg step failed. The runner already records all three shapes in the
 * step; this just words them.
 */
function reasonFor(step: SuiteRunStep): string {
  const d = (step.detail ?? '').trim();

  // The box ran it and returned its own verdict — same signal as the GUI.
  if (step.verdict) {
    const bits = [`Simnovator testcase verdict: ${step.verdict}`];
    if (step.boxStatus) bits.push(`box status ${step.boxStatus}`);
    if (step.stopped) bits.push('stopped by SimQA after the duration window');
    return bits.join(' · ');
  }

  // Failures on SimQA's side, before the box could judge the test.
  if (/^trigger\b/i.test(d)) return `SimQA could not start the execution on the box — ${d}`;
  if (/^threw:/i.test(d))    return `SimQA error while running the test — ${d.replace(/^threw:\s*/i, '')}`;
  if (/login/i.test(d))      return `SimQA could not reach or sign in to the box — ${d}`;
  if (/^cfg-/i.test(step.testcaseId)) return `Callbox configuration step failed — ${d}`;

  return d || (step.ok ? 'Passed' : 'Failed — no detail was recorded for this run');
}

export function rowOutcomes(suiteId: string): RowOutcomes {
  const runs = listRunsForSuite(suiteId);          // newest first
  const statuses: Record<string, boolean> = {};
  const details: Record<string, string> = {};
  const lastRunAt: Record<string, string> = {};
  const box: RowOutcomes['box'] = {};
  for (const run of runs) {
    for (const st of run?.steps ?? []) {
      if (!st?.testcaseId || st.testcaseId in statuses) continue;
      statuses[st.testcaseId] = !!st.ok;
      details[st.testcaseId] = reasonFor(st);
      box[st.testcaseId] = {
        status: st.boxStatus, verdict: st.verdict, stopped: st.stopped,
        // Which testcase on the box to open a report for.
        boxTestcaseId: st.boxTestcaseId,
      };
      if (run.finishedAt) lastRunAt[st.testcaseId] = run.finishedAt;
    }
  }
  return { statuses, details, lastRunAt, box };
}

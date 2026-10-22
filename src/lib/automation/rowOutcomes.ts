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
  /** The box's own words, raw: status (COMPLETED, ABORTED, …) and result
   *  (PASS, INCOMPLETE, …). The Status and Verdict columns are these two and
   *  nothing else, so they are carried through unmapped. */
  box: Record<string, { status?: string; result?: string; verdict?: string; stopped?: boolean; boxTestcaseId?: string }>;
  /**
   * The Result column: what post-processing made of the row's OTA log, and
   * the result it produced together with the execution's own verdict.
   *
   * Absent for a row whose last run configured no rules, and for every run
   * recorded before post-processing existed. The column shows an em dash
   * there rather than inventing a result — "no rules" is not a verdict.
   */
  post: Record<string, {
    /** PASS / FAIL / ERROR / NOT CONFIGURED — post-processing's own word. */
    outcome?: string;
    /** Execution verdict combined with it. This is what the column shows. */
    result?: string;
    passedRules?: number;
    rules?: number;
    /** Why it could not be established, when it could not be. */
    problem?: string;
  }>;
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

  // The box ran it and said what happened — the same two fields its GUI shows.
  //
  // This is where the detail earns its place now that the Status and Verdict
  // columns are the box's words and nothing else: whether SimQA stopped the
  // execution, and what it was doing beforehand, is exactly what those columns
  // no longer say.
  if (step.boxStatus || step.boxResult || step.verdict) {
    const bits: string[] = [];
    if (step.boxStatus) bits.push(`Simnovator status ${step.boxStatus}`);
    if (step.boxResult) bits.push(`result ${step.boxResult}`);
    else if (step.verdict) bits.push(`verdict ${step.verdict}`);
    if (step.stopped) bits.push('stopped by SimQA after the duration window');
    if (d) bits.push(d);
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
  const post: RowOutcomes['post'] = {};
  for (const run of runs) {
    for (const st of run?.steps ?? []) {
      if (!st?.testcaseId || st.testcaseId in statuses) continue;
      // Run-level bookkeeping is not a row. Putting the callbox licence back
      // is recorded as a step so the run's own account is complete, but it is
      // not a test case and has no business in a map of per-row outcomes —
      // it showed up as "licence-restore · Not Executed" alongside the
      // twenty real rows. Older records predate the flag, so the one name
      // that existed before it is matched directly.
      if (st.kind === 'note' || st.testcaseId === 'licence-restore') continue;
      statuses[st.testcaseId] = !!st.ok;
      details[st.testcaseId] = reasonFor(st);
      box[st.testcaseId] = {
        status: st.boxStatus, result: st.boxResult, verdict: st.verdict, stopped: st.stopped,
        // Which testcase on the box to open a report for.
        boxTestcaseId: st.boxTestcaseId,
      };
      // Only where the row actually had rules. A step with no postProcessing
      // is either a row that configured none or a run from before this
      // existed, and both must read as "nothing to say" rather than as PASS.
      if (st.postProcessing && st.postProcessing.rulesConfigured > 0) {
        post[st.testcaseId] = {
          outcome: st.postProcessing.outcome,
          result: st.finalResult,
          passedRules: st.postProcessing.passedRules,
          rules: st.postProcessing.rulesConfigured,
          problem: st.postProcessing.problem,
        };
      }
      if (run.finishedAt) lastRunAt[st.testcaseId] = run.finishedAt;
    }
  }
  return { statuses, details, lastRunAt, box, post };
}

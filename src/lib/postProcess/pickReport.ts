// Finding the post-processing report to SHOW for a row.
//
// The Result column says PASS or FAIL. This is what sits behind it: which
// rules were checked, what each one expected, what the log actually held, and
// every OTA message that was counted. "FAIL" on its own is an accusation; the
// report is the evidence for it.
//
// The rule for picking one: the row's MOST RECENT run that actually checked
// rules. Not simply the most recent run — a row re-run after its rules were
// removed has nothing to show, and silently falling back to an older run
// would date a report that looks current. Newest-first is the caller's
// promise; this walks in the order it is given.
//
// Pure, imports nothing, so node --test loads it directly.

/** The shape this needs from a run record. Structural on purpose: the real
 *  types live in automation/runner.ts, which drags half the server with it. */
export interface StepLike {
  testcaseId?: string;
  kind?: string;
  verdict?: string;
  boxStatus?: string;
  boxResult?: string;
  executionId?: string;
  boxTestcaseId?: string;
  finalResult?: string;
  // Structural, and deliberately not Record<string, unknown>: the real
  // report is an interface, and an interface does not satisfy an index
  // signature, so demanding one here would reject the very type this reads.
  postProcessing?: { rulesConfigured?: number };
}

export interface RunLike {
  runId?: string;
  startedAt?: string;
  finishedAt?: string;
  steps?: StepLike[];
}

export interface PickedReport {
  runId?: string;
  finishedAt?: string;
  row: string;
  executionId?: string;
  boxTestcaseId?: string;
  /** The box's own verdict, kept beside ours and never merged into it. */
  verdict?: string;
  boxStatus?: string;
  boxResult?: string;
  finalResult?: string;
  report: unknown;
}

/** Whether a step carries a report worth showing. */
export function hasReport(step: StepLike | undefined | null): boolean {
  const n = step?.postProcessing?.rulesConfigured;
  return typeof n === 'number' && n > 0;
}

/**
 * The newest report for one row, or null when that row has never been
 * post-processed.
 *
 * `runs` must be newest-first — listRunsForSuite() returns them that way.
 */
export function pickPostReport(runs: RunLike[], rowName: string): PickedReport | null {
  const want = String(rowName ?? '').trim();
  if (!want) return null;
  for (const run of runs ?? []) {
    for (const st of run?.steps ?? []) {
      if (st?.kind === 'note') continue;
      if (String(st?.testcaseId ?? '') !== want) continue;
      // The first run holding this row decides, whether or not it has a
      // report: an older one would describe rules the row no longer has.
      if (!hasReport(st)) return null;
      return {
        runId: run.runId,
        finishedAt: run.finishedAt,
        row: want,
        executionId: st.executionId,
        boxTestcaseId: st.boxTestcaseId,
        verdict: st.verdict,
        boxStatus: st.boxStatus,
        boxResult: st.boxResult,
        finalResult: st.finalResult,
        report: st.postProcessing,
      };
    }
  }
  return null;
}

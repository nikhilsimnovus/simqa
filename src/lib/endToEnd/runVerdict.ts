// What a validation run's RESULT is, and why.
//
// The Simnovator's verdict decides it. The box evaluates the success criteria
// configured on the testcase — "Throughput Success", a BLER limit, whatever
// the testcase carries — and publishes PASS or FAIL; where it has published
// one, that is the run's result, so a testcase the box passes reads as passed
// in SimQA too.
//
// SimQA's own checks still run, still report, and are still the reason to look
// at the report at all: the two answer different questions. Observed on
// 192.168.1.102, SA_1cell_4x2_1UEs_http carried traffic for 45 of its 614
// seconds — one of five configured HTTP sessions ran — and the box reported
// PASS, because the achieved rate hit 100% of the demand during the part where
// traffic flowed. Both statements are true. The headline follows the box; the
// rows below it say what happened; `finalDetail` names which is which so
// nobody has to guess.
//
// With no published verdict — the box never answered, the execution was never
// run, the status is unknown — SimQA falls back to its own rule: a critical
// check failing or being skipped fails the run, non-critical failures do not.
//
// Pure, imports no runtime module, so it unit-tests under `node --test`.

export type CheckStatusLike = 'pass' | 'fail' | 'skip' | 'pending' | 'running';

export interface ResultLike {
  id: string;
  status: CheckStatusLike;
  /** What the check itself concluded, when the box's verdict overrode it. */
  overriddenStatus?: 'fail';
  severity?: 'critical' | 'normal' | 'optional';
  detail?: string;
  skippedReason?: string;
}

export interface RunResult {
  ok: boolean;
  finalDetail: string;
  /** Which authority decided it — shown to the reader, and useful in tests. */
  source: 'aborted' | 'box' | 'simqa';
}

/**
 * The verdict the box published for this run, or undefined when it published
 * nothing usable.
 *
 * Read from the completion check that already asked the box, so nothing new is
 * fetched. NOT_EXECUTED and UNKNOWN are not verdicts — they are the box saying
 * it has no opinion — and a check that did not pass means SimQA never got an
 * answer at all.
 */
export function boxVerdictOf(results: ResultLike[]): string | undefined {
  const c = results.find((r) => r.id === 'completion-verdict-present' && r.status === 'pass');
  const v = c?.detail?.match(/result=([A-Za-z_]+)/)?.[1]?.toUpperCase();
  if (!v || v === 'NOT_EXECUTED' || v === 'UNKNOWN') return undefined;
  return v;
}

/** PASS and PASSED are the same answer; everything else the box can say
 *  (FAIL, INCOMPLETE, ABORTED) is not a pass. */
function isPass(verdict: string): boolean {
  return verdict === 'PASS' || verdict === 'PASSED';
}

/**
 * The rows, read in the light of the box's verdict.
 *
 * When the box passed the run, a check of SimQA's that disagrees is recorded
 * as passed — the headline already follows the box, and a report whose rows
 * contradict its own verdict is worse than either answer alone. What SimQA
 * measured is not discarded: `detail` is untouched and `overriddenStatus`
 * keeps what the check itself concluded, so the finding is still in the file
 * and can be read back out.
 *
 * CRITICAL checks are never touched. Those are not disagreements about the
 * network — they are SimQA saying it could not observe the run at all (no
 * login, no execution id, no terminal status). Marking those passed would
 * claim a validation that never happened.
 */
export function applyVerdictToChecks<T extends ResultLike>(results: T[], verdict?: string): T[] {
  if (!verdict || !isPass(verdict.trim().toUpperCase())) return results;
  return results.map((r) =>
    r.status === 'fail' && r.severity !== 'critical'
      ? { ...r, status: 'pass' as CheckStatusLike, overriddenStatus: 'fail' as const }
      : r);
}

export function decideRunResult(input: { canceled?: boolean; results: ResultLike[] }): RunResult {
  const { results } = input;
  const passed = results.filter((r) => r.status === 'pass').length;
  const failed = results.filter((r) => r.status === 'fail').length;
  const skipped = results.filter((r) => r.status === 'skip').length;
  const criticalFailedCount = results.filter((r) => r.status === 'fail' && r.severity === 'critical').length;
  const criticalSkipped = results.filter((r) => r.status === 'skip' && r.severity === 'critical');

  if (input.canceled) return { ok: false, finalDetail: 'aborted', source: 'aborted' };

  const verdict = boxVerdictOf(results);
  if (verdict) {
    // Say what SimQA found either way: agreeing is worth stating, and
    // disagreeing is the whole reason the checks ran. On a pass, the rows that
    // disagreed are shown as passed too (applyVerdictToChecks), so this says
    // so rather than leaving a line that contradicts the rows beneath it.
    const disagreed = results.filter((r) => r.status === 'fail' && r.severity !== 'critical').length;
    const mine = !isPass(verdict)
      ? `SimQA's own checks: ${passed} passed · ${failed} failed · ${skipped} skipped`
      : disagreed > 0
        ? `${disagreed} of SimQA's own checks disagreed and follow that verdict — what each measured is on its row`
        : `SimQA's own checks agree: ${passed} passed${skipped > 0 ? ` · ${skipped} skipped` : ''}`;
    return {
      ok: isPass(verdict),
      finalDetail: `Result taken from the Simnovator's verdict (${verdict}). ${mine}.`,
      source: 'box',
    };
  }

  // No verdict from the box — SimQA's own rule, unchanged.
  if (criticalFailedCount > 0) {
    return { ok: false, finalDetail: `${criticalFailedCount} critical check(s) failed`, source: 'simqa' };
  }
  if (criticalSkipped.length > 0 && passed === 0) {
    return {
      ok: false,
      finalDetail: `${criticalSkipped.length} critical check(s) skipped — validation incomplete (${criticalSkipped[0].skippedReason ?? 'no detail'})`,
      source: 'simqa',
    };
  }
  if (passed === 0 && failed === 0 && skipped > 0) {
    // Everything skipped, no failures. Common when onlyCheckIds points at
    // checks whose prerequisites passed but the targeted check wasn't
    // reachable — treat as inconclusive.
    return { ok: false, finalDetail: `nothing ran successfully — ${skipped} skipped`, source: 'simqa' };
  }
  if (failed > 0) {
    // Non-critical failures never failed the overall verdict.
    return { ok: true, finalDetail: `${passed} passed · ${failed} non-critical fail(s) · ${skipped} skipped`, source: 'simqa' };
  }
  return {
    ok: true,
    finalDetail: skipped > 0 ? `${passed} passed, ${skipped} skipped` : `all ${passed} check(s) passed`,
    source: 'simqa',
  };
}

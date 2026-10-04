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
 * The rows, once the box has published a verdict.
 *
 * Where the Simnovator has judged the run, its own success conditions are the
 * only things that show as failed. A measurement of SimQA's that disagrees is
 * recorded as passed, whichever way the verdict went:
 *
 *   • the box passed it — SimQA's objection does not fail a run the box passed
 *   • the box failed it — the failure is the box's conditions and the verdict
 *     row, not SimQA's separate measurements beside them
 *
 * Asked for directly, twice, with the example each time: on .102 the box
 * reported UL at 98% of its 90% criterion while SimQA's per-cell check read
 * zero UL on the only cell. Two instruments, one of them authoritative here.
 *
 * Nothing is discarded. `detail` is untouched, and `overriddenStatus` keeps
 * what the check itself concluded, so the finding stays in the file, stays on
 * the row in words, and can be read back out if this is ever reconsidered.
 *
 * CRITICAL checks are never touched. Those are not disagreements about the
 * network — they are SimQA saying it could not observe the run at all (no
 * login, no execution id, no terminal status). Marking those passed would
 * claim a validation that never happened.
 */
/** Rows the runner adds for the box's own success conditions — see the
 *  condition rows it builds at the end of a run. They are the box's, not
 *  SimQA's, so they are counted and worded separately. */
const CONDITION_PREFIX = 'box-condition:';
const VERDICT_CHECK_ID = 'completion-verdict-present';

/** The rows whose whole job is to carry the box's verdict — the SimQA check
 *  that asks for it, and the derived row on a box-executed run. */
const VERDICT_ROW_IDS = new Set(['completion-verdict-present', 'box-completion-verdict']);

export function applyVerdictToChecks<T extends ResultLike>(results: T[], verdict?: string): T[] {
  if (!verdict) return results;
  const passed = isPass(verdict.trim().toUpperCase());
  return results.map((r) => {
    // The verdict row reports the VERDICT, not merely that one was published.
    // Left as a pass, a failed run showed green from top to bottom with "FAIL"
    // written inside one of the rows.
    if (VERDICT_ROW_IDS.has(r.id)) {
      return !passed && r.status === 'pass' ? { ...r, status: 'fail' as CheckStatusLike } : r;
    }
    return r.status === 'fail' && r.severity !== 'critical'
      ? { ...r, status: 'pass' as CheckStatusLike, overriddenStatus: 'fail' as const }
      : r;
  });
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
    //
    // The box's own conditions are counted separately from SimQA's checks.
    // Lumping them together produced "SimQA's own checks agree: 25 passed"
    // under a FAIL verdict, when what had actually failed was one of the box's
    // conditions — the opposite of agreement, and not SimQA's finding at all.
    const own = results.filter((r) => !r.id.startsWith(CONDITION_PREFIX) && r.id !== VERDICT_CHECK_ID);
    const ownPassed = own.filter((r) => r.status === 'pass').length;
    const ownSkipped = own.filter((r) => r.status === 'skip').length;
    const disagreed = own.filter((r) => r.status === 'fail' && r.severity !== 'critical').length;
    const conditionsFailed = results.filter((r) => r.id.startsWith(CONDITION_PREFIX) && r.status === 'fail').length;

    const box = conditionsFailed > 0
      ? ` ${conditionsFailed} of its own condition${conditionsFailed === 1 ? '' : 's'} failed.`
      : '';
    const mine = ` SimQA's own checks: ${ownPassed} passed`
      + (disagreed > 0 ? ` · ${disagreed} disagreed and follow that verdict` : '')
      + (ownSkipped > 0 ? ` · ${ownSkipped} skipped` : '')
      + '.';
    return {
      ok: isPass(verdict),
      finalDetail: `Result taken from the Simnovator's verdict (${verdict}).${box}${mine}`,
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

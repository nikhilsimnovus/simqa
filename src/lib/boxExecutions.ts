// The Simnovator's OWN execution history for a testcase, and the check-by-check
// verdicts behind it.
//
// Why this exists: a testcase run from the Simnovator's own GUI never goes
// through SimQA's validation engine, so /testcases/[id] had nothing to show for
// it beyond "last executed <date>". The box does keep a report, though — it is
// just buried in `metadata.executionHistory[].execution_result_details` as a
// JSON *string*, which is why it looked like there was nothing there.
//
// Shape observed on .102 across several testcases (vonr, SA, TC_LTE):
//
//   {
//     "verdict": true,
//     "created_on": 1788410136,
//     "bler": { "bler": [ {achieved, condition, demand, msgname, verdict} ],
//               "verdict": true }
//   }
//
// The group key varies — `bler`, `message_counters` and `throughput` all seen —
// so the parser does NOT hard-code them: any key whose value holds an array of
// check objects is treated as a group. A new success condition on a future
// build therefore shows up on its own rather than being silently dropped.
//
// IMPORTANT, and the reason the UI states it plainly: the box's PASS means only
// that its configured success conditions held. A testcase whose only condition
// is "Avg_DL_BLER<=5%" passes with an achieved BLER of 0 — which is also what
// zero attached UEs produces. The verdict is real, but it is not proof the test
// did anything.
//
// IMPORTS: none. Pure, so it unit-tests under `node --test`.

export interface BoxCheck {
  /** The group it came from — 'bler', 'message_counters', 'throughput', … */
  group: string;
  /** The measured quantity, e.g. 'Avg_DL_BLER'. */
  name: string;
  /** The condition as the box words it, e.g. 'Avg_DL_BLER<=5%'. */
  condition: string;
  demand?: number;
  achieved?: number;
  verdict: boolean;
}

export interface BoxExecution {
  executionId: string;
  /** Which simulator the box ran it on, as the box names it. */
  simulatorName?: string;
  /** 'Completed', 'Aborted', … as the box words it. */
  status?: string;
  /** 'PASS' / 'FAIL' as the box words it. */
  result?: string;
  startedAt?: string;
  finishedAt?: string;
  durationSec?: number;
  /**
   * Still executing on the box.
   *
   * A run in flight reports status "In Progress", an empty result, an empty
   * details blob and endTimeUnix 0 — so it has no checks and no verdict. That
   * has to be distinguishable from a finished run, or "no failures" reads as
   * "passed": a testcase the box had only just started came out as a green
   * tick with zero measurements behind it.
   */
  running: boolean;
  /** The box's own overall verdict from the details blob. */
  verdict?: boolean;
  checks: BoxCheck[];
  /** Set when the details blob could not be read — shown rather than hidden,
   *  so a parse failure is never mistaken for "no checks ran". */
  parseError?: string;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Seconds-since-epoch → ISO. The box also carries `startTime` as a
 *  "03/09/2026, 04:23:33" string, which is DD/MM/YYYY and would be read as a
 *  US date by Date.parse — the unix fields are the unambiguous ones. */
function isoFromUnixSeconds(v: unknown): string | undefined {
  const n = num(v);
  if (n === undefined || n <= 0) return undefined;
  const d = new Date(n * 1000);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** Whether a status string the box wrote means "still going". */
function statusIsRunning(status: unknown): boolean {
  const s = String(status ?? '').trim().toLowerCase();
  return s === 'in progress' || s === 'in_progress' || s === 'running' || s === 'started';
}

function isCheckLike(v: unknown): boolean {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return 'verdict' in o && ('msgname' in o || 'condition' in o);
}

/**
 * Read one `execution_result_details` blob.
 *
 * Accepts the JSON string the box stores, or an already-parsed object, because
 * `metadata.lastExecution.executionResultDetails` and
 * `executionHistory[].execution_result_details` have differed by build.
 */
export function parseBoxExecutionDetails(raw: unknown): { verdict?: boolean; checks: BoxCheck[]; error?: string } {
  if (raw === undefined || raw === null || raw === '') return { checks: [] };

  let doc: any = raw;
  if (typeof raw === 'string') {
    try { doc = JSON.parse(raw); }
    catch (e: any) { return { checks: [], error: `unreadable result details: ${e?.message ?? String(e)}` }; }
  }
  if (!doc || typeof doc !== 'object') return { checks: [], error: 'result details were not an object' };

  const checks: BoxCheck[] = [];
  for (const [group, value] of Object.entries(doc as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    // A group looks like { <group>: [ …checks… ], verdict: bool }. The inner
    // array key is usually the group name but is not guaranteed to be, so take
    // whichever member is an array of check-shaped objects.
    for (const inner of Object.values(value as Record<string, unknown>)) {
      if (!Array.isArray(inner)) continue;
      for (const c of inner) {
        if (!isCheckLike(c)) continue;
        const o = c as Record<string, unknown>;
        checks.push({
          group,
          name: String(o.msgname ?? o.condition ?? '(unnamed)'),
          condition: String(o.condition ?? ''),
          demand: num(o.demand),
          achieved: num(o.achieved),
          verdict: o.verdict === true,
        });
      }
    }
  }

  return { verdict: typeof doc.verdict === 'boolean' ? doc.verdict : undefined, checks };
}

/**
 * Every execution the BOX recorded for a testcase, newest first.
 *
 * Reads `metadata.executionHistory`, falling back to `metadata.lastExecution`
 * on builds that report only the latest one.
 */
export function boxExecutionsOf(metadata: any): BoxExecution[] {
  const out: BoxExecution[] = [];

  const history = Array.isArray(metadata?.executionHistory) ? metadata.executionHistory : [];
  for (const h of history) {
    if (!h || typeof h !== 'object') continue;
    const parsed = parseBoxExecutionDetails(h.execution_result_details);
    const startedAt = isoFromUnixSeconds(h.startTimeUnix);
    // endTimeUnix is 0 while the run is in flight, which isoFromUnixSeconds
    // rejects — so an unfinished run simply has no finishedAt.
    const finishedAt = isoFromUnixSeconds(h.endTimeUnix);
    const result = h.execution_result ? String(h.execution_result) : undefined;
    out.push({
      executionId: String(h.iterationId ?? h.executionId ?? ''),
      simulatorName: h.simulatorName ? String(h.simulatorName) : undefined,
      status: h.status ? String(h.status) : undefined,
      result,
      startedAt,
      finishedAt,
      durationSec: startedAt && finishedAt
        ? Math.max(0, Math.round((Date.parse(finishedAt) - Date.parse(startedAt)) / 1000))
        : undefined,
      running: statusIsRunning(h.status) || (!finishedAt && !result),
      verdict: parsed.verdict,
      checks: parsed.checks,
      parseError: parsed.error,
    });
  }

  // Builds that report only the latest execution, and nothing in the history.
  const last = metadata?.lastExecution;
  if (out.length === 0 && last && typeof last === 'object') {
    const parsed = parseBoxExecutionDetails(last.executionResultDetails ?? last.execution_result_details);
    // NOT_EXECUTED is what the box reports for a run that has not produced a
    // verdict yet, so it must not be carried through as though it were one.
    const rawResult = last.result ? String(last.result) : undefined;
    const result = rawResult && rawResult.toUpperCase() !== 'NOT_EXECUTED' ? rawResult : undefined;
    out.push({
      executionId: String(last.executionId ?? ''),
      simulatorName: last.simulatorName ? String(last.simulatorName) : undefined,
      status: last.status ? String(last.status) : undefined,
      result,
      startedAt: typeof last.executedOn === 'string' ? last.executedOn : undefined,
      finishedAt: undefined,
      durationSec: num(last.durationSeconds) ?? num(last.testDuration),
      running: statusIsRunning(last.status) || !result,
      verdict: parsed.verdict,
      checks: parsed.checks,
      parseError: parsed.error,
    });
  }

  // Newest first. Executions with no timestamp sort last rather than to the top,
  // where they would look like the most recent run.
  return out.sort((a, b) => {
    const at = a.startedAt ? Date.parse(a.startedAt) : -Infinity;
    const bt = b.startedAt ? Date.parse(b.startedAt) : -Infinity;
    return bt - at;
  });
}

// ───────────── Stage checks derived from the box's own record ─────────────

export type DerivedPhase = 'preflight' | 'trigger' | 'during' | 'completion' | 'post';
export type DerivedStatus = 'pass' | 'fail' | 'running';

export interface DerivedCheck {
  id: string;
  phase: DerivedPhase;
  name: string;
  /** What the check means, in the same plain language the SimQA stages use. */
  description: string;
  status: DerivedStatus;
  /** The evidence from the box's record that decided it. */
  detail?: string;
}

/**
 * CURRENTLY UNUSED — kept, with its tests, rather than deleted.
 *
 * The testcase page briefly rendered these rows so a box-driven run showed the
 * same five-stage flow as a SimQA validation. That was withdrawn: presenting a
 * reconstruction of SimQA's own report for a run SimQA never performed reads as
 * though it had, and "Validate this run" now attaches to a live box execution
 * and produces a genuine one instead. Retained for a context where the
 * reconstruction cannot be mistaken for a SimQA run.
 *
 * The five-stage flow for a run the BOX executed.
 *
 * SimQA did not perform these checks — it was not driving the run — so every
 * one of them is decided from a field the box itself recorded, and `detail`
 * names that evidence. Nothing here is assumed: a missing field is a fail, not
 * a pass, and a stage that cannot be judged yet (the run is still going) is
 * 'running' rather than guessed either way.
 *
 * This replaces an earlier version that marked the four non-measurement stages
 * 'skip'. Skips were honest but useless — the flow showed a verdict for one
 * stage out of five and "not observed" for the rest.
 */
export function boxStageChecks(x: BoxExecution): DerivedCheck[] {
  const running = x.running;
  const rows: DerivedCheck[] = [];

  // ── Before Test: what had to be true for the box to run it at all.
  rows.push({
    id: 'box-preflight-testcase', phase: 'preflight',
    name: 'Test Case Available',
    description: 'The Simnovator holds this testcase and could load it.',
    status: 'pass',
    detail: 'the box returned an execution record for this testcase',
  });
  rows.push({
    id: 'box-preflight-simulator', phase: 'preflight',
    name: 'Simulator Ready',
    description: 'A simulator was free and took the run.',
    status: x.simulatorName ? 'pass' : 'fail',
    detail: x.simulatorName ? `ran on simulator ${x.simulatorName}` : 'the box recorded no simulator for this run',
  });

  // ── Starting Test.
  rows.push({
    id: 'box-trigger-started', phase: 'trigger',
    name: 'Test Started',
    description: 'The execution began on the box.',
    status: x.startedAt ? 'pass' : 'fail',
    detail: x.startedAt ? `started ${x.startedAt}` : 'the box recorded no start time',
  });
  rows.push({
    id: 'box-trigger-execution-id', phase: 'trigger',
    name: 'Execution Created',
    description: 'The box issued an execution id for the run.',
    status: x.executionId ? 'pass' : 'fail',
    detail: x.executionId ? x.executionId : 'the box recorded no execution id',
  });

  // ── Test Completion. Unknowable until it ends, so 'running' until then.
  const terminal = String(x.status ?? '').toLowerCase();
  rows.push({
    id: 'box-completion-terminal', phase: 'completion',
    name: 'Test Completed',
    description: 'The execution reached a finished state rather than stopping short.',
    status: running ? 'running' : terminal === 'completed' ? 'pass' : 'fail',
    detail: x.status ? `box status: ${x.status}` : 'the box recorded no status',
  });
  rows.push({
    id: 'box-completion-duration', phase: 'completion',
    name: 'Test Duration Recorded',
    description: 'The run lasted a measurable amount of time.',
    status: running ? 'running' : x.durationSec !== undefined && x.durationSec > 0 ? 'pass' : 'fail',
    detail: x.durationSec !== undefined ? `ran for ${x.durationSec}s` : 'the box recorded no duration',
  });
  rows.push({
    id: 'box-completion-verdict', phase: 'completion',
    name: 'Test Result Available',
    description: 'The box produced a verdict for the run.',
    status: running ? 'running' : x.result ? 'pass' : 'fail',
    detail: x.result ? `box verdict: ${x.result}` : 'the box recorded no verdict',
  });

  // ── After Test. The one thing the record proves is that the run ended and
  //    released the simulator; SimQA's own log-export and power-off checks
  //    have no counterpart in the box's data, so they are not claimed here.
  rows.push({
    id: 'box-post-simulator-released', phase: 'post',
    name: 'Simulator Released',
    description: 'The execution ended, freeing the simulator for the next run.',
    status: running ? 'running' : x.finishedAt ? 'pass' : 'fail',
    detail: x.finishedAt ? `ended ${x.finishedAt}` : 'the box recorded no end time',
  });

  return rows;
}

// Post-processing one finished execution: fetch its log, check the rules,
// report.
//
// This is the step between "the Simnovator says the execution is over" and
// "the suite row shows a Result". It exists as its own module because two
// callers need exactly the same answer: the runner, straight after a row
// settles, and the preview endpoint, where an operator points a draft rule at
// an execution that already happened. If they computed it separately, a rule
// could preview PASS and then run FAIL, which would make the preview worse
// than useless.
//
// Three things it will not do:
//
//   * It never changes the execution's own result. That verdict belongs to
//     the box and is reported beside this one, not replaced by it.
//   * It never reports PASS off a log it could not read whole. An incomplete
//     log gives confident wrong counts, so overallOutcome() turns it into
//     ERROR — see rules.ts.
//   * It never throws at the caller. A row must not lose its execution
//     result because post-processing could not reach the box, so a failure
//     here comes back as an ERROR report with the reason in `problem`.
//
// Nothing here is shared with API Tests or API Validation.

import { fetchExecutionLogWithRetry, type FetchOpts } from './fetchLogs.ts';
import { parseMessages, messageTally } from './otaParse.ts';
import {
  evaluateRule, overallOutcome, finalResult,
  type PostRule, type RuleResult, type PostProcessOutcome,
} from './rules.ts';

/** What one execution's post-processing produced. Stored on the run step. */
export interface PostProcessReport {
  outcome: PostProcessOutcome;
  /** How many rules the row configured — 0 is why outcome can be
   *  NOT CONFIGURED, and it is kept so a report can say "3 of 4 passed". */
  rulesConfigured: number;
  passedRules: number;
  results: RuleResult[];
  /** Where the evidence came from, so a result can be re-checked. */
  log: {
    records: number;
    messages: number;
    perLayer: Record<string, number>;
    requests: number;
    complete: boolean;
  };
  /**
   * Every OTA message the log held, with its count — the evidence.
   *
   * Kept with the result rather than recomputed later, because the box's logs
   * are not kept forever: a rule that expected 2 and found 11 can still be
   * explained next week. It is also what the editor offers as message names,
   * so the expected numbers are set from the log instead of from memory.
   */
  tally: Array<{ name: string; channel: string; count: number }>;
  /** Said whenever the outcome is ERROR: what stopped it. */
  problem?: string;
  /** The execution's own verdict, carried through untouched. */
  executionResult?: string;
  /** Execution result combined with ours — see finalResult() in rules.ts. */
  finalResult?: string;
}

/** The rules as the editor stores them, narrowed to what the evaluator needs. */
export function asRules(stored: Array<Record<string, unknown>> | undefined): PostRule[] {
  if (!Array.isArray(stored)) return [];
  // A rule with no message name can never be checked, and a rule that cannot
  // be checked would fail the row for nothing. The editor warns about it; the
  // suite route drops it; this is the last of the three, because a suite
  // saved before that check existed still holds one.
  const named = (r: Record<string, unknown>): boolean =>
    typeof r.messageName === 'string' && r.messageName.trim() !== '';
  return stored.filter((r) => !!r && typeof r === 'object' && named(r)) as unknown as PostRule[];
}

/** A report for a row that configured nothing — no fetch, no verdict of ours. */
export function notConfigured(executionResult?: string): PostProcessReport {
  return {
    outcome: 'NOT CONFIGURED',
    rulesConfigured: 0,
    passedRules: 0,
    results: [],
    tally: [],
    log: { records: 0, messages: 0, perLayer: {}, requests: 0, complete: true },
    ...(executionResult === undefined ? {} : { executionResult, finalResult: executionResult }),
  };
}

/**
 * A report for rules that could not be checked at all — no execution id, for
 * instance, so there is no log to read.
 *
 * ERROR rather than FAIL: nothing was learned about the product under test.
 * It still refuses to let a PASS stand, because the rules the row asked for
 * went unchecked.
 */
export function errorReport(
  problem: string, rulesConfigured: number, executionResult?: string,
): PostProcessReport {
  return {
    outcome: 'ERROR',
    rulesConfigured,
    passedRules: 0,
    results: [],
    tally: [],
    log: { records: 0, messages: 0, perLayer: {}, requests: 0, complete: false },
    problem,
    ...(executionResult === undefined
      ? {}
      : { executionResult, finalResult: finalResult(executionResult, 'ERROR') }),
  };
}

export async function postProcessExecution(
  opts: FetchOpts & {
    rules: PostRule[];
    /** The box's own verdict for this execution, for finalResult. */
    executionResult?: string;
    /** Log fetch attempts. The runner asks for several: the box finishes the
     *  execution before it has finished writing the log. */
    attempts?: number;
    gapMs?: number;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<PostProcessReport> {
  const rules = opts.rules ?? [];
  if (rules.length === 0) return notConfigured(opts.executionResult);

  const withExec = (r: PostProcessReport): PostProcessReport => ({
    ...r,
    ...(opts.executionResult === undefined
      ? {}
      : {
          executionResult: opts.executionResult,
          finalResult: finalResult(opts.executionResult, r.outcome),
        }),
  });

  let log;
  try {
    log = await fetchExecutionLogWithRetry(opts);
  } catch (e: any) {
    // Reaching the box failed outright. ERROR, not FAIL: nothing was learned
    // about the product under test.
    return withExec({
      outcome: 'ERROR',
      rulesConfigured: rules.length,
      passedRules: 0,
      results: [],
      tally: [],
      log: { records: 0, messages: 0, perLayer: {}, requests: 0, complete: false },
      problem: `could not read the execution log: ${e?.message ?? e}`,
    });
  }

  const messages = parseMessages(log.records);
  const usable = { usable: log.complete && log.records.length > 0, problem: log.problem };
  const results = rules.map((r) => evaluateRule(r, messages, usable));
  const outcome = overallOutcome(results, rules.length, usable.usable);

  return withExec({
    outcome,
    rulesConfigured: rules.length,
    passedRules: results.filter((r) => r.pass).length,
    results,
    tally: messageTally(messages),
    log: {
      records: log.records.length,
      messages: messages.length,
      perLayer: log.perLayer,
      requests: log.requests,
      complete: log.complete,
    },
    ...(usable.usable ? {} : { problem: log.problem ?? 'the execution log could not be read whole' }),
  });
}

/** One line for the run log: what post-processing decided and on what. */
export function reportLine(r: PostProcessReport): string {
  if (r.outcome === 'NOT CONFIGURED') return 'post-processing: no rules configured';
  const of = `${r.passedRules}/${r.rulesConfigured} rule${r.rulesConfigured === 1 ? '' : 's'} passed`;
  const src = `${r.log.messages} OTA message${r.log.messages === 1 ? '' : 's'} in ${r.log.records} log records`;
  const why = r.problem ? ` — ${r.problem}` : '';
  const failed = r.results.filter((x) => !x.pass).map((x) => `${x.messageName}: ${x.failure ?? 'failed'}`);
  // Joined with "; " and never with the middle dot: the dot is what
  // separates the run narrative's own steps, and a post-processing line
  // carrying one inside it split into two steps that each read as nonsense.
  return `post-processing: ${r.outcome} (${of}, ${src})${why}`
    + (failed.length ? `; ${failed.join('; ')}` : '');
}

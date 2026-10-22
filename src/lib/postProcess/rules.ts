// Post-processing rules, and deciding whether one passed.
//
// A rule asks one question of one OTA message type. The three modes from the
// requirement, in the terms this module uses:
//
//   'count'            how many <message> are there?
//   'content'          how many <message> contain <string(s)>?
//   'countAndContent'  both, and both must hold.
//
// Three different things can be counted, and conflating them is the easiest
// way to get a wrong answer:
//
//   messages          instances of the message in the log
//   matchingMessages  instances whose body satisfies the string condition —
//                     a message containing the string three times counts ONCE
//   occurrences       every appearance of the literal string across those
//                     bodies — the same message counts three times
//
// Measured on a real mobility execution: 6 "RRC reconfiguration", of which 1
// contains "reconfigurationWithSync" (the handover), appearing once. So
// messages=6, matchingMessages=1, occurrences=1. Had the handover carried two
// copies, matchingMessages would still be 1 and occurrences 2.
//
// The rule that governs everything below: a rule that could not be evaluated
// does NOT pass. Not "passes because nothing contradicted it" — the
// requirement is explicit, and a post-processing step that reports PASS when
// it could not read the log is worse than no post-processing at all.
//
// Pure, imports only the message type from otaParse (which imports nothing),
// so node --test can load this directly.

import { type OtaMessage, messagesNamed, normaliseName } from './otaParse.ts';

export type ValidationMode = 'count' | 'content' | 'countAndContent';
/** ALL: every string present. ANY: at least one. NONE: none present. */
export type StringCondition = 'ALL' | 'ANY' | 'NONE';
export type MatchMode = 'contains' | 'exact';
export type Comparison = 'eq' | 'min' | 'max';

export interface PostRule {
  /** Stable within the test case, so results can be matched to the rule. */
  id: string;
  /** The RRC/NAS message, in any spelling — see normaliseName. */
  messageName: string;
  mode: ValidationMode;
  /** Content modes only. */
  expectedStrings?: string[];
  condition?: StringCondition;
  matchMode?: MatchMode;
  /** How counts are compared. Equality unless asked otherwise. */
  comparison?: Comparison;
  /** Total instances of the message. Used by 'count' and 'countAndContent'. */
  expectedMessageCount?: number;
  /** Instances satisfying the string condition. Used by the content modes. */
  expectedMatchingCount?: number;
  /** Literal appearances across those bodies. Only when asked for. */
  expectedOccurrenceCount?: number;
}

export interface CountCheck {
  label: string;
  expected: number;
  actual: number;
  comparison: Comparison;
  pass: boolean;
}

export interface RuleResult {
  ruleId: string;
  messageName: string;
  mode: ValidationMode;
  /** PASS only when every check held AND the log could be read. */
  pass: boolean;
  /** Every count this rule asked about, with expected beside actual. */
  checks: CountCheck[];
  actualMessageCount: number;
  actualMatchingCount?: number;
  actualOccurrenceCount?: number;
  expectedCondition?: string;
  /** Why it failed, in words — empty when it passed. */
  failure?: string;
  /** Where the matching messages were, so a result points back at the log. */
  messageIndexes: number[];
}

/** Whether the log this rule is being evaluated against can be trusted. */
export interface LogContext {
  /** False when the fetch failed, was incomplete, or belonged elsewhere. */
  usable: boolean;
  /** Said in the result when it is not usable. */
  problem?: string;
}

const cmp = (actual: number, expected: number, how: Comparison): boolean =>
  how === 'min' ? actual >= expected : how === 'max' ? actual <= expected : actual === expected;

const cmpWord = (how: Comparison): string =>
  how === 'min' ? 'at least' : how === 'max' ? 'at most' : 'exactly';

/** Does one message body satisfy the rule's string condition? */
export function bodyMatches(body: string, rule: PostRule): boolean {
  const strings = (rule.expectedStrings ?? []).filter((s) => String(s ?? '').length > 0);
  if (strings.length === 0) return false;
  const exact = rule.matchMode === 'exact';
  // 'exact' means the body IS the string, which is almost never what a
  // decoded message is — it is offered because the requirement asks for
  // literal exact matching, and it is deliberately strict.
  const has = (s: string) => (exact ? body.trim() === s : body.includes(s));
  const condition = rule.condition ?? 'ALL';
  if (condition === 'ANY') return strings.some(has);
  if (condition === 'NONE') return !strings.some(has);
  return strings.every(has);
}

/** Every appearance of every configured string across these bodies. */
export function countOccurrences(bodies: string[], rule: PostRule): number {
  const strings = (rule.expectedStrings ?? []).filter(Boolean);
  let n = 0;
  for (const body of bodies) {
    for (const s of strings) {
      if (!s) continue;
      let at = body.indexOf(s);
      while (at >= 0) { n += 1; at = body.indexOf(s, at + s.length); }
    }
  }
  return n;
}

/** A readable description of the content condition, for the report. */
export function conditionText(rule: PostRule): string | undefined {
  const strings = (rule.expectedStrings ?? []).filter(Boolean);
  if (strings.length === 0) return undefined;
  const how = rule.matchMode === 'exact' ? 'exactly equals' : 'contains';
  if (strings.length === 1) return `${how} "${strings[0]}"`;
  const c = rule.condition ?? 'ALL';
  const joiner = c === 'ANY' ? 'any of' : c === 'NONE' ? 'none of' : 'all of';
  return `${how} ${joiner}: ${strings.map((s) => `"${s}"`).join(', ')}`;
}

/**
 * Evaluate one rule against the messages found in one log.
 *
 * `log.usable` is the gate: an unreadable or foreign log fails every rule
 * with that reason, rather than being treated as "no messages found", which
 * would look identical to a genuine zero and could pass a max-count rule.
 */
export function evaluateRule(rule: PostRule, messages: OtaMessage[], log: LogContext): RuleResult {
  const base: RuleResult = {
    ruleId: rule.id,
    messageName: rule.messageName,
    mode: rule.mode,
    pass: false,
    checks: [],
    actualMessageCount: 0,
    expectedCondition: conditionText(rule),
    messageIndexes: [],
  };

  if (!log.usable) {
    return { ...base, failure: log.problem ?? 'the execution log could not be read, so this rule could not be evaluated' };
  }
  if (!normaliseName(rule.messageName)) {
    return { ...base, failure: 'the rule names no OTA message' };
  }

  const found = messagesNamed(messages, rule.messageName);
  const comparison = rule.comparison ?? 'eq';
  const checks: CountCheck[] = [];

  // Total instances — asked by 'count' and 'countAndContent'.
  if (rule.mode === 'count' || rule.mode === 'countAndContent') {
    const expected = Number(rule.expectedMessageCount ?? 0);
    checks.push({
      label: 'Total message count',
      expected, actual: found.length, comparison,
      pass: cmp(found.length, expected, comparison),
    });
  }

  let matching: OtaMessage[] | undefined;
  let occurrences: number | undefined;

  if (rule.mode === 'content' || rule.mode === 'countAndContent') {
    const strings = (rule.expectedStrings ?? []).filter(Boolean);
    if (strings.length === 0) {
      return {
        ...base,
        actualMessageCount: found.length,
        messageIndexes: found.map((m) => m.index ?? -1).filter((i) => i >= 0),
        failure: 'this mode validates message content, but no expected string is configured',
      };
    }
    matching = found.filter((m) => bodyMatches(m.body, rule));
    checks.push({
      label: 'Matching message count',
      expected: Number(rule.expectedMatchingCount ?? 0),
      actual: matching.length,
      comparison,
      pass: cmp(matching.length, Number(rule.expectedMatchingCount ?? 0), comparison),
    });

    // Only when the rule asks for it: counting every appearance is a
    // different question from counting the messages that contain one.
    if (rule.expectedOccurrenceCount !== undefined && rule.expectedOccurrenceCount !== null) {
      occurrences = countOccurrences(found.map((m) => m.body), rule);
      checks.push({
        label: 'String occurrence count',
        expected: Number(rule.expectedOccurrenceCount),
        actual: occurrences,
        comparison,
        pass: cmp(occurrences, Number(rule.expectedOccurrenceCount), comparison),
      });
    }
  }

  const failed = checks.filter((c) => !c.pass);
  const indexes = (matching ?? found).map((m) => m.index ?? -1).filter((i) => i >= 0);

  return {
    ...base,
    pass: checks.length > 0 && failed.length === 0,
    checks,
    actualMessageCount: found.length,
    actualMatchingCount: matching?.length,
    actualOccurrenceCount: occurrences,
    messageIndexes: indexes,
    failure: failed.length === 0
      ? (checks.length === 0 ? 'the rule configures nothing to check' : undefined)
      : failed.map((c) => `${c.label}: expected ${cmpWord(c.comparison)} ${c.expected}, found ${c.actual}`).join('; ')
        + (found.length === 0 ? ` — no "${rule.messageName}" message appears in this log` : ''),
  };
}

export type PostProcessOutcome = 'PASS' | 'FAIL' | 'NOT CONFIGURED' | 'ERROR';

/** The result for one iteration: every rule, and the verdict over them. */
export function overallOutcome(results: RuleResult[], rulesConfigured: number, logUsable: boolean): PostProcessOutcome {
  if (rulesConfigured === 0) return 'NOT CONFIGURED';
  // An unreadable log is an error, not a failure of the product under test.
  if (!logUsable) return 'ERROR';
  if (results.length < rulesConfigured) return 'ERROR';
  return results.every((r) => r.pass) ? 'PASS' : 'FAIL';
}

/**
 * The final result, combining the execution's own verdict with ours.
 *
 * The execution result is never overwritten — this is a third value beside
 * it. NOT CONFIGURED preserves the execution's verdict exactly; anything
 * that could not be established reliably refuses to report PASS.
 */
export function finalResult(execution: string, post: PostProcessOutcome): string {
  const exec = String(execution ?? '').toUpperCase();
  if (post === 'NOT CONFIGURED') return execution;
  if (post === 'ERROR') return exec === 'PASS' ? 'FAIL' : execution;
  if (post === 'FAIL') return 'FAIL';
  return exec === 'PASS' ? 'PASS' : execution;
}

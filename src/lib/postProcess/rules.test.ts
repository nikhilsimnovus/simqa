import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMessages } from './otaParse.ts';
import {
  evaluateRule, overallOutcome, finalResult, bodyMatches, countOccurrences, conditionText,
  type PostRule,
} from './rules.ts';

const OK = { usable: true };

/** A log shaped like the real mobility execution: six RRC reconfigurations,
 *  one of which carries reconfigurationWithSync (the handover). */
const rec = (layer: string, index: number, entries: string[]) => ({
  executionId: 'e1', testCaseId: 'tc', layer, direction: 'DL', cellId: 0, ueId: 1, index,
  logData: entries,
});
const reconf = (body: string) => `DCCH-NR: RRC reconfiguration\n{\n${body}\n}`;
const REAL = parseMessages([
  rec('RRC', 143, [reconf('  radioBearerConfig { }')]),
  rec('RRC', 177, [reconf('  measConfig { }')]),
  rec('RRC', 398, [reconf('  radioBearerConfig { }')]),
  rec('RRC', 600, [reconf('  measConfig { }')]),
  rec('RRC', 1696, [reconf('  spCellConfig {\n    reconfigurationWithSync {\n      physCellId 501\n    }\n  }')]),
  rec('RRC', 1775, [reconf('  measConfig { }')]),
  rec('RRC', 1800, ['DCCH-NR: RRC reconfiguration complete\n{ }']),
  rec('NAS', 900, ['5GMM: Registration accept\n{\n  registrationResult 1\n}']),
  rec('PHY', 2, ['n_id_cell=501']),
]);

const R = (over: Partial<PostRule>): PostRule =>
  ({ id: 'r1', messageName: 'RRCReconfiguration', mode: 'count', ...over }) as PostRule;

// ── 1-4: message counting ────────────────────────────────────────────────

test('correct total RRC message count passes', () => {
  const r = evaluateRule(R({ mode: 'count', expectedMessageCount: 6 }), REAL, OK);
  assert.equal(r.pass, true);
  assert.equal(r.actualMessageCount, 6);
  assert.equal(r.failure, undefined);
});

test('incorrect total RRC message count fails, and says both numbers', () => {
  const r = evaluateRule(R({ mode: 'count', expectedMessageCount: 5 }), REAL, OK);
  assert.equal(r.pass, false);
  assert.match(r.failure!, /Total message count: expected exactly 5, found 6/);
});

test('correct total NAS message count passes', () => {
  const r = evaluateRule(R({ messageName: 'Registration Accept', mode: 'count', expectedMessageCount: 1 }), REAL, OK);
  assert.equal(r.pass, true);
  assert.equal(r.actualMessageCount, 1);
});

test('a missing message fails when a positive count is expected, and says so', () => {
  const r = evaluateRule(R({ messageName: 'RRCRelease', mode: 'count', expectedMessageCount: 1 }), REAL, OK);
  assert.equal(r.pass, false);
  assert.equal(r.actualMessageCount, 0);
  assert.match(r.failure!, /no "RRCRelease" message appears in this log/);
});

// ── 5-8: content and the three count types ───────────────────────────────

test('an expected string is found in the right message', () => {
  const r = evaluateRule(R({
    mode: 'content', expectedStrings: ['reconfigurationWithSync'], expectedMatchingCount: 1,
  }), REAL, OK);
  assert.equal(r.pass, true);
  assert.equal(r.actualMatchingCount, 1);
  assert.deepEqual(r.messageIndexes, [1696], 'and points at the message it was in');
});

test('an absent string fails rather than passing quietly', () => {
  const r = evaluateRule(R({
    mode: 'content', expectedStrings: ['nonExistentField'], expectedMatchingCount: 1,
  }), REAL, OK);
  assert.equal(r.pass, false);
  assert.equal(r.actualMatchingCount, 0);
});

test('matching message count counts MESSAGES, not appearances', () => {
  // One message carrying the string twice is one matching message.
  const twice = parseMessages([rec('RRC', 1, [reconf('  a reconfigurationWithSync b reconfigurationWithSync')])]);
  const r = evaluateRule(R({
    mode: 'content', expectedStrings: ['reconfigurationWithSync'], expectedMatchingCount: 1,
  }), twice, OK);
  assert.equal(r.pass, true);
  assert.equal(r.actualMatchingCount, 1);
});

test('literal occurrence count counts every appearance separately', () => {
  const twice = parseMessages([rec('RRC', 1, [reconf('  a reconfigurationWithSync b reconfigurationWithSync')])]);
  const r = evaluateRule(R({
    mode: 'content', expectedStrings: ['reconfigurationWithSync'],
    expectedMatchingCount: 1, expectedOccurrenceCount: 2,
  }), twice, OK);
  assert.equal(r.pass, true);
  assert.equal(r.actualMatchingCount, 1);
  assert.equal(r.actualOccurrenceCount, 2, 'the same message counted twice here');
});

// ── 9-11: conditions, combined mode, multiple rules ──────────────────────

test('ALL requires every string; ANY requires one; NONE requires neither', () => {
  const msgs = parseMessages([rec('RRC', 1, [reconf('  spCellConfig { reconfigurationWithSync { } }')])]);
  const base = { mode: 'content' as const, expectedMatchingCount: 1 };
  assert.equal(evaluateRule(R({ ...base, expectedStrings: ['reconfigurationWithSync', 'spCellConfig'], condition: 'ALL' }), msgs, OK).pass, true);
  assert.equal(evaluateRule(R({ ...base, expectedStrings: ['reconfigurationWithSync', 'absent'], condition: 'ALL' }), msgs, OK).pass, false);
  assert.equal(evaluateRule(R({ ...base, expectedStrings: ['reconfigurationWithSync', 'absent'], condition: 'ANY' }), msgs, OK).pass, true);
  assert.equal(evaluateRule(R({ ...base, expectedStrings: ['absent'], condition: 'NONE' }), msgs, OK).pass, true);
  assert.equal(evaluateRule(R({ ...base, expectedStrings: ['reconfigurationWithSync'], condition: 'NONE' }), msgs, OK).pass, false);
});

test('count and content together: both must hold', () => {
  const both = R({
    mode: 'countAndContent', expectedMessageCount: 6,
    expectedStrings: ['reconfigurationWithSync'], expectedMatchingCount: 1,
  });
  const r = evaluateRule(both, REAL, OK);
  assert.equal(r.pass, true);
  assert.equal(r.checks.length, 2);

  // The total is right but the matching count is not: still a failure.
  const bad = evaluateRule({ ...both, expectedMatchingCount: 3 }, REAL, OK);
  assert.equal(bad.pass, false);
  assert.match(bad.failure!, /Matching message count: expected exactly 3, found 1/);
  assert.equal(bad.checks.find((c) => c.label === 'Total message count')!.pass, true,
    'and the check that did hold is still reported as holding');
});

test('rules are independent, and the overall result is over all of them', () => {
  const rules: PostRule[] = [
    R({ id: 'a', mode: 'count', expectedMessageCount: 6 }),
    R({ id: 'b', mode: 'content', expectedStrings: ['reconfigurationWithSync'], expectedMatchingCount: 1 }),
    R({ id: 'c', messageName: 'Registration Accept', mode: 'count', expectedMessageCount: 1 }),
    R({ id: 'd', messageName: 'Registration Accept', mode: 'content', expectedStrings: ['registrationResult'], expectedMatchingCount: 1 }),
  ];
  const results = rules.map((rule) => evaluateRule(rule, REAL, OK));
  assert.deepEqual(results.map((r) => r.pass), [true, true, true, true]);
  assert.equal(overallOutcome(results, rules.length, true), 'PASS');

  // A string from one message must not satisfy a rule about another.
  const crossed = evaluateRule(
    R({ id: 'e', messageName: 'Registration Accept', mode: 'content', expectedStrings: ['reconfigurationWithSync'], expectedMatchingCount: 1 }),
    REAL, OK);
  assert.equal(crossed.pass, false, 'reconfigurationWithSync is in an RRC message, not the NAS one');
});

// ── 14-16: never a false pass ────────────────────────────────────────────

test('an unreadable log fails every rule and is an ERROR overall', () => {
  const bad = { usable: false, problem: 'the log API returned 500 after 3 attempts' };
  const r = evaluateRule(R({ mode: 'count', expectedMessageCount: 0 }), [], bad);
  assert.equal(r.pass, false, 'even a zero-count rule must not pass on an unread log');
  assert.match(r.failure!, /returned 500 after 3 attempts/);
  assert.equal(overallOutcome([r], 1, false), 'ERROR');
});

test('fewer results than rules is an ERROR, never a PASS', () => {
  const r = evaluateRule(R({ mode: 'count', expectedMessageCount: 6 }), REAL, OK);
  assert.equal(overallOutcome([r], 3, true), 'ERROR', 'two rules never got a result');
});

test('no rules configured preserves the execution result exactly', () => {
  assert.equal(overallOutcome([], 0, true), 'NOT CONFIGURED');
  assert.equal(finalResult('PASS', 'NOT CONFIGURED'), 'PASS');
  assert.equal(finalResult('FAIL', 'NOT CONFIGURED'), 'FAIL');
  assert.equal(finalResult('Aborted', 'NOT CONFIGURED'), 'Aborted');
});

test('an execution failure can never become a final PASS', () => {
  assert.equal(finalResult('FAIL', 'PASS'), 'FAIL');
  assert.equal(finalResult('FAIL', 'FAIL'), 'FAIL');
  assert.equal(finalResult('PASS', 'PASS'), 'PASS');
  assert.equal(finalResult('PASS', 'FAIL'), 'FAIL');
  assert.equal(finalResult('PASS', 'ERROR'), 'FAIL', 'an unreliable check must not leave a PASS standing');
});

test('a content rule with no string configured fails rather than passing', () => {
  const r = evaluateRule(R({ mode: 'content', expectedMatchingCount: 1 }), REAL, OK);
  assert.equal(r.pass, false);
  assert.match(r.failure!, /no expected string is configured/);
});

test('minimum and maximum comparisons work where equality is too strict', () => {
  assert.equal(evaluateRule(R({ mode: 'count', expectedMessageCount: 4, comparison: 'min' }), REAL, OK).pass, true);
  assert.equal(evaluateRule(R({ mode: 'count', expectedMessageCount: 8, comparison: 'min' }), REAL, OK).pass, false);
  assert.equal(evaluateRule(R({ mode: 'count', expectedMessageCount: 8, comparison: 'max' }), REAL, OK).pass, true);
  const r = evaluateRule(R({ mode: 'count', expectedMessageCount: 8, comparison: 'min' }), REAL, OK);
  assert.match(r.failure!, /expected at least 8, found 6/);
});

// ── helpers ──────────────────────────────────────────────────────────────

test('bodyMatches and countOccurrences behave on the edges', () => {
  assert.equal(bodyMatches('abc', { id: 'x', messageName: 'm', mode: 'content' }), false, 'no strings');
  assert.equal(bodyMatches('abc', { id: 'x', messageName: 'm', mode: 'content', expectedStrings: ['abc'], matchMode: 'exact' }), true);
  assert.equal(bodyMatches('abcd', { id: 'x', messageName: 'm', mode: 'content', expectedStrings: ['abc'], matchMode: 'exact' }), false);
  assert.equal(countOccurrences(['aXaXa'], { id: 'x', messageName: 'm', mode: 'content', expectedStrings: ['X'] }), 2);
  assert.equal(countOccurrences([], { id: 'x', messageName: 'm', mode: 'content', expectedStrings: ['X'] }), 0);
});

test('the condition reads back in words for the report', () => {
  assert.equal(conditionText({ id: 'x', messageName: 'm', mode: 'content', expectedStrings: ['a'] }), 'contains "a"');
  assert.equal(conditionText({ id: 'x', messageName: 'm', mode: 'content', expectedStrings: ['a', 'b'], condition: 'ANY' }),
    'contains any of: "a", "b"');
  assert.equal(conditionText({ id: 'x', messageName: 'm', mode: 'count' }), undefined);
});

// ── the five comparisons, and the punctuation the box does not print ──────

test('a count can be asked for with =, >=, <=, > or <', () => {
  const at = (comparison: any, expected: number) =>
    evaluateRule(R({ mode: 'count', expectedMessageCount: expected, comparison }), REAL, OK).pass;
  // REAL holds 6 "RRC reconfiguration".
  assert.equal(at('eq', 6), true);
  assert.equal(at('eq', 5), false);
  assert.equal(at('min', 6), true);
  assert.equal(at('max', 6), true);
  assert.equal(at('gt', 5), true, '6 > 5');
  assert.equal(at('gt', 6), false, '6 is not > 6');
  assert.equal(at('lt', 7), true, '6 < 7');
  assert.equal(at('lt', 6), false, '6 is not < 6');
});

test('the strict comparisons say so when they fail', () => {
  const r = evaluateRule(R({ mode: 'count', expectedMessageCount: 6, comparison: 'gt' }), REAL, OK);
  assert.match(r.failure!, /expected more than 6, found 6/);
  const l = evaluateRule(R({ mode: 'count', expectedMessageCount: 6, comparison: 'lt' }), REAL, OK);
  assert.match(l.failure!, /expected fewer than 6, found 6/);
});

test('quotes and colons are not what a rule turns on', () => {
  // The box prints ASN.1 value notation; people write the spec's spelling.
  // Measured on execution 01a16490 (AIO_5GSA_Redcap): the log line is
  // "                supportOfRedCap-r17 supported,".
  const body = 'redCapParameters-r17 {\n  supportOfRedCap-r17 supported,\n  supportOf16DRB-RedCap-r17 supported\n}';
  const rule = (s: string): PostRule =>
    ({ id: 'x', messageName: 'UE capability information', mode: 'content', expectedStrings: [s] });
  assert.equal(bodyMatches(body, rule('supportOfRedCap-r17: "supported"')), true);
  assert.equal(bodyMatches(body, rule('supportOfRedCap-r17 supported')), true);
  assert.equal(bodyMatches(body, rule('supportOfRedCap-r17:supported')), true);
  // What it must still refuse: a different field, and a different value.
  assert.equal(bodyMatches(body, rule('supportOfRedCapX-r17: "supported"')), false);
  assert.equal(bodyMatches(body, rule('supportOfRedCap-r17: "notSupported"')), false);
  // And the occurrence count follows the same form, so a message that
  // matches can never count zero occurrences of what matched it.
  assert.equal(countOccurrences([body], rule('supportOfRedCap-r17: "supported"')), 1);
});

test('exact mode stays literal — it is the strict option on purpose', () => {
  const rule: PostRule = { id: 'x', messageName: 'm', mode: 'content', matchMode: 'exact', expectedStrings: ['a: "b"'] };
  assert.equal(bodyMatches('a: "b"', rule), true);
  assert.equal(bodyMatches('a b', rule), false);
});

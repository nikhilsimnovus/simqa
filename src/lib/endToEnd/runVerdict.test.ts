// The run's RESULT: the box's verdict where it published one, SimQA's own
// rule where it did not.
//
// The fixtures are real: `SA_1cell_4x2_1UEs_http` on 192.168.1.102, execution
// 01a1012d, 3 October 2026 — the box reported PASS while SimQA's UE-count and
// throughput-stability checks failed, because the run carried traffic for 45
// of its 614 seconds. That disagreement is the case this module exists for, so
// it is the case it is tested against.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { decideRunResult, boxVerdictOf } = await import('./runVerdict.ts');

const verdictRow = (result: string) => ({
  id: 'completion-verdict-present', status: 'pass' as const, severity: 'normal' as const,
  detail: `result=${result}`,
});
const pass = (id: string) => ({ id, status: 'pass' as const, severity: 'normal' as const });
const fail = (id: string, severity: 'critical' | 'normal' = 'normal') => ({ id, status: 'fail' as const, severity });
const skip = (id: string, severity: 'critical' | 'normal' = 'normal', skippedReason?: string) =>
  ({ id, status: 'skip' as const, severity, skippedReason });

test('a box PASS makes the run pass, even with SimQA checks failing', () => {
  const r = decideRunResult({
    results: [
      verdictRow('PASS'),
      fail('during-ue-count-stable'),
      fail('during-throughput-stability'),
      ...Array.from({ length: 20 }, (_, i) => pass(`check-${i}`)),
    ],
  });
  assert.equal(r.ok, true);
  assert.equal(r.source, 'box');
  // And it says where the result came from, and that the checks disagreed.
  assert.match(r.finalDetail, /Simnovator's verdict \(PASS\)/);
  assert.match(r.finalDetail, /2 failed/);
});

test('a box FAIL fails the run, even with every SimQA check passing', () => {
  const r = decideRunResult({ results: [verdictRow('FAIL'), pass('a'), pass('b')] });
  assert.equal(r.ok, false);
  assert.equal(r.source, 'box');
  assert.match(r.finalDetail, /\(FAIL\)/);
});

test('agreement is stated as agreement, not as silence', () => {
  const r = decideRunResult({ results: [verdictRow('PASS'), pass('a'), skip('b')] });
  assert.equal(r.ok, true);
  assert.match(r.finalDetail, /own checks agree/);
});

test('INCOMPLETE is a verdict and it is not a pass', () => {
  const r = decideRunResult({ results: [verdictRow('INCOMPLETE'), pass('a')] });
  assert.equal(r.ok, false);
  assert.equal(r.source, 'box');
});

test('NOT_EXECUTED is the box having no opinion, so SimQA decides', () => {
  const r = decideRunResult({ results: [verdictRow('NOT_EXECUTED'), pass('a'), fail('b', 'critical')] });
  assert.equal(r.source, 'simqa');
  assert.equal(r.ok, false);
  assert.match(r.finalDetail, /1 critical check\(s\) failed/);
});

test('a verdict check that did not pass is not a verdict', () => {
  assert.equal(boxVerdictOf([{ id: 'completion-verdict-present', status: 'fail', detail: 'result=PASS' }]), undefined);
  assert.equal(boxVerdictOf([{ id: 'completion-verdict-present', status: 'skip' }]), undefined);
  assert.equal(boxVerdictOf([]), undefined);
});

test('aborting beats everything, including a box PASS', () => {
  const r = decideRunResult({ canceled: true, results: [verdictRow('PASS'), pass('a')] });
  assert.equal(r.ok, false);
  assert.equal(r.finalDetail, 'aborted');
  assert.equal(r.source, 'aborted');
});

// ── Without a verdict, the old rule stands, unchanged ────────────────

test('a critical failure still fails a run the box said nothing about', () => {
  const r = decideRunResult({ results: [pass('a'), fail('preflight-login', 'critical')] });
  assert.equal(r.ok, false);
  assert.match(r.finalDetail, /critical check\(s\) failed/);
});

test('non-critical failures alone still pass', () => {
  const r = decideRunResult({ results: [pass('a'), pass('b'), fail('c')] });
  assert.equal(r.ok, true);
  assert.match(r.finalDetail, /non-critical fail/);
});

test('a run where nothing ran is inconclusive, not a pass', () => {
  const r = decideRunResult({ results: [skip('a'), skip('b')] });
  assert.equal(r.ok, false);
  assert.match(r.finalDetail, /nothing ran successfully/);
});

test('critical checks skipped with nothing passing is incomplete', () => {
  const r = decideRunResult({ results: [skip('preflight-login', 'critical', 'no credentials')] });
  assert.equal(r.ok, false);
  assert.match(r.finalDetail, /validation incomplete/);
  assert.match(r.finalDetail, /no credentials/);
});

test('a clean run says so', () => {
  const r = decideRunResult({ results: [pass('a'), pass('b'), pass('c')] });
  assert.equal(r.ok, true);
  assert.equal(r.finalDetail, 'all 3 check(s) passed');
});

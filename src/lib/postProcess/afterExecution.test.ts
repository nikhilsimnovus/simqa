import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  postProcessExecution, notConfigured, asRules, reportLine,
} from './afterExecution.ts';

const EID = '01a15f34-ba8c-79f3-8682-b5b210b6344c';

/** A stand-in box serving one page per layer, like the real endpoint does for
 *  a short execution: page 1 has the records, page 2 is empty. */
function box(records: Record<string, Array<Record<string, unknown>>>, opts: { fail?: boolean } = {}) {
  let calls = 0;
  const impl = (async (url: string) => {
    calls += 1;
    if (opts.fail) throw new Error('connect ECONNREFUSED');
    const u = new URL(url);
    const layer = u.searchParams.get('layer') ?? '';
    const offset = Number(u.searchParams.get('offset') ?? '0');
    const items = offset === 0 ? (records[layer] ?? []) : [];
    return { ok: true, status: 200, json: async () => ({ items }) } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls: () => calls };
}

const rec = (index: number, layer: string, line: string) =>
  ({ executionId: EID, layer, index, logData: [line] });

const rule = (over: Record<string, unknown> = {}) => ({
  id: 'r1', messageName: 'RRC reconfiguration', mode: 'count' as const,
  comparison: 'eq' as const, expectedMessageCount: 2, ...over,
});

const opts = (impl: typeof fetch, rules: any[], executionResult?: string) =>
  ({ host: 'h', token: 't', executionId: EID, fetchImpl: impl, rules, executionResult, attempts: 1 });

test('a row with no rules is NOT CONFIGURED and never asks the box for a log', async () => {
  const { impl, calls } = box({ RRC: [rec(1, 'RRC', 'DL-DCCH: RRC reconfiguration')] });
  const r = await postProcessExecution(opts(impl, [], 'PASS'));
  assert.equal(r.outcome, 'NOT CONFIGURED');
  assert.equal(calls(), 0);
  // The execution's verdict is what the row still reports.
  assert.equal(r.finalResult, 'PASS');
});

test('rules that hold give PASS, and the execution result is left alone', async () => {
  const { impl } = box({
    RRC: [
      rec(1, 'RRC', 'DL-DCCH: RRC reconfiguration'),
      rec(2, 'RRC', 'DL-DCCH: RRC reconfiguration'),
      rec(3, 'RRC', 'UL-DCCH: RRC reconfiguration complete'),
    ],
  });
  const r = await postProcessExecution(opts(impl, [rule()], 'PASS'));
  assert.equal(r.outcome, 'PASS');
  assert.equal(r.passedRules, 1);
  assert.equal(r.rulesConfigured, 1);
  assert.equal(r.executionResult, 'PASS');
  assert.equal(r.finalResult, 'PASS');
  // "RRC reconfiguration complete" is a different message, not a third one.
  assert.equal(r.results[0].actualMessageCount, 2);
});

test('a rule that fails turns a PASSing execution into a FAIL result', async () => {
  const { impl } = box({ RRC: [rec(1, 'RRC', 'DL-DCCH: RRC reconfiguration')] });
  const r = await postProcessExecution(opts(impl, [rule()], 'PASS'));
  assert.equal(r.outcome, 'FAIL');
  assert.equal(r.finalResult, 'FAIL');
  // And the box's own verdict is still there to be shown beside it.
  assert.equal(r.executionResult, 'PASS');
});

test('a box that cannot be reached is ERROR, never PASS, and does not throw', async () => {
  const { impl } = box({}, { fail: true });
  const r = await postProcessExecution(opts(impl, [rule()], 'PASS'));
  assert.equal(r.outcome, 'ERROR');
  assert.ok(r.problem && r.problem.length > 0);
  // An ERROR must not let a PASS stand: nothing was established.
  assert.equal(r.finalResult, 'FAIL');
});

test('an execution that already FAILED is not promoted by a passing rule', async () => {
  const { impl } = box({
    RRC: [rec(1, 'RRC', 'DL-DCCH: RRC reconfiguration'), rec(2, 'RRC', 'DL-DCCH: RRC reconfiguration')],
  });
  const r = await postProcessExecution(opts(impl, [rule()], 'FAIL'));
  assert.equal(r.outcome, 'PASS');
  assert.equal(r.finalResult, 'FAIL');
});

test('content rules read the body of the matching messages only', async () => {
  const { impl } = box({
    RRC: [
      // The body is everything after the first line -- that is where a
      // decoded field lives.
      rec(1, 'RRC', 'DL-DCCH: RRC reconfiguration\n  reconfigurationWithSync : setup'),
      rec(2, 'RRC', 'DL-DCCH: RRC reconfiguration'),
      rec(3, 'RRC', 'DL-DCCH: RRC setup\n  reconfigurationWithSync : setup'),
    ],
  });
  const r = await postProcessExecution(opts(impl, [rule({
    mode: 'content', expectedStrings: ['reconfigurationWithSync'], condition: 'ALL',
    expectedMatchingCount: 1,
  })], 'PASS'));
  // The RRC setup carrying the string is not an RRC reconfiguration.
  assert.equal(r.outcome, 'PASS');
  assert.equal(r.results[0].actualMatchingCount, 1);
});

test('a stored rule with no message name is dropped rather than failed', () => {
  const kept = asRules([
    { id: 'a', messageName: 'RRC setup', mode: 'count' },
    { id: 'b', messageName: '   ', mode: 'count' },
    { id: 'c', mode: 'count' },
    null as any,
  ]);
  assert.deepEqual(kept.map((r) => r.id), ['a']);
  assert.deepEqual(asRules(undefined), []);
});

test('notConfigured carries the execution result through untouched', () => {
  assert.equal(notConfigured('INCOMPLETE').finalResult, 'INCOMPLETE');
  assert.equal(notConfigured().finalResult, undefined);
});

test('the run log line says what was decided and on what evidence', async () => {
  const { impl } = box({ RRC: [rec(1, 'RRC', 'DL-DCCH: RRC reconfiguration')] });
  const r = await postProcessExecution(opts(impl, [rule()], 'PASS'));
  const line = reportLine(r);
  assert.match(line, /post-processing: FAIL/);
  assert.match(line, /0\/1 rule passed/);
  assert.match(line, /OTA message/);
  assert.equal(reportLine(notConfigured('PASS')), 'post-processing: no rules configured');
});

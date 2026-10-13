// Telling this run's execution from the one that was already on the testcase.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { isOurExecution, mayReport } = await import('./ownExecution.ts');

const OLD = '01a1207d-6c4e-7979-be66-3592de96d275';   // the 9 October execution
const NEW = '01a12c00-1111-2222-3333-444455556666';

test('the id our own trigger returned is the one that counts', () => {
  assert.equal(isOurExecution({ executionId: NEW }, NEW, OLD), true);
  assert.equal(isOurExecution({ executionId: OLD }, NEW, OLD), false);
  // Even if the one on record is terminal and looks finished.
  assert.equal(isOurExecution({ executionId: OLD }, NEW, undefined), false);
});

test('without a trigger id, anything that is not the previous one is ours', () => {
  assert.equal(isOurExecution({ executionId: NEW }, undefined, OLD), true);
  assert.equal(isOurExecution({ executionId: OLD }, undefined, OLD), false);
});

test('the real failure: a row re-run inherits its own last verdict', () => {
  // NSA_3cell_Mobility_UDP_1UEs_automation on 13 October, reading the record
  // its 9 October run left behind. Terminal, PASS, and not ours.
  const onRecord = { executionId: OLD };
  assert.equal(isOurExecution(onRecord, undefined, OLD), false);
  assert.equal(mayReport(onRecord, undefined, OLD), false);
});

test('a first-ever run has nothing before it, so the first execution is ours', () => {
  assert.equal(isOurExecution({ executionId: NEW }, undefined, undefined), true);
});

test('a record with no execution id is never ours', () => {
  // Nothing identifies it, so it cannot be shown to be this run's — the run
  // waits and times out rather than claiming it.
  assert.equal(isOurExecution({}, undefined, OLD), false);
  assert.equal(isOurExecution({}, undefined, undefined), false);
  assert.equal(isOurExecution(null, undefined, undefined), false);
  assert.equal(isOurExecution(undefined, undefined, undefined), false);
});

test('nothing at all may be reported', () => {
  assert.equal(mayReport(null, undefined, undefined), false);
  assert.equal(mayReport(undefined, NEW, OLD), false);
});

test('what may be reported is exactly what counts as ours', () => {
  for (const [seen, trig, prior] of [
    [{ executionId: NEW }, undefined, OLD],
    [{ executionId: OLD }, undefined, OLD],
    [{ executionId: NEW }, NEW, OLD],
    [{ executionId: OLD }, NEW, OLD],
    [{ executionId: NEW }, undefined, undefined],
  ] as const) {
    assert.equal(mayReport(seen, trig, prior), isOurExecution(seen, trig, prior));
  }
});

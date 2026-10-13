import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readTriggerAnswer, refusalDetail } from './triggerAnswer.ts';

// The two bodies below are verbatim from 192.168.1.95, and both arrived as
// HTTP 200. That is the whole point of this module.

test('a refusal is a refusal even at HTTP 200', () => {
  const a = readTriggerAnswer(200, JSON.stringify({
    status: 'Failure',
    message: 'The test uses sdr4, which is not assigned to this simulator',
  }));
  assert.equal(a.started, false);
  assert.equal(a.message, 'The test uses sdr4, which is not assigned to this simulator');
  assert.equal(a.executionId, undefined);
  // and the operator sees the box's own words
  assert.match(refusalDetail(a, 200), /sdr4, which is not assigned/);
});

test('a start yields the execution id', () => {
  const a = readTriggerAnswer(200, JSON.stringify({
    status: 'success',
    message: 'Test case started successfully',
    executionId: '01a1340f-f3db-71c7-a2fd-30709b5f9aa9',
  }));
  assert.equal(a.started, true);
  assert.equal(a.executionId, '01a1340f-f3db-71c7-a2fd-30709b5f9aa9');
  assert.equal(a.assumed, undefined);
});

test('capitalisation is not a contract', () => {
  for (const s of ['success', 'Success', 'SUCCESS', 'Started']) {
    assert.equal(readTriggerAnswer(200, JSON.stringify({ status: s, executionId: 'x' })).started, true, s);
  }
  for (const s of ['Failure', 'failure', 'FAILED', 'error', 'Rejected']) {
    assert.equal(readTriggerAnswer(200, JSON.stringify({ status: s })).started, false, s);
  }
});

test('an id with no verdict still means it started', () => {
  const a = readTriggerAnswer(200, JSON.stringify({ executionId: 'abc' }));
  assert.equal(a.started, true);
  assert.equal(a.executionId, 'abc');
});

test('an unreadable answer falls back to the HTTP status, and says so', () => {
  const ok = readTriggerAnswer(202, '');
  assert.equal(ok.started, true);
  assert.equal(ok.assumed, true);

  const bad = readTriggerAnswer(409, 'Conflict');
  assert.equal(bad.started, false);
  assert.equal(bad.assumed, true);
  assert.equal(refusalDetail(bad, 409), 'the box refused to start it: Conflict');

  const empty = readTriggerAnswer(409, '');
  assert.equal(refusalDetail(empty, 409), 'the box refused to start it: HTTP 409');
});

test('a 409 with no body at all is named, not numbered', () => {
  const a: ReturnType<typeof readTriggerAnswer> = { started: false };
  assert.equal(refusalDetail(a, 409), 'a test case is already running on the simulator');
});

// Every shape a real run has produced, and the two words each one is allowed
// to show.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { statusLabel, verdictLabel } = await import('./outcome.ts');

const both = (o: any) => [statusLabel(o), verdictLabel(o)];

test('a test the box ran to the end and passed', () => {
  assert.deepEqual(both({ boxStatus: 'Completed', verdict: 'PASS', ok: true }), ['Completed', 'Passed']);
});

test('a test the box ran and failed', () => {
  assert.deepEqual(both({ boxStatus: 'Completed', verdict: 'FAIL', ok: false }), ['Completed', 'Failed']);
});

test('the box has the last word: it completed, so it reads Completed', () => {
  // The window expires, SimQA sends a stop, and the box still carries the test
  // to the end. Its own screen says COMPLETED, and so must this — the two
  // disagreeing about one execution is worse than either answer.
  assert.deepEqual(both({ boxStatus: 'COMPLETED', verdict: 'PASS', stopped: true, ok: true }), ['Completed', 'Passed']);
});

test('Stopped is for the box saying so itself', () => {
  assert.deepEqual(both({ boxStatus: 'STOPPED', verdict: 'ERROR', ok: false }), ['Stopped', 'Error']);
  // Cut off before the box could report anything at all.
  assert.deepEqual(both({ stopped: true, ok: false }), ['Stopped', 'Error']);
});

test('a row the box never created never executed, and that is an error', () => {
  // "duplicate failed at user-plane: BAD_REQUEST" — no box status at all.
  assert.deepEqual(both({ ok: false }), ['Not Executed', 'Error']);
});

test('a trigger the box rejected is the same kind of error', () => {
  assert.deepEqual(both({ ok: false, verdict: '' }), ['Not Executed', 'Error']);
});

test('an aborted execution says so on both sides', () => {
  assert.deepEqual(both({ boxStatus: 'Aborted', verdict: 'ABORTED', ok: false }), ['Aborted', 'Uncompleted']);
});

test('a test that ran without reaching a judgement is uncompleted, not failed', () => {
  assert.deepEqual(both({ boxStatus: 'Completed', verdict: 'INCOMPLETE', ok: false }), ['Completed', 'Uncompleted']);
});

test('a run that never settled is an error, not a silent pass', () => {
  assert.deepEqual(both({ boxStatus: 'Completed', verdict: 'TIMEOUT', ok: false }), ['Completed', 'Error']);
});

test('a row executing now shows no verdict yet', () => {
  assert.deepEqual(both({ running: true }), ['In Progress', '']);
});

test('a row that has never run shows neither', () => {
  assert.deepEqual(both({ neverRun: true }), ['Not Executed', '']);
});

test('running beats whatever the last run said', () => {
  assert.deepEqual(both({ running: true, boxStatus: 'Completed', verdict: 'FAIL' }), ['In Progress', '']);
});

test('the box spelling its status in any case is still understood', () => {
  assert.deepEqual(both({ boxStatus: 'ABORTED', verdict: 'aborted' }), ['Aborted', 'Uncompleted']);
  assert.deepEqual(both({ boxStatus: 'completed', verdict: 'passed', ok: true }), ['Completed', 'Passed']);
});

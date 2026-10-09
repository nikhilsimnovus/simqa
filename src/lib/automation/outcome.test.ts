// Every shape a real run has produced, and the two words each one shows.
//
// Both columns are the Simnovator's, so the expectations here are the labels
// its own test list uses — "PASS", not "Passed"; "Incomplete", not
// "Uncompleted" — and a row the box never ran carries no verdict at all
// rather than one of SimQA's.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { statusLabel, verdictLabel } = await import('./outcome.ts');

const both = (o: any) => [statusLabel(o), verdictLabel(o)];

// ── what the box says, said back ─────────────────────────────────────────

test('a test the box ran to the end and passed', () => {
  assert.deepEqual(both({ boxStatus: 'COMPLETED', boxResult: 'PASS', ok: true }), ['Completed', 'PASS']);
});

test('a test the box ran and failed', () => {
  assert.deepEqual(both({ boxStatus: 'COMPLETED', boxResult: 'FAIL', ok: false }), ['Completed', 'FAIL']);
});

test('a test that ran without reaching a judgement is Incomplete, in the box’s spelling', () => {
  assert.deepEqual(both({ boxStatus: 'COMPLETED', boxResult: 'INCOMPLETE', ok: false }), ['Completed', 'Incomplete']);
});

test('an aborted execution reports the box’s status and whatever result it gave', () => {
  assert.deepEqual(both({ boxStatus: 'ABORTED', boxResult: 'INCOMPLETE', ok: false }), ['Aborted', 'Incomplete']);
  // Aborted with no result at all: the status says it, the verdict stays empty
  // rather than inventing one.
  assert.deepEqual(both({ boxStatus: 'ABORTED', ok: false }), ['Aborted', '']);
});

test('the box’s own ERROR result is shown — it is its word, not ours', () => {
  assert.deepEqual(both({ boxStatus: 'COMPLETED', boxResult: 'ERROR', ok: false }), ['Completed', 'Error']);
});

test('every status the box has a label for', () => {
  const seen = (s: string) => statusLabel({ boxStatus: s });
  assert.equal(seen('IN_PROGRESS'), 'In Progress');
  assert.equal(seen('COMPLETED'), 'Completed');
  assert.equal(seen('STOPPED'), 'Stopped');
  assert.equal(seen('STOPPING'), 'Stopping');
  assert.equal(seen('STARTING'), 'Starting');
  assert.equal(seen('ABORTED'), 'Aborted');
  assert.equal(seen('NOT_EXECUTED'), 'Not Executed');
  assert.equal(seen('AVAILABLE'), 'Available');
  assert.equal(seen('UNKNOWN'), 'Unknown');
});

test('case does not matter — the box answers in capitals, the lab’s records do not always', () => {
  assert.deepEqual(both({ boxStatus: 'completed', boxResult: 'pass', ok: true }), ['Completed', 'PASS']);
  assert.deepEqual(both({ boxStatus: 'Aborted', boxResult: 'Incomplete' }), ['Aborted', 'Incomplete']);
});

// ── what SimQA must NOT say ──────────────────────────────────────────────

test('a row SimQA never got onto the box has no verdict of its own', () => {
  // "duplicate failed at user-plane: BAD_REQUEST" — the box never saw it, so
  // it reads exactly as the Simnovator would read it: never executed, no
  // result. The reason is in the row's detail, not invented into this column.
  assert.deepEqual(both({ ok: false }), ['Not Executed', '']);
  assert.deepEqual(both({ ok: false, verdict: '' }), ['Not Executed', '']);
});

test('SimQA stopping the execution does not change what the box reported', () => {
  // The window expires, SimQA sends a stop, the box still carries the test to
  // the end. Its own screen says COMPLETED / PASS, and so does this.
  assert.deepEqual(both({ boxStatus: 'COMPLETED', boxResult: 'PASS', stopped: true, ok: true }), ['Completed', 'PASS']);
  // And with nothing from the box at all, "stopped" is not a status the
  // Simnovator ever showed for this row.
  assert.deepEqual(both({ stopped: true, ok: false }), ['Not Executed', '']);
});

test('SimQA passing a row does not manufacture a PASS the box never gave', () => {
  assert.deepEqual(both({ ok: true }), ['Not Executed', '']);
});

// ── live rows ────────────────────────────────────────────────────────────

test('a row executing now shows no verdict yet', () => {
  assert.deepEqual(both({ running: true }), ['In Progress', '']);
});

test('a row that has never run shows neither', () => {
  assert.deepEqual(both({ neverRun: true }), ['Not Executed', '']);
});

test('running beats whatever the last run said', () => {
  assert.deepEqual(both({ running: true, boxStatus: 'COMPLETED', boxResult: 'FAIL' }), ['In Progress', '']);
});

// ── runs recorded before the raw result was kept ─────────────────────────

test('an older run, which stored only the derived verdict, still reads correctly', () => {
  // The old verdict folded the box's STATUS in with its result, so ABORTED and
  // TIMEOUT arrive here as "verdicts". They are statuses — and TIMEOUT is
  // SimQA's own word — so neither becomes a result.
  assert.deepEqual(both({ boxStatus: 'COMPLETED', verdict: 'PASS', ok: true }), ['Completed', 'PASS']);
  assert.deepEqual(both({ boxStatus: 'COMPLETED', verdict: 'INCOMPLETE' }), ['Completed', 'Incomplete']);
  assert.deepEqual(both({ boxStatus: 'ABORTED', verdict: 'ABORTED' }), ['Aborted', '']);
  assert.deepEqual(both({ boxStatus: 'COMPLETED', verdict: 'TIMEOUT' }), ['Completed', '']);
});

test('the raw result wins over the derived verdict when both are present', () => {
  assert.deepEqual(both({ boxStatus: 'COMPLETED', boxResult: 'INCOMPLETE', verdict: 'PASS' }), ['Completed', 'Incomplete']);
});

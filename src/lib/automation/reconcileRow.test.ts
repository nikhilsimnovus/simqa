import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileRow, needsReconcile, isTerminal } from './reconcileRow.ts';

/** The row that started this, exactly as history holds it. */
const RTSP = {
  boxTestcaseId: '01a14436-5cf0-7ebc-8ca1-0607a348db68',
  executionId: '01a152a7-bad5-7cde-aaa8-dfeb06bb60ab',
  boxStatus: 'IN_PROGRESS',
  boxResult: 'NOT_EXECUTED',
};

test('the frozen RTSP row takes the box’s verdict', () => {
  // The box, asked after the run had already been written down.
  const r = reconcileRow(RTSP, {
    executionId: '01a152a7-bad5-7cde-aaa8-dfeb06bb60ab',
    status: 'ABORTED', result: 'INCOMPLETE',
  });
  assert.equal(r?.boxStatus, 'ABORTED');
  assert.equal(r?.boxResult, 'INCOMPLETE');
  assert.match(r!.note, /stopped watching at "IN_PROGRESS"/);
  assert.match(r!.note, /finished this execution as ABORTED\/INCOMPLETE/);
});

test('a row the box finished as PASS is adopted too', () => {
  const r = reconcileRow({ ...RTSP, boxStatus: 'STARTING' }, {
    executionId: RTSP.executionId, status: 'COMPLETED', result: 'PASS',
  });
  assert.equal(r?.boxStatus, 'COMPLETED');
  assert.equal(r?.boxResult, 'PASS');
});

test('a DIFFERENT execution is never adopted', () => {
  // A later run of the same testcase. Taking its verdict would put somebody
  // else's result on this row, which is worse than leaving it unresolved.
  const r = reconcileRow(RTSP, {
    executionId: 'some-other-execution', status: 'COMPLETED', result: 'PASS',
  });
  assert.equal(r, null);
});

test('a row still genuinely running is left saying so', () => {
  assert.equal(reconcileRow(RTSP, { executionId: RTSP.executionId, status: 'IN_PROGRESS' }), null);
  assert.equal(reconcileRow(RTSP, { executionId: RTSP.executionId, status: 'STOPPING' }), null);
});

test('a row already terminal is not touched', () => {
  for (const st of ['COMPLETED', 'ABORTED', 'STOPPED', 'ERROR', 'NOT_EXECUTED']) {
    assert.equal(needsReconcile({ ...RTSP, boxStatus: st }), false, st);
    assert.equal(reconcileRow({ ...RTSP, boxStatus: st }, { status: 'COMPLETED', result: 'PASS' }), null, st);
  }
});

test('a row that never reached the box is not reconciled', () => {
  // "Not Executed" because SimQA could not build or trigger it. There is no
  // execution to ask about, and the reason is already in its detail.
  assert.equal(needsReconcile({ boxStatus: 'IN_PROGRESS' }), false);
  assert.equal(needsReconcile({ boxTestcaseId: 'tc', boxStatus: 'IN_PROGRESS' }), false);
  assert.equal(needsReconcile({ executionId: 'e', boxStatus: 'IN_PROGRESS' }), false);
});

test('a note is never a test case', () => {
  assert.equal(needsReconcile({ ...RTSP, kind: 'note' }), false);
});

test('the box having nothing changes nothing', () => {
  assert.equal(reconcileRow(RTSP, null), null);
  assert.equal(reconcileRow(RTSP, undefined), null);
  assert.equal(reconcileRow(RTSP, {}), null);
});

test('a box answer with no executionId is accepted', () => {
  // Older boxes, and the shape fetchLastExecution returns when the field is
  // absent. The testcase is this row's own copy, so its last execution is
  // this row's unless something says otherwise.
  const r = reconcileRow(RTSP, { status: 'COMPLETED', result: 'FAIL' });
  assert.equal(r?.boxStatus, 'COMPLETED');
  assert.equal(r?.boxResult, 'FAIL');
});

test('isTerminal reads the box’s spellings, case and space tolerant', () => {
  assert.equal(isTerminal('completed'), true);
  assert.equal(isTerminal('  ABORTED '), true);
  assert.equal(isTerminal('IN_PROGRESS'), false);
  assert.equal(isTerminal(undefined), false);
  assert.equal(isTerminal(''), false);
});

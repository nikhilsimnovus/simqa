import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explainSteps, boxFields, explainRow } from './explainRow.ts';

// A detail line as the runner really writes one, taken from a run record.
const REAL = [
  'testcase: created AIO_5sa_automation on the box from the folder copy',
  'cfg-source: /root/automation_configs/RAT_TYPES/AIO_5sa/enb.cfg → SA-1cell_automation.cfg',
  'cfg-link: ln -sfn SA-1cell_automation.cfg enb.cfg',
  'cfg-db: the deployed Mohan_mme_automation.cfg includes ue_db_1000_automation.json',
  'attach: 64 UE(s) registered',
  'post-processing: FAIL (0/1 rules passed, 68 OTA messages in 75 log records); RRC setup request: Total message count: expected exactly 64, found 2',
  'verdict=PASS status=COMPLETED result=PASS dur=100s',
].join(' · ');

test('each segment is labelled by what it was doing', () => {
  const steps = explainSteps(REAL);
  assert.deepEqual(steps.map((s) => s.label),
    ['test case', 'config', 'link', 'database', 'attach', 'post-processing', 'box']);
  // The machine prefix is removed; the sentence is kept whole.
  assert.equal(steps[1].text, '/root/automation_configs/RAT_TYPES/AIO_5sa/enb.cfg → SA-1cell_automation.cfg');
  assert.equal(steps[4].text, '64 UE(s) registered');
});

test('a segment that reports a problem is marked as one', () => {
  const steps = explainSteps(
    'cfg-source: a.cfg → a_automation.cfg · attach: no UE attached within 90s · trigger: failed to start');
  assert.deepEqual(steps.map((s) => s.ok), [true, false, false]);
});

test('a step with no detail explains nothing rather than guessing', () => {
  assert.deepEqual(explainSteps(undefined), []);
  assert.deepEqual(explainSteps('   '), []);
});

test('the box fields are only the ones the box gave', () => {
  assert.deepEqual(boxFields({ boxStatus: 'COMPLETED', boxResult: 'PASS' }), [
    { label: 'Execution status', value: 'COMPLETED' },
    { label: 'Execution result', value: 'PASS' },
  ]);
  // verdict repeats boxResult here, so it is not shown a second time.
  assert.equal(boxFields({ boxResult: 'PASS', verdict: 'PASS' }).length, 1);
  assert.equal(boxFields({ boxResult: 'PASS', verdict: 'STOPPED' }).length, 2);
  assert.deepEqual(boxFields({ stopped: true }), [
    { label: 'Stopped by SimQA', value: 'after the duration window' },
  ]);
});

test('a passing row is not given a reason it does not need', () => {
  const r = explainRow({ status: 'Completed', verdictLabel: 'Passed', detail: REAL, boxResult: 'PASS' });
  assert.equal(r.headline, 'Completed — the Simnovator reported Passed.');
  assert.equal(r.why, undefined);
  assert.equal(r.steps.length, 7);
});

test('a row that failed says why, preferring the reason it was given', () => {
  const r = explainRow({
    status: 'Not Executed', verdictLabel: 'Error',
    detail: 'cfg-source: a.cfg → a_automation.cfg · trigger: the simulator is already running',
    reason: 'SimQA could not start the execution on the box — trigger: the simulator is already running',
  });
  // "Error" is SimQA's label for a row the box never judged, so the headline
  // says what actually happened rather than quoting a verdict nobody gave.
  assert.equal(r.headline, 'The box never executed this row.');
  assert.match(r.why!, /already running/);
});

test('without a reason line, the last unhappy step is the explanation', () => {
  const r = explainRow({
    status: 'Aborted', verdictLabel: 'Uncompleted',
    detail: 'cfg-link: ln -sfn a.cfg enb.cfg · attach: no UE attached within 90s',
  });
  assert.equal(r.why, 'no UE attached within 90s');
});

test('a row nothing has happened to says exactly that', () => {
  assert.equal(explainRow({ status: '—' }).headline, 'This row has not been judged yet.');
  assert.match(explainRow({ status: 'In Progress' }).headline, /Executing now/);
});

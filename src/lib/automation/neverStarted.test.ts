import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  looksUnstarted, confirmUnstarted, givenUp, unstartedDetail,
  START_GRACE_SEC, START_CONFIRMATIONS,
} from './neverStarted.ts';

/** What .102 reported for AIO_NB_IoT_standalone_2Cells_automation. */
const NB_IOT = { sinceTriggerSec: 600, haveOurExecution: false, simulatorBusy: false };

test('the NB-IoT case: no execution, idle simulator, long past the grace', () => {
  assert.equal(looksUnstarted(NB_IOT), true);
});

test('a slow start is never mistaken for a dead one', () => {
  // The box has taken up to ~26s to answer a trigger. Nothing is concluded
  // anywhere near that.
  for (const t of [0, 1, 26, 60, 119]) {
    assert.equal(looksUnstarted({ ...NB_IOT, sinceTriggerSec: t }), false, `${t}s`);
  }
  assert.equal(looksUnstarted({ ...NB_IOT, sinceTriggerSec: START_GRACE_SEC }), true);
});

test('a running test is never aborted', () => {
  // Either piece of evidence on its own is enough to keep waiting.
  assert.equal(looksUnstarted({ ...NB_IOT, simulatorBusy: true }), false);
  assert.equal(looksUnstarted({ ...NB_IOT, haveOurExecution: true }), false);
  assert.equal(looksUnstarted({ ...NB_IOT, haveOurExecution: true, simulatorBusy: true }), false);
});

test('an unreadable box counts as busy, so it keeps waiting', () => {
  // The caller passes simulatorBusy: true when it cannot tell. A box that
  // will not answer is not evidence that nothing is running.
  assert.equal(looksUnstarted({ ...NB_IOT, simulatorBusy: true }), false);
});

test('one bad read cannot decide it', () => {
  let streak = 0;
  streak = confirmUnstarted(streak, NB_IOT);
  assert.equal(streak, 1);
  assert.equal(givenUp(streak), false);
  // The simulator shows busy once — the evidence has to be current, so the
  // count starts again.
  streak = confirmUnstarted(streak, { ...NB_IOT, simulatorBusy: true });
  assert.equal(streak, 0);
  assert.equal(givenUp(streak), false);
});

test('three agreeing looks are enough', () => {
  let streak = 0;
  for (let i = 0; i < START_CONFIRMATIONS; i++) streak = confirmUnstarted(streak, NB_IOT);
  assert.equal(streak, START_CONFIRMATIONS);
  assert.equal(givenUp(streak), true);
});

test('the grace is configurable, and nothing happens before it', () => {
  assert.equal(looksUnstarted({ ...NB_IOT, sinceTriggerSec: 40 }, 30), true);
  assert.equal(looksUnstarted({ ...NB_IOT, sinceTriggerSec: 20 }, 30), false);
});

test('the detail blames the box, and says what was checked', () => {
  const d = unstartedDetail(610);
  assert.match(d, /the Simnovator never started it/);
  assert.match(d, /610s after the trigger/);
  assert.match(d, /no execution for this test case and its simulator is idle/);
  assert.match(d, /created and validated/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failureReason, reasonIsOnTheBox } from './failureReason.ts';

// The details below are verbatim from runs on 192.168.1.95 and .102.

test('the reason is the outcome, not the housekeeping before it', () => {
  const detail = [
    'testcase: from the automation server (/root/automation_configs/3Cell/NSA_3cell_Mobility_Vonr_1UEs_automation/test.json)',
    '3 cells need 3 different RF cards (0, 2, 4) and simulator "simuser" owns 2 (0, 1); two cells cannot share a card',
  ].join(' · ');
  assert.equal(
    failureReason(detail, 'Not Executed'),
    '3 cells need 3 different RF cards (0, 2, 4) and simulator "simuser" owns 2 (0, 1); two cells cannot share a card',
  );
});

test('six lines of successful config work are not the reason', () => {
  const detail = [
    'testcase: from the automation server (…/test.json)',
    'testcase: reusing existing "X" on 192.168.1.95',
    'cfg-source: …/enb.cfg → SIM40-3Cells-HO-NSA.cfg',
    'cfg-link: ln -sfn SIM40-3Cells-HO-NSA.cfg enb.cfg',
    'cfg-restart: lte restarted (enb+mme+ims) + 15s settle',
    'attach: UE log unreadable — not checked',
    'triggered but no terminal state within 280s — stop attempted',
  ].join(' · ');
  assert.equal(failureReason(detail, 'Not Executed'), 'triggered but no terminal state within 280s — stop attempted');
});

test('a completed row explains nothing', () => {
  const detail = 'cfg-link: ln -sfn a b · verdict=PASS status=COMPLETED result=PASS dur=59s';
  assert.equal(failureReason(detail, 'Completed'), undefined);
  assert.equal(failureReason(detail, 'In Progress'), undefined);
});

test('an aborted row does explain itself', () => {
  const detail = 'cfg-restart: lte restarted · verdict=INCOMPLETE status=ABORTED result=INCOMPLETE dur=61s';
  // Every segment is housekeeping-shaped, so the last one is shown rather
  // than nothing at all — "it ended and here is the last thing said".
  assert.equal(failureReason(detail, 'Aborted'), 'verdict=INCOMPLETE status=ABORTED result=INCOMPLETE dur=61s');
});

test('the box refusing to start is quoted as it was', () => {
  const detail = 'cfg-link: ln -sfn a b · the box refused to start it: The test uses sdr4, which is not assigned to this simulator';
  assert.equal(
    failureReason(detail, 'Not Executed'),
    'the box refused to start it: The test uses sdr4, which is not assigned to this simulator',
  );
});

test('nothing recorded says nothing', () => {
  assert.equal(failureReason(undefined, 'Not Executed'), undefined);
  assert.equal(failureReason('', 'Not Executed'), undefined);
  assert.equal(failureReason('   ', 'Not Executed'), undefined);
});

test('which side of the lab a reason points at', () => {
  assert.equal(reasonIsOnTheBox('3 cells need 3 different RF cards (0, 2, 4)'), true);
  assert.equal(reasonIsOnTheBox('the box refused to start it: The test uses sdr4, which is not assigned to this simulator'), true);
  assert.equal(reasonIsOnTheBox('a test case is already running on the simulator'), true);
  assert.equal(reasonIsOnTheBox('this row has no test case to run'), false);
  assert.equal(reasonIsOnTheBox(undefined), false);
});

// Who ran what — attribution by simulator ownership.
//
// Fixtures mirror 192.168.1.95 on 2026-09-22: three operators on three
// simulators, two of them executing at the same moment. A wrong answer here
// labels one person's run with another person's name, which is the one thing
// this dashboard exists to get right.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { attributeBoxActivity, simulatorOwners } = await import('./boxActivityCore.ts');

const NOW = Date.parse('2026-09-22T07:02:00Z');

const sim = (id: string, name: string, availability = 'AVAILABLE', assignedUsers: any[] = []) =>
  ({ id, name, availability, nodes: { assignedUsers } });

const tc = (id: string, name: string, last?: any, history: any[] = []) =>
  ({ id, name, metadata: { lastExecution: last, executionHistory: history } });

/** simuser: running SA-1cell on 43. */
const SIMUSER = {
  username: 'simuser',
  simulators: [sim('43', 'UE-Simulator-1', 'BUSY')],
  testcases: [
    tc('t-sa', 'SA-1cell', { executionId: 'e-sa', simulatorId: 43, simulatorName: 'UE-Simulator-1', result: 'NOT_EXECUTED', status: 'IN_PROGRESS', executedOn: '2026-09-22T07:00:00Z', durationSeconds: 0 }),
    tc('t-long', '1CELL-UDP-1000UE_Long-hour', { executionId: 'e-long', simulatorId: 43, result: 'INCOMPLETE', status: 'ABORTED', executedOn: '2026-09-22T06:19:10Z', durationSeconds: 177 }),
  ],
};

/** sruthi: running her own testcase on 44 at the same time. */
const SRUTHI = {
  username: 'sruthi',
  simulators: [sim('44', 'UE-Simulator-2', 'BUSY')],
  testcases: [
    tc('t-sr', 'sruthi', { executionId: 'e-sr', simulatorId: 44, result: 'NOT_EXECUTED', status: 'IN_PROGRESS', executedOn: '2026-09-22T06:49:51Z', durationSeconds: 0 }),
  ],
};

/** mohan: idle, one finished run on 45, plus an older one only in history. */
const MOHAN = {
  username: 'mohan',
  simulators: [sim('45', 'UE-Simulator-3')],
  testcases: [
    tc('t-mo', 'mohan01',
      { executionId: 'e-mo2', simulatorId: 45, result: 'PASS', status: 'COMPLETED', executedOn: '2026-09-22T05:07:03Z', durationSeconds: 656 },
      [
        { iterationId: 'e-mo2', simulatorName: '45', status: 'Completed', startTimeUnix: 1790053623, endTimeUnix: 1790054283, execution_result: 'Pass' },
        { iterationId: 'e-mo1', simulatorName: '45', status: 'Aborted', startTimeUnix: 1790053453, endTimeUnix: 1790053469, execution_result: 'Incomplete' },
      ]),
  ],
};

test('every execution is labelled with the operator who owns its simulator', () => {
  const { executions } = attributeBoxActivity([SIMUSER, SRUTHI, MOHAN], { now: NOW });
  const who = Object.fromEntries(executions.map((e: any) => [e.executionId, e.user]));
  assert.equal(who['e-sa'], 'simuser');
  assert.equal(who['e-long'], 'simuser');
  assert.equal(who['e-sr'], 'sruthi');
  assert.equal(who['e-mo2'], 'mohan');
  assert.equal(who['e-mo1'], 'mohan');
});

test('two users running at once each show their own live execution', () => {
  const { users } = attributeBoxActivity([SIMUSER, SRUTHI, MOHAN], { now: NOW });
  const by = Object.fromEntries(users.map((u: any) => [u.username, u]));
  assert.equal(by.simuser.running?.testcaseName, 'SA-1cell');
  assert.equal(by.sruthi.running?.testcaseName, 'sruthi');
  assert.equal(by.mohan.running, undefined);
  assert.equal(by.mohan.last?.testcaseName, 'mohan01');
  assert.equal(by.mohan.last?.status, 'passed');
  assert.equal(by.sruthi.simulator?.name, 'UE-Simulator-2');
});

test('a run seen in both lastExecution and history appears once', () => {
  const { executions } = attributeBoxActivity([MOHAN], { now: NOW });
  assert.equal(executions.filter((e: any) => e.executionId === 'e-mo2').length, 1);
  assert.equal(executions.length, 2);
});

test('history reads the simulator id out of the field the box calls simulatorName', () => {
  const { executions } = attributeBoxActivity([MOHAN], { now: NOW });
  const older = executions.find((e: any) => e.executionId === 'e-mo1');
  assert.equal(older?.simulatorId, '45');
  assert.equal(older?.status, 'incomplete');
  assert.equal(older?.durationSec, 16);
});

test('newest first', () => {
  const { executions } = attributeBoxActivity([SIMUSER, SRUTHI, MOHAN], { now: NOW });
  const t = executions.map((e: any) => Date.parse(e.startedAt));
  assert.deepEqual(t, [...t].sort((a, b) => b - a));
  assert.equal(executions[0].testcaseName, 'SA-1cell');
});

test('in-progress left behind on an idle simulator is reported stale, not running', () => {
  const idle = { ...SRUTHI, simulators: [sim('44', 'UE-Simulator-2', 'AVAILABLE')] };
  const { executions, users } = attributeBoxActivity([idle], { now: NOW });
  assert.equal(executions[0].status, 'stale');
  assert.equal(users[0].running, undefined);
});

test('a fresh start counts as running before the simulator flips to BUSY', () => {
  const fresh = { ...SRUTHI, simulators: [sim('44', 'UE-Simulator-2', 'AVAILABLE')] };
  const { executions } = attributeBoxActivity([fresh], { now: Date.parse('2026-09-22T06:50:30Z') });
  assert.equal(executions[0].status, 'in progress');
});

test('admin claims only what no operator does — it is assigned to every simulator', () => {
  const ADMIN = {
    username: 'admin',
    simulators: [
      sim('43', 'UE-Simulator-1', 'BUSY', [{ username: 'admin', isDefault: true }, { username: 'simuser', isDefault: true }]),
      sim('44', 'UE-Simulator-2', 'BUSY', [{ username: 'admin' }, { username: 'sruthi', isDefault: true }]),
      sim('45', 'UE-Simulator-3', 'AVAILABLE', [{ username: 'admin' }, { username: 'mohan', isDefault: true }]),
    ],
    testcases: [],
  };
  assert.deepEqual(simulatorOwners([ADMIN, SIMUSER]), { '43': 'simuser', '44': 'sruthi', '45': 'mohan' });
});

test('an admin login alone still names operators who never registered in SimQA', () => {
  const ADMIN = {
    username: 'admin',
    simulators: [
      sim('43', 'UE-Simulator-1', 'AVAILABLE', [{ username: 'admin', isDefault: true }, { username: 'simuser', isDefault: true }]),
      sim('45', 'UE-Simulator-3', 'AVAILABLE', [{ username: 'admin' }, { username: 'mohan', isDefault: true }]),
    ],
    testcases: [],
  };
  const owners = simulatorOwners([ADMIN]);
  assert.equal(owners['43'], 'simuser');
  assert.equal(owners['45'], 'mohan');
});

test('a simulator nobody claims falls back to the one operator who can see the testcase', () => {
  const orphan = {
    username: 'simuser',
    simulators: [sim('43', 'UE-Simulator-1')],
    testcases: [tc('t-x', 'x', { executionId: 'e-x', simulatorId: 99, result: 'PASS', status: 'COMPLETED', executedOn: '2026-09-22T06:00:00Z', durationSeconds: 5 })],
  };
  const e = attributeBoxActivity([orphan], { now: NOW }).executions[0];
  assert.equal(e.user, 'simuser');
  assert.equal(e.attributedBy, 'testcase');
});

test('with neither signal, the user is unknown rather than guessed', () => {
  // Simulator 99 is nobody's, and two operators can see the testcase.
  const a = { username: 'a', simulators: [sim('1', 'S1')], testcases: [tc('t', 'shared', { executionId: 'e', simulatorId: 99, result: 'PASS', status: 'COMPLETED', executedOn: '2026-09-22T06:00:00Z', durationSeconds: 5 })] };
  const b = { username: 'b', simulators: [sim('2', 'S2')], testcases: [tc('t', 'shared')] };
  assert.equal(attributeBoxActivity([a, b], { now: NOW }).executions[0].user, undefined);
});

test('a login that could not be read is reported, and the others still render', () => {
  const broken = { username: 'mohan', simulators: [], testcases: [], error: 'the box rejected this login' };
  const { users, executions } = attributeBoxActivity([SRUTHI, broken], { now: NOW });
  assert.equal(users.find((u: any) => u.username === 'mohan')?.error, 'the box rejected this login');
  assert.equal(executions.length, 1);
});

// ── the testcase signal, from what .95 actually did on 2026-09-22 ─────────

test('a run on a since-deleted simulator is named by the testcase owner', () => {
  // mohan01 ran on simulator 42, recreated as 45 that morning.
  const mohanOld = {
    username: 'mohan',
    simulators: [sim('45', 'UE-Simulator-3')],
    testcases: [tc('t-mo', 'mohan01', { executionId: 'e-old', simulatorId: 42, result: 'PASS', status: 'COMPLETED', executedOn: '2026-09-22T05:07:03Z', durationSeconds: 656 })],
  };
  const { executions, users } = attributeBoxActivity([SIMUSER, mohanOld], { now: NOW });
  const e = executions.find((x: any) => x.executionId === 'e-old');
  assert.equal(e?.user, 'mohan');
  assert.equal(e?.attributedBy, 'testcase');
  assert.equal(e?.simulatorName, 'simulator 42');
  assert.equal(users.find((u: any) => u.username === 'mohan')?.last?.testcaseName, 'mohan01');
});

test('a user left with no simulator keeps their runs', () => {
  // sruthi was unassigned from 44 after running her testcase on it.
  const sruthiNoSim = {
    username: 'sruthi',
    simulators: [],
    testcases: [tc('t-sr', 'sruthi', { executionId: 'e-sr', simulatorId: 44, result: 'PASS', status: 'COMPLETED', executedOn: '2026-09-22T06:49:51Z', durationSeconds: 600 })],
  };
  const { executions, users } = attributeBoxActivity([SIMUSER, sruthiNoSim], { now: NOW });
  assert.equal(executions.find((x: any) => x.executionId === 'e-sr')?.user, 'sruthi');
  const s = users.find((u: any) => u.username === 'sruthi');
  assert.equal(s?.simulator, undefined);
  assert.equal(s?.last?.testcaseName, 'sruthi');
});

test('when the simulator changed hands, the testcase owner wins', () => {
  // 44 now belongs to mohan, but the run was of sruthi's testcase — mohan
  // cannot see it, so cannot have run it.
  const mohanOn44 = { username: 'mohan', simulators: [sim('44', 'UE-Simulator-2')], testcases: [] };
  const sruthiNoSim = {
    username: 'sruthi',
    simulators: [],
    testcases: [tc('t-sr', 'sruthi', { executionId: 'e-sr', simulatorId: 44, result: 'PASS', status: 'COMPLETED', executedOn: '2026-09-22T06:49:51Z', durationSeconds: 600 })],
  };
  const e = attributeBoxActivity([mohanOn44, sruthiNoSim], { now: NOW }).executions[0];
  assert.equal(e.user, 'sruthi');
  assert.equal(e.attributedBy, 'testcase');
});

test('a testcase several operators can see is not pinned on one of them', () => {
  const a = { username: 'a', simulators: [], testcases: [tc('t', 'shared', { executionId: 'e', simulatorId: 99, result: 'PASS', status: 'COMPLETED', executedOn: '2026-09-22T06:00:00Z', durationSeconds: 5 })] };
  const b = { username: 'b', simulators: [], testcases: [tc('t', 'shared')] };
  assert.equal(attributeBoxActivity([a, b], { now: NOW }).executions[0].user, undefined);
});

test('an admin view does not count as owning the testcases it can see', () => {
  const ADMIN = {
    username: 'admin',
    simulators: [sim('43', 'UE-Simulator-1'), sim('45', 'UE-Simulator-3')],
    testcases: [tc('t-sr', 'sruthi')],
  };
  const sruthiNoSim = {
    username: 'sruthi',
    simulators: [],
    testcases: [tc('t-sr', 'sruthi', { executionId: 'e-sr', simulatorId: 44, result: 'PASS', status: 'COMPLETED', executedOn: '2026-09-22T06:49:51Z', durationSeconds: 600 })],
  };
  assert.equal(attributeBoxActivity([ADMIN, sruthiNoSim], { now: NOW }).executions[0].user, 'sruthi');
});

test('with only an admin login registered, every operator still gets a tile', () => {
  const ADMIN = {
    username: 'admin',
    simulators: [
      sim('43', 'UE-Simulator-1', 'BUSY', [{ username: 'admin', isDefault: true }, { username: 'simuser', isDefault: true }]),
      sim('44', 'UE-Simulator-2', 'AVAILABLE', [{ username: 'admin' }, { username: 'sruthi', isDefault: true }]),
      sim('45', 'UE-Simulator-3', 'AVAILABLE', [{ username: 'admin' }, { username: 'mohan', isDefault: true }]),
    ],
    testcases: [tc('t-sa', 'SA-1cell', { executionId: 'e-sa', simulatorId: 43, result: 'NOT_EXECUTED', status: 'IN_PROGRESS', executedOn: '2026-09-22T07:00:00Z', durationSeconds: 0 })],
  };
  const { users } = attributeBoxActivity([ADMIN], { now: NOW });
  const by = Object.fromEntries(users.map((u: any) => [u.username, u]));
  assert.deepEqual(Object.keys(by).sort(), ['admin', 'mohan', 'simuser', 'sruthi']);
  assert.equal(by.admin.admin, true);
  assert.equal(by.admin.simulator, undefined);
  assert.equal(by.simuser.discovered, true);
  assert.equal(by.simuser.simulator?.name, 'UE-Simulator-1');
  assert.equal(by.simuser.running?.testcaseName, 'SA-1cell');
  assert.equal(by.sruthi.simulator?.name, 'UE-Simulator-2');
});

test('registered operators are not listed twice', () => {
  const { users } = attributeBoxActivity([SIMUSER, SRUTHI, MOHAN], { now: NOW });
  assert.deepEqual(users.map((u: any) => u.username), ['simuser', 'sruthi', 'mohan']);
  assert.ok(users.every((u: any) => !u.discovered));
});


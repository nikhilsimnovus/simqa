import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readBoxUsers, executingLogins, adminCannotExecute, looksLikeAdmin,
  readHosts, installModeOf, installLine, rolesOf,
} from './boxRoles.ts';

/** GET /v2/users on 192.168.1.102, as it really answers. */
const USERS = {
  pageInfo: { page: 0, totalItems: 2 },
  users: [
    {
      username: 'admin', roles: ['admin'],
      simulators: [{ simulatorId: '1', simulatorName: 'Simulator_test' }, { simulatorId: '4', simulatorName: 'UE-Simulator' }],
    },
    {
      username: 'mohan', first_name: 'Mohan', roles: ['user'],
      simulators: [{ simulatorId: '4', simulatorName: 'UE-Simulator' }],
    },
  ],
};

/** GET /v2/hosts on the same box. */
const HOSTS = {
  hosts: [{
    id: 1, name: '192.168.1.101', rfAllocation: 'board',
    nodes: [{
      role: 'ue', ipAddress: '192.168.1.101', agentConnected: true,
      machine: {
        installMode: 'regular',
        software: { os: 'Ubuntu-Server 24.04.2 v1.4 LTS', agent_version: 'v2.0.0' },
      },
    }],
    rfCards: [
      { device: 0, board: 'SDR100', role: 'master', simulatorId: 1, holder: 'Simulator_test', holderBusy: false },
      { device: 1, board: 'SDR100', role: 'slave', simulatorId: 1, holder: 'Simulator_test', holderBusy: false },
    ],
  }],
  success: true,
};

test('admin is read as the administrator it says it is, not inferred', () => {
  const users = readBoxUsers(USERS);
  const admin = users.find((u) => u.username === 'admin')!;
  const mohan = users.find((u) => u.username === 'mohan')!;
  assert.equal(admin.isAdmin, true);
  assert.equal(admin.canExecute, false, 'the box does not execute test cases as admin');
  assert.equal(mohan.isAdmin, false);
  assert.equal(mohan.canExecute, true);
  // And what each one holds, which is the other half of the Users section.
  assert.deepEqual(admin.simulators.map((s) => s.name), ['Simulator_test', 'UE-Simulator']);
  assert.deepEqual(mohan.simulators.map((s) => s.name), ['UE-Simulator']);
});

test('only the user logins are offered as the ones that can run', () => {
  assert.deepEqual(executingLogins(readBoxUsers(USERS)), ['mohan']);
});

test('a run as admin is refused with the login to use instead', () => {
  const msg = adminCannotExecute('admin', readBoxUsers(USERS));
  assert.match(msg, /is the Simnovator's administrator, not an execution account/);
  assert.match(msg, /Run this suite as one of its user logins — mohan/);
  // With no user list, it still refuses and still says what to do.
  assert.match(adminCannotExecute('admin'), /Run this suite as a user login/);
});

test('without the user list, the shipped admin name is still treated as admin', () => {
  // Reading /v2/users needs admin. A plain login cannot, so the name is all
  // there is — and starting a run the box will refuse is worse than saying so.
  assert.equal(looksLikeAdmin('admin'), true);
  assert.equal(looksLikeAdmin('Admin'), true);
  assert.equal(looksLikeAdmin('mohan'), false);
  // The stated role always wins over the name.
  const users = readBoxUsers({ users: [{ username: 'admin', roles: ['user'], simulators: [] }] });
  assert.equal(looksLikeAdmin('admin', users), false);
});

test('roles are read however the box spells them', () => {
  assert.deepEqual(rolesOf({ roles: ['Admin'] }), ['admin']);
  assert.deepEqual(rolesOf({ role: 'USER' }), ['user']);
  assert.deepEqual(rolesOf({}), []);
});

test('the install mode and the RF holders are read from /v2/hosts', () => {
  const hosts = readHosts(HOSTS);
  assert.equal(hosts.length, 1);
  assert.equal(installModeOf(hosts), 'regular');
  assert.equal(hosts[0].nodes[0].agentConnected, true);
  assert.deepEqual(hosts[0].cards.map((c) => c.holder), ['Simulator_test', 'Simulator_test']);
  const line = installLine(hosts);
  assert.match(line, /regular install/);
  assert.match(line, /RF handed out per board/);
  assert.match(line, /2\/2 RF cards held/);
});

test('nodes that disagree about the mode are called mixed, not guessed at', () => {
  const mixed = readHosts({
    hosts: [{
      id: 1, name: 'h',
      nodes: [
        { ipAddress: 'a', machine: { installMode: 'regular' } },
        { ipAddress: 'b', machine: { installMode: 'container' } },
      ],
      rfCards: [],
    }],
  });
  assert.equal(installModeOf(mixed), 'mixed');
  assert.match(installLine(mixed), /left over from the other mode/);
});

test('a box that reports nothing says so rather than claiming a mode', () => {
  assert.equal(installModeOf([]), undefined);
  assert.match(installLine([]), /install mode not reported/);
  assert.deepEqual(readBoxUsers({}), []);
  assert.deepEqual(readHosts({}), []);
});

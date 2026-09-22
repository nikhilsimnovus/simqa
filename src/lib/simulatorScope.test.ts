// Whose simulator is whose.
//
// Fixtures are the real payload from 192.168.1.95 (three operators, three
// simulators, admin assigned to all of them). A wrong answer here does not
// throw — it silently refuses one person's execution because a different
// person is running, or triggers onto somebody else's hardware.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { pickUserSimulator, isBusy } = await import('./simulatorScope.ts');

/** As admin sees it: every simulator, with the assignment list populated. */
const ADMIN_VIEW = [
  {
    id: '40', name: 'UE-Simulator', availability: 'AVAILABLE',
    nodes: { assignedUsers: [
      { username: 'admin', isDefault: true },
      { username: 'simuser', isDefault: true },
    ] },
  },
  {
    id: '41', name: 'UE-Simulator1', availability: 'BUSY',
    nodes: { assignedUsers: [
      { username: 'admin', isDefault: false },
      { username: 'sruthi', isDefault: true },
    ] },
  },
  {
    id: '42', name: 'UE-Simulator2', availability: 'AVAILABLE',
    nodes: { assignedUsers: [
      { username: 'admin', isDefault: false },
      { username: 'mohan', isDefault: true },
    ] },
  },
];

/** As an operator sees it: the box returns only their own, with no assignments. */
const SRUTHI_VIEW = [{ id: '41', name: 'UE-Simulator1', availability: 'BUSY', nodes: { assignedUsers: [] } }];

test('an operator token sees one simulator, and that is theirs', () => {
  const s = pickUserSimulator(SRUTHI_VIEW, 'sruthi');
  assert.equal(s?.id, '41');
  assert.equal(s?.via, 'only');
});

test('the single simulator is claimed even when the username is unknown to us', () => {
  // The box already scoped the list by token — second-guessing it would
  // leave an operator unable to run at all.
  assert.equal(pickUserSimulator(SRUTHI_VIEW, undefined)?.id, '41');
});

test('an admin token resolves each operator to their own simulator', () => {
  assert.equal(pickUserSimulator(ADMIN_VIEW, 'simuser')?.id, '40');
  assert.equal(pickUserSimulator(ADMIN_VIEW, 'sruthi')?.id, '41');
  assert.equal(pickUserSimulator(ADMIN_VIEW, 'mohan')?.id, '42');
});

test('admin, assigned to all three, resolves to the one flagged default', () => {
  const s = pickUserSimulator(ADMIN_VIEW, 'admin');
  assert.equal(s?.id, '40');
  assert.equal(s?.via, 'assigned-default');
});

test('matching ignores case and padding, as the inventory field is hand-typed', () => {
  assert.equal(pickUserSimulator(ADMIN_VIEW, '  SRUTHI ')?.id, '41');
});

test('an unassigned name picks nothing rather than somebody else’s simulator', () => {
  assert.equal(pickUserSimulator(ADMIN_VIEW, 'nobody'), null);
});

test('several simulators and no username picks nothing', () => {
  assert.equal(pickUserSimulator(ADMIN_VIEW, ''), null);
});

test('a box with no simulators reports none', () => {
  assert.equal(pickUserSimulator([], 'sruthi'), null);
  assert.equal(pickUserSimulator(undefined, 'sruthi'), null);
});

test('an assignment without the default flag still resolves when it is the only one', () => {
  const view = [
    { id: '1', nodes: { assignedUsers: [{ username: 'a' }] } },
    { id: '2', nodes: { assignedUsers: [{ username: 'b' }] } },
  ];
  const s = pickUserSimulator(view, 'b');
  assert.equal(s?.id, '2');
  assert.equal(s?.via, 'assigned');
});

test('two simulators assigned to one person with no default is ambiguous, not a guess', () => {
  const view = [
    { id: '1', nodes: { assignedUsers: [{ username: 'a' }] } },
    { id: '2', nodes: { assignedUsers: [{ username: 'a' }] } },
  ];
  assert.equal(pickUserSimulator(view, 'a'), null);
});

test('busy is read from availability, case-insensitively', () => {
  assert.equal(isBusy({ availability: 'BUSY' }), true);
  assert.equal(isBusy({ availability: 'busy' }), true);
  assert.equal(isBusy({ availability: 'AVAILABLE' }), false);
  assert.equal(isBusy(undefined), false);
});

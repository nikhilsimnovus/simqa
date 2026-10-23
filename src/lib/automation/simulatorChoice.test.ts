import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseSimulator, readSimulator, simulatorsOfUser, ranOnOurSimulator, type BoxSimulator,
} from './simulatorChoice.ts';

/** 192.168.1.102 as it really is, read from the box on 2026-10-23. */
const TEST_SIM: BoxSimulator = {
  id: '1', name: 'Simulator_test', availability: 'AVAILABLE', connectivity: 'DISCONNECTED', cards: [1, 2],
};
const UE_SIM: BoxSimulator = {
  id: '4', name: 'UE-Simulator', availability: 'AVAILABLE', connectivity: 'CONNECTED', cards: [],
};

/** The real GET /v2/users body, trimmed. */
const USERS = {
  users: [
    { username: 'admin', simulators: [{ simulatorId: '1', simulatorName: 'Simulator_test' }, { simulatorId: '4', simulatorName: 'UE-Simulator' }] },
    { username: 'mohan', simulators: [{ simulatorId: '4', simulatorName: 'UE-Simulator' }] },
  ],
};

test('a disconnected simulator never wins, however many cards it has', () => {
  // This is the bug: the old rule preferred Simulator_test for its 2 RF
  // cards, and the box reported PASS in 213s from a simulator that was not
  // connected at all.
  const r = chooseSimulator([TEST_SIM, UE_SIM], { runAs: 'mohan' });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.sim.name, 'UE-Simulator');
  assert.match(r.note, /1 disconnected simulator skipped/);
});

test('nothing connected is a refusal, not a choice', () => {
  const r = chooseSimulator([TEST_SIM], { runAs: 'mohan' });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.reason, /no connected simulator/);
  assert.match(r.reason, /Simulator_test \(DISCONNECTED\)/);
  // It says the manual route fails too, so nobody reads it as a SimQA fault.
  assert.match(r.reason, /fails in the Simnovator GUI too/);
});

test('an admin token is held to the run-as login’s own simulators', () => {
  // An admin sees everybody's. The Users section is what says which are
  // mohan's — the check an operator does by hand before running.
  const owned = simulatorsOfUser(USERS, 'mohan');
  assert.deepEqual(owned, [{ id: '4', name: 'UE-Simulator' }]);
  const r = chooseSimulator([TEST_SIM, UE_SIM], { runAs: 'mohan', owned });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.sim.id, '4');
});

test('a simulator the run-as login does not own is refused with what it does own', () => {
  const owned = simulatorsOfUser(USERS, 'mohan');
  const r = chooseSimulator([TEST_SIM], { runAs: 'mohan', owned });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /the Users section assigns it UE-Simulator/);
});

test('a login with no simulator at all is told so', () => {
  const r = chooseSimulator([UE_SIM], { runAs: 'ghost', owned: [] });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /assigns no simulator/);
});

test('free beats busy, and cards only break a tie between connected ones', () => {
  const busyBig: BoxSimulator = { id: '7', name: 'big', availability: 'BUSY', connectivity: 'CONNECTED', cards: [1, 2, 3] };
  const freeSmall: BoxSimulator = { id: '8', name: 'small', availability: 'AVAILABLE', connectivity: 'CONNECTED', cards: [1] };
  const freeBig: BoxSimulator = { id: '9', name: 'bigger', availability: 'AVAILABLE', connectivity: 'CONNECTED', cards: [1, 2] };
  const a = chooseSimulator([busyBig, freeSmall]);
  assert.equal(a.ok && a.sim.name, 'small');
  const b = chooseSimulator([freeSmall, freeBig]);
  assert.equal(b.ok && b.sim.name, 'bigger');
});

test('an empty list says the box offered nothing rather than crashing', () => {
  const r = chooseSimulator([], { runAs: 'mohan' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /lists no simulator/);
});

test('the box shape is read as it really comes back', () => {
  const s = readSimulator({
    id: 1, name: 'Simulator_test', availability: 'AVAILABLE', connectivity: 'DISCONNECTED',
    nodes: { ipaddress: '192.168.1.101', rfCards: [1, 2] },
  });
  assert.deepEqual(s, {
    id: '1', name: 'Simulator_test', availability: 'AVAILABLE', connectivity: 'DISCONNECTED', cards: [1, 2],
  });
  assert.equal(readSimulator({}), undefined);
});

test('an execution that landed on another simulator is reported, not assumed ours', () => {
  const ours = ranOnOurSimulator({ simulatorId: 4, simulatorName: 'UE-Simulator' }, '4');
  assert.equal(ours.ours, true);
  const other = ranOnOurSimulator({ simulatorId: 1, simulatorName: 'Simulator_test' }, '4');
  assert.equal(other.ours, false);
  assert.match(other.note!, /ran this on Simulator_test/);
  // Nothing to compare against is not a mismatch.
  assert.equal(ranOnOurSimulator({}, '4').ours, true);
  assert.equal(ranOnOurSimulator({ simulatorId: 1 }, undefined).ours, true);
});

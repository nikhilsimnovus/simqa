import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attributeCatalogue, catalogueCounts } from './boxCatalogue.ts';

/** /v2/users on 192.168.1.102, as readBoxUsers() leaves it. */
const USERS = [
  { username: 'admin', simulators: [{ id: '1', name: 'Simulator_test' }, { id: '4', name: 'UE-Simulator' }] },
  { username: 'mohan', simulators: [{ id: '4', name: 'UE-Simulator' }] },
];

const row = (id: string, name: string, le?: Record<string, unknown>) =>
  ({ id, name, metadata: le ? { lastExecution: le } : {} });

test('a test case belongs to whoever holds the simulator it ran on', () => {
  const e = attributeCatalogue([
    row('a', 'ran-on-ue', { simulatorId: 4, simulatorName: 'UE-Simulator', result: 'PASS', executedOn: '2026-10-23T07:35:55Z' }),
    row('b', 'ran-on-test', { simulatorId: 1, simulatorName: 'Simulator_test', result: 'PASS', executedOn: '2026-10-19T18:31:31Z' }),
    row('c', 'never-run'),
  ], USERS);
  const by = Object.fromEntries(e.map((x) => [x.name, x.owners]));
  // UE-Simulator is held by both, so both are named rather than one guessed.
  assert.deepEqual(by['ran-on-ue'], ['admin', 'mohan']);
  // Simulator_test is admin's alone — which is how an orphan reads as one.
  assert.deepEqual(by['ran-on-test'], ['admin']);
  assert.deepEqual(by['never-run'], []);
});

test('the duplicated rows the box returns collapse to the newest', () => {
  // The box returns one row per simulator a test case has run on.
  const e = attributeCatalogue([
    row('x', 'dup', { simulatorId: 1, simulatorName: 'Simulator_test', executedOn: '2026-10-19T18:20:37Z', durationSeconds: 213 }),
    row('x', 'dup', { simulatorId: 4, simulatorName: 'UE-Simulator', executedOn: '2026-10-23T04:27:58Z', durationSeconds: 113 }),
  ], USERS);
  assert.equal(e.length, 1);
  assert.equal(e[0].simulatorName, 'UE-Simulator');
  assert.equal(e[0].durationSeconds, 113);
});

test('newest first, and a name breaks a tie', () => {
  const e = attributeCatalogue([
    row('a', 'zeta', { executedOn: '2026-10-01T00:00:00Z' }),
    row('b', 'alpha', { executedOn: '2026-10-05T00:00:00Z' }),
    row('c', 'beta'),
    row('d', 'aardvark'),
  ], USERS);
  assert.deepEqual(e.map((x) => x.name), ['alpha', 'zeta', 'aardvark', 'beta']);
});

test('the counts say what is whose, what has never run, and what nobody holds', () => {
  const e = attributeCatalogue([
    row('a', 'one', { simulatorId: 4, simulatorName: 'UE-Simulator', executedOn: '2026-10-23T07:00:00Z' }),
    row('b', 'two', { simulatorId: 4, simulatorName: 'UE-Simulator', executedOn: '2026-10-22T07:00:00Z' }),
    row('c', 'three', { simulatorId: 1, simulatorName: 'Simulator_test', executedOn: '2026-10-19T07:00:00Z' }),
    row('d', 'four', { simulatorId: 9, simulatorName: 'Gone', executedOn: '2026-10-18T07:00:00Z' }),
    row('e', 'five'),
  ], USERS);
  const c = catalogueCounts(e);
  assert.equal(c.total, 5);
  assert.equal(c.neverRun, 1);
  assert.equal(c.unowned, 1, 'ran on a simulator no login holds');
  assert.deepEqual(c.byUser, [
    { username: 'admin', count: 3 },   // two on UE-Simulator + one on Simulator_test
    { username: 'mohan', count: 2 },   // the two on UE-Simulator
  ]);
});

test('with no user list the rows still read, and claim nobody', () => {
  const e = attributeCatalogue([
    row('a', 'one', { simulatorId: 4, simulatorName: 'UE-Simulator', executedOn: '2026-10-23T07:00:00Z' }),
  ]);
  assert.deepEqual(e[0].owners, []);
  assert.equal(catalogueCounts(e).unowned, 1);
  assert.deepEqual(attributeCatalogue([]), []);
});

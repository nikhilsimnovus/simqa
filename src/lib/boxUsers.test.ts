// Which box login a setup executes as.
//
// The fallback chain matters more than it looks: a wrong answer here does not
// throw, it silently authenticates as the wrong person — so every rung is
// pinned, including the legacy shapes that must keep working.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { listBoxUsers, uesimApiCredentials } = await import('./inventory.ts');

const A = { id: 'u1', username: 'userA', password: 'pwA' };
const B = { id: 'u2', username: 'userB', password: 'pwB' };

test('a setup listing users offers exactly those, in order', () => {
  const users = listBoxUsers({ uesimUsers: [A, B] });
  assert.deepEqual(users.map((u) => u.username), ['userA', 'userB']);
});

test('the selector picks by id', () => {
  const c = uesimApiCredentials({ uesimUsers: [A, B] }, 'u2');
  assert.deepEqual(c, { username: 'userB', password: 'pwB' });
});

test('the selector also picks by username, for callers holding only a name', () => {
  const c = uesimApiCredentials({ uesimUsers: [A, B] }, 'userB');
  assert.deepEqual(c, { username: 'userB', password: 'pwB' });
});

test('no selector uses the first configured login, not admin', () => {
  const c = uesimApiCredentials({ uesimUsers: [A, B] });
  assert.equal(c.username, 'userA');
});

test('an unknown selector falls back to the first login rather than throwing', () => {
  const c = uesimApiCredentials({ uesimUsers: [A, B] }, 'nobody');
  assert.equal(c.username, 'userA');
});

test('a pre-multi-user setup still yields its single legacy login', () => {
  const users = listBoxUsers({ uesim: { username: 'simuser', password: 'simuser' } });
  assert.equal(users.length, 1);
  assert.equal(users[0].username, 'simuser');
  // Selecting it by the synthesised id works, so the picker can round-trip.
  assert.equal(uesimApiCredentials({ uesim: { username: 'simuser', password: 'simuser' } }, 'default').password, 'simuser');
});

test('uesimUsers wins over the legacy block when both are present', () => {
  const c = uesimApiCredentials({ uesim: { username: 'admin', password: 'admin' }, uesimUsers: [A] });
  assert.equal(c.username, 'userA');
});

test('a setup with no credentials at all still resolves to admin/admin', () => {
  assert.deepEqual(uesimApiCredentials({}), { username: 'admin', password: 'admin' });
  assert.deepEqual(uesimApiCredentials(null), { username: 'admin', password: 'admin' });
  assert.equal(listBoxUsers({}).length, 0);
});

test('a listed entry with no username is ignored, not offered as a blank login', () => {
  const users = listBoxUsers({ uesimUsers: [{ id: 'x', username: '', password: 'p' }, A] });
  assert.deepEqual(users.map((u) => u.username), ['userA']);
});

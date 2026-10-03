// Guessing passwords should get slower. Mistyping yours should not cost you
// the account.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const { throttleKey, retryAfterMs, recordFailure, recordSuccess, resetThrottle, DEFAULT_THROTTLE } =
  await import('./loginThrottle.ts');

const K = throttleKey('sruthi', '10.0.0.5');
const T0 = 1_700_000_000_000;

beforeEach(() => resetThrottle());

test('a few mistakes cost nothing', () => {
  for (let i = 0; i < DEFAULT_THROTTLE.freeAttempts; i++) {
    assert.equal(recordFailure(K, T0), 0, `attempt ${i + 1} should not be held`);
  }
  assert.equal(retryAfterMs(K, T0), 0);
});

test('past that, the wait starts and then doubles', () => {
  for (let i = 0; i < DEFAULT_THROTTLE.freeAttempts; i++) recordFailure(K, T0);
  const first = recordFailure(K, T0);
  const second = recordFailure(K, T0);
  assert.equal(first, DEFAULT_THROTTLE.baseLockMs);
  assert.equal(second, DEFAULT_THROTTLE.baseLockMs * 2);
});

test('the wait is capped — nothing locks an account for good', () => {
  for (let i = 0; i < 40; i++) recordFailure(K, T0);
  assert.equal(recordFailure(K, T0), DEFAULT_THROTTLE.maxLockMs);
});

test('the hold expires on its own', () => {
  for (let i = 0; i <= DEFAULT_THROTTLE.freeAttempts; i++) recordFailure(K, T0);
  assert.ok(retryAfterMs(K, T0) > 0);
  assert.equal(retryAfterMs(K, T0 + DEFAULT_THROTTLE.baseLockMs + 1), 0);
});

test('a quiet hour forgets the failures entirely', () => {
  for (let i = 0; i <= DEFAULT_THROTTLE.freeAttempts; i++) recordFailure(K, T0);
  const later = T0 + DEFAULT_THROTTLE.forgetAfterMs + 1;
  assert.equal(retryAfterMs(K, later), 0);
  // …and the count starts over, rather than resuming where it left off.
  assert.equal(recordFailure(K, later), 0);
});

test('signing in wipes the slate', () => {
  for (let i = 0; i <= DEFAULT_THROTTLE.freeAttempts; i++) recordFailure(K, T0);
  recordSuccess(K);
  assert.equal(retryAfterMs(K, T0), 0);
});

test('one desk getting it wrong does not lock the account elsewhere', () => {
  const mine = throttleKey('sruthi', '10.0.0.5');
  const theirs = throttleKey('sruthi', '10.0.0.9');
  for (let i = 0; i <= DEFAULT_THROTTLE.freeAttempts * 2; i++) recordFailure(mine, T0);
  assert.ok(retryAfterMs(mine, T0) > 0);
  assert.equal(retryAfterMs(theirs, T0), 0);
});

test('case does not buy a fresh allowance', () => {
  assert.equal(throttleKey('Sruthi', '10.0.0.5'), throttleKey('sruthi', '10.0.0.5'));
});

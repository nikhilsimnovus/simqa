// The rules a password has to meet, and what the person is told when it does
// not. Same function the server enforces with.
//
// The shipped default accepts any password with at least one character —
// "admin" is a legitimate password for this tool. The composition rules and a
// longer minimum are still here, still tested, and still one environment
// variable away, which is the point of keeping the policy configurable rather
// than deleting it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { checkPassword, strength, DEFAULT_POLICY } = await import('./passwordPolicy.ts');

test('the shipped default turns nothing down but an empty box', () => {
  assert.deepEqual(
    { min: DEFAULT_POLICY.minLength, upper: DEFAULT_POLICY.requireUpper, digit: DEFAULT_POLICY.requireDigit },
    { min: 1, upper: false, digit: false },
  );
  // The passwords people actually use on a lab box, all of them acceptable.
  assert.equal(checkPassword('admin').ok, true, 'admin/admin is allowed, as asked');
  assert.equal(checkPassword('sruthi').ok, true);
  assert.equal(checkPassword('a').ok, true, 'one character is a password');
});

test('it says what is missing, not just "invalid"', () => {
  // Only reachable with a stricter policy now, but the wording still has to
  // name the rule rather than say "invalid".
  const strict = { ...DEFAULT_POLICY, minLength: 6 };
  assert.match(checkPassword('abc', strict).error ?? '', /6 characters/);
});

test('every rule comes back with its own state, for a checklist to show', () => {
  const strict = { ...DEFAULT_POLICY, minLength: 6 };
  assert.deepEqual(checkPassword('abc', strict).rules.map(r => r.id), ['length']);
  assert.deepEqual(checkPassword('abc', strict).rules.map(r => r.ok), [false]);
  assert.deepEqual(checkPassword('abc').rules.map(r => r.ok), [true], 'and passes under the shipped policy');
});

test('the composition rules still work when switched on', () => {
  const strict = {
    ...DEFAULT_POLICY, minLength: 8,
    requireUpper: true, requireLower: true, requireDigit: true, requireSpecial: true,
  };
  assert.equal(checkPassword('simple', strict).ok, false);
  assert.equal(checkPassword('Str0ngEnough', strict).ok, false, 'no special character');
  assert.equal(checkPassword('Str0ngEnough!', strict).ok, true);
  assert.match(checkPassword('alllowercase1', strict).error ?? '', /uppercase/i);
});

test('an absurdly long password is refused rather than hashed', () => {
  const huge = 'a'.repeat(500);
  const r = checkPassword(huge);
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /or fewer/);
});

test('nothing at all is not a password', () => {
  assert.equal(checkPassword('').ok, false);
  assert.equal(checkPassword(undefined as any).ok, false);
});

test('the meter is honest about padding', () => {
  assert.equal(strength('').score, 0);
  // Long but one repeated character — length alone must not read as strong.
  assert.ok(strength('aaaaaaaaaaaaaaaa').score <= 1);
  assert.ok(strength('Str0ng!Passphrase').score >= 3);
});

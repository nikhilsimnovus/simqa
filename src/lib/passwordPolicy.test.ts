// The rules a password has to meet, and what the person is told when it does
// not. Same function the server enforces with and the form ticks off.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { checkPassword, strength, DEFAULT_POLICY } = await import('./passwordPolicy.ts');

test('the default rules: length, upper, lower, digit', () => {
  assert.equal(checkPassword('Str0ngEnough').ok, true);
  assert.equal(checkPassword('short1A').ok, false, 'seven characters is not eight');
  assert.equal(checkPassword('alllowercase1').ok, false, 'no uppercase');
  assert.equal(checkPassword('ALLUPPERCASE1').ok, false, 'no lowercase');
  assert.equal(checkPassword('NoDigitsHere').ok, false, 'no number');
});

test('it says which rule is unmet, not just "invalid"', () => {
  assert.match(checkPassword('alllowercase1').error ?? '', /uppercase/i);
  assert.match(checkPassword('Sh0rt').error ?? '', /8 characters/);
});

test('every rule comes back with its own state, for the checklist', () => {
  const { rules } = checkPassword('abc');
  assert.deepEqual(rules.map(r => r.id), ['length', 'upper', 'lower', 'digit']);
  assert.deepEqual(rules.map(r => r.ok), [false, false, true, false]);
});

test('a special character is optional by default and enforced when asked for', () => {
  assert.equal(checkPassword('Str0ngEnough').ok, true);
  const strict = { ...DEFAULT_POLICY, requireSpecial: true };
  assert.equal(checkPassword('Str0ngEnough', strict).ok, false);
  assert.equal(checkPassword('Str0ngEnough!', strict).ok, true);
});

test('an absurdly long password is refused rather than hashed', () => {
  const huge = 'A1' + 'a'.repeat(500);
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

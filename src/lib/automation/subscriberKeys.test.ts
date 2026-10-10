// Making a subscriber's key fields agree with its algorithm — the rules
// transcribed from the box's own subscriber schema, including the xor branch
// that refuses an operator key outright.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { alignSubscriberKeys } = await import('./subscriberKeys.ts');

const def = (subs: any[]) => ({ subsConfig: { subs } });
const OPC = '000102030405060708090A0B0C0D0E0F';
const TOPC = OPC + OPC;

// ── xor: no operator key at all ──────────────────────────────────────────

test('an xor subscriber carrying a leftover opc has it emptied', () => {
  // AIO_Validation_of_IMEISV_automation: algorithm xor, opc still set from
  // when it was milenage, and the box refusing the whole definition over it.
  const td: any = def([{ algorithm: 'xor', opc: OPC, sharedKey: 'aa', asRelease: 16 }]);
  const notes = alignSubscriberKeys(td);
  assert.equal(td.subsConfig.subs[0].opc, '');
  assert.equal(td.subsConfig.subs[0].sharedKey, 'aa', 'the shared key is what xor actually uses');
  assert.match(notes.join(' '), /subscriber 0: opc emptied — xor authenticates with the shared key alone/);
});

test('every operator key is emptied for xor, and named', () => {
  const td: any = def([{ algorithm: 'xor', op: OPC, opc: OPC, top: TOPC, topc: TOPC }]);
  const notes = alignSubscriberKeys(td);
  assert.deepEqual(
    ['op', 'opc', 'top', 'topc'].map((f) => td.subsConfig.subs[0][f]),
    ['', '', '', ''],
  );
  assert.match(notes.join(' '), /op, opc, top, topc emptied/);
});

test('an xor subscriber that is already clean is left alone', () => {
  const td: any = def([{ algorithm: 'xor', opc: '', sharedKey: 'aa' }]);
  assert.deepEqual(alignSubscriberKeys(td), []);
  assert.equal('op' in td.subsConfig.subs[0], false, 'no field is added');
});

test('xor never gains an algorithmKeyMode — the schema forbids it there', () => {
  const td: any = def([{ algorithm: 'xor', opc: OPC }]);
  alignSubscriberKeys(td);
  assert.equal('algorithmKeyMode' in td.subsConfig.subs[0], false);
});

// ── milenage and tuak: the selector is required ──────────────────────────

test('a milenage subscriber with opc set and no mode gets the mode back', () => {
  const td: any = def([{ algorithm: 'milenage', opc: OPC }]);
  const notes = alignSubscriberKeys(td);
  assert.equal(td.subsConfig.subs[0].algorithmKeyMode, 'opc');
  assert.equal(td.subsConfig.subs[0].opc, OPC, 'milenage does use it — it is not touched');
  assert.match(notes.join(' '), /set it to "opc", which is what milenage requires/);
});

test('milenage with op maps to the op mode', () => {
  const td: any = def([{ algorithm: 'milenage', op: OPC }]);
  alignSubscriberKeys(td);
  assert.equal(td.subsConfig.subs[0].algorithmKeyMode, 'op');
});

test('tuak selects top and topc through the same op/opc mode', () => {
  const a: any = def([{ algorithm: 'tuak', top: TOPC }]);
  alignSubscriberKeys(a);
  assert.equal(a.subsConfig.subs[0].algorithmKeyMode, 'op');
  const b: any = def([{ algorithm: 'tuak', topc: TOPC }]);
  alignSubscriberKeys(b);
  assert.equal(b.subsConfig.subs[0].algorithmKeyMode, 'opc');
});

test('a mode already stated is never overwritten', () => {
  const td: any = def([{ algorithm: 'milenage', algorithmKeyMode: 'op', op: OPC }]);
  assert.deepEqual(alignSubscriberKeys(td), []);
  assert.equal(td.subsConfig.subs[0].algorithmKeyMode, 'op');
});

test('nothing is invented when no key is set, or when two are', () => {
  const none: any = def([{ algorithm: 'milenage', opc: '', op: '' }]);
  assert.deepEqual(alignSubscriberKeys(none), []);
  assert.equal('algorithmKeyMode' in none.subsConfig.subs[0], false);
  const both: any = def([{ algorithm: 'milenage', op: OPC, opc: OPC }]);
  assert.deepEqual(alignSubscriberKeys(both), []);
  assert.equal('algorithmKeyMode' in both.subsConfig.subs[0], false);
});

test('an algorithm the schema says nothing about is left alone', () => {
  const td: any = def([{ algorithm: 'aes', opc: OPC }]);
  assert.deepEqual(alignSubscriberKeys(td), []);
  assert.equal(td.subsConfig.subs[0].opc, OPC);
});

// ── shape ────────────────────────────────────────────────────────────────

test('each subscriber is decided on its own', () => {
  const td: any = def([
    { algorithm: 'xor', opc: OPC },
    { algorithm: 'milenage', opc: OPC },
    { algorithm: 'milenage', algorithmKeyMode: 'op', op: OPC },
  ]);
  const notes = alignSubscriberKeys(td);
  assert.equal(notes.length, 2);
  assert.equal(td.subsConfig.subs[0].opc, '');
  assert.equal(td.subsConfig.subs[1].algorithmKeyMode, 'opc');
  assert.equal(td.subsConfig.subs[2].opc, undefined);
});

test('the other spellings of the subscriber list are handled too', () => {
  const a: any = { subscriberConfig: { subs: [{ algorithm: 'xor', opc: OPC }] } };
  alignSubscriberKeys(a);
  assert.equal(a.subscriberConfig.subs[0].opc, '');
  const b: any = { subscriberData: { subsConfig: { subs: [{ algorithm: 'milenage', op: OPC }] } } };
  alignSubscriberKeys(b);
  assert.equal(b.subscriberData.subsConfig.subs[0].algorithmKeyMode, 'op');
});

test('a definition with no subscribers at all is untouched', () => {
  assert.deepEqual(alignSubscriberKeys({}), []);
  assert.deepEqual(alignSubscriberKeys({ subsConfig: {} }), []);
  assert.deepEqual(alignSubscriberKeys({ subsConfig: { subs: 'not a list' } }), []);
});

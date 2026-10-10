// Restoring a key mode the definition implies, and refusing to invent one it
// does not.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { restoreKeyMode } = await import('./subscriberKeys.ts');

const def = (subs: any[]) => ({ subsConfig: { subs } });

test('a subscriber with opc set and no mode gets the mode back', () => {
  // AIO_Validation_of_IMEISV_automation, after someone commented out the one
  // line that selects the mode.
  const td: any = def([{ algorithm: 'xor', opc: '000102030405060708090A0B0C0D0E0F', asRelease: 16 }]);
  const notes = restoreKeyMode(td);
  assert.equal(td.subsConfig.subs[0].algorithmKeyMode, 'opc');
  assert.match(notes.join(' '), /subscriber 0: algorithmKeyMode was missing and opc holds a value/);
});

test('op is restored the same way', () => {
  const td: any = def([{ op: '000102030405060708090A0B0C0D0E0F' }]);
  restoreKeyMode(td);
  assert.equal(td.subsConfig.subs[0].algorithmKeyMode, 'op');
});

test('a mode already stated is never overwritten', () => {
  const td: any = def([{ algorithmKeyMode: 'op', opc: 'aa', op: 'bb' }]);
  assert.deepEqual(restoreKeyMode(td), []);
  assert.equal(td.subsConfig.subs[0].algorithmKeyMode, 'op');
});

test('nothing is invented when no key is set', () => {
  const td: any = def([{ algorithm: 'xor', opc: '', op: '' }]);
  assert.deepEqual(restoreKeyMode(td), []);
  assert.equal('algorithmKeyMode' in td.subsConfig.subs[0], false);
});

test('an ambiguous pair is left for the box to refuse', () => {
  const td: any = def([{ op: 'aa', opc: 'bb' }]);
  assert.deepEqual(restoreKeyMode(td), []);
  assert.equal('algorithmKeyMode' in td.subsConfig.subs[0], false);
});

test('a tuak profile is outside the enum and is left alone', () => {
  // algorithmKeyMode's enum is ["op","opc"]; top/topc are not in it.
  const td: any = def([{ topc: 'a'.repeat(64), opc: 'b'.repeat(32) }]);
  assert.deepEqual(restoreKeyMode(td), []);
  assert.equal('algorithmKeyMode' in td.subsConfig.subs[0], false);
});

test('each subscriber is decided on its own', () => {
  const td: any = def([
    { opc: 'aa' },
    { algorithmKeyMode: 'op', op: 'bb' },
    { op: 'cc' },
    { },
  ]);
  const notes = restoreKeyMode(td);
  assert.equal(notes.length, 2);
  assert.deepEqual(td.subsConfig.subs.map((s: any) => s.algorithmKeyMode), ['opc', 'op', 'op', undefined]);
});

test('the other spellings of the subscriber list are handled too', () => {
  const a: any = { subscriberConfig: { subs: [{ opc: 'aa' }] } };
  restoreKeyMode(a);
  assert.equal(a.subscriberConfig.subs[0].algorithmKeyMode, 'opc');
  const b: any = { subscriberData: { subsConfig: { subs: [{ op: 'bb' }] } } };
  restoreKeyMode(b);
  assert.equal(b.subscriberData.subsConfig.subs[0].algorithmKeyMode, 'op');
});

test('a definition with no subscribers at all is untouched', () => {
  assert.deepEqual(restoreKeyMode({}), []);
  assert.deepEqual(restoreKeyMode({ subsConfig: {} }), []);
  assert.deepEqual(restoreKeyMode({ subsConfig: { subs: 'not a list' } }), []);
});

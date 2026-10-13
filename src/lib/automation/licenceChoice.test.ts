import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanTag, licenceKeyFor, enteredLicences,
  effectiveLicences, licencesToSave, tagForRole,
} from './licenceChoice.ts';

test('a tag is one short word, or it is not a tag', () => {
  for (const ok of ['rnd-enb', 'oran-enb', 'oru-mme', 'mme-oran', 'a', 'A_1.2-3']) {
    assert.equal(cleanTag(ok), ok, ok);
  }
  assert.equal(cleanTag('  rnd-mme  '), 'rnd-mme', 'trimmed');
  for (const bad of ['', '   ', 'two words', 'tag"; rm -rf /', 'a'.repeat(65), undefined, null, 7, {}]) {
    assert.equal(cleanTag(bad), undefined, JSON.stringify(bad));
  }
});

test('licences are remembered per callbox, by host', () => {
  assert.equal(licenceKeyFor('192.168.1.106'), 'callbox:192.168.1.106');
  assert.equal(licenceKeyFor('192.168.1.107'), 'callbox:192.168.1.107');
  // A suite with no callbox still has somewhere to put a choice.
  assert.equal(licenceKeyFor(undefined), 'callbox:unknown');
  assert.equal(licenceKeyFor('   '), 'callbox:unknown');
});

test('only enb and mme are entered, and junk is dropped', () => {
  assert.deepEqual(enteredLicences({ enb: 'rnd-enb', mme: 'rnd-mme' }), { enb: 'rnd-enb', mme: 'rnd-mme' });
  assert.deepEqual(enteredLicences({ enb: 'rnd-enb', mme: '' }), { enb: 'rnd-enb' });
  assert.deepEqual(enteredLicences({ enb: 'bad tag' }), {});
  assert.deepEqual(enteredLicences({ ims: 'rnd-mme' }), {}, 'ims is derived, never entered');
  assert.deepEqual(enteredLicences(null), {});
});

test('the MME licence goes to mme.cfg AND ims.cfg', () => {
  const c = effectiveLicences(undefined, { enb: 'oran-enb', mme: 'rnd-mme' });
  assert.deepEqual(c, { enb: 'oran-enb', mme: 'rnd-mme', ims: 'rnd-mme' });
  assert.equal(tagForRole(c, 'enb'), 'oran-enb');
  assert.equal(tagForRole(c, 'gnb'), 'oran-enb', 'a gnb cfg is an enb cfg for this purpose');
  assert.equal(tagForRole(c, 'mme'), 'rnd-mme');
  assert.equal(tagForRole(c, 'ims'), 'rnd-mme');
  assert.equal(tagForRole(c, 'db'), undefined, 'a DB names no licence');
  assert.equal(tagForRole(c, 'ots'), undefined);
});

test('nothing entered and nothing saved leaves every config alone', () => {
  assert.deepEqual(effectiveLicences(undefined, undefined), {});
  assert.deepEqual(effectiveLicences({}, {}), {});
  assert.equal(tagForRole({}, 'enb'), undefined);
});

test('a second run reuses what the first one used', () => {
  const saved = { enb: 'rnd-enb', mme: 'rnd-mme', updatedAt: '2026-10-13T00:00:00.000Z' };
  assert.deepEqual(effectiveLicences(saved, {}), { enb: 'rnd-enb', mme: 'rnd-mme', ims: 'rnd-mme' });
});

test('entered beats remembered, per field', () => {
  const saved = { enb: 'rnd-enb', mme: 'rnd-mme' };
  // Only the ENB value is changed; the MME one is still the remembered one.
  assert.deepEqual(effectiveLicences(saved, { enb: 'oran-enb' }),
    { enb: 'oran-enb', mme: 'rnd-mme', ims: 'rnd-mme' });
});

test('a changed choice is saved, an accepted one is not', () => {
  const now = '2026-10-13T08:00:00.000Z';
  const saved = { enb: 'rnd-enb', mme: 'rnd-mme', updatedAt: '2026-10-01T00:00:00.000Z' };

  // Pressing Run without touching anything must not move updatedAt — it would
  // claim the operator chose this today.
  assert.equal(licencesToSave(saved, {}, now), undefined);
  assert.equal(licencesToSave(saved, { enb: 'rnd-enb', mme: 'rnd-mme' }, now), undefined);

  // A change is remembered, and carries the rest forward.
  assert.deepEqual(licencesToSave(saved, { mme: 'oru-mme' }, now),
    { enb: 'rnd-enb', mme: 'oru-mme', updatedAt: now });

  // First ever choice.
  assert.deepEqual(licencesToSave(undefined, { enb: 'rnd-enb' }, now),
    { enb: 'rnd-enb', updatedAt: now });

  // Nothing at all to remember.
  assert.equal(licencesToSave(undefined, {}, now), undefined);
  assert.equal(licencesToSave(undefined, { enb: 'not a tag' } as any, now), undefined);
});

test('what is saved never includes a derived ims value', () => {
  const next = licencesToSave(undefined, { enb: 'rnd-enb', mme: 'rnd-mme' }, 'now')!;
  assert.deepEqual(Object.keys(next).sort(), ['enb', 'mme', 'updatedAt']);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keepHandEdits, nextManifest } from './handEdits.ts';

/** Stand-in for the sha the caller passes; same contract, legible in failures. */
const h = (s: string) => `h(${s})`;

test('the edit that started this: test.json changed in vi survives the run', () => {
  // The folder holds the operator's edited definition; the sync is about to
  // put the Simnovator's copy back over it.
  const r = keepHandEdits(
    { 'test.json': 'FROM THE BOX' },
    { 'test.json': 'EDITED BY HAND' },
    { 'test.json': h('WHAT SIMQA WROTE') },
    h,
  );
  assert.deepEqual(r.files, {}, 'nothing is written');
  assert.deepEqual(r.kept, ['test.json']);
  assert.match(r.notes[0], /test\.json was edited in the folder — keeping your version/);
});

test('a file SimQA wrote and nobody touched is refreshed', () => {
  const r = keepHandEdits(
    { 'test.json': 'NEWER FROM THE BOX' },
    { 'test.json': 'WHAT SIMQA WROTE' },
    { 'test.json': h('WHAT SIMQA WROTE') },
    h,
  );
  assert.deepEqual(r.files, { 'test.json': 'NEWER FROM THE BOX' });
  assert.deepEqual(r.kept, []);
});

test('a file that is not there yet is written', () => {
  const r = keepHandEdits({ 'enb.cfg': 'ENB' }, {}, {}, h);
  assert.deepEqual(r.files, { 'enb.cfg': 'ENB' });
});

test('a folder with no manifest keeps todays behaviour', () => {
  // Folders written before this existed have no record of what SimQA wrote,
  // and refusing to refresh them would freeze every suite in the lab.
  const r = keepHandEdits(
    { 'enb.cfg': 'FRESH' },
    { 'enb.cfg': 'WHATEVER IS THERE' },
    {},
    h,
  );
  assert.deepEqual(r.files, { 'enb.cfg': 'FRESH' });
  assert.deepEqual(r.kept, []);
});

test('an edit that happens to match what we would write is not flagged', () => {
  const r = keepHandEdits(
    { 'mme.cfg': 'SAME TEXT' },
    { 'mme.cfg': 'SAME TEXT' },
    { 'mme.cfg': h('SOMETHING OLDER') },
    h,
  );
  assert.deepEqual(r.files, {}, 'nothing to write — it is already that');
  assert.deepEqual(r.kept, [], 'and nothing to report');
});

test('one edited file does not protect the others', () => {
  const r = keepHandEdits(
    { 'test.json': 'BOX', 'enb.cfg': 'BOX ENB', 'mme.cfg': 'BOX MME' },
    { 'test.json': 'MINE', 'enb.cfg': 'SIMQA ENB', 'mme.cfg': 'SIMQA MME' },
    { 'test.json': h('SIMQA JSON'), 'enb.cfg': h('SIMQA ENB'), 'mme.cfg': h('SIMQA MME') },
    h,
  );
  assert.deepEqual(r.files, { 'enb.cfg': 'BOX ENB', 'mme.cfg': 'BOX MME' });
  assert.deepEqual(r.kept, ['test.json']);
});

test('undefined entries are skipped, not written as empty', () => {
  // A callbox that could not be read sends undefined; blanking the saved
  // config because a box was rebooting would be worse than serving it.
  const r = keepHandEdits({ 'enb.cfg': undefined }, { 'enb.cfg': 'KEEP ME' }, {}, h);
  assert.deepEqual(r.files, {});
  assert.deepEqual(r.kept, []);
});

test('a kept file stays kept on the next sync', () => {
  // The whole point: surviving once is not enough for a config being
  // iterated on, so the manifest keeps the OLD hash for a kept file.
  const manifest = { 'test.json': h('SIMQA JSON') };
  const first = keepHandEdits({ 'test.json': 'BOX' }, { 'test.json': 'MINE' }, manifest, h);
  const after = nextManifest(manifest, first.files, ['test.json'], h);
  assert.deepEqual(after, manifest, 'unchanged, so the edit is still an edit');

  const second = keepHandEdits({ 'test.json': 'BOX AGAIN' }, { 'test.json': 'MINE' }, after, h);
  assert.deepEqual(second.kept, ['test.json']);
});

test('deleting the file hands it back to SimQA', () => {
  const manifest = { 'test.json': h('SIMQA JSON') };
  // Gone from the folder, so its entry goes too…
  const after = nextManifest(manifest, {}, [], h);
  assert.deepEqual(after, {});
  // …and the next sync writes it again.
  const r = keepHandEdits({ 'test.json': 'BOX' }, {}, after, h);
  assert.deepEqual(r.files, { 'test.json': 'BOX' });
});

test('the manifest records what was actually written', () => {
  const after = nextManifest({}, { 'enb.cfg': 'ENB', 'test.json': 'JSON' }, ['enb.cfg', 'test.json'], h);
  assert.deepEqual(after, { 'enb.cfg': h('ENB'), 'test.json': h('JSON') });
});

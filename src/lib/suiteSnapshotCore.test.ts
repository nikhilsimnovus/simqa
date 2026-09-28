// A suite row runs against files that people edit between runs — these are the
// rules that decide whether "the same suite again" really is the same.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { diffSnapshot, hashText, nextVersion, latestVersion, safeFolder } =
  await import('./suiteSnapshotCore.ts');

const entry = (source: string, text: string) => ({ source, sha256: hashText(text), bytes: text.length });

const SAVED = {
  'enb.cfg': entry('SA-1cell.cfg', 'radio'),
  'mme.cfg': entry('demo-mme.cfg', 'core'),
  'db.cfg': entry('ue_db.cfg', 'subscribers'),
};

test('unchanged files run without a word', () => {
  const d = diffSnapshot(SAVED, { ...SAVED });
  assert.equal(d.same, true);
  assert.deepEqual(d.changed, []);
});

test('an edited file is reported by name', () => {
  const d = diffSnapshot(SAVED, { ...SAVED, 'mme.cfg': entry('demo-mme.cfg', 'core EDITED') });
  assert.equal(d.same, false);
  assert.deepEqual(d.changed.map((c: any) => [c.file, c.state]), [['mme.cfg', 'changed']]);
});

test('the same role served by a different file is a change too', () => {
  // enb.cfg re-linked to another cfg — same content would still be a different
  // configuration, and here the link itself moved.
  const d = diffSnapshot(SAVED, { ...SAVED, 'enb.cfg': entry('SA-2cell.cfg', 'radio') });
  assert.equal(d.same, false);
  assert.deepEqual(d.changed.map((c: any) => [c.file, c.was, c.now]), [['enb.cfg', 'SA-1cell.cfg', 'SA-2cell.cfg']]);
});

test('a file that appeared, and one that went away, are both named', () => {
  const current: any = { ...SAVED, 'ue.cfg': entry('ue.cfg', 'ue') };
  delete current['db.cfg'];
  const d = diffSnapshot(SAVED, current);
  assert.deepEqual(
    d.changed.map((c: any) => [c.file, c.state]).sort(),
    [['db.cfg', 'removed'], ['ue.cfg', 'added']],
  );
});

test('several edits are all listed, not just the first', () => {
  const d = diffSnapshot(SAVED, {
    'enb.cfg': entry('SA-1cell.cfg', 'radio v2'),
    'mme.cfg': entry('other-mme.cfg', 'core'),
    'db.cfg': SAVED['db.cfg'],
  });
  assert.deepEqual(d.changed.map((c: any) => c.file), ['enb.cfg', 'mme.cfg']);
});

test('versions are added, never overwritten', () => {
  assert.equal(nextVersion([]), 'v1');
  assert.equal(nextVersion(['v1']), 'v2');
  assert.equal(nextVersion(['v1', 'v2', 'v10']), 'v11');
  // A stray folder never becomes a version number.
  assert.equal(nextVersion(['v1', 'notes', 'v2.bak']), 'v2');
});

test('the newest saved version is what a run compares against', () => {
  assert.equal(latestVersion(['v1', 'v2', 'v10']), 'v10');
  assert.equal(latestVersion([]), undefined);
});

test('folder names stay readable but path-safe', () => {
  assert.equal(safeFolder('SA nightly'), 'SA nightly');
  assert.equal(safeFolder('NR/SA: n78'), 'NR_SA_ n78');
  assert.equal(safeFolder('  ..  '), 'unnamed');
  assert.equal(safeFolder(''), 'unnamed');
  assert.equal(safeFolder('x'.repeat(200)).length, 80);
});

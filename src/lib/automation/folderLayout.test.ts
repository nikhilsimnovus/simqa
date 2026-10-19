import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planFolderLayout, namesFor } from './folderLayout.ts';

test('an uploaded file keeps the name the operator gave it', () => {
  const p = planFolderLayout(
    { 'enb.cfg': 'ENB', 'mme.cfg': 'MME', 'ims.cfg': 'IMS', 'ots.cfg': 'OTS' },
    { 'enb.cfg': 'MySA1Cell.cfg', 'mme.cfg': 'my-core.cfg', 'ims.cfg': 'my-ims.cfg', 'ots.cfg': 'my-ots.cfg' },
  );
  // One name per file: the role name exists only as a link, never as a copy.
  for (const role of ['enb.cfg', 'mme.cfg', 'ims.cfg', 'ots.cfg']) {
    assert.equal(p.files[role], undefined, role);
  }
  assert.deepEqual(p.files, {
    'MySA1Cell.cfg': 'ENB', 'my-core.cfg': 'MME', 'my-ims.cfg': 'IMS', 'my-ots.cfg': 'OTS',
  });
  assert.deepEqual(p.links, {
    'enb.cfg': 'MySA1Cell.cfg', 'mme.cfg': 'my-core.cfg', 'ims.cfg': 'my-ims.cfg', 'ots.cfg': 'my-ots.cfg',
  });
  assert.deepEqual(p.notes, []);
});

test('nothing picked keeps the old behaviour exactly', () => {
  const p = planFolderLayout({ 'enb.cfg': 'ENB', 'mme.cfg': 'MME' }, {});
  assert.deepEqual(p.files, { 'enb.cfg': 'ENB', 'mme.cfg': 'MME' });
  assert.deepEqual(p.links, {});
});

test('a pick that already IS the role name is not linked to itself', () => {
  const p = planFolderLayout({ 'enb.cfg': 'ENB' }, { 'enb.cfg': 'enb.cfg' });
  assert.deepEqual(p.files, { 'enb.cfg': 'ENB' });
  assert.deepEqual(p.links, {});
});

test('a slot with no content writes nothing, link or file', () => {
  // A callbox that could not be read leaves its file as it was — writing an
  // empty one, or a dangling link, would be worse than yesterday's config.
  const p = planFolderLayout({ 'enb.cfg': 'ENB' }, { 'enb.cfg': 'a.cfg', 'mme.cfg': 'b.cfg' });
  assert.deepEqual(p.files, { 'a.cfg': 'ENB' });
  assert.deepEqual(p.links, { 'enb.cfg': 'a.cfg' });
});

test('two slots picking the same name with different contents do not collide', () => {
  const p = planFolderLayout(
    { 'mme.cfg': 'MME', 'ims.cfg': 'IMS' },
    { 'mme.cfg': 'core.cfg', 'ims.cfg': 'core.cfg' },
  );
  assert.equal(p.files['core.cfg'], 'MME', 'the first slot keeps the name');
  assert.equal(p.files['ims.cfg'], 'IMS', 'the second falls back to its role name');
  assert.deepEqual(p.links, { 'mme.cfg': 'core.cfg' });
  assert.match(p.notes.join(' '), /ims\.cfg kept its own name — mme\.cfg already saved a different "core\.cfg"/);
});

test('two slots sharing one file with the SAME contents both link at it', () => {
  const p = planFolderLayout(
    { 'mme.cfg': 'SAME', 'ims.cfg': 'SAME' },
    { 'mme.cfg': 'core.cfg', 'ims.cfg': 'core.cfg' },
  );
  assert.deepEqual(p.files, { 'core.cfg': 'SAME' });
  assert.deepEqual(p.links, { 'mme.cfg': 'core.cfg', 'ims.cfg': 'core.cfg' });
  assert.deepEqual(p.notes, []);
});

test('a pick that is another slot’s role name is refused', () => {
  const p = planFolderLayout({ 'enb.cfg': 'ENB' }, { 'enb.cfg': 'mme.cfg' });
  assert.deepEqual(p.files, { 'enb.cfg': 'ENB' });
  assert.deepEqual(p.links, {});
  assert.match(p.notes.join(' '), /"mme\.cfg" is a role name/);
});

test('a pick that is a path, a dot-file or blank is refused', () => {
  for (const bad of ['../../etc/passwd', 'sub/dir.cfg', 'a\\b.cfg', '.hidden', '  ', '.', '..']) {
    const p = planFolderLayout({ 'enb.cfg': 'ENB' }, { 'enb.cfg': bad });
    assert.deepEqual(p.files, { 'enb.cfg': 'ENB' }, bad);
    assert.deepEqual(p.links, {}, bad);
  }
});

test('the database and the includes keep their own names alongside', () => {
  const p = planFolderLayout(
    { 'mme.cfg': 'MME' },
    { 'mme.cfg': 'my-core.cfg' },
    { 'test.json': '{}', 'ue_db_1000_xor.json': 'DB', '1-db.cfg': 'FRAG' },
  );
  assert.deepEqual(p.files, {
    'my-core.cfg': 'MME', 'test.json': '{}', 'ue_db_1000_xor.json': 'DB', '1-db.cfg': 'FRAG',
  });
  assert.deepEqual(p.links, { 'mme.cfg': 'my-core.cfg' });
});

test('a slot picking a name an include already uses falls back', () => {
  const p = planFolderLayout(
    { 'mme.cfg': 'MME' },
    { 'mme.cfg': 'ue_db.json' },
    { 'ue_db.json': 'THE DATABASE' },
  );
  assert.equal(p.files['ue_db.json'], 'THE DATABASE', 'the database is not overwritten');
  assert.equal(p.files['mme.cfg'], 'MME');
  assert.deepEqual(p.links, {});
});

test('namesFor accepts either the picked name or the role name', () => {
  assert.deepEqual(namesFor('enb.cfg', 'MySA1Cell.cfg'), ['MySA1Cell.cfg', 'enb.cfg']);
  assert.deepEqual(namesFor('enb.cfg', 'enb.cfg'), ['enb.cfg']);
  assert.deepEqual(namesFor('enb.cfg', undefined), ['enb.cfg']);
  assert.deepEqual(namesFor('mme.cfg', '../x'), ['mme.cfg']);
});

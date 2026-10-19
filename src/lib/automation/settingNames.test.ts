import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSettingName, resolutionNote } from './settingNames.ts';

/** What 192.168.1.95 actually reports, verbatim. */
const SUCCESS = [
  { name: 'Attach Success', isDefault: true },
  { name: 'BLER Success', isDefault: false },
  { name: 'Throughput Success', isDefault: false },
  { name: '4gmobility', isDefault: false },
  { name: 'DL Ping Success', isDefault: false },
  { name: 'Mobility', isDefault: false },
  { name: 'UL Ping Success', isDefault: false },
];
const LOGS = [
  { name: 'debug', isDefault: false },
  { name: 'disable', isDefault: false },
  { name: 'error', isDefault: false },
  { name: 'info', isDefault: false },
  { name: 'nas_rrc_debug', isDefault: true },
  { name: 'rrc_debug', isDefault: false },
  { name: 'IP', isDefault: false },
];

test('the case that stopped the run', () => {
  // NSA_3cell_Mobility_Vonr_1UEs_automation asks for "4gMobility"; the box
  // holds "4gmobility" and compares exactly, so creating it was refused with
  // BAD_REQUEST successCriteriaName '4gMobility' does not exist.
  const r = resolveSettingName('4gMobility', SUCCESS);
  assert.equal(r.name, '4gmobility');
  assert.equal(r.how, 'case');
  assert.match(resolutionNote('successCriteriaName', '4gMobility', r)!, /spells "4gMobility" as "4gmobility"/);
});

test('a name the box has is left exactly as written', () => {
  const r = resolveSettingName('nas_rrc_debug', LOGS);
  assert.equal(r.name, 'nas_rrc_debug');
  assert.equal(r.how, 'exact');
  // Nothing to report when nothing changed.
  assert.equal(resolutionNote('loggingProfileName', 'nas_rrc_debug', r), undefined);
});

test('a name the box does not have falls back to its default', () => {
  // "enable_all" was in the old hardcoded fallback list and does not exist
  // on this box at all.
  const r = resolveSettingName('enable_all', LOGS);
  assert.equal(r.name, 'nas_rrc_debug', "the box's own default");
  assert.equal(r.how, 'default');
  assert.match(resolutionNote('loggingProfileName', 'enable_all', r)!, /no "enable_all" — used its default, "nas_rrc_debug"/);

  const s = resolveSettingName('does-not-exist', SUCCESS);
  assert.equal(s.name, 'Attach Success');
});

test('an empty or missing name takes the default', () => {
  for (const asked of [undefined, '', '   ']) {
    const r = resolveSettingName(asked, LOGS);
    assert.equal(r.name, 'nas_rrc_debug', JSON.stringify(asked));
    assert.equal(r.how, 'default');
  }
});

test('surrounding space is not a different setting', () => {
  const r = resolveSettingName('  Mobility  ', SUCCESS);
  assert.equal(r.name, 'Mobility');
  // Trimmed, it IS the box's name — so nothing was really changed and the
  // row has nothing to report.
  assert.equal(r.how, 'exact');
  assert.equal(resolutionNote('successCriteriaName', '  Mobility  ', r), undefined);
});

test('exact beats case-insensitive when both exist', () => {
  // The box holds both "Mobility" and "4gmobility"; asking for "Mobility"
  // must not drift to another row that merely matches loosely.
  const r = resolveSettingName('Mobility', SUCCESS);
  assert.equal(r.name, 'Mobility');
  assert.equal(r.how, 'exact');
});

test('a box that lists nothing changes nothing', () => {
  // Better to send what the definition said and let the box answer than to
  // invent a name it never offered.
  const r = resolveSettingName('4gMobility', []);
  assert.equal(r.name, undefined);
  assert.equal(r.how, 'none');
  assert.match(resolutionNote('successCriteriaName', '4gMobility', r)!, /names no default — left as it was/);
});

test('a listing with junk in it is tolerated', () => {
  const messy = [{ name: '' }, { name: 'ok', isDefault: true }] as Array<{ name: string; isDefault?: boolean }>;
  assert.equal(resolveSettingName('nope', messy).name, 'ok');
});

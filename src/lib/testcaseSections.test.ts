// Editing a testcase in place — only what changed is written.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { diffSections, stableJson } = await import('./testcaseSections.ts');

const BASE = {
  cellConfig: { cells: [{ band: 78, bw: 100 }] },
  subsConfig: { ueCount: 16 },
  userPlaneConfig: { profiles: [{ dataType: 'udp', sessionDuration: 600 }] },
  powerCycleConfig: { profiles: [{ powerOnTime: 650, attachDelay: 5 }] },
  settings: { test_name: 'SA-1cell', description: 'x', loggingProfileName: 'debug' },
};
const clone = (o: any) => JSON.parse(JSON.stringify(o));

test('an unchanged testcase writes nothing', () => {
  const d = diffSections(BASE, clone(BASE), 'SA-1cell');
  assert.deepEqual(d.changes, []);
  assert.equal(d.rename, undefined);
});

test('one edited field writes only its section', () => {
  const e = clone(BASE);
  e.powerCycleConfig.profiles[0].powerOnTime = 657;
  assert.deepEqual(diffSections(BASE, e, 'SA-1cell').changes.map((c: any) => c.section), ['power-cycle']);
});

test('several edits are written in the order the box applies them, settings last', () => {
  const e = clone(BASE);
  e.settings.description = 'y';
  e.subsConfig.ueCount = 32;
  e.cellConfig.cells[0].bw = 50;
  assert.deepEqual(diffSections(BASE, e, 'SA-1cell').changes.map((c: any) => c.section), ['cells', 'subscribers', 'settings']);
});

test('key order alone is not a change', () => {
  const e = clone(BASE);
  e.powerCycleConfig = { profiles: [{ attachDelay: 5, powerOnTime: 650 }] };
  assert.deepEqual(diffSections(BASE, e, 'SA-1cell').changes, []);
});

test('a rename is a settings write, and reported', () => {
  const e = clone(BASE);
  e.settings.test_name = 'SA-1cell-v2';
  const d = diffSections(BASE, e, 'SA-1cell');
  assert.equal(d.rename, 'SA-1cell-v2');
  assert.deepEqual(d.changes.map((c: any) => c.section), ['settings']);
});

test('the box omitting testCaseName from its settings is not a change', () => {
  // GET returns no testCaseName; the edited file may carry both name fields.
  const cur = clone(BASE); delete cur.settings.test_name;
  const e = clone(BASE); e.settings.testCaseName = 'SA-1cell';
  assert.deepEqual(diffSections(cur, e, 'SA-1cell').changes, []);
});

test('a section the testcase never had is created, not edited', () => {
  const e = clone(BASE);
  e.mobilityConfig = { handovers: 2 };
  assert.deepEqual(diffSections(BASE, e, 'SA-1cell').changes, [{ section: 'mobility', key: 'mobilityConfig', kind: 'add' }]);
});

test('removing mobility is reported, not silently ignored', () => {
  const cur = { ...clone(BASE), mobilityConfig: { handovers: 2 } };
  const d = diffSections(cur, clone(BASE), 'SA-1cell');
  assert.deepEqual(d.changes, []);
  assert.equal(d.warnings.length, 1);
  assert.match(d.warnings[0], /mobility/);
});

test('stable JSON ignores key order and undefined', () => {
  assert.equal(stableJson({ b: 1, a: [2, { d: 3, c: undefined }] }), stableJson({ a: [2, { d: 3 }], b: 1 }));
});

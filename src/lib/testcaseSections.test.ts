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

// ── per-antenna arrays follow the antenna counts ──────────────────────────

const { reconcileCellArrays } = await import('./testcaseSections.ts');

test('DL 4 → 2 shrinks rxGain to 2, keeping the gains already set', () => {
  // The exact edit that was refused: "rxGain array size (4) must match DL antenna count (2)".
  const cfg = { cells: [{ antennas: { dl: 2, ul: 2 }, rxGain: [12, 11, 10, 10], txGain: [80, 80] }] };
  const notes = reconcileCellArrays(cfg);
  assert.deepEqual(cfg.cells[0].rxGain, [12, 11]);
  assert.deepEqual(cfg.cells[0].txGain, [80, 80]);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /rxGain resized 4 → 2/);
});

test('raising the count pads with the last gain the cell had', () => {
  const cfg = { cells: [{ antennas: { dl: 4, ul: 4 }, rxGain: [12, 11], txGain: [70, 75] }] };
  reconcileCellArrays(cfg);
  assert.deepEqual(cfg.cells[0].rxGain, [12, 11, 11, 11]);
  assert.deepEqual(cfg.cells[0].txGain, [70, 75, 75, 75]);
});

test('a missing gain array gets the box GUI defaults', () => {
  const cfg: any = { cells: [{ antennas: { dl: 2, ul: 1 } }] };
  reconcileCellArrays(cfg);
  assert.deepEqual(cfg.cells[0].rxGain, [10, 10]);
  assert.deepEqual(cfg.cells[0].txGain, [80]);
});

test('a consistent cell is left exactly as it is', () => {
  const cell = { antennas: { dl: 4, ul: 2 }, rxGain: [10, 10, 10, 10], txGain: [80, 80] };
  const cfg = { cells: [JSON.parse(JSON.stringify(cell))] };
  assert.deepEqual(reconcileCellArrays(cfg), []);
  assert.deepEqual(cfg.cells[0], cell);
});

test('an O-RU cell also gets its antenna config and eAxC ids', () => {
  const cfg = { cells: [{ antennas: { dl: 2, ul: 1 }, rxGain: [40, 40, 40, 40], txGain: [-40], oruConfig: { ru: [{ ruAntennaConfig: { dl: 4, ul: 1 } }] } }] };
  reconcileCellArrays(cfg);
  const ru = (cfg.cells[0] as any).oruConfig.ru[0];
  assert.deepEqual(ru.ruAntennaConfig, { ul: 1, dl: 2 });
  assert.deepEqual(ru.eAxCIDConfig.dlEAxCIDs, { sectionType1: [0, 1] });
  assert.deepEqual(ru.eAxCIDConfig.ulEAxCIDs, { sectionType1: [0], sectionType3: [1] });
  assert.deepEqual(cfg.cells[0].rxGain, [40, 40]);
});

test('a SUL second cell mirrors cell 0', () => {
  const cfg = { cells: [
    { antennas: { dl: 2, ul: 1 }, rxGain: [10, 10], txGain: [80] },
    { duplexMode: 'SUL', antennas: { dl: 4, ul: 2 }, rxGain: [10, 10, 10, 10], txGain: [80, 80] },
  ] };
  reconcileCellArrays(cfg);
  assert.deepEqual(cfg.cells[1].antennas, { dl: 2, ul: 1 });
  assert.deepEqual(cfg.cells[1].rxGain, [10, 10]);
  assert.deepEqual(cfg.cells[1].txGain, [80]);
});

// ── radio cards follow the simulator ─────────────────────────────────────

const { remapRfCards } = await import('./testcaseSections.ts');

test("a copy to another user's simulator moves onto its cards", () => {
  // sruthi's testcase (card 2) copied to mohan, whose simulator has 4,5.
  const cfg = { cells: [{ rfCard: 2 }] };
  assert.deepEqual(remapRfCards(cfg, [4, 5]), ['rfCard 2 → 4']);
  assert.equal(cfg.cells[0].rfCard, 4);
});

test('two cells keep their separation on the new simulator', () => {
  const cfg = { cells: [{ rfCard: 2 }, { rfCard: 3 }, { rfCard: 2 }] };
  remapRfCards(cfg, [4, 5]);
  assert.deepEqual(cfg.cells.map((c: any) => c.rfCard), [4, 5, 4]);
});

test('a testcase already on the simulator’s cards is untouched', () => {
  const cfg = { cells: [{ rfCard: 4 }, { rfCard: 5 }] };
  assert.deepEqual(remapRfCards(cfg, [4, 5]), []);
  assert.deepEqual(cfg.cells.map((c: any) => c.rfCard), [4, 5]);
});

test('more cards than the simulator has is reported, not silently dropped', () => {
  const cfg = { cells: [{ rfCard: 0 }, { rfCard: 1 }, { rfCard: 2 }] };
  const notes = remapRfCards(cfg, [4]);
  assert.deepEqual(cfg.cells.map((c: any) => c.rfCard), [4, 4, 4]);
  assert.ok(notes.some((n: string) => /3 radio cards but this simulator has 1/.test(n)));
});

test('nothing to map without cells or without target cards', () => {
  assert.deepEqual(remapRfCards({ cells: [] }, [4, 5]), []);
  assert.deepEqual(remapRfCards({ cells: [{ rfCard: 2 }] }, []), []);
});

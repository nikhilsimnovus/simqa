// When a re-run can execute the testcase already on the box, and when it has
// to build it again from the automation server's copy.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { changedSections, definitionDiffers, BUILT_FROM } = await import('./sameDefinition.ts');

const td = (over: Record<string, unknown> = {}) => ({
  cellConfig: { cells: [{ band: 78, bandwidth: 20 }] },
  subsConfig: { subs: [{ imsi: '001010000000001', ueCount: 2 }] },
  userPlaneConfig: { profiles: [{ dataType: 'iperf', sessionDuration: 95, startDelay: 5 }] },
  powerCycleConfig: { profiles: [{ powerOnTime: 100, durationP: 100 }] },
  ...over,
});

test('an unchanged row reuses its testcase', () => {
  assert.deepEqual(changedSections(td(), td()), []);
  assert.equal(definitionDiffers(td(), td()), false);
});

test('key order is not a difference', () => {
  // The box returns its sections in its own order, and a definition that has
  // been through a file and a parse comes back in insertion order. Comparing
  // raw JSON reported a difference on every run.
  const a = { cellConfig: { band: 78, bandwidth: 20 } };
  const b = { cellConfig: { bandwidth: 20, band: 78 } };
  assert.deepEqual(changedSections(a, b), []);
});

test('array order IS a difference — two cells are not one pair', () => {
  const a = { cellConfig: { cells: [{ id: 1 }, { id: 2 }] } };
  const b = { cellConfig: { cells: [{ id: 2 }, { id: 1 }] } };
  assert.deepEqual(changedSections(a, b), ['cellConfig']);
});

test('a power-on duration changed for the next run rebuilds it', () => {
  const was = td();
  const now = td({ powerCycleConfig: { profiles: [{ powerOnTime: 200, durationP: 200 }] } });
  assert.deepEqual(changedSections(was, now), ['powerCycleConfig']);
});

test('a testcase edited on the Simnovator rebuilds it', () => {
  // Somebody opens the row's testcase on the box and changes a cell. The run
  // has to put the server's definition back, not execute theirs.
  const server = td();
  const edited = td({ cellConfig: { cells: [{ band: 41, bandwidth: 20 }] } });
  assert.deepEqual(changedSections(edited, server), ['cellConfig']);
});

test('every section the box is built from is watched', () => {
  for (const k of BUILT_FROM) {
    assert.deepEqual(changedSections(td(), td({ [k]: { changed: true } })), [k], k);
  }
});

test('a section missing on both sides is not a difference', () => {
  // Plenty of testcases have no mobility at all.
  assert.deepEqual(changedSections(td(), td()), []);
  assert.equal('mobilityConfig' in td(), false);
});

test('a section on one side only is a difference', () => {
  assert.deepEqual(changedSections(td(), td({ mobilityConfig: { profiles: [] } })), ['mobilityConfig']);
});

test('the box\u2019s own metadata and defaults are ignored', () => {
  // The box echoes back settings, ids and timestamps nobody sent; comparing
  // whole objects would rebuild a perfectly good testcase every run.
  const fromBox = { ...td(), settings: { test_name: 'X' }, id: 'abc', metadata: { createdOn: 'now' } };
  assert.deepEqual(changedSections(fromBox, td()), []);
});

test('nothing at all compares as nothing at all', () => {
  assert.deepEqual(changedSections(undefined, undefined), []);
  assert.deepEqual(changedSections(null, {}), []);
  assert.deepEqual(changedSections({}, td()), [...BUILT_FROM].filter(k => k !== 'mobilityConfig'));
});

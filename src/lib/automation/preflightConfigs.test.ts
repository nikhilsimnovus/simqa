// Whether a row can run on a given setup, decided before any box is touched.
//
// The cases are the ones this lab actually produces: suites whose folders are
// complete and portable, and suites with rows pointing at core cfgs that exist
// in neither the folder nor on the callbox — Mohan_mme.cfg on .102, which was
// deleted from the callbox and never captured.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { preflightRows, includesOf } = await import('./preflightConfigs.ts');

const row = (name: string) => ({ name, callboxCfg: 'SA-1cell.cfg', mmeCfg: 'demo-mme.cfg', imsCfg: 'demo-ims.cfg' });
const MME_WITH_DB = 'engine: "x"\n  include "ue_db_1000_xor.json",\n';

test('a complete folder runs anywhere — nothing is needed from the box', () => {
  const out = preflightRows({
    rows: [row('TC1')],
    folder: { TC1: { 'test.json': '{}', 'enb.cfg': 'a', 'mme.cfg': MME_WITH_DB, 'ims.cfg': 'c', 'ue_db_1000_xor.json': 'd' } },
    withCallbox: true,
  });
  assert.deepEqual(out, []);
});

test('a file only the callbox has is fine — that is how suites have always run', () => {
  const out = preflightRows({
    rows: [row('TC1')],
    folder: { TC1: { 'test.json': '{}' } },
    onCallboxRadio: new Set(['SA-1cell.cfg']),
    onCallboxCore: new Set(['demo-mme.cfg', 'demo-ims.cfg']),
    withCallbox: true,
  });
  assert.deepEqual(out, []);
});

test('a cfg in neither place is named, with the row and what it was for', () => {
  const out = preflightRows({
    rows: [{ name: 'AIO_SA_Emergencycall_PEI_automation', callboxCfg: 'SA-1cell.cfg', mmeCfg: 'Mohan_mme.cfg', imsCfg: 'Mohan_ims.cfg' }],
    folder: { AIO_SA_Emergencycall_PEI_automation: { 'test.json': '{}', 'enb.cfg': 'a' } },
    onCallboxCore: new Set(['demo-mme.cfg']),
    withCallbox: true,
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].row, 'AIO_SA_Emergencycall_PEI_automation');
  assert.deepEqual(out[0].missing, ['mme.cfg ("Mohan_mme.cfg")', 'ims.cfg ("Mohan_ims.cfg")']);
});

test('an upload the suite carries counts as present', () => {
  const out = preflightRows({
    rows: [row('TC1')],
    folder: { TC1: {} },
    uploads: new Set(['SA-1cell.cfg', 'demo-mme.cfg', 'demo-ims.cfg']),
    withCallbox: true,
  });
  assert.deepEqual(out, []);
});

test('a DB the MME includes must be somewhere too', () => {
  const out = preflightRows({
    rows: [row('TC1')],
    folder: { TC1: { 'enb.cfg': 'a', 'mme.cfg': MME_WITH_DB, 'ims.cfg': 'c' } },
    withCallbox: true,
  });
  assert.deepEqual(out[0].missing, ['ue_db_1000_xor.json (included by mme.cfg)']);

  // …and is satisfied by the callbox already holding it.
  const ok = preflightRows({
    rows: [row('TC1')],
    folder: { TC1: { 'enb.cfg': 'a', 'mme.cfg': MME_WITH_DB, 'ims.cfg': 'c' } },
    onCallboxCore: new Set(['ue_db_1000_xor.json']),
    withCallbox: true,
  });
  assert.deepEqual(ok, []);
});

test('a uesim-only run needs no callbox files at all', () => {
  const out = preflightRows({ rows: [row('TC1')], folder: { TC1: {} }, withCallbox: false });
  assert.deepEqual(out, []);
});

test('includes are read by name, path stripped, deduped', () => {
  const text = '  include "demo-1000ue_db-ims-volte.cfg",\ninclude "/root/mme/config/demo-1000ue_db-ims-volte.cfg",\n# include "commented.cfg"\n';
  assert.deepEqual(includesOf(text), ['demo-1000ue_db-ims-volte.cfg']);
});

test('a database the row chose must come from somewhere, like any other file', () => {
  const pick = { ...row('TC1'), dbCfg: 'chosen-ue_db.cfg' };
  // Nowhere to be found.
  const missing = preflightRows({
    rows: [pick],
    folder: { TC1: { 'test.json': '{}' } },
    onCallboxRadio: new Set(['SA-1cell.cfg']),
    onCallboxCore: new Set(['demo-mme.cfg', 'demo-ims.cfg']),
    withCallbox: true,
  });
  assert.deepEqual(missing[0].missing, ['chosen-ue_db.cfg ("chosen-ue_db.cfg")']);
  // On the callbox already: nothing to provide.
  assert.deepEqual(preflightRows({
    rows: [pick],
    folder: { TC1: { 'test.json': '{}' } },
    onCallboxRadio: new Set(['SA-1cell.cfg']),
    onCallboxCore: new Set(['demo-mme.cfg', 'demo-ims.cfg', 'chosen-ue_db.cfg']),
    withCallbox: true,
  }), []);
  // Or carried by the suite as an upload.
  assert.deepEqual(preflightRows({
    rows: [pick],
    folder: { TC1: { 'test.json': '{}' } },
    uploads: new Set(['chosen-ue_db.cfg']),
    onCallboxRadio: new Set(['SA-1cell.cfg']),
    onCallboxCore: new Set(['demo-mme.cfg', 'demo-ims.cfg']),
    withCallbox: true,
  }), []);
});

test('an ots.cfg the row binds is checked against /root/ots/config', () => {
  const pick = { ...row('TC1'), otsCfg: 'my-ots.cfg' };
  const base = {
    folder: { TC1: { 'test.json': '{}' } },
    onCallboxRadio: new Set(['SA-1cell.cfg']),
    onCallboxCore: new Set(['demo-mme.cfg', 'demo-ims.cfg']),
    withCallbox: true,
  };
  assert.deepEqual(preflightRows({ rows: [pick], ...base }), [
    { row: 'TC1', missing: ['ots.cfg ("my-ots.cfg")'] },
  ]);
  // The ots directory is its own: a file of that name in /root/mme/config
  // would not do.
  assert.deepEqual(preflightRows({ rows: [pick], ...base, onCallboxOts: new Set(['my-ots.cfg']) }), []);
  // The folder keeps it under the role name, whatever the box calls the file.
  assert.deepEqual(preflightRows({
    rows: [pick], ...base,
    folder: { TC1: { 'test.json': '{}', 'ots.cfg': 'COMPONENTS+=" MME"' } },
  }), []);
});

test('a row that overrides neither is unaffected', () => {
  assert.deepEqual(preflightRows({
    rows: [row('TC1')],
    folder: { TC1: { 'test.json': '{}' } },
    onCallboxRadio: new Set(['SA-1cell.cfg']),
    onCallboxCore: new Set(['demo-mme.cfg', 'demo-ims.cfg']),
    withCallbox: true,
  }), []);
});

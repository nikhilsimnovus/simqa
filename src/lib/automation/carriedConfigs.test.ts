// Which uploaded files land in a row's folder, and under what name.
//
// The folder is what lets a row run on a box that has never held its configs,
// so a file the operator uploaded has to be there — and captureRowConfigs
// cannot see it, because that reads the callbox by name and the upload is on
// no box yet.
//
// It lives in a module of its own, importing nothing, so the test runner can
// load it without dragging SSH and the inventory in behind it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { carriedConfigs } = await import('./carriedConfigs.ts');

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const suite = (uploads: Record<string, string>) => ({
  uploadedConfigs: Object.fromEntries(Object.entries(uploads).map(([k, v]) => [k, b64(v)])),
}) as any;

test('each slot lands under its role name', () => {
  const s = suite({
    'my-enb.cfg': 'ENB', 'my-mme.cfg': 'MME', 'my-ims.cfg': 'IMS', 'my-ots.cfg': 'OTS',
  });
  const out = carriedConfigs(s, {
    callboxCfg: 'my-enb.cfg', mmeCfg: 'my-mme.cfg', imsCfg: 'my-ims.cfg', otsCfg: 'my-ots.cfg',
  });
  assert.deepEqual(out, { 'enb.cfg': 'ENB', 'mme.cfg': 'MME', 'ims.cfg': 'IMS', 'ots.cfg': 'OTS' });
});

test('the subscriber database keeps its own name', () => {
  // The MME config includes it by that name, and that is the name it has to
  // exist under on the callbox — "db" said nothing about which file it was.
  const out = carriedConfigs(suite({ 'ue_db_1000_xor.json': 'UEDB' }), { dbCfg: 'ue_db_1000_xor.json' });
  assert.deepEqual(out, { 'ue_db_1000_xor.json': 'UEDB' });
});

test('a slot filled from the callbox rather than an upload contributes nothing', () => {
  // demo-mme.cfg is a file the box already has: the capture reads it, not this.
  assert.deepEqual(carriedConfigs(suite({ 'my-enb.cfg': 'ENB' }), { mmeCfg: 'demo-mme.cfg' }), {});
  assert.deepEqual(carriedConfigs(suite({}), { callboxCfg: 'SA-1cell.cfg' }), {});
});

test('a row that picked nothing carries nothing', () => {
  assert.deepEqual(carriedConfigs(suite({ 'my-enb.cfg': 'ENB' }), {}), {});
});

test('a suite with no uploads at all carries nothing', () => {
  assert.deepEqual(carriedConfigs({} as any, { callboxCfg: 'my-enb.cfg' }), {});
});

test('an empty uploaded file is still written — it is what the operator chose', () => {
  const out = carriedConfigs(suite({ 'empty.cfg': '' }), { imsCfg: 'empty.cfg' });
  assert.deepEqual(out, { 'ims.cfg': '' });
});

test('the same upload bound to two slots lands under both names', () => {
  const out = carriedConfigs(suite({ 'both.cfg': 'X' }), { mmeCfg: 'both.cfg', imsCfg: 'both.cfg' });
  assert.deepEqual(out, { 'mme.cfg': 'X', 'ims.cfg': 'X' });
});

test('the bytes come back as they went in, non-ASCII and all', () => {
  const text = '/* cfg */\nname: "café — ①"\n';
  const out = carriedConfigs(suite({ 'u.cfg': text }), { callboxCfg: 'u.cfg' });
  assert.equal(out['enb.cfg'], text);
});

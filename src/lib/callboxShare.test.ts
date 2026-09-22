// A config change restarts LTE under everyone on the callbox — only allowed
// when nobody else is executing.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { decideBringUp, cfgChanges, describeOthers, describeCfg } = await import('./callboxShare.ts');

const CURRENT = { enb: 'gnb-sa-n78.cfg', mme: 'mme-ims.cfg', ims: 'ims.cfg' };
const SRUTHI = { user: 'sruthi', testcaseName: 'sample', simulator: 'UE-Simulator-2', state: 'executing' as const };

test('nobody else executing, different config → link and restart', () => {
  const d = decideBringUp({ enb: 'gnb-sa-n41.cfg' }, CURRENT, []);
  assert.equal(d.action, 'link-restart');
  assert.deepEqual((d as any).changes, ['enb.cfg: gnb-sa-n78.cfg → gnb-sa-n41.cfg']);
});

test('someone else executing, different config → blocked, never restarted under them', () => {
  const d = decideBringUp({ enb: 'gnb-sa-n41.cfg' }, CURRENT, [SRUTHI]);
  assert.equal(d.action, 'blocked');
  assert.deepEqual((d as any).others, [SRUTHI]);
  assert.deepEqual((d as any).current, CURRENT);
});

test('picked config already linked → no restart, whoever is executing', () => {
  assert.equal(decideBringUp({ enb: 'gnb-sa-n78.cfg', mme: 'mme-ims.cfg' }, CURRENT, []).action, 'unchanged');
  assert.equal(decideBringUp({ enb: 'gnb-sa-n78.cfg' }, CURRENT, [SRUTHI]).action, 'unchanged');
});

test('nothing picked → nothing to do', () => {
  assert.equal(decideBringUp({}, CURRENT, [SRUTHI]).action, 'none');
  assert.equal(decideBringUp(undefined, CURRENT, []).action, 'none');
});

test('a role not picked is not a change, even if something else is linked there', () => {
  assert.deepEqual(cfgChanges({ mme: 'mme-ims.cfg' }, CURRENT), []);
});

test('a role with nothing linked yet counts as a change', () => {
  assert.deepEqual(cfgChanges({ gnb: 'x.cfg' }, CURRENT), ['gnb.cfg: (none) → x.cfg']);
});

test('messages name who is running what, and the config in use', () => {
  assert.equal(describeOthers([SRUTHI, { user: 'mohan', state: 'starting' }]), 'sruthi (sample on UE-Simulator-2), mohan (starting)');
  assert.equal(describeCfg(CURRENT), 'enb.cfg → gnb-sa-n78.cfg, mme.cfg → mme-ims.cfg, ims.cfg → ims.cfg');
  assert.equal(describeCfg({}), 'whatever is currently linked');
});

test('an absolute link target and a bare file name are the same file', () => {
  assert.deepEqual(cfgChanges({ enb: 'gnb-sa-n78.cfg' }, { enb: '/root/enb/config/gnb-sa-n78.cfg' }), []);
  assert.equal(decideBringUp({ enb: 'gnb-sa-n78.cfg' }, { enb: '/root/enb/config/gnb-sa-n78.cfg' }, [SRUTHI]).action, 'unchanged');
});

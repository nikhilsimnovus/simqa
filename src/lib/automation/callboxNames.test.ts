import { test } from 'node:test';
import assert from 'node:assert/strict';
import { automationName, isAutomationName, AUTOMATION_SUFFIX } from './callboxNames.ts';

test('the suffix goes before the extension', () => {
  // The real names from the Subscriber and 3Cell suites.
  assert.equal(automationName('Mohan_mme.cfg'), 'Mohan_mme_automation.cfg');
  assert.equal(automationName('SA-1cell.cfg'), 'SA-1cell_automation.cfg');
  assert.equal(automationName('gnb-sa-slice_pr.cfg'), 'gnb-sa-slice_pr_automation.cfg');
  assert.equal(automationName('demo-2000ue_db-ims-volte.cfg'), 'demo-2000ue_db-ims-volte_automation.cfg');
  assert.equal(automationName('ue_db_1000_xor.json'), 'ue_db_1000_xor_automation.json');
});

test('a re-run does not grow the name', () => {
  // The whole reason this is idempotent: the deployed name has to be the
  // same every run, or the stale copy can never be found and deleted.
  const once = automationName('Mohan_mme.cfg');
  assert.equal(automationName(once), once);
  assert.equal(automationName(automationName(once)), once);
});

test('a file the lab already named _automation is left alone', () => {
  assert.equal(automationName('Mohan_mme_automation.cfg'), 'Mohan_mme_automation.cfg');
  assert.equal(automationName('already_automation'), 'already_automation');
});

test('a name with no extension still gets the suffix', () => {
  assert.equal(automationName('db'), `db${AUTOMATION_SUFFIX}`);
  assert.equal(automationName('ue_db'), 'ue_db_automation');
});

test('only the LAST dot counts as the extension', () => {
  assert.equal(automationName('mme-ims-slice-single.v2.cfg'), 'mme-ims-slice-single.v2_automation.cfg');
});

test('a path, a dot-file or blank is passed through untouched', () => {
  // Refused by the caller; inventing a different path here would be worse.
  for (const bad of ['../../etc/passwd', 'sub/dir.cfg', 'a\\b.cfg', '.hidden', '', '  ', '.', '..']) {
    assert.equal(automationName(bad), bad, JSON.stringify(bad));
    assert.equal(isAutomationName(bad), false, JSON.stringify(bad));
  }
});

test('isAutomationName recognises exactly what a run deploys', () => {
  assert.equal(isAutomationName('Mohan_mme_automation.cfg'), true);
  assert.equal(isAutomationName(automationName('SA-1cell.cfg')), true);
  // The lab's own files are not ours to delete.
  assert.equal(isAutomationName('Mohan_mme.cfg'), false);
  assert.equal(isAutomationName('SA-1cell.cfg'), false);
  assert.equal(isAutomationName('enb.cfg'), false);
  // "_automation" must be the end of the STEM, not merely present.
  assert.equal(isAutomationName('Mohan_automation_core.cfg'), false);
});

test('row display names are not run through this', () => {
  // Rows are already called X_automation; this is for FILES. Guarding the
  // behaviour anyway, since the two names sit next to each other in the
  // runner and confusing them would double the suffix on one of them.
  assert.equal(automationName('AIO_Network_Slicing_singleslice_automation'),
    'AIO_Network_Slicing_singleslice_automation');
});

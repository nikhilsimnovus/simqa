// The risk policy is the part of discovery that protects live hardware, so it
// is tested against the labels this lab's UI actually carries.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { normaliseLabel, slugOf, riskOf, elementKey, looksLikeEmptyState } =
  await import('./classify.ts');

test('labels keep their name across badge and icon churn', () => {
  assert.equal(normaliseLabel('  Manage   Simulators '), 'Manage Simulators');
  assert.equal(normaliseLabel('Unstable (3)'), 'Unstable');
  assert.equal(normaliseLabel('Stable:'), 'Stable');
});

test('a breadcrumb slugs to the same id on both builds', () => {
  assert.equal(
    slugOf(['Tools', 'Simnovator Management', 'Manage Simulators', 'Stable']),
    'tools/simnovator-management/manage-simulators/stable',
  );
});

test('anything that changes the box is never operated', () => {
  for (const l of ['Delete', 'Remove UE', 'Save Changes', 'Apply Changes', 'Start Test',
                   'Stop', 'Reboot', 'Install Build', 'Reset', 'Upload', 'Disable',
                   'Log out', 'Update']) {
    assert.equal(riskOf(l, 'button'), 'mutate', l);
  }
});

test('forms are opened and cancelled, not avoided', () => {
  for (const l of ['Add Simulator', 'New Test Case', 'Edit', 'Configure', 'Details']) {
    assert.equal(riskOf(l, 'button'), 'open', l);
  }
});

test('reading the UI is free', () => {
  for (const l of ['Stable', 'Unstable', 'Container Hosts', 'Search', 'Filter', 'Next']) {
    assert.equal(riskOf(l, 'tab'), 'read', l);
  }
});

test('an unlabelled button is treated as dangerous, an unlabelled field is not', () => {
  assert.equal(riskOf('', 'button'), 'mutate');
  assert.equal(riskOf('', 'input'), 'read');
});

test('word matching does not fire on substrings', () => {
  assert.equal(riskOf('Readdress', 'button'), 'read');
  assert.equal(riskOf('Starting point', 'link'), 'read');
  assert.equal(riskOf('Updates', 'button'), 'mutate');
});

test('element keys are stable by name and fall back to position', () => {
  assert.equal(elementKey('button', 'Add Simulator', 0), 'button:add-simulator');
  assert.equal(elementKey('input', '', 3), 'input:#3');
});

test('an empty table says so in its own words', () => {
  assert.ok(looksLikeEmptyState('No data available'));
  assert.ok(looksLikeEmptyState('No records found'));
  assert.ok(!looksLikeEmptyState('UE1_Mohan'));
});

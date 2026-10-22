import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultRowNameFor } from './rowName.ts';

test('a plain test case name gains the suffix', () => {
  assert.equal(defaultRowNameFor('5G_1cell_UDP_64UEs'), '5G_1cell_UDP_64UEs_automation');
});

test('a name that already ends in _automation does not gain a second', () => {
  // The bug seen in the field: the box holds the copy a previous run made,
  // it appears in the picker, and choosing it doubled the suffix.
  assert.equal(defaultRowNameFor('5G_1cell_UDP_64UEs_automation'), '5G_1cell_UDP_64UEs_automation');
});

test('and never a third, however many times it goes round', () => {
  let n = 'AIO_SA_Redcap_Simqa';
  for (let i = 0; i < 5; i++) n = defaultRowNameFor(n);
  assert.equal(n, 'AIO_SA_Redcap_Simqa_automation');
});

test('the check is case-insensitive, because the box is not consistent', () => {
  assert.equal(defaultRowNameFor('X_Automation'), 'X_Automation');
  assert.equal(defaultRowNameFor('X_AUTOMATION'), 'X_AUTOMATION');
});

test('a name merely containing the word still gains the suffix', () => {
  // "automation_suite_test" is not an already-made copy.
  assert.equal(defaultRowNameFor('automation_suite_test'), 'automation_suite_test_automation');
});

test('an empty or missing name yields nothing to show', () => {
  assert.equal(defaultRowNameFor(''), '');
  assert.equal(defaultRowNameFor(undefined), '');
  assert.equal(defaultRowNameFor('   '), '');
});

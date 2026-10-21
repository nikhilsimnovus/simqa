import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSteps, parseExpected, parseObserved, deriveExpected, planTicket, pageOf, runnabilityOf } from './steps.ts';

/** SIM40-3409, verbatim from Jira. */
const REAL = [
  '**Step 1:** Log in to Simnovator using any valid user account.',
  '',
  '**Step 2:** Navigate to the **My Test** page and start any long-duration test case.',
  '',
  '**Step 3:** Log in to Simnovator using an Admin account in a separate session.',
  '',
  '**Step 4:** Navigate to **Tools → Manage Simulator** under Simulator Management. The Simulator Management page will be displayed.',
  '',
  '**Step 5:** Check whether any option is available to stop the ongoing test case.',
  '',
  '**Expected Result:** The Admin should be able to stop another user’s ongoing test case.',
].join('\n');

test('the real ticket parses into its five steps', () => {
  const steps = parseSteps(REAL);
  assert.equal(steps.length, 5);
  assert.deepEqual(steps.map((s) => s.n), [1, 2, 3, 4, 5]);
  assert.match(steps[0].text, /^Log in to Simnovator using any valid user account\.$/);
  // The markdown emphasis is gone, so the step reads as a sentence.
  assert.ok(!steps[1].text.includes('**'));
});

test('the page a step names is recognised', () => {
  const steps = parseSteps(REAL);
  assert.equal(steps[1].page, 'My Tests');
  // "Tools → Manage Simulator" names two; the more specific one wins.
  assert.equal(steps[3].page, 'Manage Simulator');
  assert.equal(steps[0].page, 'Login');
});

test('an observation step is marked as the place a check belongs', () => {
  const steps = parseSteps(REAL);
  assert.equal(steps[4].isCheck, true, '"Check whether..." is a check');
  assert.equal(steps[1].isCheck, false, '"Navigate and start" is an action');
});

test('the expected result is quoted, not assembled', () => {
  const e = parseExpected(REAL);
  assert.match(e, /Admin should be able to stop another user/);
  // It comes from the ticket's own heading, so it carries the ticket's words.
  assert.ok(!e.includes('Step'));
});

test('a bare "Step 1:" is parsed as well as "**Step 1:**"', () => {
  const steps = parseSteps('Step 1: Open the Dashboard.\nStep 2: Check the counters.');
  assert.equal(steps.length, 2);
  assert.equal(steps[0].page, 'Dashboard');
});

test('a ticket stating nothing expected is NOT run', () => {
  // The whole point: no assertion can be invented.
  const p = planTicket({ key: 'X-1', description: '**Step 1:** Open the **Dashboard** page.' });
  assert.equal(p.runnability.runnable, false);
  assert.equal(p.expectedSource, 'none');
  assert.match((p.runnability as any).reason, /neither states an expected result/);
});

test('a ticket with no steps is not run, and says so', () => {
  const p = planTicket({ key: 'SIM40-441', description: '' });
  assert.equal(p.runnability.runnable, false);
  assert.match((p.runnability as any).reason, /no numbered steps/);
});

test('steps that name no page are not run', () => {
  const r = runnabilityOf(
    [{ n: 1, text: 'Do the thing', isCheck: false }], 'it should work');
  assert.equal(r.runnable, false);
  assert.match((r as any).reason, /name no Simnovator page/);
});

test('an infrastructure ticket is never run as a UI test', () => {
  const r = runnabilityOf(
    [{ n: 1, text: 'Open the Dashboard', page: 'Dashboard', isCheck: false }],
    'containers should start',
    'Installation, Services and Infrastructure');
  assert.equal(r.runnable, false);
  assert.match((r as any).reason, /names no UI screen/);
});

test('the complete real ticket is runnable, with its pages in order', () => {
  const p = planTicket({ key: 'SIM40-3409', description: REAL, category: 'Tools, Simulator and User Management' });
  assert.equal(p.runnability.runnable, true);
  assert.deepEqual(p.pages, ['Login', 'My Tests', 'Manage Simulator']);
  assert.equal(p.steps.length, 5);
  assert.ok(p.expected.length > 0);
});

test('a "should" sentence counts when there is no Expected heading', () => {
  const e = parseExpected('**Step 1:** Open it.\nThe count should match the number of test cases.');
  assert.match(e, /count should match/);
});

test('pageOf prefers the longer, more specific alias', () => {
  assert.equal(pageOf('go to Tools and open Manage Simulator'), 'Manage Simulator');
  assert.equal(pageOf('open the Sample Tests page'), 'Sample Tests');
  assert.equal(pageOf('nothing here names a screen'), undefined);
});

test('the reported actual behaviour is picked up from the house style', () => {
  // 92 tickets use "Actual Result", 55 "Observed Behaviour", 43 "Observed
  // Result" — far more than state an expectation.
  const a = parseObserved('**Step 1:** Open it.\n**Actual Result:** The version is blank.');
  assert.match(a, /version is blank/);
  const b = parseObserved('**Observed Behaviour:** The counter stays at zero.');
  assert.match(b, /counter stays at zero/);
  const c = parseObserved('**Observed Result:** Nothing is listed.');
  assert.match(c, /Nothing is listed/);
  assert.equal(parseObserved('**Step 1:** Open it.'), '');
});

test('a defect summary is turned round into the expectation it implies', () => {
  // Reading the reporter's own statement, not inventing one.
  assert.match(deriveExpected('Failed: Simnovator GUI fails to display installed version on GUI dashboard.'),
    /Simnovator GUI should display installed version/i);
  assert.match(deriveExpected('Action/Status not refreshed after stopping Test Case.'),
    /should be available/i);
  assert.match(deriveExpected('Admin unable to stop another User\u2019s ongoing test case.'),
    /should be able to stop/i);
  assert.match(deriveExpected('Missing Access Class values (11\u201315) in UAC Class Value selection.'),
    /should be present/i);
  assert.match(deriveExpected('Duplicate success notification displayed when deleting a test case'),
    /should appear once/i);
  assert.match(deriveExpected('"Current Mode" heading incorrectly switches between Online and Offline.'),
    /should not switch/i);
});

test('a summary with no defect wording yields nothing, and the ticket blocks', () => {
  assert.equal(deriveExpected('Failed: SA - Two cells - Handover with UDP - 256 UEs'), '');
  assert.equal(deriveExpected('Add ORU support for simnovator'), '');
});

test('a quoted expectation always beats a derived one', () => {
  const p = planTicket({
    key: 'X', summary: 'Failed: GUI fails to display the count',
    description: '**Step 1:** Open the **Dashboard**.\n**Expected Result:** The count shows 12.',
  });
  assert.equal(p.expectedSource, 'stated');
  assert.match(p.expected, /count shows 12/);
});

test('a derived expectation is labelled as derived, never as the reporter\u2019s words', () => {
  const p = planTicket({
    key: 'SIM40-544', summary: 'Failed: Simnovator GUI fails to display installed version on GUI dashboard.',
    description: '**Step 1:** Log in to the Simnovator.\n**Step 2:** Verify the installed version displayed on the GUI **dashboard**.',
  });
  assert.equal(p.runnability.runnable, true);
  assert.equal(p.expectedSource, 'derived');
  assert.match(p.expected, /should display installed version/i);
});

test('with neither, the reason names both routes that were tried', () => {
  const p = planTicket({
    key: 'Y', summary: 'Failed: SA - Two cells - Handover with UDP - 256 UEs',
    description: '**Step 1:** Open the **Dashboard**.',
  });
  assert.equal(p.runnability.runnable, false);
  assert.match((p.runnability as any).reason, /neither states an expected result nor describes a defect/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  categoriseTicket, categoriseAll, scoreRule, testTypesOf,
  CATEGORY_RULES, TEST_TYPE_LABELS, UNCLASSIFIED,
} from './categorise.ts';

/** Real SIM40 tickets, verbatim, so the rules are tested against the thing
 *  they were derived from rather than against invented examples. */
const T = {
  logs: {
    key: 'SIM40-424',
    summary: 'Failed: Logs are not downloaded for the selected test case',
    description: '**Step 1:** Log in. **Step 2:** Download log from My Tests.',
    labels: ['QA_GUI_Functional', 'logs'],
  },
  adminStop: {
    key: 'SIM40-3409',
    summary: "Admin unable to stop another User's ongoing test case or delete the user to release Simulator resources.",
    description: '**Step 4:** Navigate to **Tools → Manage Simulator** under Simulator Management.',
    labels: ['admin', 'spaceX'],
  },
  ueStats: {
    key: 'SIM40-X1',
    summary: 'Failed: UE Statistics table does not update during execution',
    description: 'Start the test and open the UE statistics page.',
    labels: ['QA_GUI_Functional'],
  },
  podman: {
    key: 'SIM40-1023',
    summary: 'Podman containers do not start automatically after VM reboot.',
    description: 'Reboot the VM and check podman ps.',
    labels: ['QA_GUI_Functional'],
  },
  sampleTests: {
    key: 'SIM40-2982',
    summary: 'Failed: Simnovator GUI fails to display Sample Test Cases on the Sample Tests page',
    description: '**Step 1:** Open the Sample Tests page.',
    labels: ['QA_GUI_User_Exp'],
  },
  nothing: { key: 'SIM40-441', summary: 'Failed: SA - Two cells - Handover with UDP - 256 UEs', description: '', labels: [] },
};

test('a QA label places a ticket outright', () => {
  const a = categoriseTicket(T.logs);
  assert.equal(a.category, 'Logs and Reports');
  assert.match(a.why.join(' '), /label "logs"/);
});

test('statistics beat execution when a ticket is about both', () => {
  // "does not update during execution" would match Test Execution on its
  // description; the rule order puts the statistics page first, which is
  // what the ticket is actually about.
  assert.equal(categoriseTicket(T.ueStats).category, 'UE Statistics');
});

test('a service bug is not a UI category', () => {
  // These must never be run as UI tests — they name no screen.
  assert.equal(categoriseTicket(T.podman).category, 'Installation, Services and Infrastructure');
});

test('the Tools label wins over the words in the steps', () => {
  // The description says "Navigate to Tools", but the LABEL is what decides.
  const a = categoriseTicket(T.adminStop);
  assert.equal(a.category, 'Tools, Simulator and User Management');
  assert.match(a.why.join(' '), /label "admin"/);
});

test('QA_GUI_User_Exp does not become a category', () => {
  // It is on 375 of the 996 and spans the whole product. When it WAS a
  // category rule it swallowed 362 tickets into one unusable bucket.
  assert.equal(categoriseTicket(T.sampleTests).category, 'My Tests and Test Case Management');
  for (const rule of CATEGORY_RULES) {
    for (const l of rule.labels ?? []) {
      assert.ok(!TEST_TYPE_LABELS.includes(l.toLowerCase()),
        `rule "${rule.name}" must not categorise on the test-type label "${l}"`);
    }
  }
});

test('test types are reported as a facet, not a category', () => {
  assert.deepEqual(testTypesOf(T.sampleTests), ['QA_GUI_User_Exp']);
  assert.deepEqual(testTypesOf(T.adminStop), ['spaceX']);
  assert.deepEqual(testTypesOf(T.nothing), []);
});

test('a ticket with no signal is surfaced, never dropped', () => {
  const a = categoriseTicket(T.nothing);
  assert.equal(a.category, UNCLASSIFIED);
  assert.match(a.why[0], /no label, summary or description signal/);
});

test('every ticket gets exactly one category and none is lost', () => {
  const all = Object.values(T);
  const { assignments, categories } = categoriseAll(all);
  assert.equal(assignments.length, all.length);
  assert.deepEqual(assignments.map((a) => a.key).sort(), all.map((t) => t.key).sort());
  // The counts add up to the input — nothing counted twice, nothing missing.
  assert.equal(categories.reduce((n, c) => n + c.total, 0), all.length);
});

test('a category with no tickets does not appear', () => {
  const { categories } = categoriseAll([T.logs]);
  assert.deepEqual(categories.map((c) => c.name), ['Logs and Reports']);
});

test('Unclassified sorts last however big it is', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ ...T.nothing, key: `X-${i}` }));
  const { categories } = categoriseAll([...many, T.logs]);
  assert.equal(categories[categories.length - 1].name, UNCLASSIFIED);
  assert.equal(categories[0].name, 'Logs and Reports');
});

test('an assignment can be explained and challenged', () => {
  const a = categoriseTicket(T.ueStats);
  assert.ok(a.why.length > 0, 'every assignment says why');
  assert.ok(Array.isArray(a.alternatives), 'and what it nearly was');
});

test('scoreRule weights label above summary above description', () => {
  const rule = CATEGORY_RULES.find((r) => r.name === 'Logs and Reports')!;
  const byLabel = scoreRule({ key: 'a', labels: ['logs'] }, rule).score;
  const bySummary = scoreRule({ key: 'b', summary: 'log download broken' }, rule).score;
  const byBody = scoreRule({ key: 'c', description: 'then download the log' }, rule).score;
  assert.ok(byLabel > bySummary && bySummary > byBody, `${byLabel} > ${bySummary} > ${byBody}`);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickPostReport, hasReport, type RunLike } from './pickReport.ts';

const withRules = (n = 2) => ({ rulesConfigured: n, outcome: 'FAIL', passedRules: 1 });

const run = (runId: string, steps: any[]): RunLike => ({
  runId, finishedAt: `2026-10-2${runId.slice(-1)}T10:00:00Z`, steps,
});

test('the newest run that checked rules is the one shown', () => {
  const runs = [
    run('r3', [{ testcaseId: 'A', postProcessing: withRules(), finalResult: 'FAIL', verdict: 'PASS' }]),
    run('r2', [{ testcaseId: 'A', postProcessing: withRules(1), finalResult: 'PASS' }]),
  ];
  const p = pickPostReport(runs, 'A');
  assert.equal(p?.runId, 'r3');
  assert.equal(p?.finalResult, 'FAIL');
  // The box's own verdict travels with it, to be shown beside ours.
  assert.equal(p?.verdict, 'PASS');
});

test('a row re-run without rules has nothing to show — it does not fall back', () => {
  // Otherwise a report from last week would sit under a result from today.
  const runs = [
    run('r3', [{ testcaseId: 'A', verdict: 'PASS' }]),
    run('r2', [{ testcaseId: 'A', postProcessing: withRules() }]),
  ];
  assert.equal(pickPostReport(runs, 'A'), null);
});

test('other rows in the same run are not confused for this one', () => {
  const runs = [
    run('r3', [
      { testcaseId: 'B', postProcessing: withRules() },
      { testcaseId: 'A', postProcessing: withRules(3), finalResult: 'PASS' },
    ]),
  ];
  assert.equal((pickPostReport(runs, 'A')?.report as { rulesConfigured: number }).rulesConfigured, 3);
});

test('run-level bookkeeping is skipped', () => {
  const runs = [run('r1', [
    { testcaseId: 'licence-restore', kind: 'note' },
    { testcaseId: 'A', postProcessing: withRules() },
  ])];
  assert.equal(pickPostReport(runs, 'A')?.runId, 'r1');
});

test('a row that never ran, and an empty name, give nothing', () => {
  assert.equal(pickPostReport([run('r1', [{ testcaseId: 'A', postProcessing: withRules() }])], 'Z'), null);
  assert.equal(pickPostReport([], 'A'), null);
  assert.equal(pickPostReport([run('r1', [{ testcaseId: 'A', postProcessing: withRules() }])], '  '), null);
});

test('a report with zero rules is not a report', () => {
  assert.equal(hasReport({ postProcessing: { rulesConfigured: 0 } }), false);
  assert.equal(hasReport({ postProcessing: {} }), false);
  assert.equal(hasReport({}), false);
  assert.equal(hasReport(undefined), false);
  assert.equal(hasReport({ postProcessing: { rulesConfigured: 1 } }), true);
});

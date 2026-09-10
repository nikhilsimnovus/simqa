// node --test src/lib/boxExecutions.test.ts
//
// The fixtures are copied VERBATIM from .102 (testcases vonr, SA and TC_LTE),
// including the < escape the box writes into its condition strings. A
// hand-written fixture would have used "<" and hidden the fact that this data
// arrives as an embedded JSON string.

import test from 'node:test';
import assert from 'node:assert/strict';

const { parseBoxExecutionDetails, boxExecutionsOf } = await import('./boxExecutions.ts');

/** vonr, execution 01a06581 — a BLER-only success condition. */
const VONR_DETAILS =
  '{"bler":{"bler":[{"achieved":0,"condition":"Avg_DL_BLER\\u003c=5%","demand":5,"msgname":"Avg_DL_BLER","verdict":true}],"verdict":true},"created_on":1788410136,"verdict":true}';

/** SA — a different group key entirely. */
const SA_DETAILS =
  '{"created_on":1788185453,"message_counters":{"message_counters":[{"achieved":0,"condition":"nas_pdn_connectivity_reject\\u003c1","demand":1,"msgname":"nas_pdn_connectivity_reject","verdict":true}],"verdict":true},"verdict":true}';

test('reads the checks out of the embedded JSON string', () => {
  const r = parseBoxExecutionDetails(VONR_DETAILS);
  assert.equal(r.error, undefined);
  assert.equal(r.verdict, true);
  assert.equal(r.checks.length, 1);
  assert.deepEqual(r.checks[0], {
    group: 'bler',
    name: 'Avg_DL_BLER',
    condition: 'Avg_DL_BLER<=5%',
    demand: 5,
    achieved: 0,
    verdict: true,
  });
});

test('group keys are not hard-coded — message_counters parses the same way', () => {
  const r = parseBoxExecutionDetails(SA_DETAILS);
  assert.equal(r.checks.length, 1);
  assert.equal(r.checks[0].group, 'message_counters');
  assert.equal(r.checks[0].name, 'nas_pdn_connectivity_reject');
});

test('a group the box has not shipped yet is still picked up', () => {
  // The point of not hard-coding: a future success condition must appear
  // rather than be silently dropped.
  const r = parseBoxExecutionDetails(JSON.stringify({
    verdict: false,
    latency: { latency: [{ achieved: 91, condition: 'p95<=50ms', demand: 50, msgname: 'p95', verdict: false }], verdict: false },
  }));
  assert.equal(r.checks.length, 1);
  assert.equal(r.checks[0].group, 'latency');
  assert.equal(r.checks[0].verdict, false);
});

test('an unreadable blob is reported, not swallowed', () => {
  const r = parseBoxExecutionDetails('{not json');
  assert.equal(r.checks.length, 0);
  assert.match(r.error ?? '', /unreadable result details/);
});

test('empty details are simply no checks, with no error', () => {
  for (const empty of [undefined, null, '']) {
    const r = parseBoxExecutionDetails(empty);
    assert.deepEqual(r.checks, []);
    assert.equal(r.error, undefined);
  }
});

test('executionHistory becomes executions, newest first', () => {
  const meta = {
    executionHistory: [
      { status: 'Completed', iterationId: 'older', startTimeUnix: 1788000000, endTimeUnix: 1788000600, execution_result: 'FAIL', execution_result_details: SA_DETAILS },
      { status: 'Completed', iterationId: 'newer', startTimeUnix: 1788409413, endTimeUnix: 1788410135, execution_result: 'PASS', execution_result_details: VONR_DETAILS },
    ],
  };
  const runs = boxExecutionsOf(meta);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].executionId, 'newer', 'newest first');
  assert.equal(runs[0].result, 'PASS');
  assert.equal(runs[0].durationSec, 722, 'derived from the unix timestamps');
  assert.equal(runs[1].executionId, 'older');
});

test('an execution with no timestamp sorts last, not first', () => {
  const runs = boxExecutionsOf({
    executionHistory: [
      { iterationId: 'undated', execution_result: 'PASS' },
      { iterationId: 'dated', startTimeUnix: 1788409413, execution_result: 'PASS' },
    ],
  });
  assert.equal(runs[0].executionId, 'dated');
  assert.equal(runs[1].executionId, 'undated');
});

test('falls back to lastExecution when there is no history array', () => {
  const runs = boxExecutionsOf({
    lastExecution: {
      executionId: '01a06581-8c22-752b-a1c5-914043e5ce99',
      result: 'PASS',
      status: 'COMPLETED',
      executedOn: '2026-09-03T04:23:33Z',
      durationSeconds: 718,
      executionResultDetails: VONR_DETAILS,
    },
  });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].executionId, '01a06581-8c22-752b-a1c5-914043e5ce99');
  assert.equal(runs[0].durationSec, 718);
  assert.equal(runs[0].checks.length, 1);
});

test('no execution data at all is an empty list, not a crash', () => {
  assert.deepEqual(boxExecutionsOf(undefined), []);
  assert.deepEqual(boxExecutionsOf({}), []);
  assert.deepEqual(boxExecutionsOf({ executionHistory: 'nonsense' }), []);
});

test('an in-flight execution is running, not passed', () => {
  // Verbatim from ND_clone on .102 while it was executing: empty result, empty
  // details, endTimeUnix 0. Read as finished this is "0 checks, 0 failures",
  // which is how it came out as a green tick on a run that had measured
  // nothing at all.
  const [run] = boxExecutionsOf({
    executionHistory: [{
      status: 'In Progress',
      simulatorName: '1',
      startTime: '04/09/2026, 04:35:10',
      endTime: '',
      startTimeUnix: 1788496510,
      endTimeUnix: 0,
      iterationId: '01a06ab2-9ee7-7960-87bb-3f57efbbe662',
      execution_result: '',
      execution_result_details: '',
    }],
  });
  assert.equal(run.running, true);
  assert.equal(run.result, undefined);
  assert.equal(run.finishedAt, undefined, 'endTimeUnix 0 is not a finish time');
  assert.equal(run.durationSec, undefined);
  assert.deepEqual(run.checks, []);
});

test('lastExecution NOT_EXECUTED is not carried through as a verdict', () => {
  const [run] = boxExecutionsOf({
    lastExecution: {
      executionId: '01a06ab2-9ee7-7960-87bb-3f57efbbe662',
      result: 'NOT_EXECUTED',
      status: 'IN_PROGRESS',
      executedOn: '2026-09-04T04:35:10Z',
      durationSeconds: 0,
    },
  });
  assert.equal(run.running, true);
  assert.equal(run.result, undefined, 'NOT_EXECUTED is the absence of a result');
});

test('a finished execution is not running', () => {
  const [run] = boxExecutionsOf({
    executionHistory: [{
      status: 'Completed', iterationId: 'done',
      startTimeUnix: 1788409413, endTimeUnix: 1788410135,
      execution_result: 'PASS', execution_result_details: VONR_DETAILS,
    }],
  });
  assert.equal(run.running, false);
  assert.equal(run.result, 'PASS');
});

test('a vacuous PASS still reports what it actually measured', () => {
  // The whole reason the UI shows the numbers: this run passed on
  // "Avg_DL_BLER<=5%" with an achieved BLER of 0, which is also what zero
  // attached UEs produces. The verdict is real; it is not proof of traffic.
  const [run] = boxExecutionsOf({
    executionHistory: [{ iterationId: 'x', startTimeUnix: 1788409413, execution_result: 'PASS', execution_result_details: VONR_DETAILS }],
  });
  assert.equal(run.result, 'PASS');
  assert.equal(run.checks[0].achieved, 0);
  assert.equal(run.checks[0].condition, 'Avg_DL_BLER<=5%');
});

// ───────────── boxStageChecks ─────────────

const { boxStageChecks } = await import('./boxExecutions.ts');

const FINISHED = {
  executionHistory: [{
    status: 'Completed', simulatorName: '1', iterationId: '01a06581-8c22-752b-a1c5-914043e5ce99',
    startTimeUnix: 1788409413, endTimeUnix: 1788410135,
    execution_result: 'PASS', execution_result_details: VONR_DETAILS,
  }],
};

const RUNNING = {
  executionHistory: [{
    status: 'In Progress', simulatorName: '1', iterationId: '01a06ab2-9ee7-7960-87bb-3f57efbbe662',
    startTimeUnix: 1788496510, endTimeUnix: 0,
    execution_result: '', execution_result_details: '',
  }],
};

const byPhase = (rows: any[]): Record<string, any[]> =>
  rows.reduce((m: Record<string, any[]>, r: any) => { (m[r.phase] ??= []).push(r); return m; }, {});

/** Fetch a derived check by id, failing loudly if it is missing. */
const check = (rows: any[], id: string): any => {
  const hit = rows.find((r) => r.id === id);
  assert.ok(hit, `no derived check with id ${id}`);
  return hit;
};

test('a finished box run produces a result in every stage, never a skip', () => {
  const rows = boxStageChecks(boxExecutionsOf(FINISHED)[0]);
  const g = byPhase(rows);
  for (const phase of ['preflight', 'trigger', 'completion', 'post']) {
    assert.ok(g[phase]?.length, `${phase} must have at least one check`);
    for (const r of g[phase]) {
      assert.ok(r.status === 'pass' || r.status === 'fail', `${r.id} should be a result, got ${r.status}`);
    }
  }
});

test('every derived check cites the evidence that decided it', () => {
  for (const r of boxStageChecks(boxExecutionsOf(FINISHED)[0])) {
    assert.ok(r.detail && r.detail.length > 0, `${r.id} must carry its evidence`);
  }
});

test('a finished, passing run passes each derived stage', () => {
  const rows = boxStageChecks(boxExecutionsOf(FINISHED)[0]);
  assert.equal(rows.filter((r) => r.status === 'fail').length, 0, JSON.stringify(rows.filter((r) => r.status === 'fail')));
  assert.match(check(rows, 'box-completion-verdict').detail, /PASS/);
  assert.match(check(rows, 'box-completion-duration').detail, /722s/);
});

test('stages that cannot be judged yet are running, not guessed', () => {
  const rows = boxStageChecks(boxExecutionsOf(RUNNING)[0]);
  const g = byPhase(rows);
  // Started and pre-flight are already knowable from a run in flight...
  for (const r of [...g.preflight, ...g.trigger]) assert.equal(r.status, 'pass', r.id);
  // ...completion and after-test are not.
  for (const r of [...g.completion, ...g.post]) assert.equal(r.status, 'running', r.id);
});

test('an aborted run fails Test Completed rather than passing it', () => {
  const [x] = boxExecutionsOf({
    executionHistory: [{
      status: 'Aborted', simulatorName: '1', iterationId: 'a',
      startTimeUnix: 1788409413, endTimeUnix: 1788409500,
      execution_result: 'FAIL', execution_result_details: '',
    }],
  });
  const rows = boxStageChecks(x);
  assert.equal(check(rows, 'box-completion-terminal').status, 'fail');
  assert.match(check(rows, 'box-completion-terminal').detail, /Aborted/);
});

test('a missing field fails its check rather than passing by default', () => {
  const [x] = boxExecutionsOf({
    executionHistory: [{ status: 'Completed', iterationId: '', startTimeUnix: 0, endTimeUnix: 0, execution_result: 'PASS' }],
  });
  const rows = boxStageChecks(x);
  assert.equal(check(rows, 'box-preflight-simulator').status, 'fail', 'no simulator recorded');
  assert.equal(check(rows, 'box-trigger-started').status, 'fail', 'no start time');
  assert.equal(check(rows, 'box-trigger-execution-id').status, 'fail', 'no execution id');
  assert.equal(check(rows, 'box-post-simulator-released').status, 'fail', 'no end time');
});

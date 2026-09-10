// The detail strings here are copied verbatim from real runs on 192.168.1.102
// and from the templates in endToEnd/checks.ts. That matters: this module's
// whole job is reading those strings, so a test against invented input would
// only prove the regexes match themselves.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { explainFailure, explainBoxCheck, boxMetricName, explainSkip } = await import('./checkExplain.ts');

test('all 64 UEs dropping off is stated as that, not as a peak/min pair', () => {
  const out = explainFailure(
    'during-ue-count-stable',
    'UE count dropped from peak 64 to 0 mid-run (64 UE(s) silently deregistered)',
  );
  assert.match(out!, /All 64 UEs disconnected/);
  // The point of the sentence is the consequence, not the counter.
  assert.match(out!, /only cover part of the test/);
  assert.doesNotMatch(out!, /deregistered/);
});

test('a partial drop names how many went and where it landed', () => {
  const out = explainFailure(
    'during-ue-count-stable',
    'UE count dropped from peak 64 to 12 mid-run (52 UE(s) silently deregistered)',
  );
  assert.match(out!, /52 of 64 UEs dropped off/);
  assert.match(out!, /down to 12/);
});

test('throughput collapse reads as a collapse, with the numbers kept', () => {
  const out = explainFailure(
    'during-throughput-stability',
    'DL throughput unstable: mean=710.7M min=0 (0% of mean) cv=0.88 over 22 samples — drops/oscillation beyond tolerance',
  );
  assert.match(out!, /kept collapsing/);
  assert.match(out!, /710\.7M/);
  // cv is a statistic for whoever wrote the check, not for the reader.
  assert.doesNotMatch(out!, /cv=/);
});

test('unstable-but-nonzero throughput is not described as collapsing to zero', () => {
  const out = explainFailure(
    'during-throughput-stability',
    'DL throughput unstable: mean=800.0M min=120.5M (15% of mean) cv=0.61 over 30 samples — drops/oscillation beyond tolerance',
  );
  assert.match(out!, /dropped as low as 120\.5M/);
  assert.doesNotMatch(out!, /fell to zero/);
});

test('a short run says it stopped early, in minutes not raw seconds', () => {
  const out = explainFailure('completion-duration-sane', 'observed=128.2s configured=378s — outside [302, 574]s');
  assert.match(out!, /stopped early/);
  assert.match(out!, /2m 08s/);
  assert.match(out!, /6m 18s/);
});

test('an overrun is described as an overrun, not as stopping early', () => {
  const out = explainFailure('completion-duration-sane', 'observed=900.0s configured=378s — outside [302, 574]s');
  assert.match(out!, /overran/);
  assert.doesNotMatch(out!, /stopped early/);
});

test('a 401 login blames the credentials; another code does not', () => {
  assert.match(explainFailure('preflight-login', 'login returned 401')!, /rejected the username and password/);
  assert.match(explainFailure('preflight-login', 'login returned 502')!, /HTTP 502/);
});

test('partial attach says how many are missing', () => {
  const out = explainFailure('during-all-ues-attach', 'only 12/64 UEs attached after 45s — partial attach');
  assert.match(out!, /Only 12 of 64/);
  assert.match(out!, /52 never attached/);
});

test('BLER keeps the measured value, the cell and the limit', () => {
  const out = explainFailure(
    'during-bler-zero',
    'BLER reached 12.5% on cell 0 across 20 sample(s) — must stay within 5%',
  );
  assert.match(out!, /12\.5%/);
  assert.match(out!, /cell 0/);
  assert.match(out!, /5% limit/);
});

test('UEs left attached afterwards say so, with the count', () => {
  const out = explainFailure(
    'post-all-ues-power-off',
    '12 of 64 UE(s) still connected/registered 30s after terminal status (up=12)',
  );
  assert.match(out!, /12 of 64 UEs were still attached/);
  assert.match(out!, /next run/);
});

test('an unknown check id returns undefined so the caller keeps the raw detail', () => {
  assert.equal(explainFailure('some-future-check', 'anything at all'), undefined);
});

test('a rule that cannot parse its own detail returns undefined rather than a half sentence', () => {
  // Same id, but a detail shaped differently from what the rule expects.
  assert.equal(explainFailure('during-ue-count-stable', 'UE count looked wrong'), undefined);
  assert.equal(explainFailure('completion-duration-sane', 'durations disagreed'), undefined);
});

test('no detail at all yields no explanation', () => {
  assert.equal(explainFailure('during-ue-count-stable', undefined), undefined);
  assert.equal(explainFailure('during-ue-count-stable', ''), undefined);
});

test('BLER is rounded for reading — the full float stays in the evidence line', () => {
  const out = explainFailure(
    'during-bler-zero',
    'BLER reached 5.948812543232649% on cell 0 across 23 sample(s) — must stay within 5%',
  );
  assert.match(out!, /BLER hit 5\.9% on cell 0/);
  assert.doesNotMatch(out!, /5\.9488/);
});

test("a start failure quotes the box's own reason, not just the status code", () => {
  const out = explainFailure(
    'trigger-start-execution',
    'start returned 500: {"code":"INTERNAL_SERVER_ERROR","message":"failed to start UE","executionId":"01a08978"}',
  );
  assert.match(out!, /failed to start UE/);
  assert.match(out!, /HTTP 500/);
});

test('a start failure with no message body still names the status code', () => {
  const out = explainFailure('trigger-start-execution', 'start returned 503: upstream unavailable');
  assert.match(out!, /HTTP 503/);
});

test("a box condition names the metric and says which way it fell short", () => {
  // Verbatim from 5G_Single_Cell_Attach_TDD_Single_UE on .102.
  const out = explainBoxCheck('Achieved_Avg_DL_Throughput', 'Achieved_Avg_DL_Throughput>=95%', 95, 44);
  assert.match(out!, /Download Throughput reached only 44%/);
  assert.match(out!, /95% this testcase requires/);
});

test('an upper-bound condition reads as over the limit, not short of it', () => {
  const out = explainBoxCheck('Avg_DL_BLER', 'Avg_DL_BLER<=5%', 5, 9);
  assert.match(out!, /over the 5% limit/);
  assert.doesNotMatch(out!, /short of/);
});

test('an unmapped box metric still reads as words', () => {
  assert.equal(boxMetricName('Some_New_Counter'), 'Some New Counter');
  assert.equal(boxMetricName('Achieved_Avg_UL_Throughput'), 'Upload Throughput');
});

test('a box condition with no numbers falls back to the terse form', () => {
  assert.equal(explainBoxCheck('Achieved_Avg_DL_Throughput', 'x>=1', undefined, 44), undefined);
});

test('an attached run explains why nothing was started, without the execution id', () => {
  const out = explainSkip(
    'trigger-start-execution',
    'attached to execution 01a07b2b-9e02-76ac-8d83-08699b7a01eb already running on the box — not triggering another',
  );
  assert.match(out!, /started on the Simnovator, not by SimQA/);
  assert.doesNotMatch(out!, /01a07b2b/);
});

test('a skipped cfg bring-up on an attached run names the files that were NOT applied', () => {
  const out = explainSkip(
    'preflight-cfg-bring-up',
    'the box was already running this execution, so its configuration is whatever was linked when it started — SA-1cell, demo-mme.cfg, demo-ims.cfg were NOT applied',
  );
  assert.match(out!, /SA-1cell, demo-mme\.cfg, demo-ims\.cfg were NOT applied/);
  assert.match(out!, /already running when SimQA joined it/);
});

test('a cfg bring-up skipped for having nothing selected says the run used what was there', () => {
  const out = explainSkip('preflight-cfg-bring-up', 'no cfg files selected for this run');
  assert.match(out!, /nothing was linked/);
  assert.match(out!, /whatever the callbox already had/);
});

test('an unknown skip falls back to the raw reason', () => {
  assert.equal(explainSkip('some-check', 'because reasons'), undefined);
  assert.equal(explainSkip('trigger-start-execution', undefined), undefined);
});

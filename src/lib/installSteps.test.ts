// node --test src/lib/installSteps.test.ts
//
// The important test here replays the ACTUAL event stream from a real install
// of Simnovator-4.0.0_2609012008 on .102 (data/builds/build-2026-09-02-10-58-08).
// Ticking a checklist off log lines is exactly the kind of thing that works on
// invented fixtures and fails on real output — the Cockpit terminal wraps
// lines, re-emits them, and concatenates neighbours — so the fixture below is
// copied from that run rather than written by hand.

import test from 'node:test';
import assert from 'node:assert/strict';

const { deriveInstallSteps, INSTALL_STEPS } = await import('./installSteps.ts');

/** Verbatim from the real run, including the re-emitted / concatenated forms. */
const REAL_STREAM = [
  { type: 'step', step: 'launch', status: 'ok' },
  { type: 'step', step: 'login', status: 'ok' },
  { type: 'step', step: 'terminal', status: 'ok' },
  { type: 'step', step: 'preflight', status: 'ok' },
  { type: 'step', step: 'fetch', status: 'start' },
  { type: 'step', step: 'fetch', status: 'ok' },
  { type: 'step', step: 'extract', status: 'start' },
  { type: 'step', step: 'extract', status: 'ok' },
  { type: 'step', step: 'install', status: 'start' },
  { type: 'log', stream: 'stdout', line: '============================================================================' },
  { type: 'log', stream: 'stdout', line: 'Welcome! Installing Simnovus UE Simulator (4.0.0_2609012008)' },
  { type: 'log', stream: 'stdout', line: 'Step 1: Installing App server on 192.168.1.100' },
  { type: 'log', stream: 'stdout', line: 'Installing ✔ App Server Installed successfully!! Step 2: Installing UE simulator on 192.168.1.101 - Installing UE stack ' },
  { type: 'log', stream: 'stdout', line: 'Step 2: Installing UE simulator on 192.168.1.101 - Installing UE stack' },
  { type: 'log', stream: 'stdout', line: 'UE Simulator installed successfully!!' },
  { type: 'log', stream: 'stdout', line: 'Step 3: Installing Simnovator manager on 192.168.1.102' },
  { type: 'step', step: 'install', status: 'ok' },
  { type: 'log', stream: 'stdout', line: 'Simnovator Status: OK (12/12 containers running)' },
  { type: 'done', ok: true },
];

const states = (s: any) => Object.fromEntries(Object.entries(s).map(([k, v]: any) => [k, v.state]));

test('the real install stream ticks every step', () => {
  const r = deriveInstallSteps(REAL_STREAM, { versionChanged: true, finished: true });
  for (const step of INSTALL_STEPS) {
    assert.equal(r[step.id].state, 'done', `${step.id} should be ticked: ${JSON.stringify(states(r), null, 1)}`);
  }
});

test('each tick is traceable to the line that earned it', () => {
  const r = deriveInstallSteps(REAL_STREAM, { versionChanged: true, finished: true });
  assert.match(r['app-server'].because ?? '', /App Server Installed successfully/);
  assert.match(r['ue'].because ?? '', /UE Simulator installed successfully/);
  assert.match(r['manager'].because ?? '', /containers running/);
  assert.match(r['completed'].because ?? '', /new build/);
});

test('steps tick as the install progresses, not all at once', () => {
  // Cut the stream at the point the App Server finished: the App Server is
  // ticked, the UE is not.
  const upToAppServer = REAL_STREAM.slice(0, REAL_STREAM.findIndex((e) => /App Server Installed/.test(String(e.line ?? ''))) + 1);
  const r = deriveInstallSteps(upToAppServer);
  assert.equal(r['download'].state, 'done');
  assert.equal(r['extract'].state, 'done');
  assert.equal(r['started'].state, 'done');
  assert.equal(r['app-server'].state, 'done');
  // That same wrapped line also announces Step 2, so the UE reads as running.
  assert.equal(r['ue'].state, 'running');
  assert.equal(r['manager'].state, 'pending');
  assert.equal(r['completed'].state, 'pending');
});

test('nothing is ticked before anything has happened', () => {
  const r = deriveInstallSteps([]);
  for (const step of INSTALL_STEPS) assert.equal(r[step.id].state, 'pending');
});

test('a re-emitted line cannot un-tick a completed step', () => {
  // The Cockpit terminal repeats wrapped lines; "Step 1: Installing App server"
  // arriving again after the App Server finished must not reset it to running.
  const withRepeat = [
    ...REAL_STREAM.slice(0, REAL_STREAM.findIndex((e) => /App Server Installed/.test(String(e.line ?? ''))) + 1),
    { type: 'log', stream: 'stdout', line: 'Step 1: Installing App server on 192.168.1.100' },
  ];
  assert.equal(deriveInstallSteps(withRepeat)['app-server'].state, 'done');
});

test('an installer error that still installed the build reads as completed', () => {
  // The real failure mode: ./install exits 1 on a late App Server SSH key,
  // yet the box comes back on the new build. The box is the authority.
  const failing = [
    ...REAL_STREAM.filter((e) => e.type !== 'done'),
    { type: 'log', stream: 'stderr', line: 'sysadmin@192.168.1.100: Permission denied (publickey).' },
    { type: 'log', stream: 'stdout', line: 'FAILED : Please check App Server credentials' },
    { type: 'step', step: 'install', status: 'fail' },
    { type: 'done', ok: false },
  ];
  const r = deriveInstallSteps(failing, { versionChanged: true, finished: true });
  assert.equal(r['completed'].state, 'done', 'the box reporting the new build settles it');
});

test('a genuine failure leaves the run marked failed, not spinning', () => {
  const dead = [
    { type: 'step', step: 'fetch', status: 'start' },
    { type: 'step', step: 'fetch', status: 'fail' },
    { type: 'done', ok: false },
  ];
  const r = deriveInstallSteps(dead, { finished: true });
  assert.equal(r['download'].state, 'failed');
  assert.equal(r['completed'].state, 'failed');
  assert.equal(r['ue'].state, 'pending', 'steps that never started stay pending');
});

// node --test src/lib/backup/status.test.ts
//
// The retry window is pure date arithmetic with the times injected, so these
// walk a system from its first failure to past the 30-minute mark without any
// waiting and without depending on the machine clock.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'simqa-status-test-'));
process.env.SIMQA_BACKUP_ROOT = ROOT;

const {
  markFailure, markSuccess, failureMessage, scrubError, readStatus, writeStatus, RETRY_WINDOW_MS,
} = await import('./status.ts');

const T0 = '2026-09-01T10:00:00.000Z';
const at = (mins: number) => new Date(Date.parse(T0) + mins * 60_000).toISOString();

test('the first failure starts the window and reads as retrying', () => {
  const st = { systems: {} };
  const s = markFailure(st, '192.168.1.122', { systemType: 'CALLBOX', error: new Error('connect ETIMEDOUT'), now: T0 });

  assert.equal(s.state, 'retrying');
  assert.equal(s.firstFailedAt, T0);
  assert.match(s.lastError ?? '', /ETIMEDOUT/);
});

test('still retrying at 29 minutes, failed at 31', () => {
  const st = { systems: {} };
  markFailure(st, '192.168.1.122', { systemType: 'CALLBOX', error: 'down', now: T0 });

  const at29 = markFailure(st, '192.168.1.122', { error: 'down', now: at(29) });
  assert.equal(at29.state, 'retrying');
  assert.equal(at29.firstFailedAt, T0, 'the window must not restart on each failure');

  const at31 = markFailure(st, '192.168.1.122', { error: 'down', now: at(31) });
  assert.equal(at31.state, 'failed');

  const msg = failureMessage(at31, at(31));
  assert.match(msg, /CALLBOX/, 'the message must name the setup type');
  assert.match(msg, /192\.168\.1\.122/, 'the message must name the IP');
  assert.match(msg, /31 minutes/);
});

test('the boundary itself counts as failed', () => {
  const st = { systems: {} };
  markFailure(st, '10.0.0.1', { error: 'x', now: T0 });
  const exact = markFailure(st, '10.0.0.1', { error: 'x', now: new Date(Date.parse(T0) + RETRY_WINDOW_MS).toISOString() });
  assert.equal(exact.state, 'failed');
});

test('a success clears the window so the next failure starts a fresh 30 minutes', () => {
  const st = { systems: {} };
  markFailure(st, '10.0.0.2', { error: 'x', now: T0 });
  markFailure(st, '10.0.0.2', { error: 'x', now: at(29) });

  const ok = markSuccess(st, '10.0.0.2', { added: 2, updated: 1, unchanged: 40, now: at(30) });
  assert.equal(ok.state, 'ok');
  assert.equal(ok.firstFailedAt, undefined);
  assert.equal(ok.lastError, undefined);
  assert.equal(ok.added, 2);

  // 31 minutes after the ORIGINAL first failure, but only 1 minute into the new
  // run of failures — so retrying, not failed.
  const again = markFailure(st, '10.0.0.2', { error: 'x', now: at(31) });
  assert.equal(again.state, 'retrying');
  assert.equal(again.firstFailedAt, at(31));
});

test('credentials never survive into a stored failure reason', () => {
  const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEA\n-----END OPENSSH PRIVATE KEY-----';
  const scrubbed = scrubError(new Error(`auth failed using ${pem} and password: hunter2 for sysadmin`));

  assert.equal(scrubbed.includes('b3BlbnNzaC1rZXktdjEA'), false, 'key material leaked into the status file');
  assert.equal(scrubbed.includes('hunter2'), false, 'a password leaked into the status file');
  assert.match(scrubbed, /private key redacted/);
  assert.ok(scrubbed.length <= 300);
});

test('status survives a round-trip to disk', () => {
  const st = readStatus();
  markSuccess(st, '10.0.0.3', { systemType: 'UESIM', added: 1, updated: 0, unchanged: 0, now: T0 });
  st.lastCycleFinishedAt = T0;
  writeStatus(st);

  const back = readStatus();
  assert.equal(back.systems['10.0.0.3'].state, 'ok');
  assert.equal(back.lastCycleFinishedAt, T0);
});

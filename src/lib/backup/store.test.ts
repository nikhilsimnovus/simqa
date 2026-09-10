// node --test src/lib/backup/store.test.ts
//
// These prove the incremental rules the whole feature rests on — above all that
// a file removed from the source is STILL in the backup afterwards. That is the
// single requirement a backup cannot get wrong, and it is the one a casual
// "sync the directory" implementation silently breaks.
//
// The store is imported with its explicit .ts extension because node --test
// runs this file directly through Node's type stripping; there is no bundler in
// the loop to resolve an extensionless path or the @/ alias. That is also why
// store.ts imports only node builtins.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Must be set before the first store call — backupRoot() reads it each time, so
// setting it here (module body, before any test runs) is enough.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'simqa-backup-test-'));
process.env.SIMQA_BACKUP_ROOT = ROOT;

const {
  readManifest, writeManifest, upsertFile, listFiles, readFile,
  categoryDir, isSafeName, storedHash, listBackedUpIps,
  hasStoredBytes, countByCategory, sha256,
} = await import('./store.ts');

const IP = '10.0.0.9';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('a new file is added and its bytes land on disk', () => {
  const m = readManifest(IP);
  const outcome = upsertFile(m, 'enb_config', 'enb-n78.cfg', Buffer.from('cell 1\n'));
  writeManifest(m);

  assert.equal(outcome, 'added');
  assert.equal(fs.readFileSync(path.join(categoryDir(IP, 'enb_config'), 'enb-n78.cfg'), 'utf8'), 'cell 1\n');
  assert.equal(readFile(IP, 'enb_config', 'enb-n78.cfg').toString(), 'cell 1\n');
});

test('changed content is updated and the backup holds the NEW bytes', () => {
  const m = readManifest(IP);
  const outcome = upsertFile(m, 'enb_config', 'enb-n78.cfg', Buffer.from('cell 2\n'));
  writeManifest(m);

  assert.equal(outcome, 'updated');
  assert.equal(readFile(IP, 'enb_config', 'enb-n78.cfg').toString(), 'cell 2\n');
});

test('identical content is unchanged and the file is not rewritten', async () => {
  const target = path.join(categoryDir(IP, 'enb_config'), 'enb-n78.cfg');
  const before = fs.statSync(target).mtimeMs;

  // Enough of a gap that a rewrite would move mtime — without it the assertion
  // below could pass on a rewrite that happened within the same clock tick.
  await sleep(50);

  const m = readManifest(IP);
  const outcome = upsertFile(m, 'enb_config', 'enb-n78.cfg', Buffer.from('cell 2\n'));
  writeManifest(m);

  assert.equal(outcome, 'unchanged');
  assert.equal(fs.statSync(target).mtimeMs, before, 'mtime moved — the file was rewritten');
});

test('a file that disappears from the source is KEPT in the backup', () => {
  const cycle1 = '2026-09-01T10:00:00.000Z';
  const cycle2 = '2026-09-01T10:05:00.000Z';

  const m1 = readManifest(IP);
  upsertFile(m1, 'mme_config', 'mme-a.cfg', Buffer.from('a'), { now: cycle1 });
  upsertFile(m1, 'mme_config', 'mme-b.cfg', Buffer.from('b'), { now: cycle1 });
  writeManifest(m1);

  // Second cycle: the source no longer has mme-b.cfg, so only mme-a is offered.
  const m2 = readManifest(IP);
  upsertFile(m2, 'mme_config', 'mme-a.cfg', Buffer.from('a'), { now: cycle2 });
  writeManifest(m2);

  const files = listFiles(IP, 'mme_config', cycle2);
  const gone = files.find((f) => f.name === 'mme-b.cfg');

  assert.ok(gone, 'mme-b.cfg was dropped from the backup — the one thing that must never happen');
  assert.equal(gone.missingFromSource, true, 'it should be flagged as no longer on the box');
  assert.equal(readFile(IP, 'mme_config', 'mme-b.cfg').toString(), 'b', 'its bytes must still be readable');

  const still = files.find((f) => f.name === 'mme-a.cfg');
  assert.equal(still?.missingFromSource, false);
});

test('a path-escaping name is rejected and nothing is written outside the category dir', () => {
  const m = readManifest(IP);
  for (const bad of ['../escaped.cfg', '/etc/passwd', 'sub/dir.cfg', '..', String.raw`a\b.cfg`]) {
    assert.equal(isSafeName(bad), false, `${bad} should not be a safe name`);
    assert.throws(() => upsertFile(m, 'UE_config', bad, Buffer.from('x')), /unsafe backup file name/);
  }
  assert.equal(fs.existsSync(path.join(ROOT, IP, 'escaped.cfg')), false);
  assert.equal(fs.existsSync(path.join(ROOT, 'escaped.cfg')), false);
});

test('storedHash and listBackedUpIps report what is actually held', () => {
  const m = readManifest(IP);
  assert.equal(typeof storedHash(m, 'enb_config', 'enb-n78.cfg'), 'string');
  assert.equal(storedHash(m, 'enb_config', 'never-seen.cfg'), undefined);
  assert.deepEqual(listBackedUpIps(), [IP]);
});

test('two names differing only in case are both kept, not collapsed', () => {
  // Real case: /root/ue/config on .101 holds UE.cfg AND ue.cfg. On the Windows
  // host running SimQA those are the same path, so the naive write loses one of
  // them and leaves the manifest claiming both.
  const m = readManifest(IP);
  assert.equal(upsertFile(m, 'UE_config', 'UE.cfg', Buffer.from('upper')), 'added');
  assert.equal(upsertFile(m, 'UE_config', 'ue.cfg', Buffer.from('lower')), 'added');
  writeManifest(m);

  assert.equal(readFile(IP, 'UE_config', 'UE.cfg').toString(), 'upper');
  assert.equal(readFile(IP, 'UE_config', 'ue.cfg').toString(), 'lower');

  const names = listFiles(IP, 'UE_config').map((f) => f.name).sort();
  assert.deepEqual(names, ['UE.cfg', 'ue.cfg'], 'both source names must be offered for download');

  // And the disambiguation must be stable: a second cycle finds them unchanged
  // rather than rewriting under a fresh suffix.
  const m2 = readManifest(IP);
  assert.equal(upsertFile(m2, 'UE_config', 'UE.cfg', Buffer.from('upper')), 'unchanged');
  assert.equal(upsertFile(m2, 'UE_config', 'ue.cfg', Buffer.from('lower')), 'unchanged');
});

test('a manifest entry whose file has vanished is not reported as unchanged', () => {
  // Why this matters: the hash comparison is what makes the backup incremental,
  // so an entry pointing at bytes that are gone would match on every cycle,
  // transfer nothing, and never repair itself. Observed for real — 2 of 226
  // testcases on .102 sat in exactly this state.
  const m = readManifest(IP);
  upsertFile(m, 'mme_config', 'orphan.cfg', Buffer.from('body'));
  writeManifest(m);

  fs.unlinkSync(path.join(categoryDir(IP, 'mme_config'), 'orphan.cfg'));

  const m2 = readManifest(IP);
  assert.equal(hasStoredBytes(m2, 'mme_config', 'orphan.cfg'), false);
  assert.equal(
    upsertFile(m2, 'mme_config', 'orphan.cfg', Buffer.from('body')),
    'updated',
    'identical bytes must still be REWRITTEN when the stored file is missing',
  );
  assert.equal(readFile(IP, 'mme_config', 'orphan.cfg').toString(), 'body');
});

test('a case collision recorded before diskName existed is healed', () => {
  // Reproduces the real corruption: two entries differing only in case, neither
  // carrying a diskName, one file on disk. The early resolveDiskName returned
  // the existing name unconditionally, so this could never repair itself.
  const ip = '10.0.0.77';
  const dir = path.join(ROOT, ip, 'enb_config');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Test1.cfg'), 'upper');
  fs.writeFileSync(path.join(ROOT, ip, 'manifest.json'), JSON.stringify({
    ip, updatedAt: '2026-09-01T00:00:00.000Z',
    files: {
      'enb_config/Test1.cfg': { name: 'Test1.cfg', category: 'enb_config', bytes: 5, sha256: sha256('upper'), lastSeen: 'x', lastChanged: 'x' },
      'enb_config/test1.cfg': { name: 'test1.cfg', category: 'enb_config', bytes: 5, sha256: sha256('lower'), lastSeen: 'x', lastChanged: 'x' },
    },
  }, null, 2));

  // Before: the manifest claims two files, only one is really held.
  assert.equal(listFiles(ip, 'enb_config').length, 1);

  const m = readManifest(ip);
  upsertFile(m, 'enb_config', 'Test1.cfg', Buffer.from('upper'));
  upsertFile(m, 'enb_config', 'test1.cfg', Buffer.from('lower'));
  writeManifest(m);

  assert.equal(readFile(ip, 'enb_config', 'Test1.cfg').toString(), 'upper');
  assert.equal(readFile(ip, 'enb_config', 'test1.cfg').toString(), 'lower');
  assert.deepEqual(listFiles(ip, 'enb_config').map((f) => f.name).sort(), ['Test1.cfg', 'test1.cfg']);
});

test('the picker count and the file list can never disagree', () => {
  const counts = countByCategory(IP);
  for (const [cat, n] of Object.entries(counts)) {
    assert.equal(n, listFiles(IP, cat as any).length, `${cat} count vs rows`);
  }
});

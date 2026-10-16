import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testcaseExportFilename, userPrefix, userOfFile } from '../testcaseBackupName.ts';

/**
 * A Simnovator scopes its catalogue per account. On 192.168.1.95 sruthi holds
 * 61 testcases, simuser 168 and admin 369, and none can see another's — so a
 * backup that captures one login captures a fraction of the box and looks
 * complete while doing it.
 *
 * These pin the two things that make per-login backups legible: the login is
 * in the export filename, and the stored files carry a "<user>--" prefix the
 * browser filters on.
 */
test('an export filename names the login it was taken as', () => {
  const at = new Date('2026-10-16T09:30:00Z');
  const a = testcaseExportFilename('sys-5', at, 'simuser');
  const b = testcaseExportFilename('sys-5', at, 'admin');
  assert.notEqual(a, b, 'two logins of one box must not export to the same filename');
  assert.match(a, /^testcases-sys-5-simuser-/);
  assert.match(b, /^testcases-sys-5-admin-/);
  assert.match(a, /\.json$/);
});

test('a setup with no named login keeps the old filename', () => {
  const at = new Date('2026-10-16T09:30:00Z');
  assert.match(testcaseExportFilename('sys-2', at), /^testcases-sys-2-\d/);
});

test('a login that is awkward in a filename is made safe', () => {
  const name = testcaseExportFilename('sys-5', new Date(), 'a/b c:d');
  assert.ok(!/[/\:]/.test(name), `unsafe characters survived: ${name}`);
});



test('stored files are separated by login', () => {
  const files = [
    `${userPrefix('sruthi')}NSA_3cell.json`,
    `${userPrefix('simuser')}NSA_3cell.json`,
    `${userPrefix('admin')}NSA_3cell.json`,
  ];
  // Three logins can each hold a test case of the same name without one
  // overwriting another in a flat directory.
  assert.equal(new Set(files).size, 3);
  for (const u of ['sruthi', 'simuser', 'admin']) {
    assert.equal(files.filter((f) => f.startsWith(userPrefix(u))).length, 1);
  }
});

test('the login is read back off a filename', () => {
  const read = userOfFile;
  assert.equal(read('simuser--AIO_SA_1cell.json'), 'simuser');
  // A login with a hyphen in it still reads back whole.
  assert.equal(read('qa-lead--AIO_SA_1cell.json'), 'qa-lead');
  // A file from a single-login setup has no prefix and no login to read.
  assert.equal(read('AIO_SA_1cell.json'), undefined);
});

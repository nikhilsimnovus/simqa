import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkableFrom, runCheck } from './checks.ts';

test('a "should display X" expectation is checkable for X', () => {
  // SIM40-544, derived: "Simnovator GUI should display installed version on GUI dashboard"
  const c = checkableFrom('Simnovator GUI should display installed version on GUI dashboard');
  assert.equal(c.kind, 'present');
  assert.match(c.needle, /installed version/i);
});

test('and it passes or fails on what the page actually says', () => {
  const c = checkableFrom('GUI should display installed version on dashboard');
  assert.equal(runCheck(c, 'Dashboard — Installed Version 4.1.0').pass, true);
  const miss = runCheck(c, 'Dashboard — no version here');
  assert.equal(miss.pass, false);
  assert.match(miss.detail, /is NOT on the page, but the ticket expects it/);
});

test('"should appear once" counts, so a duplicate fails', () => {
  const c = checkableFrom('success notification should appear once');
  assert.equal(c.kind, 'once');
  assert.equal(runCheck(c, 'Success notification shown').pass, true);
  const twice = runCheck(c, 'success notification ... success notification');
  assert.equal(twice.pass, false);
  assert.match(twice.detail, /appears 2 times.*expected exactly once/);
});

test('"should not display X" passes only when X is absent', () => {
  const c = checkableFrom('the heading should not display Offline');
  assert.equal(c.kind, 'absent');
  assert.equal(runCheck(c, 'Current Mode: Online').pass, true);
  assert.equal(runCheck(c, 'Current Mode: Offline').pass, false);
});

test('"X should be present" is checkable for X', () => {
  const c = checkableFrom('Access Class values (11-15) should be present');
  assert.equal(c.kind, 'present');
  assert.match(c.needle, /Access Class values/i);
});

test('a page load is never, by itself, a pass', () => {
  // The whole point. An expectation that cannot be put to the page comes
  // back uncheckable, and the caller must not invent a verdict from the
  // fact that the page rendered.
  const c = checkableFrom('the Advanced Settings layout should be proper');
  assert.equal(c.kind, 'none');
  const o = runCheck(c, 'a page that loaded perfectly well');
  assert.equal(o.pass, undefined, 'no verdict at all');
  assert.match(o.detail, /needs a person/);
});

test('an expectation only of filler words is not checkable', () => {
  // "should be displayed properly" names nothing to look for; matching it
  // against any page would prove nothing.
  for (const e of [
    'the page should be displayed properly',
    'it should be shown correctly',
    'the values should be displayed',
  ]) {
    assert.equal(checkableFrom(e).kind, 'none', e);
  }
});

test('an empty expectation says so rather than guessing', () => {
  const c = checkableFrom('');
  assert.equal(c.kind, 'none');
  assert.match(c.why!, /states no expected result/);
});

test('matching tolerates case and whitespace differences', () => {
  // The ticket writes lower case; the page renders title case over two lines.
  const c = checkableFrom('dashboard should display test case count');
  assert.equal(runCheck(c, 'Test\n  Case   Count: 12').pass, true);
});

test('"able to" expectations are recognised where they name a thing', () => {
  const c = checkableFrom('Admin should be able to display the stop option');
  assert.equal(c.kind, 'present');
  assert.match(c.needle, /stop option/i);
});

test('an unverifiable "able to" is left to a person', () => {
  // SIM40-3409: stopping another user's test cannot be settled by reading
  // a page, and must not be reported as verified.
  const c = checkableFrom("the Admin should be able to stop another user's ongoing test case");
  assert.equal(c.kind, 'none');
});

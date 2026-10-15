import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderReport } from './renderReport.ts';

/** A minimal report with one row of each verdict. */
function sample() {
  const entry = (n: number, verdict: string, status: number | null, expect: string[]) => ({
    n, section: 'tools', opId: `op${n}`, method: 'POST', path: '/tools/x',
    summary: 'does a thing', case: `case ${n}`, kind: 'negative', expect, status, verdict,
    reason: '', note: '', info: '', issues: [], warnings: [], ms: 4,
    request: { method: 'POST', url: 'http://h/v2/x', headers: { Accept: 'application/json' }, body: '{}', curl: 'curl …' },
    response: { status, reason: 'OK', headers: {}, body: '{}' },
    documented: { 200: 'ok' }, as: 'admin',
  });
  return {
    meta: { tool: 'SimQA', run_id: 'r1', host: 'h', started: 'a', finished: 'b', duration: '1s' },
    summary: { total: 4, counts: { PASS: 1, FAIL: 1, SKIP: 1, ERROR: 1 }, pass_rate: 25, documented_errors: 0, warned: 0 },
    results: [
      entry(1, 'PASS', 200, ['200']),
      entry(2, 'FAIL', 500, ['400']),
      entry(3, 'SKIP', null, []),
      entry(4, 'ERROR', null, ['200']),
    ],
    spec_issues: {},
    notes: [],
  } as never;
}

/**
 * Every row class the report emits must have a background rule that matches it.
 *
 * This test exists because that was not true. The CSS named the chip classes
 * (.entry.ok / .bad / .warn) while the rows carried the verdict ones, so three
 * verdicts out of four had no colour — and checking that the stylesheet
 * CONTAINED the rules said nothing about whether anything matched them. Assert
 * the join, not the presence.
 */
test('every row class has a background rule that matches it', () => {
  const html = renderReport(sample());

  const rowClasses = [...html.matchAll(/<details class="r v-([A-Z]+)"/g)].map(m => m[1]);
  assert.deepEqual([...new Set(rowClasses)].sort(), ['ERROR', 'FAIL', 'PASS', 'SKIP']);

  for (const cls of new Set(rowClasses)) {
    const rule = new RegExp(`details\\.r\\.v-${cls}\\s*\\{[^}]*background:`, 'i');
    assert.ok(rule.test(html), `no background rule matches a row with class "v-${cls}"`);
  }
});

test('the row colours are the ones asked for', () => {
  const html = renderReport(sample());
  const bg = (cls: string) =>
    (html.match(new RegExp(`details\\.r\\.v-${cls}\\s*\\{[^}]*background:\\s*var\\((--[a-z-]+)\\)`, 'i')) ?? [])[1];
  assert.equal(bg('PASS'), '--pass-bg', 'passed rows take the light green');
  assert.equal(bg('FAIL'), '--fail-bg', 'failed rows take the light red');
  assert.equal(bg('SKIP'), '--skip-bg', 'skipped rows take the light grey');
  // And those tokens are what the reference report defines them as.
  assert.match(html, /--pass-bg:\s*#e3f5ea/);
  assert.match(html, /--fail-bg:\s*#fdecea/);
  assert.match(html, /--skip-bg:\s*#eef1f4/);
});

test('the status group is one right-aligned block per row', () => {
  const html = renderReport(sample());
  assert.equal((html.match(/class="codes"/g) ?? []).length, 4);
  assert.match(html, /\.codes\s*\{[^}]*margin-left:\s*auto/);
});

test('expected and actual are both shown', () => {
  const html = renderReport(sample());
  const groups = [...html.matchAll(/<span class="codes">([\s\S]*?)<\/span>/g)]
    .map(m => m[1].replace(/<[^>]+>/g, '').replace(/&#39;/g, "'").trim());
  assert.ok(groups.includes('#1 · expected 200 → 200 · 4 ms'), groups.join(' | '));
  assert.ok(groups.includes('#2 · expected 400 → 500 · 4 ms'), 'a failure shows what it wanted and what it got');
  // A case with no documented expectation shows the actual alone rather than
  // inventing one; one that never replied shows an em dash.
  assert.ok(groups.includes('#3 · — · 4 ms'), groups.join(' | '));
  assert.ok(groups.includes('#4 · expected 200 → — · 4 ms'), groups.join(' | '));
});

test('the toolbar and its filters are the reference ones', () => {
  const html = renderReport(sample());
  for (const f of ['all', 'FAIL', 'PASS', 'SKIP', 'ERROR', 'NOTE', 'WARN']) {
    assert.match(html, new RegExp(`data-f="${f}"`), `missing the ${f} filter`);
  }
  assert.match(html, /id="kind"/);
  assert.match(html, /id="q"/);
  assert.match(html, /id="expand"/);
  assert.match(html, /id="collapse"/);
  assert.match(html, /window\.print\(\)/);
});

test('every row carries what the filters read', () => {
  const html = renderReport(sample());
  const rows = [...html.matchAll(/<details class="r v-[A-Z]+"([^>]*)>/g)].map(m => m[1]);
  assert.equal(rows.length, 4);
  for (const attrs of rows) {
    assert.match(attrs, /data-v="[A-Z]+"/);
    assert.match(attrs, /data-k="[a-z]*"/);
    assert.match(attrs, /data-n="[01]"/);
    assert.match(attrs, /data-w="[01]"/);
  }
});

test('it is one self-contained file', () => {
  const html = renderReport(sample());
  // Nothing fetched: no external script, stylesheet or font.
  assert.ok(!/<script[^>]+src=/.test(html), 'an external script would break opening it offline');
  assert.ok(!/<link[^>]+stylesheet/.test(html), 'an external stylesheet would break the styling offline');
  assert.match(html, /^<!doctype html>/i);
});

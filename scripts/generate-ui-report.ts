// Generate a self-contained HTML report from a UI-tests run JSON.
//
// Inputs:
//   - scripts/.out/ui-final-132.json (or whatever the latest run is)
//   - Screenshots already at data/ui-tests/<runDir>/<testId>/screenshot.png
//
// Output:
//   - data/ui-tests/<runDir>/REPORT.html  (self-contained, screenshots inlined as base64)
//
// Optional env: JIRA_BASE — e.g. "https://your-org.atlassian.net". When set,
// ticket-shaped strings in the test descriptions become clickable links.

import * as fs from 'node:fs';
import * as path from 'node:path';

const JIRA_BASE = (process.env.JIRA_BASE ?? '').replace(/\/$/, '');
const ticketLink = (key: string) => JIRA_BASE ? `${JIRA_BASE}/browse/${key}` : undefined;

interface Result {
  number: number; id: string; name: string; description: string;
  category: string; severity: string; ok: boolean; skipped?: boolean;
  detail?: string; expected?: string; durationMs?: number;
  finalUrl?: string; consoleErrorCount?: number; networkRequestCount?: number;
  evidence?: { screenshotFile?: string; networkFile?: string; consoleFile?: string; downloadFile?: string };
  ranAt?: string;
}
interface Run {
  startedAt: string; finishedAt: string; ok: boolean; runDir: string;
  counts: { total: number; passed: number; failed: number; skipped: number };
  results: Result[];
}

const inputPath = process.argv[2] ?? path.resolve(process.cwd(), 'scripts/.out/ui-final-132.json');
if (!fs.existsSync(inputPath)) { console.error(`input missing: ${inputPath}`); process.exit(1); }
const run: Run = JSON.parse(fs.readFileSync(inputPath, 'utf8'));

function escape(s: any): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function inlineScreenshot(testId: string, fileName?: string): string | null {
  if (!fileName) return null;
  const p = path.join(run.runDir, testId, fileName);
  if (!fs.existsSync(p)) return null;
  const buf = fs.readFileSync(p);
  return `data:image/png;base64,${buf.toString('base64')}`;
}

const failures = run.results.filter((r) => !r.ok && !r.skipped);
const passes = run.results.filter((r) => r.ok && !r.skipped);
const skips = run.results.filter((r) => r.skipped);

const byCategory: Record<string, Result[]> = {};
for (const r of failures) {
  byCategory[r.category] = byCategory[r.category] ?? [];
  byCategory[r.category].push(r);
}
const categoryOrder = ['security', 'errors', 'lifecycle', 'patterns', 'auth', 'navigation', 'testcases', 'stats', 'logs', 'users', 'tools', 'perf', 'compat'];
// Defensive: any category in the data that isn't in the order list gets appended at the end.
for (const c of Object.keys(byCategory)) if (!categoryOrder.includes(c)) categoryOrder.push(c);

const severityRank: Record<string, number> = { 'critical': 0, 'normal': 1, 'optional': 2 };
for (const k of Object.keys(byCategory)) {
  byCategory[k].sort((a, b) => (severityRank[a.severity] ?? 9) - (severityRank[b.severity] ?? 9));
}

const runtimeMs = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
const runtimeStr = `${Math.floor(runtimeMs / 60000)}m ${Math.floor((runtimeMs % 60000) / 1000)}s`;
const passRate = (run.counts.passed / run.counts.total * 100).toFixed(1);

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>simqa UI test report — ${escape(run.finishedAt)}</title>
<style>
  :root {
    --pass: #16a34a; --fail: #dc2626; --warn: #d97706; --skip: #6b7280;
    --slate-50: #f8fafc; --slate-100: #f1f5f9; --slate-200: #e2e8f0; --slate-300: #cbd5e1;
    --slate-500: #64748b; --slate-700: #334155; --slate-900: #0f172a;
    --primary: #ea580c;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: var(--slate-900); background: var(--slate-50); }
  .wrap { max-width: 1200px; margin: 0 auto; padding: 24px; }
  header { background: linear-gradient(135deg, #1e293b 0%, #334155 100%); color: white; padding: 32px 24px; border-radius: 8px 8px 0 0; }
  h1 { margin: 0 0 8px; font-size: 28px; letter-spacing: -0.02em; }
  .subtitle { opacity: 0.85; font-size: 14px; }
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-top: 24px; }
  .stat { background: rgba(255,255,255,0.08); padding: 12px 16px; border-radius: 6px; }
  .stat-num { font-size: 28px; font-weight: 700; line-height: 1; }
  .stat-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; opacity: 0.85; margin-top: 4px; }
  .stat.pass .stat-num { color: #4ade80; }
  .stat.fail .stat-num { color: #f87171; }
  .stat.skip .stat-num { color: #cbd5e1; }
  main { background: white; border-radius: 0 0 8px 8px; padding: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
  h2 { font-size: 18px; margin: 32px 0 12px; color: var(--slate-900); border-bottom: 1px solid var(--slate-200); padding-bottom: 8px; }
  h2:first-child { margin-top: 0; }
  h3 { font-size: 14px; margin: 24px 0 8px; color: var(--slate-700); }
  .toc { background: var(--slate-100); padding: 16px; border-radius: 6px; margin-bottom: 24px; }
  .toc ol { margin: 8px 0 0; padding-left: 24px; font-size: 13px; line-height: 1.8; }
  .toc a { color: var(--slate-700); text-decoration: none; }
  .toc a:hover { color: var(--primary); text-decoration: underline; }
  .issue { border: 1px solid var(--slate-200); border-radius: 8px; padding: 16px; margin-bottom: 16px; background: white; }
  .issue.critical { border-left: 4px solid var(--fail); }
  .issue.normal { border-left: 4px solid var(--warn); }
  .issue.optional { border-left: 4px solid var(--slate-300); }
  .issue-header { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 8px; }
  .issue-num { display: inline-flex; align-items: center; justify-content: center; min-width: 36px; height: 24px; padding: 0 8px; border-radius: 4px; background: var(--slate-100); font-family: monospace; font-size: 12px; color: var(--slate-700); }
  .issue-title { font-size: 15px; font-weight: 600; flex: 1; line-height: 1.4; color: var(--slate-900); }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
  .badge.severity-critical { background: #fee2e2; color: #991b1b; }
  .badge.severity-normal { background: #fef3c7; color: #92400e; }
  .badge.severity-optional { background: #f1f5f9; color: var(--slate-700); }
  .badge.cat { background: #e0e7ff; color: #3730a3; }
  .issue-body { padding-left: 48px; font-size: 13px; color: var(--slate-700); line-height: 1.6; }
  .desc { color: var(--slate-700); margin-bottom: 8px; }
  .observation { background: #fef2f2; border-left: 3px solid var(--fail); padding: 8px 12px; border-radius: 4px; margin: 8px 0; font-family: monospace; font-size: 12px; color: #991b1b; }
  .expected { background: #fffbeb; border-left: 3px solid var(--warn); padding: 8px 12px; border-radius: 4px; margin: 8px 0; font-size: 12px; color: #78350f; }
  .meta { font-size: 11px; color: var(--slate-500); margin-top: 8px; }
  .meta code { background: var(--slate-100); padding: 1px 6px; border-radius: 3px; font-size: 11px; }
  .screenshot-wrap { margin-top: 12px; border: 1px solid var(--slate-200); border-radius: 6px; overflow: hidden; }
  .screenshot-header { background: var(--slate-100); padding: 6px 12px; font-size: 11px; color: var(--slate-700); }
  .screenshot { display: block; max-width: 100%; cursor: zoom-in; }
  .pattern-link { display: inline-block; padding: 1px 6px; background: #fef3c7; color: #78350f; border-radius: 3px; font-size: 10px; font-family: monospace; margin-left: 6px; text-decoration: none; }
  .pattern-link:hover { background: #fde68a; }
  .jira-comment { margin: 12px 0; border: 1px solid #c7d2fe; background: #eef2ff; border-radius: 6px; overflow: hidden; }
  .jira-comment-header { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; background: #e0e7ff; font-size: 11px; color: #3730a3; }
  .jira-comment-header a { color: #3730a3; }
  .jira-comment-body { margin: 0; padding: 12px; background: white; font-family: ui-monospace, 'Cascadia Mono', Menlo, monospace; font-size: 11px; color: #334155; white-space: pre-wrap; word-break: break-word; }
  .copy-btn { padding: 3px 10px; border-radius: 4px; border: 1px solid #6366f1; background: white; color: #4338ca; font-size: 11px; font-weight: 600; cursor: pointer; transition: all 0.15s; }
  .copy-btn:hover { background: #6366f1; color: white; }
  .copy-btn.copied { background: #10b981; color: white; border-color: #10b981; }
  details { margin-top: 24px; }
  summary { cursor: pointer; font-size: 14px; font-weight: 600; color: var(--slate-700); padding: 8px 0; }
  table.passes { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 12px; }
  table.passes td { padding: 4px 8px; border-bottom: 1px solid var(--slate-100); }
  table.passes td:first-child { width: 50px; font-family: monospace; color: var(--slate-500); }
  footer { text-align: center; padding: 24px; color: var(--slate-500); font-size: 12px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>simqa — UI Test Report</h1>
    <div class="subtitle">Browser-driven validation of the Simnovator management UI</div>
    <div class="subtitle" style="margin-top: 4px;">
      Run started ${escape(new Date(run.startedAt).toLocaleString())}
      · finished ${escape(new Date(run.finishedAt).toLocaleString())}
      · duration ${runtimeStr}
    </div>
    <div class="stats">
      <div class="stat"><div class="stat-num">${run.counts.total}</div><div class="stat-label">Total tests</div></div>
      <div class="stat pass"><div class="stat-num">${run.counts.passed}</div><div class="stat-label">Passed (${passRate}%)</div></div>
      <div class="stat fail"><div class="stat-num">${run.counts.failed}</div><div class="stat-label">Failed</div></div>
      <div class="stat skip"><div class="stat-num">${run.counts.skipped}</div><div class="stat-label">Skipped</div></div>
    </div>
  </header>

  <main>
    <h2>Failed tests by category</h2>
    <div class="toc">
      <strong>Quick jump:</strong>
      <ol>
        ${categoryOrder.filter((c) => byCategory[c]?.length).map((c) => `<li><a href="#cat-${c}">${escape(c)} — ${byCategory[c].length} failure${byCategory[c].length === 1 ? '' : 's'}</a></li>`).join('\n        ')}
      </ol>
    </div>

    ${categoryOrder.filter((c) => byCategory[c]?.length).map((cat) => `
    <h2 id="cat-${cat}">${escape(cat)} <span style="font-size: 12px; font-weight: 400; color: var(--slate-500);">— ${byCategory[cat].length} failure${byCategory[cat].length === 1 ? '' : 's'}</span></h2>
    ${byCategory[cat].map((r) => {
      const screenshotData = inlineScreenshot(r.id, r.evidence?.screenshotFile);
      const sim40Match = (r.description ?? '').match(/SIM40-\d{3,4}/g);
      // Pre-compose a Jira-ready comment for this failure when it links to a SIM40 ticket.
      const jiraComment = sim40Match
        ? `**Still failing** as of ${new Date(run.finishedAt).toLocaleString()}.

* Test: ${r.name} (\`${r.id}\`, severity ${r.severity})
* Observed: ${(r.detail ?? '').slice(0, 400)}
${r.expected ? `* Expected: ${r.expected.slice(0, 400)}\n` : ''}* Run: \`${path.basename(run.runDir)}\`

— posted from simqa UI tests`
        : '';
      return `
    <div class="issue ${escape(r.severity)}" id="issue-${escape(r.id)}">
      <div class="issue-header">
        <span class="issue-num">#${r.number}</span>
        <div class="issue-title">${escape(r.name)}</div>
        <span class="badge severity-${escape(r.severity)}">${escape(r.severity)}</span>
        <span class="badge cat">${escape(r.category)}</span>
      </div>
      <div class="issue-body">
        <div class="desc">${escape(r.description)}${sim40Match ? sim40Match.map((m) => {
          const href = ticketLink(m);
          return href
            ? `<a class="pattern-link" href="${href}" target="_blank">${escape(m)}</a>`
            : `<span class="pattern-link">${escape(m)}</span>`;
        }).join('') : ''}</div>
        <div class="observation"><strong>Observed:</strong> ${escape(r.detail ?? '')}</div>
        ${r.expected ? `<div class="expected"><strong>Expected:</strong> ${escape(r.expected)}</div>` : ''}
        ${jiraComment ? `
        <div class="jira-comment">
          <div class="jira-comment-header">
            <span>📋 Pre-composed comment for ${sim40Match!.map((m) => {
              const href = ticketLink(m);
              return href ? `<a href="${href}" target="_blank">${escape(m)}</a>` : escape(m);
            }).join(', ')}</span>
            <button class="copy-btn" data-copy="${escape(jiraComment)}" onclick="copyToClipboard(this)">Copy comment</button>
          </div>
          <pre class="jira-comment-body">${escape(jiraComment)}</pre>
        </div>` : ''}
        <div class="meta">
          test id: <code>${escape(r.id)}</code>
          ${r.finalUrl ? ` · final url: <code>${escape(r.finalUrl)}</code>` : ''}
          ${typeof r.durationMs === 'number' ? ` · ${r.durationMs}ms` : ''}
          ${r.consoleErrorCount ? ` · ${r.consoleErrorCount} console error${r.consoleErrorCount === 1 ? '' : 's'}` : ''}
        </div>
        ${screenshotData ? `
        <div class="screenshot-wrap">
          <div class="screenshot-header">Screenshot — final state when test failed</div>
          <img class="screenshot" src="${screenshotData}" alt="${escape(r.id)} screenshot" onclick="window.open(this.src,'_blank')" />
        </div>` : ''}
      </div>
    </div>`;
    }).join('\n    ')}
    `).join('\n    ')}

    <details>
      <summary>Passing tests (${passes.length})</summary>
      <table class="passes">
        ${passes.map((r) => `<tr><td>#${r.number}</td><td>${escape(r.name)}</td><td style="color: var(--slate-500); font-size: 11px;">${escape(r.category)}</td></tr>`).join('\n        ')}
      </table>
    </details>

    ${skips.length ? `
    <details>
      <summary>Skipped tests (${skips.length})</summary>
      <table class="passes">
        ${skips.map((r) => `<tr><td>#${r.number}</td><td>${escape(r.name)}</td><td style="color: var(--slate-500); font-size: 11px;">${escape(r.category)}</td></tr>`).join('\n        ')}
      </table>
    </details>` : ''}
  </main>

  <footer>
    simqa · run dir <code>${escape(path.basename(run.runDir))}</code> · evidence files (screenshots, network logs, console logs) under <code>data/ui-tests/${escape(path.basename(run.runDir))}/</code>
  </footer>
</div>
<script>
function copyToClipboard(btn) {
  const text = btn.getAttribute('data-copy');
  navigator.clipboard.writeText(text.replace(/&quot;/g,'"').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&'))
    .then(() => {
      const orig = btn.textContent;
      btn.textContent = '✓ Copied';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied'); }, 2000);
    })
    .catch((e) => { btn.textContent = 'Failed: ' + e.message; });
}
</script>
</body>
</html>`;

const outPath = path.join(run.runDir, 'REPORT.html');
fs.writeFileSync(outPath, html);
console.log(`report written: ${outPath}`);
console.log(`open in browser: file:///${outPath.replace(/\\/g, '/')}`);
console.log(`size: ${(fs.statSync(outPath).size / 1024).toFixed(0)} KB`);
console.log(`failures: ${failures.length} | passes: ${passes.length} | skipped: ${skips.length}`);

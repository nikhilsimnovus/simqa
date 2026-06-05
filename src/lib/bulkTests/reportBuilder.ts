// Per-build report artifact builder. Joins the GenerationResult (what got
// created on the box, with each variant's dimensions) with the
// ValidationSummary (per-step pass/fail) and emits three on-disk files:
//
//   dist/build-reports/<build-slug>/report.json   — raw data for diffing
//   dist/build-reports/<build-slug>/report.md     — Jira/Confluence paste
//   dist/build-reports/<build-slug>/report.html   — self-contained, filter-
//                                                   able table for sharing
//
// The build-slug is derived from the Simnovator build version captured at
// generation time (e.g. "4.0.0_260602" → "v4_0_0_260602"). That makes the
// directory layout one-folder-per-build, so QA can keep the prior build's
// report side-by-side with the current run.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GenerationResult, CreatedTestcase } from './generator';
import type { ValidationSummary, ValidationResult, ValidationStepName } from './validator';

const STEP_ORDER: ValidationStepName[] = [
  'get', 'search', 'export', 'import', 'fidelity', 'delete-clone', 'verify-clone-gone', 'verify-original',
];

export interface BuildReportInputs {
  /** Source of truth for which testcases exist + their dimensions. */
  generation: GenerationResult;
  /** Optional — per-testcase validation step results. */
  validation?: ValidationSummary;
}

export interface BuildReportPaths {
  dir: string;
  jsonPath: string;
  mdPath: string;
  htmlPath: string;
  buildSlug: string;
}

export function buildSlug(version?: string): string {
  if (!version) return 'unknown-build';
  return 'v' + version.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
}

export function buildReportsRoot(): string {
  return path.join(process.cwd(), 'dist', 'build-reports');
}

/** Index validation results by manifest id for O(1) joins. */
function indexValidation(validation: ValidationSummary | undefined): Map<string, ValidationResult> {
  const out = new Map<string, ValidationResult>();
  if (!validation) return out;
  for (const r of validation.results ?? []) {
    out.set(r.id, r);
  }
  return out;
}

interface CategoryTally {
  category: string;
  total: number;
  generated: number;
  validated: number;
  passed: number;
  failed: number;
  /** Per-step pass count. */
  byStep: Record<string, { pass: number; fail: number }>;
}

function tallyByCategory(inputs: BuildReportInputs): CategoryTally[] {
  const vIdx = indexValidation(inputs.validation);
  const tally = new Map<string, CategoryTally>();
  for (const c of inputs.generation.created) {
    if (!tally.has(c.category)) {
      tally.set(c.category, {
        category: c.category, total: 0, generated: 0, validated: 0, passed: 0, failed: 0,
        byStep: Object.fromEntries(STEP_ORDER.map(s => [s, { pass: 0, fail: 0 }])),
      });
    }
    const t = tally.get(c.category)!;
    t.total += 1;
    t.generated += 1;
    const v = vIdx.get(c.id);
    if (v) {
      t.validated += 1;
      if (v.ok) t.passed += 1; else t.failed += 1;
      for (const s of v.steps ?? []) {
        if (!t.byStep[s.step]) t.byStep[s.step] = { pass: 0, fail: 0 };
        if (s.ok) t.byStep[s.step].pass += 1; else t.byStep[s.step].fail += 1;
      }
    }
  }
  return [...tally.values()].sort((a, b) => a.category.localeCompare(b.category));
}

// ─── JSON ────────────────────────────────────────────────────────────────

interface ReportRow {
  name: string;
  rat: string;
  band: string;
  bandwidth: number;
  scs?: number;
  duplex: string;
  ueCount: number;
  antennas: string;
  traffic: string;
  mobility: string;
  fading: string;
  generated: boolean;
  apiVerdict: 'pass' | 'fail' | 'not-run';
  fidelityVerdict: 'pass' | 'fail' | 'not-run';
  /** Per-step verdicts so the consumer can pivot any way they like. */
  steps: Record<string, 'pass' | 'fail' | 'not-run'>;
}

function buildRows(inputs: BuildReportInputs): ReportRow[] {
  const vIdx = indexValidation(inputs.validation);
  return inputs.generation.created.map((c): ReportRow => {
    const v = vIdx.get(c.id);
    const steps: Record<string, 'pass' | 'fail' | 'not-run'> = Object.fromEntries(
      STEP_ORDER.map(s => [s, 'not-run' as const]),
    );
    if (v) {
      for (const s of v.steps ?? []) steps[s.step] = s.ok ? 'pass' : 'fail';
    }
    const apiVerdict = v ? (v.ok ? 'pass' : 'fail') : 'not-run';
    const fidelityVerdict = steps['fidelity'] ?? 'not-run';
    return {
      name: c.name,
      rat: c.rat,
      band: c.band,
      bandwidth: c.bandwidth,
      scs: c.scs,
      duplex: c.duplexMode,
      ueCount: c.ueCount,
      antennas: `${c.antennas.dl}x${c.antennas.ul}`,
      traffic: c.dataType,
      mobility: c.mobility,
      fading: c.fading,
      generated: true,
      apiVerdict,
      fidelityVerdict,
      steps,
    };
  });
}

// ─── Markdown ────────────────────────────────────────────────────────────

function renderMarkdown(inputs: BuildReportInputs, rows: ReportRow[], tally: CategoryTally[]): string {
  const g = inputs.generation;
  const v = inputs.validation;
  const lines: string[] = [];
  lines.push(`# Bulk Test Cases — Build Report`);
  lines.push('');
  lines.push(`- **Build:** \`${g.buildVersion ?? 'unknown'}\``);
  lines.push(`- **Target box:** ${g.targetHost}`);
  lines.push(`- **Generated at:** ${g.finishedAt}`);
  if (v) lines.push(`- **Validated at:** ${v.finishedAt} (${v.passed}/${v.total} PASS, ${v.failed} FAIL)`);
  lines.push(`- **Total testcases authored:** ${g.created.length} (of ${g.total} attempted)`);
  if (g.failed > 0) lines.push(`- **Generation failures:** ${g.failed} (see report.json for per-variant errors)`);
  if (g.skipped > 0) lines.push(`- **Generation skips:** ${g.skipped} (already on box)`);
  lines.push('');

  // Category summary table
  lines.push('## Categories validated');
  lines.push('');
  lines.push('| Category | Authored | Validated | Pass | Fail | Fidelity Pass |');
  lines.push('|---|---:|---:|---:|---:|---:|');
  for (const t of tally) {
    const fidelityPass = t.byStep['fidelity']?.pass ?? 0;
    lines.push(`| ${t.category} | ${t.generated} | ${t.validated} | ${t.passed} | ${t.failed} | ${fidelityPass} |`);
  }
  lines.push('');

  // Per-step roll-up
  lines.push('## Per-step pass rate');
  lines.push('');
  lines.push('| Step | Pass | Fail | Coverage |');
  lines.push('|---|---:|---:|---:|');
  for (const step of STEP_ORDER) {
    let pass = 0, fail = 0;
    for (const t of tally) {
      pass += t.byStep[step]?.pass ?? 0;
      fail += t.byStep[step]?.fail ?? 0;
    }
    const total = pass + fail;
    const rate = total === 0 ? '–' : `${Math.round((pass / total) * 100)}%`;
    lines.push(`| ${step} | ${pass} | ${fail} | ${rate} |`);
  }
  lines.push('');

  // Failures section — only listed if any
  const failedRows = rows.filter(r => r.apiVerdict === 'fail');
  if (failedRows.length > 0) {
    lines.push('## Failures');
    lines.push('');
    lines.push('| Testcase | Failed step | Detail |');
    lines.push('|---|---|---|');
    const vIdx = indexValidation(v);
    for (const r of failedRows) {
      const vR = vIdx.get(r.name);
      const failedStep = vR?.steps?.find(s => !s.ok);
      const detail = (failedStep?.detail ?? '').replace(/\|/g, '\\|').slice(0, 100);
      lines.push(`| \`${r.name}\` | ${failedStep?.step ?? '?'} | ${detail} |`);
    }
    lines.push('');
  }

  // Top of the per-testcase table — Jira chokes on huge tables, so we
  // only include the first 20 rows here and refer the reader to the HTML
  // / JSON for the rest.
  lines.push('## Sample of per-testcase verdicts (first 20)');
  lines.push('');
  lines.push('| Name | RAT | Band | BW | SCS | UEs | Ant | Traffic | Mobility | Fading | API | Fidelity |');
  lines.push('|---|---|---|---:|---:|---:|---|---|---|---|:-:|:-:|');
  for (const r of rows.slice(0, 20)) {
    const tick = (s: ReportRow['apiVerdict']) => s === 'pass' ? '✅' : s === 'fail' ? '❌' : '–';
    lines.push(`| \`${r.name}\` | ${r.rat} | ${r.band} | ${r.bandwidth} | ${r.scs ?? '–'} | ${r.ueCount} | ${r.antennas} | ${r.traffic} | ${r.mobility} | ${r.fading} | ${tick(r.apiVerdict)} | ${tick(r.fidelityVerdict)} |`);
  }
  lines.push('');
  lines.push('_Full table: `report.html` (filterable) / `report.json` (raw)._');
  lines.push('');

  return lines.join('\n');
}

// ─── HTML ────────────────────────────────────────────────────────────────

/** Self-contained HTML file — no external dependencies; embeds the row
 *  data as JSON inside a <script> so the page is one shareable file. */
function renderHtml(inputs: BuildReportInputs, rows: ReportRow[], tally: CategoryTally[]): string {
  const g = inputs.generation;
  const v = inputs.validation;
  const data = JSON.stringify({ generation: { buildVersion: g.buildVersion, targetHost: g.targetHost, finishedAt: g.finishedAt }, validation: v ? { passed: v.passed, failed: v.failed, total: v.total, finishedAt: v.finishedAt } : null, tally, rows });

  // Keep this template plain HTML+JS so it works opened directly from disk.
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<title>Bulk Test Cases — ${escapeHtml(g.buildVersion ?? 'build report')}</title>
<style>
  :root { color-scheme: light; }
  body { font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 24px; background: #f8fafc; color: #0f172a; }
  h1 { margin: 0 0 4px; font-size: 22px; }
  h2 { margin: 28px 0 8px; font-size: 15px; text-transform: uppercase; letter-spacing: 0.06em; color: #475569; }
  .meta { color: #475569; margin-bottom: 24px; font-size: 13px; }
  .meta b { color: #0f172a; }
  table { border-collapse: collapse; width: 100%; background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; }
  th, td { padding: 6px 10px; border-bottom: 1px solid #f1f5f9; text-align: left; font-size: 13px; white-space: nowrap; }
  th { background: #f8fafc; color: #334155; font-weight: 600; cursor: pointer; user-select: none; }
  tr:hover td { background: #f8fafc; }
  td.tick { text-align: center; font-size: 15px; }
  td.tick.pass { color: #16a34a; }
  td.tick.fail { color: #dc2626; font-weight: 700; }
  td.tick.notrun { color: #cbd5e1; }
  .summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 12px; }
  .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px 14px; }
  .card .label { color: #64748b; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; }
  .card .value { font-size: 24px; font-weight: 600; color: #0f172a; }
  .filters { display: flex; gap: 8px; margin: 12px 0 6px; flex-wrap: wrap; align-items: center; }
  .filters input, .filters select { padding: 6px 10px; border: 1px solid #cbd5e1; border-radius: 6px; font: inherit; background: #fff; }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; background: #e2e8f0; color: #334155; font-weight: 500; }
  code { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; background: #f1f5f9; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
  footer { margin-top: 24px; color: #94a3b8; font-size: 12px; }
</style>
</head><body>
<h1>Bulk Test Cases — Build Report</h1>
<div class="meta"><b>Build:</b> <code>${escapeHtml(g.buildVersion ?? 'unknown')}</code> &nbsp;|&nbsp; <b>Box:</b> ${escapeHtml(g.targetHost)} &nbsp;|&nbsp; <b>Generated:</b> ${escapeHtml(g.finishedAt)} ${v ? `&nbsp;|&nbsp; <b>Validated:</b> ${escapeHtml(v.finishedAt)}` : ''}</div>

<div class="summary" id="summary-cards"></div>

<h2>Categories</h2>
<table id="cat-table">
  <thead><tr><th>Category</th><th>Authored</th><th>Validated</th><th>Pass</th><th>Fail</th><th>Fidelity Pass</th></tr></thead>
  <tbody></tbody>
</table>

<h2>Per-testcase verdicts</h2>
<div class="filters">
  <input id="q" placeholder="Filter by name…" size="32">
  <select id="ratF"><option value="">All RATs</option></select>
  <select id="verdictF"><option value="">All verdicts</option><option value="pass">Pass only</option><option value="fail">Fail only</option><option value="not-run">Not validated</option></select>
  <span class="pill" id="row-count">0 rows</span>
</div>
<table id="row-table">
  <thead><tr>
    <th data-sort="name">Name</th>
    <th data-sort="rat">RAT</th>
    <th data-sort="band">Band</th>
    <th data-sort="bandwidth">BW</th>
    <th data-sort="scs">SCS</th>
    <th data-sort="ueCount">UEs</th>
    <th data-sort="antennas">Ant</th>
    <th data-sort="traffic">Traffic</th>
    <th data-sort="mobility">Mobility</th>
    <th data-sort="fading">Fading</th>
    <th data-sort="apiVerdict">API</th>
    <th data-sort="fidelityVerdict">Fidelity</th>
  </tr></thead>
  <tbody></tbody>
</table>

<footer>Generated by simqa bulk-tests · self-contained — no external resources · for the matching raw data see <code>report.json</code> in the same folder.</footer>

<script id="data" type="application/json">${data.replace(/</g, '\\u003c')}</script>
<script>
(function() {
  const DATA = JSON.parse(document.getElementById('data').textContent);

  // Summary cards.
  const sc = document.getElementById('summary-cards');
  const cards = [
    ['Total tests', DATA.rows.length],
    ['Validated', DATA.validation ? DATA.validation.total : 0],
    ['Pass', DATA.validation ? DATA.validation.passed : 0],
    ['Fail', DATA.validation ? DATA.validation.failed : 0],
  ];
  for (const [label, value] of cards) {
    const div = document.createElement('div');
    div.className = 'card';
    div.innerHTML = '<div class="label">' + label + '</div><div class="value">' + value + '</div>';
    sc.appendChild(div);
  }

  // Categories table.
  const catTbody = document.querySelector('#cat-table tbody');
  for (const t of DATA.tally) {
    const fidelity = (t.byStep && t.byStep.fidelity && t.byStep.fidelity.pass) || 0;
    const tr = document.createElement('tr');
    tr.innerHTML = '<td><code>' + t.category + '</code></td><td>' + t.generated + '</td><td>' + t.validated + '</td><td>' + t.passed + '</td><td>' + t.failed + '</td><td>' + fidelity + '</td>';
    catTbody.appendChild(tr);
  }

  // RAT filter populate.
  const ratSet = new Set(DATA.rows.map(r => r.rat));
  const ratF = document.getElementById('ratF');
  for (const r of [...ratSet].sort()) {
    const opt = document.createElement('option'); opt.value = r; opt.textContent = r; ratF.appendChild(opt);
  }

  // Row rendering + filter.
  const tbody = document.querySelector('#row-table tbody');
  let sortKey = 'name', sortDir = 1;
  function tickCell(v) {
    if (v === 'pass') return '<td class="tick pass">✓</td>';
    if (v === 'fail') return '<td class="tick fail">✗</td>';
    return '<td class="tick notrun">–</td>';
  }
  function rowHtml(r) {
    return '<tr>'
      + '<td><code>' + r.name + '</code></td>'
      + '<td>' + r.rat + '</td>'
      + '<td>' + r.band + '</td>'
      + '<td>' + r.bandwidth + '</td>'
      + '<td>' + (r.scs || '–') + '</td>'
      + '<td>' + r.ueCount + '</td>'
      + '<td>' + r.antennas + '</td>'
      + '<td>' + r.traffic + '</td>'
      + '<td>' + r.mobility + '</td>'
      + '<td>' + r.fading + '</td>'
      + tickCell(r.apiVerdict)
      + tickCell(r.fidelityVerdict)
      + '</tr>';
  }
  function render() {
    const q = document.getElementById('q').value.toLowerCase();
    const ratV = document.getElementById('ratF').value;
    const vV = document.getElementById('verdictF').value;
    let rows = DATA.rows.filter(r => {
      if (q && !r.name.toLowerCase().includes(q)) return false;
      if (ratV && r.rat !== ratV) return false;
      if (vV && r.apiVerdict !== vV) return false;
      return true;
    });
    rows.sort((a, b) => {
      const av = a[sortKey], bv = b[sortKey];
      if (av < bv) return -1 * sortDir;
      if (av > bv) return 1 * sortDir;
      return 0;
    });
    tbody.innerHTML = rows.map(rowHtml).join('');
    document.getElementById('row-count').textContent = rows.length + ' rows';
  }
  document.getElementById('q').addEventListener('input', render);
  document.getElementById('ratF').addEventListener('change', render);
  document.getElementById('verdictF').addEventListener('change', render);
  document.querySelectorAll('#row-table th').forEach(th => {
    th.addEventListener('click', () => {
      const k = th.dataset.sort;
      if (k === sortKey) sortDir = -sortDir;
      else { sortKey = k; sortDir = 1; }
      render();
    });
  });
  render();
})();
</script>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Public entrypoint ───────────────────────────────────────────────────

export function writeBuildReport(inputs: BuildReportInputs): BuildReportPaths {
  const slug = buildSlug(inputs.generation.buildVersion);
  const dir = path.join(buildReportsRoot(), slug);
  fs.mkdirSync(dir, { recursive: true });

  const rows = buildRows(inputs);
  const tally = tallyByCategory(inputs);

  const jsonPath = path.join(dir, 'report.json');
  const mdPath   = path.join(dir, 'report.md');
  const htmlPath = path.join(dir, 'report.html');

  fs.writeFileSync(jsonPath, JSON.stringify({
    buildVersion: inputs.generation.buildVersion ?? null,
    targetHost: inputs.generation.targetHost,
    generatedAt: inputs.generation.finishedAt,
    validatedAt: inputs.validation?.finishedAt ?? null,
    summary: {
      authored: inputs.generation.created.length,
      validated: inputs.validation?.total ?? 0,
      passed: inputs.validation?.passed ?? 0,
      failed: inputs.validation?.failed ?? 0,
    },
    categories: tally,
    rows,
  }, null, 2));
  fs.writeFileSync(mdPath, renderMarkdown(inputs, rows, tally));
  fs.writeFileSync(htmlPath, renderHtml(inputs, rows, tally));

  return { dir, jsonPath, mdPath, htmlPath, buildSlug: slug };
}

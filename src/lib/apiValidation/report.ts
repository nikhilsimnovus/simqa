// Writes report.html (self-contained, printable to PDF) and results.json.
//
// Ported from report.py and templates/report.html. The report is deliberately
// one file with no external assets: it is downloaded, attached to tickets and
// opened on machines that have never seen SimQA.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Json, Spec, SpecOp } from './spec.ts';
import * as testplan from './testplan.ts';
import type { Entry, Run } from './runner.ts';
import { runDir } from './store.ts';

const TOOL_NAME = 'SimQA · API Validation';

export const LABELS: Record<string, string> = {
  UNDOCUMENTED_STATUS: 'The server returned a status code that the document does not list for this API.',
  WRONG_STATUS: 'A negative test did not get the code the document gives for its reason (e.g. 401 where an unknown ID should give 404), or strict status codes were on and a positive test got a non-2xx.',
  CONTENT_TYPE_MISMATCH: 'The response Content-Type (or presence of a body) differs from the document.',
  MISSING_KEY: 'A key the document marks as required is missing.',
  UNDOCUMENTED_KEY: 'A key is present that the document does not list.',
  WRONG_STRUCTURE: 'An object / array / single value appears where the document has a different one.',
  WRONG_TYPE: 'A field has a different JSON type than documented (checked for test-creation APIs only).',
  INVALID_JSON: 'The response claims to be JSON but cannot be parsed.',
  NOT_IN_RESPONSE: 'A documented key that the response does not contain (checked on the sampled executed test case of GET /testcases, where every documented field is expected).',
  INCONSISTENT_DATA: "The test case's lastExecution.executionId is not one of its executionHistory iterationIds.",
  DOCUMENT_VALUE_USED: "No ID from the run, Shared values or Inputs, so the document's example value was sent instead of skipping (safety check off, or a DELETE in a section without a create API).",
};

function counter<T extends string>(items: T[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of items) out[i] = (out[i] ?? 0) + 1;
  return out;
}

export function summarize(results: Entry[]): Json {
  const tests = results.filter(e => e.kind !== 'setup');
  const byKind: Json = {};
  for (const k of ['positive', 'negative']) {
    byKind[k] = counter(tests.filter(e => e.kind === k).map(e => String(e.verdict)));
  }
  const sections: Json = {};
  for (const e of tests) {
    const c = (sections[e.section] ??= {});
    c[String(e.verdict)] = (c[String(e.verdict)] ?? 0) + 1;
    c.total = (c.total ?? 0) + 1;
  }
  const total = counter(tests.map(e => String(e.verdict)));
  const documentedErrors = tests.filter(e => e.verdict === 'PASS' && e.note).length;
  const warned = tests.filter(e => e.warnings.length);
  const executed = (total.PASS ?? 0) + (total.FAIL ?? 0);
  return {
    total: tests.length,
    counts: total,
    documented_errors: documentedErrors,
    warned: warned.length,
    warning_labels: counter(warned.flatMap(e => e.warnings.map(w => w.label))),
    by_kind: byKind,
    pass_rate: executed ? Math.round((1000 * (total.PASS ?? 0)) / executed) / 10 : 0,
    sections,
    labels: counter(tests.flatMap(e => e.issues.map(i => i.label))),
  };
}

/** Documented examples that break their own schema, judged by the rules the
 *  run uses. */
export function specIssues(spec: Spec, ops: SpecOp[]): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  for (const op of ops) {
    const typed = testplan.TYPED_SECTIONS.has(op.section);
    for (const ex of spec.examples) {
      if (ex.opId !== op.id) continue;
      for (const [kind, msg] of spec.shapeErrors(ex.schema, ex.example, typed)) {
        (found[`${op.method.toUpperCase()} ${op.path}`] ??= []).push(`${ex.label} → ${kind}: ${msg}`);
      }
    }
  }
  return found;
}

export function buildReportData(run: Run): Json {
  const finished = run.finished ?? run.started;
  const order: Record<string, number> = {};
  for (const e of run.results) if (!(e.section in order)) order[e.section] = Object.keys(order).length;
  const ms = finished.getTime() - run.started.getTime();
  return {
    meta: {
      tool: TOOL_NAME,
      run_id: run.id,
      host: run.cfg.host,
      base_url: run.baseUrl,
      run_as: run.cfg.runAs,
      user: run.cfg.username,
      started: stamp(run.started),
      finished: stamp(finished),
      duration: hhmmss(ms),
      spec_title: run.spec.title,
      spec_version: run.spec.version,
      spec_fingerprint: run.spec.fingerprint,
      server_version: run.vars.serverVersion,
      apis_selected: run.ops.length,
      negative: !!run.cfg.negative,
      strict_status: !!run.cfg.strictStatus,
      safety: run.cfg.safety !== false,
      suite: !!run.cfg.suite,
      suite_user: run.cfg.suite ? run.cfg.suiteUser?.username : null,
      suite_ue_ip: run.cfg.suiteUeIp,
      status: run.status,
      error: run.error,
    },
    summary: summarize(run.results),
    notes: run.notes,
    spec_issues: specIssues(run.spec, run.ops),
    // Grouped by section in the order the sections first ran, run order kept inside each.
    results: [...run.results].sort((a, b) => order[a.section] - order[b.section]),
  };
}

export function write(run: Run): Json {
  const dir = runDir(run.id);
  fs.mkdirSync(dir, { recursive: true });
  const data = buildReportData(run);
  fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify(data, null, 2));
  fs.writeFileSync(path.join(dir, 'report.html'), renderHtml(data));
  run.dir = dir;
  return data;
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function hhmmss(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

function esc(v: Json): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const VERDICT_CLASS: Record<string, string> = { PASS: 'pass', FAIL: 'fail', SKIP: 'skip', ERROR: 'err' };

/** One self-contained HTML file: no scripts fetched, no fonts, no styles from
 *  elsewhere, so it opens the same on any machine and prints to PDF. */
export function renderHtml(data: Json): string {
  const m = data.meta;
  const s = data.summary;
  const bySection = new Map<string, Entry[]>();
  for (const e of data.results as Entry[]) {
    const arr = bySection.get(e.section) ?? [];
    arr.push(e);
    bySection.set(e.section, arr);
  }

  const chip = (label: string, n: Json, cls = '') =>
    `<span class="chip ${cls}">${esc(label)} <b>${esc(n ?? 0)}</b></span>`;

  const entryHtml = (e: Entry): string => {
    const cls = VERDICT_CLASS[String(e.verdict)] ?? 'skip';
    const req = e.request ?? {};
    const res = e.response ?? {};
    return `
<details class="entry ${cls}" data-verdict="${esc(e.verdict)}" data-kind="${esc(e.kind)}" ${e.warnings.length ? 'data-warned="1"' : ''} ${e.note ? 'data-note="1"' : ''}>
  <summary>
    <span class="v ${cls}">${esc(e.verdict)}</span>
    <span class="meth">${esc(e.method)}</span>
    <span class="path">${esc(e.path)}</span>
    <span class="case">${esc(e.case)}</span>
    ${e.as ? `<span class="as">as ${esc(e.as)}</span>` : ''}
    ${e.status !== null ? `<span class="code">${esc(e.status)}</span>` : ''}
    ${e.ms !== null ? `<span class="ms">${esc(e.ms)} ms</span>` : ''}
    ${e.issues.length ? `<span class="badge bad">${e.issues.length} issue(s)</span>` : ''}
    ${e.warnings.length ? `<span class="badge warn">${e.warnings.length} warning(s)</span>` : ''}
  </summary>
  <div class="body">
    ${e.reason ? `<p class="reason">${esc(e.reason)}</p>` : ''}
    ${e.note ? `<p class="note">${esc(e.note)}</p>` : ''}
    ${e.info ? `<p class="info">${esc(e.info)}</p>` : ''}
    ${e.issues.length ? `<ul class="issues">${e.issues.map(i => `<li><code>${esc(i.label)}</code> ${esc(i.detail)}</li>`).join('')}</ul>` : ''}
    ${e.warnings.length ? `<details class="warnings"><summary>${e.warnings.length} request warning(s)</summary><ul>${e.warnings.map(w => `<li><code>${esc(w.label)}</code> ${esc(w.detail)}</li>`).join('')}</ul></details>` : ''}
    <div class="exchange">
      <div>
        <h4>Request</h4>
        <p class="url">${esc(req.method ?? '')} ${esc(req.url ?? '')}</p>
        ${req.headers ? `<pre>${esc(Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\n'))}</pre>` : ''}
        ${req.body ? `<pre>${esc(req.body)}</pre>` : ''}
        ${req.curl ? `<details><summary>curl</summary><pre>${esc(req.curl)}</pre></details>` : ''}
      </div>
      <div>
        <h4>Response ${res.status !== undefined ? `· ${esc(res.status)} ${esc(res.reason ?? '')}` : ''}</h4>
        ${res.headers ? `<details><summary>headers</summary><pre>${esc(Object.entries(res.headers).map(([k, v]) => `${k}: ${v}`).join('\n'))}</pre></details>` : ''}
        ${res.body ? `<pre>${esc(res.body)}</pre>` : ''}
      </div>
    </div>
    <p class="documented">Documented status codes: ${esc(Object.entries(e.documented).map(([c, d]) => `${c} ${d}`).join(' · ') || 'none')}</p>
  </div>
</details>`;
  };

  const sections = [...bySection.entries()].map(([name, entries]) => `
<section class="sec">
  <h3>${esc(name)} <span class="muted">${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}</span></h3>
  ${entries.map(entryHtml).join('')}
</section>`).join('');

  const specIssueRows = Object.entries(data.spec_issues as Record<string, string[]>)
    .map(([api, list]) => `<details><summary>${esc(api)} <span class="muted">${list.length}</span></summary><ul>${list.map(x => `<li>${esc(x)}</li>`).join('')}</ul></details>`)
    .join('') || '<p class="muted">No documented example breaks its own schema for the APIs in this run.</p>';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${esc(m.tool)} — ${esc(m.run_id)}</title>
<style>
  :root { --ok:#047857; --bad:#b91c1c; --warn:#b45309; --skip:#6b7280; --line:#e5e7eb; --ink:#0f172a; --muted:#64748b; }
  * { box-sizing: border-box; }
  body { font: 14px/1.5 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: var(--ink); margin: 0; padding: 24px; background: #f8fafc; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h3 { font-size: 15px; margin: 22px 0 8px; }
  h4 { font-size: 12px; margin: 0 0 4px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
  .muted { color: var(--muted); font-weight: 400; }
  .card { background: #fff; border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; margin-bottom: 14px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 6px 18px; }
  .grid div { font-size: 13px; }
  .grid b { color: var(--muted); font-weight: 500; }
  .chip { display: inline-block; border: 1px solid var(--line); border-radius: 999px; padding: 2px 10px; margin: 2px 4px 2px 0; font-size: 12px; background: #fff; }
  .chip.pass { border-color: #a7f3d0; background: #ecfdf5; color: var(--ok); }
  .chip.fail { border-color: #fecaca; background: #fef2f2; color: var(--bad); }
  .chip.skip { border-color: #e5e7eb; background: #f9fafb; color: var(--skip); }
  .chip.warn { border-color: #fde68a; background: #fffbeb; color: var(--warn); }
  .entry { border: 1px solid var(--line); border-radius: 8px; margin: 6px 0; background: #fff; }
  .entry > summary { cursor: pointer; padding: 8px 10px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .entry.fail { border-color: #fecaca; }
  .v { font-weight: 700; font-size: 11px; padding: 1px 7px; border-radius: 4px; }
  .v.pass { color: var(--ok); background: #ecfdf5; }
  .v.fail { color: var(--bad); background: #fef2f2; }
  .v.skip { color: var(--skip); background: #f3f4f6; }
  .v.err  { color: #7c3aed; background: #f5f3ff; }
  .meth { font-weight: 700; font-size: 12px; }
  .path { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; }
  .case { color: var(--muted); font-size: 12px; }
  .as { font-size: 11px; color: #1d4ed8; background: #eff6ff; border-radius: 4px; padding: 1px 6px; }
  .code, .ms { font-size: 12px; color: var(--muted); margin-left: auto; }
  .badge { font-size: 11px; border-radius: 4px; padding: 1px 6px; }
  .badge.bad { color: var(--bad); background: #fef2f2; }
  .badge.warn { color: var(--warn); background: #fffbeb; }
  .body { padding: 0 12px 12px; border-top: 1px solid var(--line); }
  .reason { color: var(--bad); }
  .note { color: var(--warn); }
  .info { color: var(--muted); }
  .issues li { margin: 2px 0; }
  code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; background: #f1f5f9; padding: 1px 4px; border-radius: 3px; }
  pre { background: #f8fafc; border: 1px solid var(--line); border-radius: 6px; padding: 8px; overflow: auto; max-height: 420px; font-size: 12px; }
  .exchange { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .url { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; word-break: break-all; }
  .documented { font-size: 11px; color: var(--muted); }
  @media print {
    body { background: #fff; padding: 0; }
    .entry > .body { display: block !important; }
    details { break-inside: avoid; }
  }
</style></head>
<body>
<h1>${esc(m.tool)}</h1>
<p class="muted">Run ${esc(m.run_id)} · ${esc(m.started)} → ${esc(m.finished)} (${esc(m.duration)})</p>

<div class="card">
  <div class="grid">
    <div><b>Run as</b> ${esc(m.run_as ?? '—')}</div>
    <div><b>Server</b> ${esc(m.host)}</div>
    <div><b>Base URL</b> ${esc(m.base_url)}</div>
    <div><b>Login</b> ${esc(m.user)}</div>
    <div><b>Document</b> ${esc(m.spec_title)} ${esc(m.spec_version)}</div>
    <div><b>Fingerprint</b> ${esc(m.spec_fingerprint)}</div>
    <div><b>Server version</b> ${esc(m.server_version ?? '—')}</div>
    <div><b>APIs selected</b> ${esc(m.apis_selected)}</div>
    <div><b>Negative tests</b> ${m.negative ? 'on' : 'off'}</div>
    <div><b>Strict status codes</b> ${m.strict_status ? 'on' : 'off'}</div>
    <div><b>Safety check</b> ${m.safety ? 'on' : '<span style="color:#b91c1c">OFF</span>'}</div>
    ${m.suite ? `<div><b>Full API suite</b> user ${esc(m.suite_user ?? '')}, UE ${esc(m.suite_ue_ip ?? '—')}</div>` : ''}
  </div>
</div>

<div class="card">
  <h3 style="margin-top:0">Summary</h3>
  ${chip('Total', s.total)}
  ${chip('Passed', s.counts.PASS ?? 0, 'pass')}
  ${chip('Failed', s.counts.FAIL ?? 0, 'fail')}
  ${chip('Skipped', s.counts.SKIP ?? 0, 'skip')}
  ${chip('Errors', s.counts.ERROR ?? 0, 'fail')}
  ${chip('Pass rate', `${s.pass_rate}%`)}
  ${chip('Documented errors', s.documented_errors, 'warn')}
  ${chip('With request warnings', s.warned, 'warn')}
  ${Object.keys(s.labels).length ? `<p style="margin:10px 0 0">${Object.entries(s.labels as Record<string, number>).map(([l, n]) => `<span class="chip fail" title="${esc(LABELS[l] ?? '')}">${esc(l)} <b>${n}</b></span>`).join('')}</p>` : ''}
  ${Object.keys(s.warning_labels).length ? `<p style="margin:6px 0 0">${Object.entries(s.warning_labels as Record<string, number>).map(([l, n]) => `<span class="chip warn" title="${esc(LABELS[l] ?? '')}">${esc(l)} <b>${n}</b></span>`).join('')}</p>` : ''}
</div>

${(data.notes as string[]).length ? `<div class="card"><h3 style="margin-top:0">Notes</h3><ul>${(data.notes as string[]).map(n => `<li>${esc(n)}</li>`).join('')}</ul></div>` : ''}

<div class="card">
  <h3 style="margin-top:0">Document self-check</h3>
  <p class="muted">Documented examples that break their own schema, judged by the same rules as the run. These usually mean the document is inconsistent, not the server.</p>
  ${specIssueRows}
</div>

${sections}

<p class="muted" style="margin-top:20px">${esc(m.tool)} · document ${esc(m.spec_fingerprint)} · generated ${esc(m.finished)}</p>
</body></html>`;
}

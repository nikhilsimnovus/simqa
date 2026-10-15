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
import { renderReport } from './renderReport';

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
/**
 * What was expected, what came back, and how long it took — as one group at
 * the right edge of the row.
 *
 *   expected 400 → 400 · 4 ms
 *
 * The expectation is the half that was missing. A row reading just "400" tells
 * you what the box said and nothing about whether that was the right answer,
 * which is the only thing a reader of a validation report wants to know.
 *
 * An operation can document several acceptable codes, so they are joined
 * rather than reduced to one. A case that never got a reply shows an em dash
 * on the right of the arrow, not a blank.
 */
function codesHtml(e: Entry): string {
  const want = (e.expect ?? []).filter(Boolean);
  const got = e.status !== null && e.status !== undefined ? String(e.status) : '—';
  if (!want.length && e.status === null && e.ms === null) return '';
  const parts: string[] = [];
  if (want.length) parts.push(`expected ${esc(want.join('/'))} → `);
  parts.push(`<span class="got">${esc(got)}</span>`);
  if (e.ms !== null && e.ms !== undefined) parts.push(` · ${esc(e.ms)} ms`);
  return `<span class="codes">${parts.join('')}</span>`;
}

/**
 * The HTML report.
 *
 * The rendering lives in renderReport.ts, which follows the structure,
 * stylesheet and filtering of the report Pradeep's own tool produces — so the
 * two are interchangeable and a reader who knows one knows this. This stays as
 * the entry point every caller already uses.
 */
export function renderHtml(data: Json): string {
  return renderReport(data);
}

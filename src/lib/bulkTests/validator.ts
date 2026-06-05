// API validator for the 500+ generated testcases. For each previously-
// created testcase id, asserts the full read/round-trip/delete contract:
//
//   1. GET    /v2/testcases/{id}                  → 200, name matches manifest
//   2. POST   /v2/testcases/search { name: ... }  → finds the id
//   3. POST   /v2/testcases/export { ids:[id] }   → 200, returns pack
//   4. POST   /v2/testcases/import (the pack)     → 200, new id assigned
//   5. DELETE /v2/testcases/{newid}               → 200/204 (clean up the clone)
//   6. GET    /v2/testcases/{newid}               → 404 (clone really gone)
//   7. GET    /v2/testcases/{id}                  → 200 (original untouched)
//
// Any step failing → that testcase fails validation; the next steps are
// skipped so we don't leak state across testcases.

import type { UesimApiOpts } from './types';

export type ValidationStepName =
  | 'get' | 'search' | 'export' | 'import' | 'delete-clone' | 'verify-clone-gone' | 'verify-original';

export interface ValidationStep {
  step: ValidationStepName;
  ok: boolean;
  status: number;
  durationMs: number;
  detail?: string;
}

export interface ValidationResult {
  /** Manifest id (qa-bulk-…). */
  id: string;
  /** Box-side testcase id. */
  boxId: string;
  /** Display name. */
  name: string;
  /** Category bucket for reporting. */
  category: string;
  /** Each lifecycle step + verdict. */
  steps: ValidationStep[];
  /** Final verdict for this testcase. */
  ok: boolean;
  /** Total wall-clock duration. */
  durationMs: number;
}

export interface ValidationProgress {
  startedAt: string;
  finishedAt?: string;
  total: number;
  done: number;
  passed: number;
  failed: number;
  currentName?: string;
  aborted?: boolean;
}

export interface ValidationSummary {
  startedAt: string;
  finishedAt: string;
  targetHost: string;
  total: number;
  passed: number;
  failed: number;
  results: ValidationResult[];
}

/** Login once and reuse the token across all validations. */
async function login(opts: UesimApiOpts): Promise<string> {
  const r = await fetch(`http://${opts.host}/v2/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: opts.username, password: opts.password }),
  });
  if (!r.ok) throw new Error(`login: ${r.status}`);
  const d: any = await r.json();
  return d.access_token ?? d.token;
}

async function timed<T extends { status: number }>(fn: () => Promise<T>): Promise<T & { durationMs: number }> {
  const t0 = Date.now();
  const r = await fn();
  return Object.assign(r, { durationMs: Date.now() - t0 });
}

export async function validateBulkTestcases(
  opts: UesimApiOpts,
  manifest: Array<{ id: string; name: string; boxId: string; category: string }>,
  onProgress?: (p: ValidationProgress) => void,
  signal?: AbortSignal,
): Promise<ValidationSummary> {
  const startedAt = new Date().toISOString();
  const token = await login(opts);
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const progress: ValidationProgress = { startedAt, total: manifest.length, done: 0, passed: 0, failed: 0 };
  const results: ValidationResult[] = [];

  for (const m of manifest) {
    if (signal?.aborted) { progress.aborted = true; break; }
    progress.currentName = m.name;
    onProgress?.(progress);

    const t0 = Date.now();
    const steps: ValidationStep[] = [];
    let failed = false;

    // Step 1: GET original
    {
      const t = await timed(async () => {
        const r = await fetch(`http://${opts.host}/v2/testcases/${encodeURIComponent(m.boxId)}`, { headers: H });
        const j: any = await r.json().catch(() => ({}));
        return { status: r.status, name: j?.name ?? j?.testCaseName ?? '' };
      });
      const okStep = t.status === 200 && String(t.name).toLowerCase() === m.name.toLowerCase();
      steps.push({ step: 'get', ok: okStep, status: t.status, durationMs: t.durationMs, detail: okStep ? `name=${t.name}` : `expected name=${m.name}, got name=${t.name}, status=${t.status}` });
      if (!okStep) failed = true;
    }

    // Step 2: search by name
    if (!failed) {
      const t = await timed(async () => {
        const r = await fetch(`http://${opts.host}/v2/testcases/search`, {
          method: 'POST', headers: H, body: JSON.stringify({ name: m.name, offset: 0, limit: 5 }),
        });
        const j: any = await r.json().catch(() => ({}));
        const items: any[] = j.items ?? j.data ?? [];
        return { status: r.status, found: items.some(it => it?.id === m.boxId) };
      });
      steps.push({ step: 'search', ok: t.found, status: t.status, durationMs: t.durationMs, detail: t.found ? 'found in search' : `not found (status=${t.status})` });
      if (!t.found) failed = true;
    }

    // Step 3: export
    let exportPack: any = null;
    if (!failed) {
      const t = await timed(async () => {
        const r = await fetch(`http://${opts.host}/v2/testcases/export`, {
          method: 'POST', headers: H, body: JSON.stringify({ ids: [m.boxId] }),
        });
        const text = await r.text();
        let j: any = null;
        try { j = JSON.parse(text); } catch { /* not JSON */ }
        return { status: r.status, body: j, raw: text };
      });
      const okStep = t.status === 200 && t.body;
      steps.push({ step: 'export', ok: okStep, status: t.status, durationMs: t.durationMs, detail: okStep ? `bytes=${t.raw.length}` : `status=${t.status}` });
      if (okStep) exportPack = t.body;
      else failed = true;
    }

    // Step 4: re-import
    let cloneBoxId = '';
    if (!failed && exportPack) {
      const t = await timed(async () => {
        const r = await fetch(`http://${opts.host}/v2/testcases/import`, {
          method: 'POST', headers: H, body: JSON.stringify(exportPack),
        });
        const j: any = await r.json().catch(() => ({}));
        const newIds: string[] = (j.testCases ?? j.imported ?? j.test_case_details ?? []).map((x: any) => x?.id ?? x?.Test_Id ?? x?.testCaseId).filter(Boolean);
        return { status: r.status, newIds };
      });
      const okStep = (t.status >= 200 && t.status < 300) && t.newIds.length > 0;
      steps.push({ step: 'import', ok: okStep, status: t.status, durationMs: t.durationMs, detail: okStep ? `newId=${t.newIds[0]}` : `status=${t.status}, newIds=${t.newIds.join(',')}` });
      if (okStep) cloneBoxId = t.newIds[0]!;
      else failed = true;
    }

    // Step 5: delete clone
    if (!failed && cloneBoxId) {
      const t = await timed(async () => {
        const r = await fetch(`http://${opts.host}/v2/testcases/${encodeURIComponent(cloneBoxId)}`, { method: 'DELETE', headers: H });
        return { status: r.status };
      });
      const okStep = t.status === 200 || t.status === 204;
      steps.push({ step: 'delete-clone', ok: okStep, status: t.status, durationMs: t.durationMs, detail: okStep ? 'clone deleted' : `status=${t.status}` });
      if (!okStep) failed = true;
    }

    // Step 6: verify clone gone
    if (!failed && cloneBoxId) {
      const t = await timed(async () => {
        const r = await fetch(`http://${opts.host}/v2/testcases/${encodeURIComponent(cloneBoxId)}`, { headers: H });
        return { status: r.status };
      });
      const okStep = t.status === 404;
      steps.push({ step: 'verify-clone-gone', ok: okStep, status: t.status, durationMs: t.durationMs, detail: okStep ? '404 as expected' : `expected 404, got ${t.status}` });
      if (!okStep) failed = true;
    }

    // Step 7: verify original untouched
    if (!failed) {
      const t = await timed(async () => {
        const r = await fetch(`http://${opts.host}/v2/testcases/${encodeURIComponent(m.boxId)}`, { headers: H });
        return { status: r.status };
      });
      const okStep = t.status === 200;
      steps.push({ step: 'verify-original', ok: okStep, status: t.status, durationMs: t.durationMs, detail: okStep ? 'original 200' : `original lost — status=${t.status}` });
      if (!okStep) failed = true;
    }

    results.push({
      id: m.id, boxId: m.boxId, name: m.name, category: m.category,
      steps, ok: !failed, durationMs: Date.now() - t0,
    });

    if (failed) progress.failed++;
    else progress.passed++;
    progress.done++;
    onProgress?.(progress);
  }

  const finishedAt = new Date().toISOString();
  progress.finishedAt = finishedAt;
  onProgress?.(progress);

  return {
    startedAt, finishedAt,
    targetHost: opts.host,
    total: manifest.length,
    passed: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok).length,
    results,
  };
}

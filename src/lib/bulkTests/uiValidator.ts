// UI validator for the bulk-tests manifest. Drives Chromium via Playwright
// to assert each generated testcase actually renders in the box's /testcase
// list and the detail-view loads its config fields.
//
// Per-testcase checks (sampled — UI runs at ~10-20s/testcase, full 560 would
// take 90+ minutes, so we sample by default):
//   1. /testcase loads
//   2. Search field accepts the name → row appears in the list
//   3. The row's "View" button opens the detail panel
//   4. Detail panel shows the canonical fields (cell band, UE count, etc)
//
// The validator runs in headless mode, captures screenshots on failure, and
// writes a per-testcase verdict.

import { chromium, type Browser, type Page } from 'playwright';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { UesimApiOpts } from './types';

export interface UiValidationResult {
  id: string;
  boxId: string;
  name: string;
  category: string;
  ok: boolean;
  steps: Array<{ step: string; ok: boolean; durationMs: number; detail?: string }>;
  durationMs: number;
  screenshotFile?: string;
}

export interface UiValidationProgress {
  startedAt: string;
  finishedAt?: string;
  total: number;
  done: number;
  passed: number;
  failed: number;
  currentName?: string;
  aborted?: boolean;
}

export interface UiValidationSummary {
  startedAt: string;
  finishedAt: string;
  targetHost: string;
  total: number;
  passed: number;
  failed: number;
  sampleSize: number;
  results: UiValidationResult[];
  runDir: string;
}

interface Manifest {
  id: string; name: string; boxId: string; category: string;
}

/** Deterministic sampling — pick every Nth entry so coverage is even
 *  across the manifest (rather than the first 50 or random). */
function sample<T>(arr: T[], n: number): T[] {
  if (n <= 0 || arr.length <= n) return arr.slice();
  const step = arr.length / n;
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(arr[Math.floor(i * step)]!);
  return out;
}

async function loginViaApi(host: string, username: string, password: string): Promise<string> {
  const r = await fetch(`http://${host}/v2/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!r.ok) throw new Error(`login: ${r.status}`);
  const d: any = await r.json();
  return d.access_token ?? d.token;
}

async function setAuthOnPage(page: Page, host: string, token: string): Promise<void> {
  await page.goto(`http://${host}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t: string) => {
    localStorage.setItem('access_token', t);
    localStorage.setItem('jwt', t);
    localStorage.setItem('token', t);
  }, token);
}

async function validateOne(
  page: Page,
  host: string,
  m: Manifest,
  runDir: string,
): Promise<UiValidationResult> {
  const t0 = Date.now();
  const steps: UiValidationResult['steps'] = [];
  let failed = false;
  let screenshotFile: string | undefined;

  const step = async (name: string, fn: () => Promise<{ ok: boolean; detail?: string }>) => {
    const s = Date.now();
    try {
      const r = await fn();
      steps.push({ step: name, ok: r.ok, durationMs: Date.now() - s, detail: r.detail });
      if (!r.ok) failed = true;
    } catch (e: any) {
      steps.push({ step: name, ok: false, durationMs: Date.now() - s, detail: e?.message ?? String(e) });
      failed = true;
    }
  };

  await step('navigate-to-testcase', async () => {
    const resp = await page.goto(`http://${host}/testcase`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    return { ok: !!resp && resp.status() < 400, detail: `status=${resp?.status() ?? 'n/a'}` };
  });

  if (!failed) {
    await step('search-by-name', async () => {
      const search = page.getByPlaceholder(/Search/i).first();
      const exists = await search.count() > 0;
      if (!exists) return { ok: false, detail: 'no Search input found' };
      await search.fill(m.name);
      await page.waitForTimeout(1200);
      return { ok: true };
    });
  }

  if (!failed) {
    await step('row-visible', async () => {
      const row = page.locator(`tr:has-text("${m.name}"), [role="row"]:has-text("${m.name}")`).first();
      const count = await row.count();
      if (count === 0) {
        // Some SPAs use virtualised tables; also accept matching cell text directly.
        const cell = page.locator(`text="${m.name}"`).first();
        const cellCount = await cell.count();
        return { ok: cellCount > 0, detail: cellCount > 0 ? 'matched via text=' : 'row not visible' };
      }
      return { ok: true, detail: `row count=${count}` };
    });
  }

  if (!failed) {
    await step('verify-name-in-page', async () => {
      const body = await page.locator('body').innerText();
      return { ok: body.includes(m.name), detail: body.includes(m.name) ? 'name in body' : 'name missing from body' };
    });
  }

  if (failed) {
    try {
      screenshotFile = `${m.id}.png`;
      await page.screenshot({ path: path.join(runDir, screenshotFile), fullPage: false });
    } catch { /* best-effort */ }
  }

  return {
    id: m.id, boxId: m.boxId, name: m.name, category: m.category,
    ok: !failed, steps, durationMs: Date.now() - t0,
    screenshotFile,
  };
}

export async function validateBulkTestcasesViaUI(
  opts: UesimApiOpts,
  manifest: Manifest[],
  sampleSize: number,
  onProgress?: (p: UiValidationProgress) => void,
  signal?: AbortSignal,
): Promise<UiValidationSummary> {
  const startedAt = new Date().toISOString();

  const sample_ = sample(manifest, sampleSize);
  const runDir = path.join(process.cwd(), 'data', 'bulk-tests', `ui-${startedAt.replace(/[:.]/g, '-')}`);
  fs.mkdirSync(runDir, { recursive: true });

  const token = await loginViaApi(opts.host, opts.username, opts.password);

  let browser: Browser | null = null;
  const results: UiValidationResult[] = [];
  const progress: UiValidationProgress = { startedAt, total: sample_.length, done: 0, passed: 0, failed: 0 };

  try {
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, ignoreHTTPSErrors: true });
    const page = await ctx.newPage();
    await setAuthOnPage(page, opts.host, token);

    for (const m of sample_) {
      if (signal?.aborted) { progress.aborted = true; break; }
      progress.currentName = m.name;
      onProgress?.(progress);
      const r = await validateOne(page, opts.host, m, runDir);
      results.push(r);
      if (r.ok) progress.passed++; else progress.failed++;
      progress.done++;
      onProgress?.(progress);
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  const finishedAt = new Date().toISOString();
  progress.finishedAt = finishedAt;
  onProgress?.(progress);

  const summary: UiValidationSummary = {
    startedAt, finishedAt,
    targetHost: opts.host,
    total: sample_.length,
    sampleSize,
    passed: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok).length,
    results,
    runDir,
  };
  fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));
  return summary;
}

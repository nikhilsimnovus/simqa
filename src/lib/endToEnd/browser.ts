// Browser helpers for end-to-end UI checks (Phase 2).
//
// Kept deliberately minimal — we don't reuse uiTester's bundle because that
// one expects a long-lived shared auth context. End-to-end UI checks run
// short-lived contexts per-check (or rather: per phase), so isolation is
// easier than threading shared storage state through.
//
// The launch chain mirrors buildInstaller / uiTester:
//   system Chrome → system Edge → bundled Chromium → bundled Firefox.
// If none launch, requiresBrowser checks get marked SKIPPED with a clear
// reason, while API-only checks keep running.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { chromium, firefox, type Browser, type BrowserContext, type Page } from 'playwright';

export interface BrowserLaunchResult {
  browser: Browser;
  label: string;
}

export async function tryLaunchBrowser(): Promise<BrowserLaunchResult | { error: string }> {
  const baseOpts = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] };
  const attempts: Array<{ label: string; opts: any; launcher: typeof chromium | typeof firefox }> = [
    { label: 'chrome (system)',    opts: { ...baseOpts, channel: 'chrome' }, launcher: chromium },
    { label: 'msedge (system)',    opts: { ...baseOpts, channel: 'msedge' }, launcher: chromium },
    { label: 'chromium (bundled)', opts: baseOpts,                            launcher: chromium },
    { label: 'firefox (bundled)',  opts: baseOpts,                            launcher: firefox  },
  ];
  let lastErr = '';
  for (const a of attempts) {
    try {
      const browser = await a.launcher.launch(a.opts);
      return { browser, label: a.label };
    } catch (e: any) {
      lastErr = `${a.label}: ${e?.message ?? e}`;
    }
  }
  return { error: `no browser could be launched. Tried: ${attempts.map((a) => a.label).join(', ')}. Last error: ${lastErr}` };
}

/** Convenience: create a new context + page, monitor network + console.
 *  The caller closes the context when done. */
export async function newCheckContext(browser: Browser): Promise<{
  context: BrowserContext;
  page: Page;
  /** All console.error messages observed on the page. */
  consoleErrors: string[];
  /** Status-code lookup keyed by URL. Useful for "did any 5xx fire". */
  responses: Array<{ url: string; status: number; method: string }>;
}> {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
  });
  const consoleErrors: string[] = [];
  const responses: Array<{ url: string; status: number; method: string }> = [];
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.setDefaultNavigationTimeout(30_000);

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text().slice(0, 300));
    }
  });
  page.on('response', (res) => {
    try {
      responses.push({ url: res.url(), status: res.status(), method: res.request().method() });
    } catch { /* swallow */ }
  });

  return { context, page, consoleErrors, responses };
}

/** Log into the Simnovator UI by filling the visible form. We could shortcut
 *  via localStorage but the actual login form is more representative of what
 *  a real user does — and the resulting auth cookie is what every subsequent
 *  page navigation depends on. */
export async function loginUI(page: Page, host: string, username: string, password: string): Promise<{ ok: boolean; detail: string }> {
  try {
    await page.goto(`http://${host}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('input[name="username"], #username', { timeout: 15_000 });
    await page.fill('input[name="username"], #username', username);
    await page.fill('input[name="password"], #password', password);
    await page.click('button[type="submit"], #login-button, button:has-text("Login")');
    // Successful login lands on /testcase. Allow up to 30s for the auth handshake.
    const ok = await page.waitForURL((u) => !u.toString().endsWith('/') && !/login|signin/i.test(u.toString()), { timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    if (!ok) return { ok: false, detail: `still on ${page.url()} after submit` };
    return { ok: true, detail: `landed on ${page.url()}` };
  } catch (e: any) {
    return { ok: false, detail: `login threw: ${e?.message ?? e}` };
  }
}

/** Save a screenshot under evidenceDir/{checkId}/screenshot.png. */
export async function snapshot(page: Page, evidenceDir: string, checkId: string): Promise<string | undefined> {
  try {
    const dir = path.join(evidenceDir, checkId);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'screenshot.png');
    await page.screenshot({ path: file, fullPage: false });
    return path.relative(evidenceDir, file).split(path.sep).join('/');
  } catch { return undefined; }
}

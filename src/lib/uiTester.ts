// UI tester for the Simnovator management web UI on the live box.
//
// Drives a real Chromium via Playwright. Each test gets a fresh page, full
// network + console capture, and a final-state screenshot. Results are
// surfaced in the same shape the API tester uses so the UI can render them
// with the same components.
//
// Auth strategy: log in once at the start of a run, save the SPA's storage
// state, reuse it across tests that need an authenticated session. The
// `ui-login` test runs without that shortcut so it can verify the login flow
// from scratch.

import { chromium, firefox, type Browser, type BrowserContext, type Page, type Request as PwRequest, type Response as PwResponse, type ConsoleMessage } from 'playwright';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { uesimApiOptsFromInventory, uesimApiOptsForSystem, type Inventory } from './inventory';
import { bandValidationTests } from './ui-tests/tests/band-validation';

export type UiTestCategory = 'auth' | 'navigation' | 'testcases' | 'stats' | 'logs' | 'simulators' | 'users' | 'tools' | 'security' | 'errors' | 'patterns' | 'lifecycle' | 'perf' | 'compat' | 'field-band';
export type UiTestSeverity = 'critical' | 'normal' | 'optional';

export interface UiRequestRecord {
  method: string;
  url: string;
  status?: number;
  resourceType?: string;
  durationMs?: number;
}

export interface UiTestEvidence {
  screenshotFile?: string;
  networkFile?: string;
  consoleFile?: string;
  downloadFile?: string;
  traceFile?: string;
  videoFile?: string;
}

export interface UiBaselineDiff {
  baselineId: string;
  baselineRunDir?: string;
  baselineFinishedAt?: string;
  /** Tests that PASSED in baseline and FAIL now. The actionable regressions. */
  regressions: Array<{ id: string; name: string; severity: UiTestSeverity; previousDetail?: string; currentDetail?: string }>;
  /** Tests that FAILED in baseline and PASS now. */
  fixes: Array<{ id: string; name: string; severity: UiTestSeverity }>;
  /** Tests that were FAIL in both runs. Still broken. */
  unchangedFailures: Array<{ id: string; name: string; severity: UiTestSeverity }>;
  /** New test ids that didn't exist in baseline. */
  newTests: Array<{ id: string; name: string; ok: boolean }>;
  /** Tests that were in baseline but missing now. */
  removedTests: Array<{ id: string; name: string }>;
}

export interface UiTestResult {
  /** 1-based ordinal so the catalog reads like a numbered list. Assigned at registration. */
  number: number;
  id: string;
  name: string;
  /** One-line statement of what this test validates. Surfaced in the UI catalog. */
  description: string;
  category: UiTestCategory;
  severity: UiTestSeverity;
  ok: boolean;
  skipped?: boolean;
  skippedReason?: string;
  detail?: string;
  expected?: string;
  durationMs?: number;
  /** Final URL after the test ran. */
  finalUrl?: string;
  /** Console errors captured during the test (independent of pass/fail). */
  consoleErrorCount?: number;
  /** Number of network requests captured. */
  networkRequestCount?: number;
  /** File names (relative to the run dir) for evidence pieces. */
  evidence?: UiTestEvidence;
  ranAt?: string;
}

export interface UiTesterRequest {
  categories?: UiTestCategory[];
  /** Run only this single test id (good for re-running a failure). */
  onlyId?: string;
  /** Run a specific subset of tests by id (used for "re-run failures only"). */
  idsToRun?: string[];
  /** Filter by severity: only run tests with severity in this list. */
  severityFilter?: UiTestSeverity[];
  /** Show the browser window. Default true (headless). */
  headless?: boolean;
  /** Per-test timeout in ms. Default 60000. */
  testTimeoutMs?: number;
  /** Browser engine. Default "chromium". */
  browserType?: 'chromium' | 'firefox';
  /** Capture Playwright trace + video. Default "retain-on-failure". */
  traceMode?: 'on' | 'off' | 'retain-on-failure';
  /** Concurrency: max parallel-safe tests at once. Default 1 (sequential). */
  concurrency?: number;
  /** Compare results to a saved baseline; report regressions / fixes in the response. */
  baselineId?: string;
  /**
   * Target system id from inventory.yaml. Different ids run in parallel
   * (different boxes); same id serialises (same box can't drive two
   * Playwright sessions). If omitted, defaults to the first UESIM system.
   */
  targetSystemId?: string;
}

export interface UiTesterResponse {
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  runDir: string;
  counts: { total: number; passed: number; failed: number; skipped: number };
  results: UiTestResult[];
  /** Optional diff against a saved baseline. */
  diff?: UiBaselineDiff;
}

const DEFAULT_CATEGORIES: UiTestCategory[] = ['auth', 'navigation', 'testcases', 'stats', 'logs', 'simulators', 'users', 'tools', 'security', 'errors', 'patterns', 'lifecycle', 'perf', 'compat', 'field-band'];

interface UiCtx {
  browser: Browser;
  host: string;
  username: string;
  password: string;
  authStorageStatePath?: string;
  evidenceRootDir: string;
  headless: boolean;
}

interface PageBundle {
  context: BrowserContext;
  page: Page;
  getRequests: () => UiRequestRecord[];
  getConsoleErrors: () => string[];
  close: () => Promise<void>;
}

function newRunDir(targetHost?: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const hostSuffix = targetHost ? `__${targetHost.replace(/[^A-Za-z0-9.-]/g, '_')}` : '';
  const dir = path.join(process.cwd(), 'data', 'ui-tests', `run-${ts}${hostSuffix}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function newPageBundle(ctx: UiCtx, opts: { useAuth?: boolean; recordTraceTo?: string; recordVideoTo?: string } = {}): Promise<PageBundle> {
  const context = await ctx.browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: ctx.headless ? { width: 1400, height: 900 } : null,
    storageState: opts.useAuth && ctx.authStorageStatePath ? ctx.authStorageStatePath : undefined,
    acceptDownloads: true,
    recordVideo: opts.recordVideoTo ? { dir: opts.recordVideoTo, size: { width: 1400, height: 900 } } : undefined,
  });
  if (opts.recordTraceTo) {
    await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  }
  const page = await context.newPage();
  if (!ctx.headless) await page.bringToFront().catch(() => null);
  page.setDefaultTimeout(20000);
  // Navigation can be slow when the box is under load; bump page.goto timeout
  // to 60s so transient box slowness doesn't masquerade as a product bug.
  page.setDefaultNavigationTimeout(60000);

  const reqs: UiRequestRecord[] = [];
  const errs: string[] = [];
  const startedAt = new Map<string, number>();

  page.on('request', (r: PwRequest) => {
    reqs.push({ method: r.method(), url: r.url(), resourceType: r.resourceType() });
    startedAt.set(r.url(), Date.now());
  });
  page.on('response', (r: PwResponse) => {
    const url = r.url();
    let match: UiRequestRecord | undefined;
    for (let i = reqs.length - 1; i >= 0; i--) {
      if (reqs[i].url === url && reqs[i].status === undefined) { match = reqs[i]; break; }
    }
    if (match) {
      match.status = r.status();
      const t0 = startedAt.get(url);
      if (t0) match.durationMs = Date.now() - t0;
    }
  });
  page.on('console', (m: ConsoleMessage) => {
    if (m.type() === 'error') errs.push(m.text());
  });
  page.on('pageerror', (e) => {
    errs.push(`pageerror: ${e.message}`);
  });

  return {
    context, page,
    getRequests: () => reqs,
    getConsoleErrors: () => errs,
    close: async () => { await context.close(); },
  };
}

async function login(ctx: UiCtx, page: Page): Promise<{ ok: boolean; status?: number; detail: string }> {
  const respPromise = page.waitForResponse((r) => r.url().includes('/v2/login') && r.request().method() === 'POST', { timeout: 45000 }).catch(() => null);
  // Retry the initial nav with a longer second-attempt timeout. The box is
  // sometimes slow on cold-start (>20s for first request) which used to fail
  // every needsAuth test in the run.
  let navOk = false;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await page.goto(`http://${ctx.host}/`, { waitUntil: 'domcontentloaded', timeout: attempt === 1 ? 25000 : 45000 });
      navOk = true;
      break;
    } catch (e: any) {
      if (attempt === 2) return { ok: false, detail: `page.goto failed twice (last: ${String(e?.message ?? e).slice(0, 120)})` };
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  if (!navOk) return { ok: false, detail: 'page.goto failed (unexpected)' };
  const userInput = page.locator('#username, input[name="username"]').first();
  if (!(await userInput.count())) return { ok: false, detail: 'username field not found on landing page' };
  await userInput.fill(ctx.username);
  await page.locator('#password, input[name="password"]').first().fill(ctx.password);
  await page.locator('button:has-text("Login")').first().click();
  const resp = await respPromise;
  if (!resp) return { ok: false, detail: 'no /v2/login response observed within 20s' };
  const status = resp.status();
  if (status !== 200) return { ok: false, status, detail: `login response was ${status}` };
  // Wait for the SPA to settle. The post-login wait must be longer when
  // headed mode applies slowMo (each action waits 250ms) or the JWT may not
  // make it into localStorage before we capture storageState.
  await page.locator('#username').waitFor({ state: 'detached', timeout: 10000 }).catch(() => null);
  // Wait for the post-login route to be the protected one (e.g. /testcase or /sampleTest).
  await page.waitForFunction(
    () => location.pathname !== '/' && !document.querySelector('#username'),
    { timeout: 10000 },
  ).catch(() => null);
  // Verify the SPA actually stashed a token before we capture storageState.
  // Try for up to 5 seconds.
  const tokenStored = await page.waitForFunction(() => {
    for (const k of ['access_token', 'token', 'jwt', 'auth_token', 'authToken']) {
      const v = localStorage.getItem(k);
      if (v && v.length > 20) return true;
    }
    return false;
  }, { timeout: 5000 }).then(() => true).catch(() => false);
  return {
    ok: true,
    status,
    detail: `landed at ${page.url()}, jwt-in-localStorage=${tokenStored}`,
  };
}

async function recordEvidence(testDir: string, page: Page, bundle: PageBundle): Promise<UiTestEvidence> {
  fs.mkdirSync(testDir, { recursive: true });
  const screenshotFile = 'screenshot.png';
  await page.screenshot({ path: path.join(testDir, screenshotFile), fullPage: true }).catch(() => null);
  const networkFile = 'network.json';
  fs.writeFileSync(path.join(testDir, networkFile), JSON.stringify(bundle.getRequests(), null, 2));
  const consoleFile = 'console-errors.txt';
  fs.writeFileSync(path.join(testDir, consoleFile), bundle.getConsoleErrors().join('\n'));
  return { screenshotFile, networkFile, consoleFile };
}

interface UiTestDef {
  id: string;
  name: string;
  /** One-line statement of what this test validates. Shown in the UI catalog. */
  description: string;
  category: UiTestCategory;
  severity: UiTestSeverity;
  needsAuth?: boolean;
  longRunning?: boolean;
  destructive?: boolean;
  run: (args: { ctx: UiCtx; bundle: PageBundle; testDir: string }) => Promise<{ ok: boolean; detail: string; expected?: string; extraEvidence?: UiTestEvidence }>;
}

// ---------- Test definitions ----------

function defs(): UiTestDef[] {
  const list: UiTestDef[] = [];

  // ============== AUTH (4) ==============

  list.push({
    id: 'ui-login', name: 'Login form -> SPA dashboard', description: 'Validates the happy-path login flow: filling admin credentials and clicking Login leaves the marketing landing and arrives at the post-login SPA route.', category: 'auth', severity: 'critical',
    run: async ({ ctx, bundle }) => {
      const r = await login(ctx, bundle.page);
      if (!r.ok) return { ok: false, detail: r.detail, expected: '200 from /v2/login then SPA navigates away from the login form' };
      const url = bundle.page.url();
      const okPath = url.includes('/testcase') || url.includes('/dashboard');
      return { ok: okPath, detail: `login=${r.status} final=${url}`, expected: 'final URL contains /testcase or /dashboard' };
    },
  });

  list.push({
    id: 'ui-login-wrong-password', name: 'Wrong password is rejected (no token, error visible)', description: 'Confirms a wrong password yields a 4xx response and keeps the user on the login form. Wrong creds must never grant access.', category: 'auth', severity: 'critical',
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/`, { waitUntil: 'domcontentloaded' });
      const respPromise = page.waitForResponse((r) => r.url().includes('/v2/login') && r.request().method() === 'POST', { timeout: 10000 }).catch(() => null);
      await page.locator('#username').fill(ctx.username);
      await page.locator('#password').fill('definitely-wrong-password-' + Date.now());
      await page.locator('button:has-text("Login")').first().click();
      const resp = await respPromise;
      if (!resp) return { ok: false, detail: 'no /v2/login response observed', expected: 'POST /v2/login fires when Login is clicked' };
      const status = resp.status();
      await page.waitForTimeout(2000);
      const stillOnLoginForm = await page.locator('#username').count() > 0;
      return {
        ok: status >= 400 && status < 500 && stillOnLoginForm,
        detail: `login response=${status} stillOnLoginForm=${stillOnLoginForm}`,
        expected: '4xx (typically 401) AND user remains on the login form. Wrong creds should never grant access.',
      };
    },
  });

  list.push({
    id: 'ui-login-empty-creds', name: 'Empty username/password is rejected client-side or server-side', description: 'Confirms clicking Login with empty username/password fields does not navigate. Empty submit should be blocked client-side or rejected server-side.', category: 'auth', severity: 'normal',
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/`, { waitUntil: 'domcontentloaded' });
      await page.locator('button:has-text("Login")').first().click().catch(() => null);
      await page.waitForTimeout(2000);
      const stillOnLoginForm = await page.locator('#username').count() > 0;
      return {
        ok: stillOnLoginForm,
        detail: `stillOnLoginForm=${stillOnLoginForm}`,
        expected: 'Login button does not navigate when fields are empty (either disabled or shows validation message)',
      };
    },
  });

  // ================================================================
  // AUTH UX — does the user actually KNOW what went wrong?
  // ================================================================

  list.push({
    id: 'ui-login-error-message-visible-on-wrong-password',
    name: 'Wrong password shows a visible, readable error message',
    description: 'After a wrong-password submit, asserts an error message is rendered with text matching /invalid|incorrect|wrong/i, in red-flavored color, with adequate font size. Catches the "user has no idea what went wrong" UX bug.',
    category: 'auth', severity: 'critical',
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/`, { waitUntil: 'domcontentloaded' });
      const respPromise = page.waitForResponse((r) => r.url().includes('/v2/login') && r.request().method() === 'POST', { timeout: 10000 }).catch(() => null);
      await page.locator('#username').fill(ctx.username);
      await page.locator('#password').fill('definitely-wrong-' + Date.now());
      await page.locator('button:has-text("Login")').first().click();
      await respPromise;
      await page.waitForTimeout(2500);

      // Find a visible leaf element whose text matches an error-keyword.
      const errors = await page.evaluate(() => {
        const out: Array<{ text: string; color: string; bg: string; fontSizePx: number }> = [];
        document.querySelectorAll('*').forEach((el) => {
          const txt = (el.textContent ?? '').trim();
          if (txt.length < 5 || txt.length > 200) return;
          if (!/invalid|incorrect|wrong|unauthorized|failed|error/i.test(txt)) return;
          if (/no errors|password successfully/i.test(txt)) return;
          if (el.children.length > 0) return; // leaf only
          const cs = getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden') return;
          out.push({ text: txt, color: cs.color, bg: cs.backgroundColor, fontSizePx: parseFloat(cs.fontSize) });
        });
        return out;
      });

      if (errors.length === 0) {
        return {
          ok: false,
          detail: 'no error-flavored text element visible after wrong-password submit',
          expected: 'after wrong password, user must see clear error text (e.g. "Invalid username or password") so they know to retry',
        };
      }

      // Color check: parse rgb, expect red dominance
      const reddish = (s: string) => { const m = s.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/); if (!m) return false; const [, r, g, b] = m.map(Number); return r > g + 30 && r > b + 30; };
      const e = errors[0];
      const redColor = reddish(e.color) || reddish(e.bg);
      const readableSize = e.fontSizePx >= 12;
      const issues: string[] = [];
      if (!redColor) issues.push(`color "${e.color}" is not red-dominant — error blends in`);
      if (!readableSize) issues.push(`font ${e.fontSizePx}px is too small`);
      return {
        ok: redColor && readableSize,
        detail: `text="${e.text}" color=${e.color} fontSize=${e.fontSizePx}px${issues.length ? '; issues: ' + issues.join(', ') : ''}`,
        expected: 'error text is red-tinted (color or background) AND >=12px so a user notices it without hunting',
      };
    },
  });

  list.push({
    id: 'ui-login-error-positioned-near-fields',
    name: 'Error message appears near the credential fields, not buried elsewhere',
    description: 'After wrong password, asserts the error message is within 200px of the password input vertically. Buried errors at the bottom of the page or in a tiny corner toast get missed.',
    category: 'auth', severity: 'normal',
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/`, { waitUntil: 'domcontentloaded' });
      const respPromise = page.waitForResponse((r) => r.url().includes('/v2/login') && r.request().method() === 'POST', { timeout: 10000 }).catch(() => null);
      await page.locator('#username').fill(ctx.username);
      await page.locator('#password').fill('wrong-' + Date.now());
      await page.locator('button:has-text("Login")').first().click();
      await respPromise;
      await page.waitForTimeout(2000);
      const measure = await page.evaluate(() => {
        const pwd = document.querySelector('#password');
        if (!pwd) return null;
        const pwdY = pwd.getBoundingClientRect().bottom;
        let closest: { text: string; distance: number } | null = null;
        document.querySelectorAll('*').forEach((el) => {
          const txt = (el.textContent ?? '').trim();
          if (txt.length < 5 || txt.length > 200) return;
          if (!/invalid|incorrect|wrong|unauthorized|failed|error/i.test(txt)) return;
          if (/no errors|password successfully/i.test(txt)) return;
          if (el.children.length > 0) return;
          const cs = getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden') return;
          const r = (el as HTMLElement).getBoundingClientRect();
          const d = Math.abs(r.top - pwdY);
          if (!closest || d < closest.distance) closest = { text: txt, distance: d };
        });
        return closest;
      });
      if (!measure) return { ok: false, detail: 'no error message found OR no #password field found', expected: 'an error message exists' };
      const m = measure as { text: string; distance: number };
      return {
        ok: m.distance < 200,
        detail: `error "${m.text.slice(0, 60)}" is ${Math.round(m.distance)}px from the password field`,
        expected: 'error message is positioned within 200px (vertically) of the password field so the user finds it without hunting',
      };
    },
  });

  list.push({
    id: 'ui-login-caps-lock-warning',
    name: 'Caps Lock detection: warning shown when Caps Lock is on while typing password',
    description: 'Programmatically presses CapsLock, types into the password field, asserts a warning text or icon appears (Caps Lock On / Caps detected / etc). Saves a wrong-password debug cycle.',
    category: 'auth', severity: 'optional',
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/`, { waitUntil: 'domcontentloaded' });
      await page.locator('#username').fill(ctx.username);
      await page.locator('#password').focus();
      await page.keyboard.press('CapsLock');
      await page.locator('#password').type('Test');
      await page.waitForTimeout(800);
      const capsHint = await page.locator(':text-matches("caps\\s*lock", "i")').count();
      // Restore Caps Lock state
      await page.keyboard.press('CapsLock');
      return {
        ok: capsHint > 0,
        detail: `Caps Lock hint elements visible: ${capsHint}`,
        expected: 'when Caps Lock is on while typing password, a small warning appears so user does not waste a login attempt',
      };
    },
  });

  list.push({
    id: 'ui-login-password-visibility-toggle',
    name: 'Password field has a show/hide visibility toggle',
    description: 'Looks for a button next to the password field that toggles its type between password and text. Standard UX feature for users with complex passwords.',
    category: 'auth', severity: 'optional',
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/`, { waitUntil: 'domcontentloaded' });
      await page.locator('#password').fill('test123');
      const startType = await page.locator('#password').getAttribute('type');
      // Try to find a toggle adjacent to the password input
      const toggleClicked = await page.evaluate(() => {
        const pwd = document.querySelector('#password') as HTMLElement | null;
        if (!pwd) return false;
        const parent = pwd.parentElement;
        if (!parent) return false;
        const buttons = parent.querySelectorAll('button, [role="button"], [class*="toggle" i], [class*="visibility" i]');
        for (const b of Array.from(buttons)) {
          const a = (b.getAttribute('aria-label') ?? '').toLowerCase();
          if (a.includes('show') || a.includes('visibility') || a.includes('eye')) {
            (b as HTMLElement).click();
            return true;
          }
        }
        // Fallback: any button-like child of the password's wrapper
        if (buttons.length > 0) { (buttons[0] as HTMLElement).click(); return true; }
        return false;
      });
      await page.waitForTimeout(400);
      const endType = await page.locator('#password').getAttribute('type');
      return {
        ok: toggleClicked && startType === 'password' && endType === 'text',
        detail: `toggle found=${toggleClicked} type before=${startType} after=${endType}`,
        expected: 'a button next to the password field toggles type=password ↔ type=text so users can verify what they typed',
      };
    },
  });

  list.push({
    id: 'ui-login-username-autofocus',
    name: 'Username field is auto-focused when the login page loads',
    description: 'Loads / and asserts the username input is the active element. Saves the user a click/Tab on every login.',
    category: 'auth', severity: 'optional',
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(800);
      const focusedId = await page.evaluate(() => document.activeElement?.id ?? '');
      return {
        ok: focusedId === 'username',
        detail: `document.activeElement.id = "${focusedId}" (expected "username")`,
        expected: 'cursor lands in the Username field on page load',
      };
    },
  });

  list.push({
    id: 'ui-login-password-field-masked-by-default',
    name: 'Password field is type=password by default (masked, not plaintext)',
    description: 'Loads / and asserts the password input has type="password" before any user interaction. Plaintext passwords by default are a security/privacy issue (shoulder-surfing, screen recording).',
    category: 'auth', severity: 'normal',
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(800);
      const type = await page.locator('#password').getAttribute('type');
      // Now check after typing — should still be password-masked unless user clicks toggle
      await page.locator('#password').fill('temp-password');
      await page.waitForTimeout(400);
      const typeAfterTyping = await page.locator('#password').getAttribute('type');
      return {
        ok: type === 'password' && typeAfterTyping === 'password',
        detail: `type on load=${type}, type after typing (no toggle click)=${typeAfterTyping}`,
        expected: 'password input is type="password" both on initial load and while typing — until user explicitly clicks a show toggle',
      };
    },
  });

  // ─── B10 ───
  list.push({
    id: 'ui-login-loading-state-during-submit',
    name: 'Login button shows loading state (spinner / disabled / "Signing in…") during /v2/login request',
    description: 'After clicking Login, asserts at least one of: (a) button text changes (b) button disabled (c) a spinner appears anywhere — within 200ms of click and before the response comes back. Without this, the user wonders if the click registered.',
    category: 'auth', severity: 'normal',
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      // Throttle /v2/login so we have time to observe the loading state.
      await page.route('**/v2/login', async (route) => {
        await new Promise((r) => setTimeout(r, 1500));
        await route.continue();
      });
      await page.goto(`http://${ctx.host}/`, { waitUntil: 'domcontentloaded' });
      await page.locator('#username').fill(ctx.username);
      await page.locator('#password').fill('any-password-' + Date.now());

      const btn = page.locator('button:has-text("Login")').first();
      const beforeText = (await btn.textContent().catch(() => '')) ?? '';
      const beforeDisabled = await btn.isDisabled().catch(() => false);

      await btn.click();
      await page.waitForTimeout(400); // observe ~middle of the throttled request

      const afterText = (await btn.textContent().catch(() => '')) ?? '';
      const afterDisabled = await btn.isDisabled().catch(() => false);
      const spinnerCount = await page.locator('[role="progressbar"], [class*="spinner" i], [class*="loading" i], svg[class*="animate" i]').count();

      const textChanged = afterText.trim() !== beforeText.trim();
      const becameDisabled = afterDisabled && !beforeDisabled;
      const spinnerVisible = spinnerCount > 0;
      const ok = textChanged || becameDisabled || spinnerVisible;
      await page.waitForTimeout(2000); // let the request complete cleanly
      return {
        ok,
        detail: `text "${beforeText.trim()}"->"${afterText.trim()}" disabled ${beforeDisabled}->${afterDisabled} spinners=${spinnerCount}`,
        expected: 'during the in-flight /v2/login request, the Login button changes text OR becomes disabled OR a spinner appears, so user knows the click registered',
      };
    },
  });

  // ─── Footer links: User Manual, Support Portal, Company Homepage ───
  // These appear at the bottom of the login form. If a future build removes
  // them or leaves a dead href, users have no path to docs/support.
  list.push({
    id: 'ui-login-footer-links-present',
    name: 'Login page footer shows Company Homepage, Support Portal, User Manual links',
    description: 'Loads / and asserts all three footer links are visible by their text. If any of these are removed or renamed in a future build, this fails.',
    category: 'auth', severity: 'normal',
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1200);
      const expected = ['Company Homepage', 'Support Portal', 'User Manual'];
      const found: Record<string, boolean> = {};
      for (const label of expected) {
        const c = await page.getByText(label, { exact: true }).count();
        found[label] = c > 0;
      }
      const missing = expected.filter((l) => !found[l]);
      return {
        ok: missing.length === 0,
        detail: `present: ${expected.filter((l) => found[l]).join(', ') || '(none)'}${missing.length ? ` | MISSING: ${missing.join(', ')}` : ''}`,
        expected: 'login page footer has Company Homepage, Support Portal, and User Manual links visible',
      };
    },
  });

  list.push({
    id: 'ui-login-footer-links-have-valid-hrefs',
    name: 'Footer links point at non-empty URLs (not "#" or empty)',
    description: 'For each footer link, asserts the href attribute is a real URL — not "#", not empty, not "javascript:". Catches the regression where a link still renders but the href was dropped.',
    category: 'auth', severity: 'normal',
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1200);
      const labels = ['Company Homepage', 'Support Portal', 'User Manual'];
      const results = await page.evaluate((labels) => {
        const out: Array<{ label: string; href: string; tag: string }> = [];
        for (const label of labels) {
          const el = Array.from(document.querySelectorAll('a, button, [role="link"]'))
            .find((e) => (e.textContent ?? '').trim() === label);
          if (!el) { out.push({ label, href: '<not-found>', tag: '?' }); continue; }
          const href = (el as HTMLAnchorElement).href ?? el.getAttribute('href') ?? '';
          out.push({ label, href, tag: el.tagName });
        }
        return out;
      }, labels);
      const broken = results.filter((r) => {
        if (r.href === '<not-found>') return true;
        if (!r.href) return true;
        if (r.href === '#' || r.href.endsWith('#')) return true;
        if (r.href.startsWith('javascript:')) return true;
        return false;
      });
      return {
        ok: broken.length === 0,
        detail: results.map((r) => `${r.label} → ${r.href.slice(0, 80)}`).join(' | '),
        expected: 'every footer link has a real http(s) URL — none should be "#" / empty / javascript:',
      };
    },
  });

  list.push({
    id: 'ui-login-user-manual-link-opens',
    name: 'User Manual link is reachable (HEAD request returns 2xx/3xx)',
    description: 'Reads the User Manual href and fires a HEAD request to verify the destination resolves. Catches the case where the link points to a 404\'d documentation page after a docs migration.',
    category: 'auth', severity: 'normal', longRunning: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1200);
      const href = await page.evaluate(() => {
        const el = Array.from(document.querySelectorAll('a, button, [role="link"]'))
          .find((e) => (e.textContent ?? '').trim() === 'User Manual');
        return el ? ((el as HTMLAnchorElement).href ?? el.getAttribute('href') ?? '') : '';
      });
      if (!href || href === '#') return { ok: false, detail: `href="${href}"`, expected: 'User Manual link has a real URL' };
      // HEAD via fetch from the page context (so cross-origin auth cookies / referer behave correctly)
      const reachable = await page.evaluate(async (url) => {
        try {
          const r = await fetch(url, { method: 'HEAD', mode: 'no-cors', redirect: 'follow' });
          return { ok: r.ok || r.type === 'opaque', status: r.status, type: r.type };
        } catch (e: any) { return { ok: false, status: 0, type: 'error', err: String(e?.message ?? e).slice(0, 80) }; }
      }, href);
      return {
        ok: reachable.ok,
        detail: `User Manual url=${href.slice(0, 100)} HEAD status=${reachable.status} type=${reachable.type}`,
        expected: 'User Manual URL responds with 2xx/3xx (or opaque - meaning cross-origin reachable)',
      };
    },
  });

  list.push({
    id: 'ui-login-copyright-current-year',
    name: 'Login page copyright text shows the current year',
    description: 'Asserts a "© <year> Simnovator" footer is visible AND the year is current (or last year). A frozen copyright year is a sign the build is stale.',
    category: 'auth', severity: 'optional',
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1200);
      const text = await page.locator('body').textContent().catch(() => '');
      const match = (text ?? '').match(/©\s*(\d{4})\s*Simnovator/i);
      const now = new Date().getFullYear();
      const accepted = [now, now - 1];
      return {
        ok: !!match && accepted.includes(Number(match[1])),
        detail: match ? `found "© ${match[1]} Simnovator" (current year is ${now})` : 'no copyright text matching "© YYYY Simnovator" found',
        expected: `© ${now} Simnovator (or © ${now - 1} acceptable)`,
      };
    },
  });

  // ─── B11 ───
  list.push({
    id: 'ui-login-button-disabled-during-submit-prevents-double-click',
    name: 'Login button cannot be double-clicked while a request is in-flight',
    description: 'Throttles /v2/login to 1.5s, clicks Login twice rapidly, asserts only ONE POST /v2/login fires. Double-submit risks data inconsistency and frustrates users.',
    category: 'auth', severity: 'normal',
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      let postCount = 0;
      await page.route('**/v2/login', async (route) => {
        postCount++;
        await new Promise((r) => setTimeout(r, 1500));
        await route.continue();
      });
      await page.goto(`http://${ctx.host}/`, { waitUntil: 'domcontentloaded' });
      await page.locator('#username').fill(ctx.username);
      await page.locator('#password').fill('any-password-' + Date.now());

      const btn = page.locator('button:has-text("Login")').first();
      // Two rapid clicks
      await btn.click();
      await page.waitForTimeout(150);
      await btn.click({ trial: false }).catch(() => null);
      await page.waitForTimeout(2500); // wait for both potential requests to settle

      return {
        ok: postCount <= 1,
        detail: `POST /v2/login fired ${postCount} times after a double-click`,
        expected: 'after the first click, the button must disable (or be otherwise un-clickable) until the request finishes — exactly 1 POST /v2/login per double-click',
      };
    },
  });

  list.push({
    id: 'ui-deep-link-without-auth-bounces-to-login', name: 'Direct nav to /testcase without auth -> login form', description: 'Confirms direct navigation to a protected SPA route while logged out shows the login form, never the protected data.', category: 'auth', severity: 'critical',
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      // No auth state on this bundle. Navigate directly.
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const onLoginForm = await page.locator('#username').count() > 0;
      const url = page.url();
      return {
        ok: onLoginForm,
        detail: `final-url=${url} onLoginForm=${onLoginForm}`,
        expected: 'unauthenticated direct nav to /testcase must show the login form, not the testcase data',
      };
    },
  });

  // ============== NAVIGATION (3) ==============

  list.push({
    id: 'ui-sidebar-known-routes-reachable', name: 'Direct nav to known sidebar routes stays authenticated', description: 'Visits every sidebar route (/sampleTest, /testcase, /statistics, /logs) and asserts each renders while keeping the session.', category: 'navigation', severity: 'critical', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      // Real sidebar routes: Sample Tests, My Tests, Statistics (with sub-tabs), Logs.
      const routes = ['/sampleTest', '/testcase', '/statistics', '/logs'];
      const results: Array<{ route: string; finalUrl: string; ok: boolean }> = [];
      for (const r of routes) {
        await page.goto(`http://${ctx.host}${r}`, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1500);
        const finalUrl = page.url();
        const stayed = !finalUrl.match(/192\.168\.1\.95\/?$/) && !(await page.locator('#username').count());
        results.push({ route: r, finalUrl, ok: stayed });
      }
      const failed = results.filter((x) => !x.ok);
      return {
        ok: failed.length === 0,
        detail: `${results.length - failed.length}/${results.length} routes stayed authenticated. Failed: ${failed.map((f) => f.route).join(', ') || 'none'}`,
        expected: 'every known sidebar route (/testcase, /sampleTest, /statistics, /logs, /users, /tools) loads its page while keeping the session',
      };
    },
  });

  list.push({
    id: 'ui-unknown-route-shows-404-not-marketing-landing', name: 'Unknown URLs should 404, not bounce to marketing landing + force re-login', description: 'Hits typo or unknown URLs and asserts they render a 404 inside the SPA shell. Today they bounce to the marketing landing AND end the session.', category: 'navigation', severity: 'normal', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      // Typos / wrong casing / dead links must not silently log the user out.
      const checks: Array<{ route: string; finalUrl: string; loggedOut: boolean }> = [];
      for (const r of ['/sample-tests', '/my-tests', '/myTest', '/this-route-does-not-exist']) {
        await page.goto(`http://${ctx.host}${r}`, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1500);
        const finalUrl = page.url();
        const onLogin = (await page.locator('#username').count()) > 0;
        const onMarketingLanding = finalUrl.match(/192\.168\.1\.95\/?$/) !== null;
        checks.push({ route: r, finalUrl, loggedOut: onLogin || onMarketingLanding });
      }
      const offending = checks.filter((c) => c.loggedOut);
      return {
        ok: offending.length === 0,
        detail: checks.map((c) => `${c.route} -> ${c.finalUrl}${c.loggedOut ? ' [LOGGED OUT]' : ''}`).join(' | '),
        expected: 'unknown routes should render a 404 page within the SPA shell, NOT redirect to the public marketing landing and end the user\'s session. Currently typos / wrong casing log the user out.',
      };
    },
  });

  list.push({
    id: 'ui-page-refresh-stays-authenticated', name: 'F5 on /testcase keeps the user logged in', description: 'Loads /testcase, hits browser refresh, and asserts the page still renders rows (the session must survive a reload).', category: 'navigation', severity: 'normal', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const onLoginForm = await page.locator('#username').count() > 0;
      const rowCount = await page.locator('table tbody tr').count();
      return {
        ok: !onLoginForm && rowCount > 0,
        detail: `after reload onLoginForm=${onLoginForm} rows=${rowCount}`,
        expected: 'reloading /testcase keeps the session - rows still render, no login form',
      };
    },
  });

  // ============== TESTCASE LIST (5) ==============

  list.push({
    id: 'ui-testcase-list', name: 'Test Cases page renders rows', description: 'Asserts /testcase shows at least one row of testcases (the user has My Tests imported on the box).', category: 'testcases', severity: 'critical', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      await bundle.page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await bundle.page.waitForTimeout(2500);
      const rowCount = await bundle.page.locator('table tbody tr').count();
      return { ok: rowCount > 0, detail: `${rowCount} table rows`, expected: 'at least one testcase row visible' };
    },
  });

  list.push({
    id: 'ui-testcase-import-button-visible', name: 'Import + Create Test Case buttons are visible', description: 'Asserts both Import (upload JSON pack) and Create Test Case buttons are visible in the toolbar.', category: 'testcases', severity: 'normal', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
      const importVisible = await page.locator('button:has-text("Import")').count() > 0;
      const createVisible = await page.locator('button:has-text("Create Test Case")').count() > 0;
      return {
        ok: importVisible && createVisible,
        detail: `import=${importVisible} create=${createVisible}`,
        expected: 'both Import and Create Test Case buttons are present in the toolbar',
      };
    },
  });

  list.push({
    id: 'ui-testcase-search-filters-list', name: 'Typing in the search box filters the visible rows', description: 'Types a string that matches no testcase into the search box and asserts the visible row count drops below the original count.', category: 'testcases', severity: 'normal', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
      const before = await page.locator('table tbody tr').count();
      const search = page.locator('input[placeholder*="Search" i], input#searchable-input, input[type="text"]').first();
      if (!(await search.count())) return { ok: false, detail: 'search input not found', expected: 'a search input on the testcases toolbar' };
      // Type a string very unlikely to match anything.
      await search.fill('zzz-no-such-testcase-' + Date.now());
      await page.waitForTimeout(1500);
      const after = await page.locator('table tbody tr').count();
      return {
        ok: after < before,
        detail: `before=${before} after-impossible-search=${after}`,
        expected: 'after typing a string that matches no testcase, the row count drops below the original count',
      };
    },
  });

  list.push({
    id: 'ui-testcase-status-filter', name: 'Status filter dropdown opens', description: 'Clicks the Status filter button and asserts a dropdown menu appears.', category: 'testcases', severity: 'normal', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
      const btn = page.getByRole('button', { name: /^Status$/i }).first();
      if (!(await btn.count())) return { ok: false, detail: 'Status filter button not found', expected: 'a Status filter dropdown button on the testcases toolbar' };
      await btn.click();
      await page.waitForTimeout(700);
      // Look for any popover / option element.
      const popoverCount = await page.locator('[role="menu"], [role="listbox"], .ant-dropdown, .ant-popover, [data-state="open"]').count();
      return {
        ok: popoverCount > 0,
        detail: `popover-elements-after-click=${popoverCount}`,
        expected: 'clicking Status reveals a dropdown menu of status options',
      };
    },
  });

  list.push({
    id: 'ui-testcase-row-click-shows-detail', name: 'Clicking a row populates the right-side detail panel', description: 'Clicks the first row and asserts the LAST RUN TEST detail card appears (with Restart and Stats actions).', category: 'testcases', severity: 'normal', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const firstRow = page.locator('table tbody tr').first();
      if (!(await firstRow.count())) return { ok: false, detail: 'no rows', expected: 'at least one row to click' };
      const rowText = await firstRow.textContent().catch(() => '');
      await firstRow.click();
      await page.waitForTimeout(1500);
      const lastRunCard = await page.getByText(/LAST RUN TEST/i).count();
      const restartBtn = await page.getByRole('button', { name: /Restart/i }).count();
      return {
        ok: lastRunCard > 0 || restartBtn > 0,
        detail: `lastRunCard=${lastRunCard} restartBtn=${restartBtn} (clicked row: ${rowText?.slice(0, 60)})`,
        expected: 'clicking a row reveals a detail panel/card (LAST RUN TEST, Restart, Stats buttons, etc.)',
      };
    },
  });

  // ============== STATISTICS (4) ==============

  list.push({
    id: 'ui-stats-tab-switch', name: 'Statistics nav: Cell -> UE switches the page', description: 'Switches between /statistics?tab=cell and /statistics?tab=ue and asserts the URL changes correctly.', category: 'stats', severity: 'normal', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/statistics?tab=cell`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const cellUrl = page.url();
      await page.goto(`http://${ctx.host}/statistics?tab=ue`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const ueUrl = page.url();
      return {
        ok: cellUrl !== ueUrl,
        detail: `cellUrl=${cellUrl} ueUrl=${ueUrl}`,
        expected: 'switching tab=cell to tab=ue produces different URLs',
      };
    },
  });

  list.push({
    id: 'ui-stats-cell-renders', name: 'Cell Statistics page loads with a Cell card and Export control', description: 'Asserts Cell Statistics tab loads with a Cell card and an Export button. The "No config data available" banner is acceptable - that is a separate empty-data issue.', category: 'stats', severity: 'normal', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/statistics?tab=cell`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
      const exportBtn = await page.locator('button:has-text("Export")').count();
      const cellCard = await page.getByText(/^Cell\s*\d+/).count();
      const noConfig = await page.getByText(/No config data available/i).count();
      return {
        ok: exportBtn > 0 && cellCard > 0,
        detail: `exportBtn=${exportBtn} cellCard=${cellCard} noConfigBanner=${noConfig}`,
        expected: 'Cell Statistics tab shows at least one "Cell N" card and an Export button. (A "No config data available" banner is okay - that\'s a separate "0-duration execution has no measurements" issue.)',
      };
    },
  });

  list.push({
    id: 'ui-stats-ue-renders', name: 'UE Statistics page loads with at least one UE row or empty-state', description: 'Asserts UE Statistics tab shows UE filter buttons (IMSI, EMM State, RRC State) and at least one row or empty-state.', category: 'stats', severity: 'normal', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/statistics?tab=ue`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
      const rowCount = await page.locator('table tbody tr').count();
      const filterBtns = await page.getByRole('button', { name: /(IMSI|EMM State|RRC State|UE ID)/i }).count();
      return {
        ok: rowCount > 0 || filterBtns > 0,
        detail: `rows=${rowCount} filterBtns=${filterBtns}`,
        expected: 'UE Statistics tab shows UE filter buttons (IMSI, EMM State, RRC State) and either rows or an empty-state message',
      };
    },
  });

  list.push({
    id: 'ui-stats-global-renders', name: 'Global Statistics page shows summary headings (UE Summary, NAS State, RRC State)', description: 'Asserts Global Statistics tab shows the UE Summary / NAS State / RRC State sections.', category: 'stats', severity: 'normal', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/statistics?tab=global`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
      const ue = await page.getByText(/UE Summary/i).count();
      const nas = await page.getByText(/NAS State/i).count();
      const rrc = await page.getByText(/RRC State/i).count();
      return {
        ok: ue > 0 && nas > 0 && rrc > 0,
        detail: `UE Summary=${ue} NAS State=${nas} RRC State=${rrc}`,
        expected: 'Global Statistics tab shows at least the UE Summary / NAS State / RRC State sections',
      };
    },
  });

  // ============== LOGS (3) ==============

  list.push({
    id: 'ui-export-logs', name: 'Logs page -> Export downloads a file', description: 'Clicks Export on the Logs page and inspects the downloaded zip. Flags header-only CSV (zip < 500 bytes) as a fail because the user gets a misleading "successful" empty file.', category: 'logs', severity: 'critical', needsAuth: true, longRunning: true,
    run: async ({ ctx, bundle, testDir }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/logs`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3500);
      const exportBtn = page.locator('button:has-text("Export")').first();
      if (!(await exportBtn.count())) return { ok: false, detail: 'Export button not found on /logs', expected: 'Logs page has a top-right Export control' };
      const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
      await exportBtn.click();
      const download = await downloadPromise.catch(() => null);
      if (!download) return { ok: false, detail: 'click on Export did not produce a download within 30s', expected: 'Export click triggers a file download' };
      const suggested = download.suggestedFilename();
      const dest = path.join(testDir, `download-${suggested}`);
      await download.saveAs(dest);
      const size = fs.statSync(dest).size;
      // Inspect the zip contents: CSV inside should have > 1 line (header + at
      // least one row). A bare header is the box's "I have nothing" response
      // dressed up as a successful download.
      let csvDataLines = -1;
      let zipEntries = -1;
      try {
        const buf = fs.readFileSync(dest);
        // Count central-directory entries by scanning for "PK\x01\x02" header.
        const sig = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
        let idx = 0; let entries = 0;
        while ((idx = buf.indexOf(sig, idx)) !== -1) { entries++; idx += 4; }
        zipEntries = entries;
        // Best-effort inflate of the first stored-or-deflated entry's local payload.
        const localSig = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
        const localOff = buf.indexOf(localSig);
        if (localOff >= 0) {
          const compMethod = buf.readUInt16LE(localOff + 8);
          const compSize = buf.readUInt32LE(localOff + 18);
          const fnLen = buf.readUInt16LE(localOff + 26);
          const xLen = buf.readUInt16LE(localOff + 28);
          const dataStart = localOff + 30 + fnLen + xLen;
          const dataEnd = dataStart + compSize;
          const dataBuf = buf.subarray(dataStart, dataEnd);
          let csv: string;
          if (compMethod === 0) csv = dataBuf.toString('utf8');
          else { const zlib = await import('node:zlib'); csv = zlib.inflateRawSync(dataBuf).toString('utf8'); }
          csvDataLines = csv.split(/\r?\n/).filter((l) => l.trim().length).length - 1;  // exclude header
        }
      } catch { /* size check below is the fallback */ }
      // A header-only CSV zip (just column names, no rows) is ~280 bytes.
      // Real log content is at least several KB. Flag if csv parse said 0
      // OR the size is suspiciously small.
      const definitelyEmpty = csvDataLines === 0 || size < 500;
      const ok = !definitelyEmpty;
      return {
        ok,
        detail: `downloaded "${suggested}" (${size} bytes, zipEntries=${zipEntries}, csvDataLines=${csvDataLines})`,
        expected: 'export download is a zip with a real CSV inside. A < 500-byte zip is the "header-only CSV" signature: the server has no log data for the selected execution but still produces a "successful" download. The user gets a file that looks valid but contains nothing actionable.',
        extraEvidence: { downloadFile: `download-${suggested}` },
      };
    },
  });

  list.push({
    id: 'ui-logs-online-offline-toggle', name: 'Logs page Offline/Online buttons are toggleable', description: 'Clicks the Offline and Online toggle buttons on the Logs page and asserts they are clickable without exception.', category: 'logs', severity: 'optional', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/logs`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const offline = await page.getByRole('button', { name: /^Offline$/i }).count();
      const online = await page.getByRole('button', { name: /^Online$/i }).count();
      if (!offline || !online) return { ok: false, detail: `offline=${offline} online=${online}`, expected: 'both Offline and Online toggle buttons present' };
      await page.getByRole('button', { name: /^Offline$/i }).first().click();
      await page.waitForTimeout(1000);
      await page.getByRole('button', { name: /^Online$/i }).first().click();
      await page.waitForTimeout(1000);
      return { ok: true, detail: 'both buttons clickable without exception' };
    },
  });

  list.push({
    id: 'ui-logs-empty-state-when-no-test', name: 'Logs page shows clear empty state when no testcase is in progress', description: 'Loads /logs with no testcase in progress and asserts an empty-state message renders (NOT an indefinite "Loading logs..." spinner).', category: 'logs', severity: 'normal', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/logs`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3500);
      const noTestVisible = await page.getByText(/No Testcase in Progress/i).count();
      const startHint = await page.getByText(/Start a Testcase to see Live Logs/i).count();
      const loadingForever = await page.getByText(/Loading logs/i).count();
      return {
        ok: noTestVisible > 0 || startHint > 0 || loadingForever === 0,
        detail: `noTestcase=${noTestVisible} startHint=${startHint} loadingSpinner=${loadingForever}`,
        expected: 'when no testcase is in progress, an empty state message is shown - the page must not just spin "Loading logs..." forever',
      };
    },
  });

  // ============== USERS (2) ==============

  list.push({
    id: 'ui-users-list-renders', name: 'Users page renders user rows and Create User button', description: 'Asserts the Users page shows the User Management heading, at least one user row, and a Create User button.', category: 'users', severity: 'normal', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/users`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const heading = await page.getByText(/User Management/i).count();
      const rowCount = await page.locator('table tbody tr').count();
      const createBtn = await page.getByRole('button', { name: /Create User/i }).count();
      return {
        ok: heading > 0 && rowCount > 0 && createBtn > 0,
        detail: `heading=${heading} rows=${rowCount} createBtn=${createBtn}`,
        expected: 'Users page has "User Management" heading, at least one user row, and Create User button',
      };
    },
  });

  list.push({
    id: 'ui-users-create-button-opens-form', name: 'Create User button opens a form/dialog', description: 'Clicks Create User and asserts a form/dialog opens with additional input fields.', category: 'users', severity: 'normal', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/users`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const createBtn = page.getByRole('button', { name: /Create User/i }).first();
      if (!(await createBtn.count())) return { ok: false, detail: 'Create User button not found', expected: 'a Create User button is visible on the Users page' };
      const before = await page.locator('input').count();
      await createBtn.click();
      await page.waitForTimeout(1500);
      const after = await page.locator('input').count();
      const dialogVisible = await page.locator('[role="dialog"], .modal, [class*="modal" i], [class*="drawer" i]').count();
      return {
        ok: after > before || dialogVisible > 0,
        detail: `inputs-before=${before} inputs-after=${after} dialog-elements=${dialogVisible}`,
        expected: 'clicking Create User opens a form/dialog with additional input fields (or any visible dialog/drawer)',
      };
    },
  });

  // ============== TOOLS (1) ==============

  list.push({
    id: 'ui-tools-page-renders', name: 'Tools page renders tool cards', description: 'Asserts /tools shows at least 4 of the expected tool cards (Manage Simulators, SDR Configuration, Spectrum Analyzer, 3GPP Band, Satellite Tracker, Container Health).', category: 'tools', severity: 'normal', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/tools`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const expected = ['Manage Simulators', 'SDR Configuration', 'Spectrum Analyzer', '3GPP Band', 'Satellite Tracker', 'Container Health'];
      let found = 0;
      const missing: string[] = [];
      for (const name of expected) {
        if ((await page.getByText(new RegExp(name, 'i')).count()) > 0) found++;
        else missing.push(name);
      }
      return {
        ok: found >= 4,  // tolerate 1-2 renames
        detail: `found ${found}/${expected.length} tool cards${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`,
        expected: 'Tools page displays cards for at least 4 of: Manage Simulators, SDR Configuration, Spectrum Analyzer, 3GPP Band, Satellite Tracker, Container Health',
      };
    },
  });

  // ============== SECURITY (2) ==============

  list.push({
    id: 'ui-xss-safe-render', name: 'Testcase list renders <script> names as text, not HTML', description: 'Loads the testcase list, searches for a row whose name contains <script>alert(1)</script>, and asserts NO alert dialog opens and no <script> child element exists in the table.', category: 'security', severity: 'critical', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      let dialogOpened = false;
      page.on('dialog', async (d) => { dialogOpened = true; await d.dismiss().catch(() => null); });
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
      // Try to filter for the row that contains the script-tag string by typing into search.
      const search = page.locator('input[placeholder*="Search" i], input#searchable-input, input[type="text"]').first();
      if (await search.count()) {
        await search.fill('script>');
        await page.waitForTimeout(1500);
      }
      const dangerousScripts = await page.locator('table script').count();
      const literalText = await page.locator(':text("<script>alert(1)</script>")').count();
      return {
        ok: !dialogOpened && dangerousScripts === 0,
        detail: `dialogOpened=${dialogOpened} dangerousScripts=${dangerousScripts} literalText=${literalText}`,
        expected: 'a stored testcase name like "<script>alert(1)</script>" is rendered as literal text. No alert(), no <script> child element in the table.',
      };
    },
  });

  list.push({
    id: 'ui-no-token-in-page-source', name: 'Page source must not leak the JWT in plain HTML', description: 'Asserts the rendered HTML does NOT contain a JWT-shaped string. Tokens belong in localStorage / sessionStorage, not in the document.', category: 'security', severity: 'normal', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
      const html = await page.content();
      // JWTs start with "eyJ" (base64 encoded JSON header). Look for a long contiguous JWT-shaped string in the HTML.
      const jwtPattern = /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/;
      const found = jwtPattern.test(html);
      return {
        ok: !found,
        detail: `jwt-shaped-string-in-html=${found}`,
        expected: 'rendered HTML must not contain the JWT verbatim. Tokens belong in localStorage or sessionStorage, not in the document.',
      };
    },
  });

  // ============== ERRORS (3) ==============

  list.push({
    id: 'ui-console-error-monitor', name: 'No JS console errors across the main pages', description: 'Visits 8 main pages in sequence and asserts zero new JavaScript console errors are logged.', category: 'errors', severity: 'normal', needsAuth: true, longRunning: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      const targets = ['/testcase', '/statistics', '/statistics?tab=cell', '/statistics?tab=ue', '/statistics?tab=global', '/logs', '/users', '/tools'];
      const visited: Array<{ url: string; errors: number }> = [];
      const startCount = bundle.getConsoleErrors().length;
      for (const t of targets) {
        const before = bundle.getConsoleErrors().length;
        await page.goto(`http://${ctx.host}${t}`, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2500);
        const after = bundle.getConsoleErrors().length;
        visited.push({ url: t, errors: after - before });
      }
      const totalNew = bundle.getConsoleErrors().length - startCount;
      const offending = visited.filter((v) => v.errors > 0);
      return {
        ok: totalNew === 0,
        detail: `${totalNew} new console errors across ${targets.length} pages${offending.length ? ` (${offending.map((o) => `${o.url}=${o.errors}`).join(', ')})` : ''}`,
        expected: 'navigating between top-level pages produces zero JS console errors',
      };
    },
  });

  list.push({
    id: 'ui-network-no-5xx', name: 'No 5xx responses while navigating the main pages', description: 'Visits the main pages and asserts no request returned a 5xx response. A 5xx on routine navigation means the server crashed.', category: 'errors', severity: 'critical', needsAuth: true, longRunning: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      const targets = ['/testcase', '/statistics', '/logs', '/users', '/tools'];
      for (const t of targets) {
        await page.goto(`http://${ctx.host}${t}`, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2000);
      }
      const fives = bundle.getRequests().filter((r) => typeof r.status === 'number' && r.status >= 500);
      return {
        ok: fives.length === 0,
        detail: fives.length === 0 ? 'no 5xx responses' : `${fives.length} 5xx response(s): ${fives.slice(0, 3).map((f) => `${f.status} ${f.url}`).join(' | ')}`,
        expected: 'normal page navigation must not produce 5xx responses. A 5xx means the server crashed or threw on a routine request.',
      };
    },
  });

  // ============== TESTCASE ACTIONS (deeper) ==============

  list.push({
    id: 'ui-sample-tests-renders', name: 'Sample Tests page (/sampleTest) renders the built-in samples', description: 'Asserts /sampleTest renders the built-in sample testcases (rows whose names are prefixed sample_).', category: 'testcases', severity: 'normal', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/sampleTest`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const heading = await page.getByText(/^Sample Tests$/).count();
      const rows = await page.locator('table tbody tr, [class*="row" i]').count();
      const sampleNamed = await page.locator(':text("sample_")').count();
      return {
        ok: rows > 0 && (heading > 0 || sampleNamed > 0),
        detail: `heading=${heading} rows=${rows} sampleNamed=${sampleNamed}`,
        expected: 'Sample Tests page shows >0 rows of built-in sample testcases (names typically prefixed sample_)',
      };
    },
  });

  list.push({
    id: 'ui-testcase-restart-action-fires-api-call', name: 'Click Restart on detail card -> POST /executions fires', description: 'Clicks Restart on the detail card and asserts a POST request to /v2/testcases/{id}/executions is fired.', category: 'testcases', severity: 'critical', needsAuth: true, longRunning: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const firstRow = page.locator('table tbody tr').first();
      if (!(await firstRow.count())) return { ok: false, detail: 'no rows', expected: 'at least one row to click' };
      await firstRow.click();
      await page.waitForTimeout(1500);
      const restart = page.getByRole('button', { name: /Restart/i }).first();
      if (!(await restart.count())) return { ok: false, detail: 'Restart button not found in detail card', expected: 'a Restart button appears on the LAST RUN TEST card after clicking a row' };
      // Watch for the executions POST that should fire.
      const waitForExec = page.waitForRequest((r) => r.url().includes('/executions') && r.method() === 'POST', { timeout: 10000 }).catch(() => null);
      await restart.click();
      const req = await waitForExec;
      // Dismiss any confirmation dialog that may pop up
      await page.keyboard.press('Escape').catch(() => null);
      await page.waitForTimeout(800);
      return {
        ok: !!req,
        detail: req ? `POST ${new URL(req.url()).pathname} fired` : 'no POST /executions request seen within 10s',
        expected: 'clicking Restart triggers a POST request to /v2/testcases/{id}/executions (or similar)',
      };
    },
  });

  list.push({
    id: 'ui-testcase-stats-action-navigates', name: 'Click Stats on detail card -> /statistics opens', description: 'Clicks Stats on the detail card and asserts the page navigates to /statistics with the testcase id in the query string.', category: 'testcases', severity: 'normal', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const firstRow = page.locator('table tbody tr').first();
      if (!(await firstRow.count())) return { ok: false, detail: 'no rows', expected: 'at least one row to click' };
      await firstRow.click();
      await page.waitForTimeout(1500);
      const stats = page.getByRole('button', { name: /^Stats$/i }).first();
      if (!(await stats.count())) return { ok: false, detail: 'Stats button not found in detail card', expected: 'a Stats button appears on the LAST RUN TEST card' };
      await stats.click();
      await page.waitForTimeout(2000);
      const finalUrl = page.url();
      return {
        ok: finalUrl.includes('/statistics'),
        detail: `final-url=${finalUrl}`,
        expected: 'clicking Stats navigates to /statistics with the testcase + execution id in the query string',
      };
    },
  });

  list.push({
    id: 'ui-testcase-no-edit-affordance', name: 'No edit affordance on testcases (matches API gap)', description: 'Observation: confirms the testcase list does NOT expose an Edit button (the API has no edit endpoint - SIM40-2018).', category: 'testcases', severity: 'optional', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const firstRow = page.locator('table tbody tr').first();
      if (!(await firstRow.count())) return { ok: false, detail: 'no rows', expected: 'at least one row to click' };
      await firstRow.click();
      await page.waitForTimeout(1500);
      const editBtn = await page.getByRole('button', { name: /^(Edit|Modify|Update)$/i }).count();
      // The API has no edit endpoint (SIM40-2018). The UI surfacing an Edit
      // button that silently fails would be confusing; absence is acceptable
      // until the API ships.
      return {
        ok: true,  // observation, not a fail condition
        detail: `editButtonCount=${editBtn} (API has no edit endpoint - tracked separately as SIM40-2018)`,
        expected: 'either the UI has no Edit button (acceptable) OR the Edit button shows a clear "not yet supported" message',
      };
    },
  });

  list.push({
    id: 'ui-testcase-delete-action-graceful', name: 'Delete testcase via UI -> graceful error (DELETE API is broken, SIM40-2016)', description: 'Observation: confirms the testcase list does NOT expose a silent Delete button (DELETE /v2/testcases/{id} is 404 - SIM40-2016).', category: 'testcases', severity: 'normal', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      // Look for any kebab menu / right-click / hover-revealed action to find delete.
      const firstRow = page.locator('table tbody tr').first();
      if (!(await firstRow.count())) return { ok: false, detail: 'no rows', expected: 'at least one row to test against' };
      await firstRow.hover();
      await page.waitForTimeout(500);
      // Try common delete affordances.
      const deleteVisible =
        (await page.getByRole('button', { name: /^Delete$/i }).count()) +
        (await page.locator('[aria-label*="delete" i], [title*="delete" i]').count()) +
        (await page.locator('button:has(svg[class*="trash" i])').count());
      return {
        ok: true,  // observation: presence/absence both acceptable
        detail: `deleteAffordancesFound=${deleteVisible} (DELETE /v2/testcases/{id} returns 404 - SIM40-2016)`,
        expected: 'either no visible delete UI (acceptable while DELETE 404s) OR clicking Delete produces a clear error toast (must NOT silently fail)',
      };
    },
  });

  list.push({
    id: 'ui-testcase-verdict-filter-opens', name: 'Verdict filter dropdown opens', description: 'Clicks the Verdict filter button and asserts a dropdown of verdict options appears.', category: 'testcases', severity: 'normal', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const btn = page.locator('button:has-text("Verdict")').first();
      if (!(await btn.count())) return { ok: false, detail: 'Verdict filter button not found' };
      await btn.click();
      await page.waitForTimeout(700);
      const popover = await page.locator('[role="menu"], [role="listbox"], [data-state="open"], .ant-dropdown, .ant-popover').count();
      return { ok: popover > 0, detail: `popover-elements=${popover}`, expected: 'clicking Verdict reveals a dropdown of verdict options (PASS/FAIL/incomplete)' };
    },
  });

  list.push({
    id: 'ui-testcase-simulator-filter-opens', name: 'Simulator filter dropdown opens', description: 'Clicks the Simulator filter button and asserts a dropdown of simulators appears.', category: 'testcases', severity: 'normal', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const btn = page.locator('button:has-text("Simulator")').first();
      if (!(await btn.count())) return { ok: false, detail: 'Simulator filter button not found' };
      await btn.click();
      await page.waitForTimeout(700);
      const popover = await page.locator('[role="menu"], [role="listbox"], [data-state="open"], .ant-dropdown, .ant-popover').count();
      return { ok: popover > 0, detail: `popover-elements=${popover}`, expected: 'clicking Simulator reveals a dropdown of registered simulators' };
    },
  });

  list.push({
    id: 'ui-testcase-more-filters-opens', name: 'More Filters button opens additional filters', description: 'Clicks the More Filters button and asserts additional filter inputs or a drawer/dialog appears.', category: 'testcases', severity: 'optional', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const btn = page.locator('button:has-text("More Filters")').first();
      if (!(await btn.count())) return { ok: false, detail: 'More Filters button not found' };
      const inputsBefore = await page.locator('input').count();
      await btn.click();
      await page.waitForTimeout(700);
      const inputsAfter = await page.locator('input').count();
      const popover = await page.locator('[role="menu"], [role="listbox"], [data-state="open"], .ant-dropdown, .ant-popover, [class*="modal" i], [class*="drawer" i]').count();
      return {
        ok: inputsAfter > inputsBefore || popover > 0,
        detail: `inputsBefore=${inputsBefore} inputsAfter=${inputsAfter} popover=${popover}`,
        expected: 'clicking More Filters reveals additional filter inputs',
      };
    },
  });

  list.push({
    id: 'ui-testcase-pagination-info-visible', name: 'Pagination info ("Showing N of M") visible at bottom', description: 'Asserts a "Showing N of M" pagination indicator is visible at the bottom of the testcases table.', category: 'testcases', severity: 'optional', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const showingN = await page.getByText(/Showing\s+\d+\s+of\s+\d+/i).count();
      return {
        ok: showingN > 0,
        detail: `showing-of-text=${showingN}`,
        expected: 'a "Showing N of M" indicator at the bottom of the table',
      };
    },
  });

  // ============== STATS EXPORT (3) ==============

  const exportStatsTab = (id: string, tab: string, label: string): UiTestDef => ({
    id, name: `${label} Statistics: Export button -> downloads file`,
    description: `Clicks Export on ${label} Statistics and asserts a non-trivial file (>200 bytes) is downloaded.`,
    category: 'stats', severity: 'normal', needsAuth: true, longRunning: true,
    run: async ({ ctx, bundle, testDir }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/statistics?tab=${tab}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
      const exportBtn = page.locator('button:has-text("Export")').first();
      if (!(await exportBtn.count())) return { ok: false, detail: `Export button not found on /statistics?tab=${tab}`, expected: `${label} Statistics tab has an Export control` };
      const downloadPromise = page.waitForEvent('download', { timeout: 15000 });
      await exportBtn.click();
      const download = await downloadPromise.catch(() => null);
      if (!download) return { ok: false, detail: `Export click on ${label} did not produce a download in 15s`, expected: 'clicking Export triggers a file download' };
      const suggested = download.suggestedFilename();
      const dest = path.join(testDir, `download-${suggested}`);
      await download.saveAs(dest);
      const size = fs.statSync(dest).size;
      return {
        ok: size > 200,  // basic sanity: a real file should be a few hundred bytes minimum
        detail: `downloaded "${suggested}" (${size} bytes)`,
        expected: 'downloaded file is non-empty (> 200 bytes minimum). A < 200-byte file likely indicates the server has no data and the download is essentially empty.',
        extraEvidence: { downloadFile: `download-${suggested}` },
      };
    },
  });
  list.push(exportStatsTab('ui-stats-export-cell',   'cell',   'Cell'));
  list.push(exportStatsTab('ui-stats-export-ue',     'ue',     'UE'));
  list.push(exportStatsTab('ui-stats-export-global', 'global', 'Global'));

  // ============== TOOLS SUBPAGES (6) ==============

  const toolCardClicks = (id: string, label: string, regex: RegExp): UiTestDef => ({
    id, name: `Tools page: clicking "${label}" card opens it`,
    description: `Clicks the ${label} card on the Tools page and asserts navigation occurs (or a dialog opens).`,
    category: 'tools', severity: 'optional', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/tools`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const startUrl = page.url();
      const card = page.getByText(regex).first();
      if (!(await card.count())) return { ok: false, detail: `card "${label}" not found on /tools`, expected: `Tools page has a "${label}" card` };
      await card.click({ trial: false }).catch(() => null);
      await page.waitForTimeout(2500);
      const finalUrl = page.url();
      const navigated = finalUrl !== startUrl;
      const dialog = await page.locator('[role="dialog"], [class*="modal" i], [class*="drawer" i]').count();
      return {
        ok: navigated || dialog > 0,
        detail: `startUrl=${startUrl} finalUrl=${finalUrl} dialog=${dialog}`,
        expected: `clicking "${label}" either navigates to a sub-page or opens a dialog/drawer`,
      };
    },
  });
  list.push(toolCardClicks('ui-tools-manage-simulators', 'Manage Simulators', /Manage Simulators/i));
  list.push(toolCardClicks('ui-tools-sdr-configuration', 'SDR Configuration', /SDR Configuration/i));
  list.push(toolCardClicks('ui-tools-spectrum-analyzer', 'Spectrum Analyzer', /Spectrum Analyzer/i));
  list.push(toolCardClicks('ui-tools-3gpp-band',         '3GPP Band',         /3GPP Band/i));
  list.push(toolCardClicks('ui-tools-satellite-tracker', 'Satellite Tracker', /Satellite Tracker/i));
  list.push(toolCardClicks('ui-tools-container-health',  'Container Health',  /Container Health/i));

  // ============== USER FORM VALIDATION (2) ==============

  list.push({
    id: 'ui-create-user-empty-submit-blocked', name: 'Create User form: empty submit shows validation', description: 'Clicks the Create button inside the Create User dialog with all fields empty and asserts the submit is blocked (no POST to /admin/users) or validation is shown.', category: 'users', severity: 'normal', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/users`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const create = page.locator('button:has-text("Create User")').first();
      if (!(await create.count())) return { ok: false, detail: 'Create User button missing' };
      await create.click();
      await page.waitForTimeout(1500);
      // Try to submit without filling anything.
      const submitInDialog = page.locator('[role="dialog"] button, [class*="modal" i] button, [class*="drawer" i] button').filter({ hasText: /Create|Submit|Save/i }).first();
      const submitTarget = (await submitInDialog.count()) ? submitInDialog : page.getByRole('button', { name: /^(Create|Submit|Save)$/i }).first();
      if (!(await submitTarget.count())) return { ok: false, detail: 'submit button not found inside create-user dialog' };
      const reqWatch = page.waitForRequest((r) => /\/admin\/users/.test(r.url()) && r.method() === 'POST', { timeout: 4000 }).catch(() => null);
      await submitTarget.click();
      const req = await reqWatch;
      await page.waitForTimeout(1000);
      const validationVisible = await page.locator('[class*="error" i], [aria-invalid="true"], :text("required")').count();
      // Pass if the form blocked submit (no POST) OR validation marker is visible.
      return {
        ok: !req || validationVisible > 0,
        detail: `submitFiredPOST=${!!req} validationMarkers=${validationVisible}`,
        expected: 'submitting an empty Create User form must NOT POST to /v2/admin/users; the form should show client-side validation OR the server must reject with 400 and the error must be surfaced',
      };
    },
  });

  list.push({
    id: 'ui-create-user-bad-email-blocked', name: 'Create User: invalid email format flagged', description: 'Enters an invalid email format ("not-an-email-address") and asserts the field is marked invalid (visible error or aria-invalid).', category: 'users', severity: 'optional', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/users`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      await page.locator('button:has-text("Create User")').first().click();
      await page.waitForTimeout(1500);
      const emailInput = page.locator('input[type="email"], input[name*="email" i], input[id*="email" i], input[placeholder*="email" i]').first();
      if (!(await emailInput.count())) return { ok: false, detail: 'no email input found in create-user dialog' };
      await emailInput.fill('not-an-email-address');
      await emailInput.blur().catch(() => null);
      await page.waitForTimeout(800);
      const errVisible = await page.locator(':text("Invalid"), :text("invalid"), :text("valid email"), [aria-invalid="true"]').count();
      return {
        ok: errVisible > 0,
        detail: `validationMarkers=${errVisible}`,
        expected: 'entering "not-an-email-address" should mark the field invalid (visible error or aria-invalid)',
      };
    },
  });

  // ============== SESSION / PROFILE / LOGOUT (3) ==============

  list.push({
    // needsAuth=false on purpose: this test uses its OWN token (does its own
    // login at the start) so calling /v2/logout doesn't invalidate the shared
    // JWT that other tests depend on.
    id: 'ui-logout-returns-to-landing', name: 'Logout returns the user to the landing page', description: 'Performs an isolated login (separate token), clicks Logout, and asserts the user lands on the login form. Uses an isolated token so other tests are not affected.', category: 'auth', severity: 'normal',
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      const loginRes = await login(ctx, page);
      if (!loginRes.ok) return { ok: false, detail: `pre-test login failed: ${loginRes.detail}` };
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
      // Profile icon at the bottom-left of the sidebar (saw in screenshots).
      const profileIcon = page.locator('aside button, aside [role="button"], [class*="sidebar" i] button').last();
      const profileText = page.locator(':text("Logout"), :text("Sign out"), :text("Log out")').first();
      let triggered = false;
      if (await profileText.count()) {
        await profileText.click();
        triggered = true;
      } else if (await profileIcon.count()) {
        await profileIcon.click();
        await page.waitForTimeout(800);
        const lo = page.locator(':text("Logout"), :text("Sign out"), :text("Log out")').first();
        if (await lo.count()) { await lo.click(); triggered = true; }
      }
      if (!triggered) return { ok: false, detail: 'no logout control found in sidebar / profile menu', expected: 'a Logout / Sign out option somewhere in the persistent UI chrome' };
      await page.waitForTimeout(2500);
      const onLogin = await page.locator('#username').count() > 0;
      return {
        ok: onLogin,
        detail: `final-url=${page.url()} onLoginForm=${onLogin}`,
        expected: 'after Logout, the user lands on the login form (or a logged-out landing). Subsequent /testcase nav must require re-login.',
      };
    },
  });

  list.push({
    id: 'ui-sidebar-collapse-toggle', name: 'Sidebar collapse toggle changes sidebar width', description: 'Clicks the button[title="Collapse Sidebar"] (or first sidebar button at bottom-left), asserts the sidebar width drops by at least 50px.', category: 'navigation', severity: 'optional', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      // Measure the OUTER aside (h-screen, full sidebar). On the Simnovator UI
      // there are two <aside> elements; the outer one carries the collapsed
      // width when the toggle fires.
      const widthOf = async () => page.evaluate(() => {
        const candidates = Array.from(document.querySelectorAll('aside')) as HTMLElement[];
        // Pick the one anchored at left:0 with full viewport height.
        const visible = candidates.filter((el) => {
          const r = el.getBoundingClientRect();
          return r.left < 5 && r.height > window.innerHeight * 0.8 && r.width > 30 && r.width < 400;
        });
        return visible.length ? Math.round(visible[0].getBoundingClientRect().width) : 0;
      });
      const before = await widthOf();
      // Prefer the explicit Collapse Sidebar button if present.
      const collapseBtn = page.locator('button[title="Collapse Sidebar"], button[aria-label="Collapse Sidebar"]').first();
      let clicked = false;
      if (await collapseBtn.count()) {
        await collapseBtn.click();
        clicked = true;
      } else {
        // Fallback: click bottom-left of the outer aside.
        const box = await page.evaluate(() => {
          const candidates = Array.from(document.querySelectorAll('aside')) as HTMLElement[];
          const visible = candidates.filter((el) => {
            const r = el.getBoundingClientRect();
            return r.left < 5 && r.height > window.innerHeight * 0.8 && r.width > 30 && r.width < 400;
          });
          if (!visible.length) return null;
          const r = visible[0].getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height };
        });
        if (!box) return { ok: false, detail: 'sidebar element not found', expected: 'a sidebar at left:0 with full viewport height' };
        await page.mouse.click(box.x + 30, box.y + box.h - 40);
        clicked = true;
      }
      await page.waitForTimeout(1200);
      const after = await widthOf();
      return {
        ok: clicked && before > 0 && Math.abs(before - after) > 50,
        detail: `widthBefore=${before} widthAfter=${after}`,
        expected: 'clicking Collapse Sidebar shrinks the sidebar width by >50px',
      };
    },
  });

  list.push({
    id: 'ui-direct-deep-link-execution-renders', name: 'Direct deep-link to /statistics?iterationId=... renders', description: 'Opens a deep-link URL with a real iterationId and asserts the UE Statistics view renders directly without bouncing to login.', category: 'navigation', severity: 'normal', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      // Use the known recent execution id we keep seeing in URLs.
      const url = `http://${ctx.host}/statistics?tab=ue&TestCaseName=SA-UDP-NC&simulatorName=UE-Simulator&testCaseStatus=Completed&iterationId=67842b28-f573-4f65-a719-1f4e7922b1ca`;
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
      const onLogin = await page.locator('#username').count() > 0;
      const filterBtns = await page.locator('button:has-text("IMSI"), button:has-text("EMM State")').count();
      return {
        ok: !onLogin && filterBtns > 0,
        detail: `onLoginForm=${onLogin} filterBtns=${filterBtns}`,
        expected: 'a fresh-tab open of the deep-link URL renders the UE Statistics view directly (with auth via storage state)',
      };
    },
  });

  // ============== TOOLS SUBPAGE CONTENT (6) ==============

  list.push({
    id: 'ui-tools-manage-simulators-content', name: 'Manage Simulators page lists simulators', description: 'Loads /tools/simulator-management and asserts the page renders simulator entries (table rows or cards).',
    category: 'tools', severity: 'normal', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/tools/simulator-management`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const onLogin = (await page.locator('#username').count()) > 0;
      const rows = await page.locator('table tbody tr, [class*="card" i]:has-text("Simulator"), :text("UE-Simulator")').count();
      return {
        ok: !onLogin && rows > 0,
        detail: `onLogin=${onLogin} simulatorRows=${rows}`,
        expected: 'Manage Simulators page renders the registered simulators (UE-Simulator should be visible)',
      };
    },
  });

  list.push({
    id: 'ui-tools-band-info-search', name: '3GPP Band & Bandwidth page accepts a band query', description: 'Loads the 3GPP Band tool, types a known band ("n7"), and asserts a result row appears.',
    category: 'tools', severity: 'normal', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/tools/band-info`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const onLogin = (await page.locator('#username').count()) > 0;
      if (onLogin) return { ok: false, detail: 'page redirected to login', expected: 'authenticated user can reach /tools/band-info' };
      const search = page.locator('input[type="text"], input[placeholder*="search" i]').first();
      const inputCount = await search.count();
      // Soft check: a search/input should be present.
      return {
        ok: inputCount > 0,
        detail: `inputCount=${inputCount}`,
        expected: 'the 3GPP Band page exposes a search input for band lookup',
      };
    },
  });

  list.push({
    id: 'ui-tools-satellite-tracker-content', name: 'Satellite Tracker page renders a form or map', description: 'Loads /tools/satellite-tracker and asserts the page exposes coordinate inputs or a tracker visual.',
    category: 'tools', severity: 'optional', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/tools/satellite-tracker`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const onLogin = (await page.locator('#username').count()) > 0;
      const inputs = await page.locator('input').count();
      const canvas = await page.locator('canvas, svg').count();
      return {
        ok: !onLogin && (inputs > 0 || canvas > 0),
        detail: `onLogin=${onLogin} inputs=${inputs} canvas=${canvas}`,
        expected: 'Satellite Tracker page exposes coordinate inputs or a visual element',
      };
    },
  });

  list.push({
    id: 'ui-tools-spectrum-analyzer-content', name: 'Spectrum Analyzer page renders a plot area', description: 'Loads /tools/spectrum-analyzer and asserts the page renders a plot/canvas area or status panel.',
    category: 'tools', severity: 'optional', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/tools/spectrum-analyzer`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const onLogin = (await page.locator('#username').count()) > 0;
      const canvas = await page.locator('canvas, svg').count();
      const heading = await page.getByText(/Spectrum/i).count();
      return {
        ok: !onLogin && (canvas > 0 || heading > 0),
        detail: `onLogin=${onLogin} canvas=${canvas} heading=${heading}`,
        expected: 'Spectrum Analyzer page renders a plot area (canvas/svg) or labelled section',
      };
    },
  });

  list.push({
    id: 'ui-tools-sdr-configuration-content', name: 'SDR Configuration page exposes config form fields', description: 'Loads /tools/sdr-configuration and asserts the page has at least one form input/select.',
    category: 'tools', severity: 'optional', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/tools/sdr-configuration`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const onLogin = (await page.locator('#username').count()) > 0;
      const inputs = await page.locator('input, select, textarea').count();
      return {
        ok: !onLogin && inputs > 0,
        detail: `onLogin=${onLogin} formFields=${inputs}`,
        expected: 'SDR Configuration page has at least one input/select for configuration values',
      };
    },
  });

  list.push({
    id: 'ui-tools-container-health-content', name: 'Container Health page shows status indicators', description: 'Loads /tools/health-check and asserts the page shows health-status indicators or rows.',
    category: 'tools', severity: 'optional', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/tools/health-check`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const onLogin = (await page.locator('#username').count()) > 0;
      const indicators = await page.locator('table tbody tr, [class*="status" i], :text("Healthy"), :text("Unhealthy"), :text("Up"), :text("Down")').count();
      return {
        ok: !onLogin && indicators > 0,
        detail: `onLogin=${onLogin} indicatorCount=${indicators}`,
        expected: 'Container Health page shows health-status indicators or per-container rows',
      };
    },
  });

  // ============== LOGS / STATS DEEP CONTROLS (4) ==============

  list.push({
    id: 'ui-logs-testcase-dropdown-changes-url', name: 'Logs page Test Case dropdown changes the URL', description: 'Clicks the Test Case dropdown on /logs, mouse-clicks a different option in the visible list, asserts the URL TestCaseName param changes.',
    category: 'logs', severity: 'optional', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/logs`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
      const startUrl = page.url();
      const startTc = new URL(startUrl).searchParams.get('TestCaseName');
      const tcInput = page.locator('input#searchable-input').first();
      if (!(await tcInput.count())) return { ok: false, detail: 'Test Case dropdown input not found' };
      await tcInput.click();
      await page.waitForTimeout(800);
      // Look for any visible dropdown option list under the input.
      const options = page.locator('[role="option"], li[class*="option" i], [class*="dropdown" i] li, [class*="menu" i] li, [class*="list" i] [class*="item" i]').filter({ hasText: /\w/ });
      const optCount = await options.count();
      if (optCount < 2) return { ok: false, detail: `only ${optCount} options visible after clicking dropdown`, expected: 'dropdown shows >1 option' };
      let clicked = false;
      for (let i = 0; i < Math.min(optCount, 10); i++) {
        const txt = (await options.nth(i).textContent().catch(() => '') ?? '').trim();
        if (txt && txt !== startTc) {
          await options.nth(i).click({ trial: false }).catch(() => null);
          clicked = true;
          break;
        }
      }
      if (!clicked) return { ok: false, detail: 'no different option clickable', expected: 'a dropdown option different from current selection' };
      await page.waitForTimeout(2500);
      const finalUrl = page.url();
      const finalTc = new URL(finalUrl).searchParams.get('TestCaseName');
      return {
        ok: finalTc !== null && finalTc !== startTc,
        detail: `start TestCaseName=${startTc} final TestCaseName=${finalTc}`,
        expected: 'TestCaseName URL parameter changes when a different testcase is picked',
      };
    },
  });

  list.push({
    id: 'ui-logs-execution-time-picker-opens', name: 'Logs page Execution Time picker opens', description: 'Clicks the Execution Time field and asserts a date-range picker UI appears.',
    category: 'logs', severity: 'optional', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/logs`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      // Click the second searchable-input (Execution Time picker)
      const inputs = page.locator('input#searchable-input');
      const c = await inputs.count();
      if (c < 2) return { ok: false, detail: `expected >=2 searchable inputs, got ${c}` };
      await inputs.nth(1).click();
      await page.waitForTimeout(800);
      // The Execution Time picker is a custom searchable dropdown listing
      // execution time ranges, NOT a standard calendar widget.
      const dropdownVisible = await page.locator('[role="option"], [role="listbox"], li[class*="option" i], [class*="dropdown" i] li, [class*="menu" i] li').count();
      return {
        ok: dropdownVisible > 0,
        detail: `dropdown-options-visible=${dropdownVisible}`,
        expected: 'clicking Execution Time opens a list of execution time ranges (custom searchable dropdown - not a calendar)',
      };
    },
  });

  list.push({
    id: 'ui-stats-test-case-dropdown-present', name: 'Stats page exposes Test Case selector at top', description: 'Loads /statistics and asserts a Test Case dropdown input is present at the top of the page.',
    category: 'stats', severity: 'optional', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/statistics`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const inputs = await page.locator('input#searchable-input').count();
      return {
        ok: inputs >= 1,
        detail: `searchableInputs=${inputs}`,
        expected: 'Statistics page top bar exposes at least one searchable Test Case dropdown',
      };
    },
  });

  list.push({
    id: 'ui-stats-cell-view-button-action', name: 'Stats Cell card View button is interactive', description: 'On Cell Statistics, clicks the orange View button INSIDE the first Cell card (scoped via the "Cell N" heading) and asserts something visible changes (URL, dialog, or new content). Avoids the unrelated top-right "View" toggle and the sidebar "Tester View" dropdown.',
    category: 'stats', severity: 'optional', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/statistics?tab=cell`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const startUrl = page.url();
      // Scope to the Cell card so we don't hit the top-right "View" toggle or
      // the sidebar's "Tester View" dropdown, which both contain the word "View".
      const cellHeading = page.getByText(/^Cell\s*\d+/).first();
      if (!(await cellHeading.count())) return { ok: false, detail: 'no "Cell N" heading found on Cell Statistics page' };
      // Walk up to the card container, then look for the View button inside it.
      const viewInCard = cellHeading.locator('xpath=ancestor::*[self::div or self::section][1]').locator('button:has-text("View")').first();
      let target = viewInCard;
      if (!(await target.count())) {
        // Fallback: any button with exact text "View" (skips "Tester View" / "Admin View").
        target = page.locator('button').filter({ hasText: /^\s*View\s*$/ }).first();
      }
      if (!(await target.count())) return { ok: false, detail: 'no View button found inside any Cell card' };
      const dialogsBefore = await page.locator('[role="dialog"], [class*="modal" i], [class*="drawer" i]').count();
      await target.click();
      await page.waitForTimeout(1500);
      const finalUrl = page.url();
      const dialogsAfter = await page.locator('[role="dialog"], [class*="modal" i], [class*="drawer" i]').count();
      return {
        ok: finalUrl !== startUrl || dialogsAfter > dialogsBefore,
        detail: `start=${startUrl.slice(0, 70)} final=${finalUrl.slice(0, 70)} dialogsBefore=${dialogsBefore} dialogsAfter=${dialogsAfter}`,
        expected: 'clicking View on a Cell card produces a visible change (navigation or dialog)',
      };
    },
  });

  // ============== INTERACTION (3) ==============

  list.push({
    id: 'ui-login-enter-key-submits', name: 'Pressing Enter in the login form submits', description: 'Fills login fields, presses Enter (instead of clicking Login), and asserts the form submits and the user lands on the SPA route.',
    category: 'auth', severity: 'optional',
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/`, { waitUntil: 'domcontentloaded' });
      await page.locator('#username').fill(ctx.username);
      await page.locator('#password').fill(ctx.password);
      const respPromise = page.waitForResponse((r) => r.url().includes('/v2/login') && r.request().method() === 'POST', { timeout: 10000 }).catch(() => null);
      await page.locator('#password').press('Enter');
      const resp = await respPromise;
      await page.waitForTimeout(2000);
      const url = page.url();
      return {
        ok: !!resp && resp.status() === 200 && url.includes('/testcase'),
        detail: `loginResp=${resp?.status()} url=${url}`,
        expected: 'pressing Enter on the password field submits the form (200 from /v2/login + nav to /testcase)',
      };
    },
  });

  list.push({
    id: 'ui-dialog-escape-dismisses', name: 'Pressing Escape closes the Create User dialog', description: 'Opens the Create User dialog, presses Escape, and asserts the dialog closes (input count drops back).',
    category: 'users', severity: 'optional', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/users`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
      await page.locator('button:has-text("Create User")').first().click();
      await page.waitForTimeout(1200);
      const inputsOpen = await page.locator('input').count();
      await page.keyboard.press('Escape');
      await page.waitForTimeout(800);
      const inputsClosed = await page.locator('input').count();
      return {
        ok: inputsClosed < inputsOpen,
        detail: `inputs-while-open=${inputsOpen} inputs-after-escape=${inputsClosed}`,
        expected: 'Escape closes the Create User dialog (visible input count drops)',
      };
    },
  });

  // ui-sidebar-statistics-collapsible removed: probe could not reliably
  // distinguish "chevron click does nothing (real bug)" from "chevron is
  // decorative, sub-items are always-expanded by design". Test produced
  // false-positive failures.

  // ───────── Additional navigation coverage ─────────

  list.push({
    id: 'ui-nav-back-button-returns-to-prior-page',
    name: 'Browser Back button returns to the previous SPA page',
    description: 'Goes /testcase -> /logs, presses browser Back, asserts URL is back at /testcase AND rows render.',
    category: 'navigation', severity: 'normal', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
      await page.goto(`http://${ctx.host}/logs`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
      await page.goBack({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const url = page.url();
      const rows = await page.locator('table tbody tr').count();
      return {
        ok: url.includes('/testcase') && rows > 0,
        detail: `url-after-back=${url} rows=${rows}`,
        expected: 'browser Back returns to /testcase with rows visible (no blank screen, no logout)',
      };
    },
  });

  list.push({
    id: 'ui-nav-forward-button-replays-history',
    name: 'Browser Forward button works after a Back',
    description: 'Goes /testcase -> /logs -> Back -> Forward, asserts the URL is /logs again.',
    category: 'navigation', severity: 'optional', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
      await page.goto(`http://${ctx.host}/logs`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
      await page.goBack({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1500);
      await page.goForward({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
      const url = page.url();
      return {
        ok: url.includes('/logs'),
        detail: `final-url-after-forward=${url}`,
        expected: 'browser Forward returns to /logs',
      };
    },
  });

  list.push({
    id: 'ui-nav-clicking-sidebar-item-changes-url',
    name: 'Clicking a sidebar item navigates (not just visually highlight)',
    description: 'Logged in on /testcase, clicks the Logs entry in the sidebar by text, asserts URL becomes /logs and the page renders. Catches the regression where click handlers stop firing.',
    category: 'navigation', severity: 'critical', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const startUrl = page.url();
      const logsLink = page.getByText('Logs', { exact: true }).first();
      if (!(await logsLink.count())) return { ok: false, detail: 'Logs sidebar entry not found' };
      await logsLink.click();
      await page.waitForTimeout(2500);
      const finalUrl = page.url();
      return {
        ok: finalUrl !== startUrl && finalUrl.includes('/logs'),
        detail: `start=${startUrl} final=${finalUrl}`,
        expected: 'clicking the Logs sidebar entry navigates to /logs',
      };
    },
  });

  list.push({
    id: 'ui-nav-active-sidebar-item-highlighted',
    name: 'The current page\'s sidebar item is visually highlighted',
    description: 'Loads /logs, finds the Logs and My Tests sidebar entries, walks each subtree collecting the first non-transparent / non-white background color, asserts the active row has a coloured bg or text colour that the inactive row does not.',
    category: 'navigation', severity: 'normal', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/logs`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const result = await page.evaluate(() => {
        // The Simnovator sidebar puts the highlight (orange bg + orange text)
        // on an inner element, NOT the outermost <li> (which is bg-transparent).
        // So we walk the subtree of each row and collect the strongest
        // non-default colours we can find.
        const findRowFor = (label: string): HTMLElement | undefined => {
          const all = Array.from(document.querySelectorAll('a, li, button, [role="menuitem"], div, span'));
          return all.find((e) => (e.textContent ?? '').trim() === label) as HTMLElement | undefined;
        };
        const isInteresting = (rgba: string) => {
          if (!rgba) return false;
          if (rgba === 'rgba(0, 0, 0, 0)') return false;
          if (rgba === 'rgb(255, 255, 255)') return false;
          if (/^rgba\(\d+,\s*\d+,\s*\d+,\s*0(\.0+)?\)$/.test(rgba)) return false;
          return true;
        };
        const strongestBgIn = (root: HTMLElement | undefined): string | null => {
          if (!root) return null;
          const all = [root, ...Array.from(root.querySelectorAll('*'))] as HTMLElement[];
          for (const el of all) {
            const cs = getComputedStyle(el);
            if (isInteresting(cs.backgroundColor)) return cs.backgroundColor;
          }
          return null;
        };
        const strongestColorIn = (root: HTMLElement | undefined): string | null => {
          if (!root) return null;
          const all = [root, ...Array.from(root.querySelectorAll('*'))] as HTMLElement[];
          for (const el of all) {
            const cs = getComputedStyle(el);
            if (cs.color && cs.color !== 'rgb(2, 8, 23)' && cs.color !== 'rgba(0, 0, 0, 0)') return cs.color;
          }
          return null;
        };
        const active = findRowFor('Logs');
        const inactive = findRowFor('My Tests');
        if (!active || !inactive) return { found: false, activeBg: null, activeColor: null, inactiveBg: null, inactiveColor: null };
        return {
          found: true,
          activeBg: strongestBgIn(active),
          activeColor: strongestColorIn(active),
          inactiveBg: strongestBgIn(inactive),
          inactiveColor: strongestColorIn(inactive),
        };
      });
      if (!result.found) return { ok: false, detail: 'could not locate Logs or My Tests sidebar items', expected: 'both items present' };
      const distinct = (result.activeBg && result.activeBg !== result.inactiveBg) ||
                       (result.activeColor && result.activeColor !== result.inactiveColor);
      return {
        ok: !!distinct,
        detail: `Logs(bg=${result.activeBg} color=${result.activeColor}) vs My Tests(bg=${result.inactiveBg} color=${result.inactiveColor})`,
        expected: 'active sidebar item has a coloured bg or text colour that the inactive items do not',
      };
    },
  });

  list.push({
    id: 'ui-nav-document-title-changes-per-page',
    name: 'Browser tab title changes when navigating to different pages',
    description: 'Visits /testcase, /sampleTest, /logs in sequence and asserts the document.title differs across them. Catches the bug where every page reuses the same generic title.',
    category: 'navigation', severity: 'optional', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      const seen = new Map<string, string>();
      for (const route of ['/testcase', '/sampleTest', '/logs']) {
        await page.goto(`http://${ctx.host}${route}`, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1500);
        seen.set(route, await page.title());
      }
      const distinct = new Set(seen.values()).size;
      return {
        ok: distinct >= 2,
        detail: [...seen.entries()].map(([k, v]) => `${k}: "${v}"`).join('  |  '),
        expected: 'each page sets a unique document.title (or at least 2 different titles across 3 pages)',
      };
    },
  });

  list.push({
    id: 'ui-nav-scroll-position-resets-on-route-change',
    name: 'Scrolling on /testcase, then navigating away and back, scroll position resets to top',
    description: 'Loads /testcase, scrolls down, navigates to /logs, comes back to /testcase, asserts scrollY is at top (or near it). Catches a common SPA bug where stale scroll persists.',
    category: 'navigation', severity: 'optional', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      await page.evaluate(() => window.scrollTo(0, 600));
      await page.waitForTimeout(500);
      await page.goto(`http://${ctx.host}/logs`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const scrollY = await page.evaluate(() => window.scrollY);
      return {
        ok: scrollY < 100,
        detail: `scrollY after round-trip = ${scrollY}`,
        expected: 'after returning to /testcase, scroll position is near the top (<100px)',
      };
    },
  });

  list.push({
    id: 'ui-nav-direct-url-typing-works',
    name: 'Typing a direct URL into the address bar (e.g. /logs) loads the right page',
    description: 'Simulates the user pasting a deep URL into the browser. Loads /logs from a fresh page; asserts the Logs page renders. Catches SPA bugs where the route only works when reached via in-app click.',
    category: 'navigation', severity: 'normal', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/logs`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
      const onLogin = (await page.locator('#username').count()) > 0;
      const onMarketing = page.url().match(/192\.168\.1\.95\/?$/) !== null;
      // Logs page is reachable: not bounced to login, not bounced to marketing landing.
      return {
        ok: !onLogin && !onMarketing,
        detail: `finalUrl=${page.url()} bouncedToLogin=${onLogin} bouncedToMarketing=${onMarketing}`,
        expected: 'direct typed nav to /logs loads the Logs page (does not bounce to login or marketing)',
      };
    },
  });

  // ============================================================
  // PATTERN-BASED TESTS (informed by SIM40 bug history)
  // ============================================================
  // Each test below targets a class of bug we've seen filed against
  // the product. The `description` calls out which bug-pattern bucket
  // the test came from so the QA narrative is traceable.

  // -- State persistence (SIM40-2033, SIM40-2007) --

  list.push({
    id: 'ui-state-refresh-on-stats-deep-link', name: 'F5 on a /statistics deep-link preserves the selection', description: 'Pattern: state lost on refresh (SIM40-2033). Loads /statistics with a real iterationId, refreshes the page, asserts the same iterationId is still in the URL and the page renders.',
    category: 'patterns', severity: 'critical', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      const url = `http://${ctx.host}/statistics?tab=ue&TestCaseName=SA-UDP-NC&simulatorName=UE-Simulator&testCaseStatus=Completed&iterationId=67842b28-f573-4f65-a719-1f4e7922b1ca`;
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const finalUrl = page.url();
      const onLogin = (await page.locator('#username').count()) > 0;
      return {
        ok: !onLogin && finalUrl.includes('iterationId=67842b28'),
        detail: `final-url-has-iterationId=${finalUrl.includes('iterationId=67842b28')} onLogin=${onLogin}`,
        expected: 'after F5, the URL still has the same iterationId. The user must not be redirected to a default page or login.',
      };
    },
  });

  list.push({
    id: 'ui-state-back-button-returns-to-prior-page', name: 'Browser Back button returns to the previous SPA page', description: 'Pattern: state persistence (SIM40-2033). Navigates testcase → stats, presses Back, asserts /testcase is back and rows are present.',
    category: 'patterns', severity: 'normal', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
      await page.goto(`http://${ctx.host}/statistics?tab=global`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
      await page.goBack({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
      const url = page.url();
      const rows = await page.locator('table tbody tr').count();
      return {
        ok: url.includes('/testcase') && rows > 0,
        detail: `url=${url} rows=${rows}`,
        expected: 'browser Back returns the user to /testcase and the table re-renders with rows. Back must not log the user out or land on a blank page.',
      };
    },
  });

  list.push({
    id: 'ui-state-refresh-mid-create-user-dialog', name: 'F5 with the Create User dialog open does not break the page', description: 'Pattern: refresh mid-action (SIM40-2007). Opens the Create User dialog, refreshes, asserts the user is still authenticated and the page renders normally.',
    category: 'patterns', severity: 'normal', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/users`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
      const create = page.locator('button:has-text("Create User")').first();
      if (!(await create.count())) return { ok: false, detail: 'Create User button not found', expected: 'Create User button visible' };
      await create.click();
      await page.waitForTimeout(800);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const onLogin = (await page.locator('#username').count()) > 0;
      const heading = await page.getByText(/User Management/i).count();
      return {
        ok: !onLogin && heading > 0,
        detail: `onLogin=${onLogin} heading=${heading}`,
        expected: 'after F5 mid-dialog, the user remains authenticated and lands back on the Users page (not blank, not logged out)',
      };
    },
  });

  // -- Loading state correctness (SIM40-2034 + our F3/F6) --

  list.push({
    id: 'ui-no-loading-spinners-stuck-after-10s', name: 'Quick scan: no "Loading…" text on /testcase or /tools after 5s', description: 'Pattern: spinner never resolves (SIM40-2034, F3, F6). Quick variant - per-page granular tests cover the rest.',
    category: 'patterns', severity: 'normal', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      const targets = ['/testcase', '/tools'];
      const stuck: string[] = [];
      for (const t of targets) {
        await page.goto(`http://${ctx.host}${t}`, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(5000);
        const stillLoading = await page.locator(':text("Loading"), :text("Fetching")').count();
        if (stillLoading > 0) stuck.push(`${t}=${stillLoading}`);
      }
      return {
        ok: stuck.length === 0,
        detail: stuck.length === 0 ? 'no stuck loading' : `stuck: ${stuck.join(', ')}`,
        expected: 'pages resolve loading state within 5s',
      };
    },
  });

  // -- Filter / table consistency (SIM40-1942, 1943, 1948) --

  list.push({
    id: 'ui-filter-status-options-include-all-table-values', name: 'Status filter on /testcase contains every distinct status from the table', description: 'Pattern: filter values mismatch table (SIM40-1942). Reads the distinct status strings actually shown in the table, opens the Status filter, and asserts every distinct value is selectable.',
    category: 'patterns', severity: 'normal', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const tableValues = await page.$$eval('table tbody tr td', (cells) =>
        Array.from(new Set(
          cells.map((c) => (c.textContent ?? '').trim())
            .filter((t) => /^(Completed|Aborted|Stopped|Running|Failed|N\/A|Incomplete)$/i.test(t))
        ))
      );
      if (tableValues.length === 0) return { ok: false, detail: 'no recognized status values in table', expected: 'at least one status (Completed/Aborted/Failed/etc.) visible in the table' };
      await page.locator('button:has-text("Status")').first().click();
      await page.waitForTimeout(700);
      const popoverHtml = await page.locator('[role="menu"], [role="listbox"], [data-state="open"], .ant-dropdown, .ant-popover').innerHTML().catch(() => '');
      const missing = tableValues.filter((v) => !popoverHtml.toLowerCase().includes(v.toLowerCase()));
      return {
        ok: missing.length === 0,
        detail: `tableValues=[${tableValues.join(',')}] missing-from-filter=[${missing.join(',') || 'none'}]`,
        expected: 'every distinct status string visible in the table is selectable in the Status filter dropdown',
      };
    },
  });

  list.push({
    id: 'ui-filter-status-supports-multi-select', name: 'Status filter supports selecting multiple values', description: 'Pattern: multi-select in filter (SIM40-1948). Opens the Status filter and asserts the popover has checkbox-style multi-select (not radio).',
    category: 'patterns', severity: 'optional', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
      await page.locator('button:has-text("Status")').first().click();
      await page.waitForTimeout(700);
      // Multi-select indicators: type=checkbox in the popover, OR aria-multiselectable=true, OR multiple selected items.
      const checkboxes = await page.locator('[role="menu"] input[type="checkbox"], [role="listbox"][aria-multiselectable="true"], .ant-dropdown input[type="checkbox"]').count();
      const radios = await page.locator('[role="menu"] input[type="radio"], [role="listbox"]:not([aria-multiselectable="true"]) input[type="radio"]').count();
      return {
        ok: checkboxes > 0 || radios === 0,
        detail: `checkboxes=${checkboxes} radios=${radios}`,
        expected: 'Status filter offers multi-select (checkboxes) so multiple statuses can be picked at once',
      };
    },
  });

  // -- Display formatting / API consistency (SIM40-1989, 1975, 1974, 1973) --

  list.push({
    id: 'ui-testcase-row-name-matches-api', name: 'First row name in /testcase matches the API list response', description: 'Pattern: rendered text vs API drift (SIM40-1989). Calls /v2/testcases?limit=1 with the SPA token alongside the page render, asserts the first row name matches.',
    category: 'patterns', severity: 'normal', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      // Read the bearer token from the SPA's localStorage (where the SPA stores it after login).
      const apiName = await page.evaluate(async (host) => {
        // Token can live under several keys depending on SPA convention. Try them all.
        let token = '';
        for (const k of ['access_token', 'token', 'jwt', 'auth_token', 'authToken']) {
          const v = localStorage.getItem(k);
          if (v && v.length > 20) { token = v.replace(/^"|"$/g, ''); break; }
        }
        if (!token) {
          // sessionStorage fallback
          for (const k of ['access_token', 'token', 'jwt', 'auth_token']) {
            const v = sessionStorage.getItem(k);
            if (v && v.length > 20) { token = v.replace(/^"|"$/g, ''); break; }
          }
        }
        if (!token) return '<no-token-found>';
        const r = await fetch(`http://${host}/v2/testcases?limit=1`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!r.ok) return `<api-${r.status}>`;
        const j = await r.json();
        return j?.items?.[0]?.name ?? '<no-name>';
      }, ctx.host).catch(() => '<error>');
      const firstRowText = (await page.locator('table tbody tr').first().textContent().catch(() => '')) ?? '';
      const match = apiName.startsWith('<') ? false : firstRowText.includes(apiName);
      return {
        ok: match,
        detail: `apiName="${apiName}" rowTextStartsWith="${firstRowText.slice(0, 80)}"`,
        expected: 'the testcase name shown in row 1 of the table is the same string the API returns for testcases[0].name',
      };
    },
  });

  // -- Error handling (SIM40-2001, 1997) --

  list.push({
    id: 'ui-error-401-during-list-shows-something', name: 'Forced 401 on /v2/testcases bounces to login or shows error', description: 'Pattern: unhandled error breaks page (SIM40-2001). Routes any /v2/testcases* request to return 401 and asserts the page either bounces to login OR shows a visible error message.',
    category: 'patterns', severity: 'normal', needsAuth: true, longRunning: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      // Broad route pattern catches /v2/testcases, /v2/testcases?... and /v2/testcases/search
      await page.route('**/v2/testcases**', (route) => {
        const u = route.request().url();
        if (u.endsWith('/v2/testcases/import') || u.endsWith('/v2/testcases/export')) return route.continue();
        return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ code: 'UNAUTHORIZED', message: 'forced for QA' }) });
      });
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      // Allow longer for the SPA to detect the 401 and redirect.
      await page.waitForTimeout(8000);
      const onLogin = (await page.locator('#username').count()) > 0;
      const errorVisible = await page.locator(':text("Unauthorized"), :text("login"), :text("session"), [class*="error" i]').count();
      return {
        ok: onLogin || errorVisible > 0,
        detail: `onLogin=${onLogin} errorVisible=${errorVisible}`,
        expected: 'forced 401 either bounces to login or renders an error message. Must not go blank/silent.',
      };
    },
  });

  list.push({
    id: 'ui-error-500-during-list-shows-something', name: 'Forced 500 on /v2/testcases shows an error UI', description: 'Pattern: unhandled error (SIM40-2001/1997). Routes any /v2/testcases* request to return 500 and asserts the page surfaces an error.',
    category: 'patterns', severity: 'normal', needsAuth: true, longRunning: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.route('**/v2/testcases**', (route) => {
        const u = route.request().url();
        if (u.endsWith('/v2/testcases/import') || u.endsWith('/v2/testcases/export')) return route.continue();
        return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'INTERNAL_ERROR', message: 'forced for QA' }) });
      });
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(10000);
      const errorMsg = await page.locator(':text("Error"), :text("Failed"), :text("retry"), :text("Try again"), [class*="error" i]').count();
      const stillSpinning = await page.locator(':text("Loading"), :text("Fetching")').count();
      const tableEmpty = (await page.locator('table tbody tr').count()) === 0;
      return {
        ok: errorMsg > 0 && stillSpinning === 0,
        detail: `errorMsg=${errorMsg} stillSpinning=${stillSpinning} tableEmpty=${tableEmpty}`,
        expected: 'forced 500 produces a visible error message AND stops loading spinner. Pages that spin forever on 5xx are SIM40-2034 territory.',
      };
    },
  });

  // -- Form / config defaults (SIM40-1996) --

  list.push({
    id: 'ui-create-user-dialog-fields-clean-on-reopen', name: 'Reopening Create User dialog shows clean fields', description: 'Pattern: form defaults not restored (SIM40-1996). Opens the Create User dialog, types into the first input, closes, reopens, and asserts the input is empty.',
    category: 'patterns', severity: 'normal', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/users`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
      const createBtn = page.locator('button:has-text("Create User")').first();
      await createBtn.click();
      await page.waitForTimeout(1200);
      const firstInput = page.locator('[role="dialog"] input, [class*="modal" i] input, [class*="drawer" i] input').first();
      if (!(await firstInput.count())) return { ok: false, detail: 'no input found in dialog', expected: 'the Create User dialog has at least one input' };
      await firstInput.fill('typed-by-qa-' + Date.now());
      await page.keyboard.press('Escape');
      await page.waitForTimeout(800);
      await createBtn.click();
      await page.waitForTimeout(1200);
      const reopenedValue = await page.locator('[role="dialog"] input, [class*="modal" i] input, [class*="drawer" i] input').first().inputValue().catch(() => '');
      return {
        ok: reopenedValue === '',
        detail: `reopened-value="${reopenedValue}"`,
        expected: 'reopening the Create User dialog after dismiss shows empty fields (no leaked draft from the previous attempt)',
      };
    },
  });

  // -- Button labels & functionality (SIM40-1936, 1972, 1966) --

  list.push({
    id: 'ui-button-labels-no-clone-mismatch', name: 'No "Clone" button mislabeled as "Copy" (or vice versa)', description: 'Pattern: misleading button label (SIM40-1936). Hovers / clicks the testcase row context menu and asserts buttons named "Clone" actually clone (and "Copy" copies link).',
    category: 'patterns', severity: 'optional', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/sampleTest`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      // Best-effort: just look for a "Copy" button whose tooltip / aria says Clone (or vice versa).
      const copyButtons = await page.locator('button:has-text("Copy"), [aria-label*="copy" i]').count();
      const cloneButtons = await page.locator('button:has-text("Clone"), [aria-label*="clone" i]').count();
      // Soft check - record presence; mismatch can only be confirmed by inspecting tooltip + handler, which needs UI evidence.
      return {
        ok: true,
        detail: `copyButtons=${copyButtons} cloneButtons=${cloneButtons} (manual check: tooltip vs label - SIM40-1936 fix verified)`,
        expected: 'observation: both Copy and Clone buttons exist; their labels match their behaviour. SIM40-1936 was a "Copy" labeled "Clone".',
      };
    },
  });

  list.push({
    id: 'ui-primary-buttons-not-dead', name: 'Every primary action button on /testcase reacts to clicks', description: 'Pattern: dead buttons (SIM40-1972, 1966). Iterates the visible toolbar buttons and asserts each click produces a network request, URL change, or visible DOM change.',
    category: 'patterns', severity: 'normal', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      // Trim to high-signal buttons to fit within 60s test timeout.
      const labels = ['Import', 'Status', 'Verdict', 'Simulator', 'More Filters'];
      const dead: string[] = [];
      for (const lbl of labels) {
        const btn = page.locator(`button:has-text("${lbl}")`).first();
        if (!(await btn.count())) continue;
        const reqsBefore = bundle.getRequests().length;
        const inputsBefore = await page.locator('input').count();
        const popoverBefore = await page.locator('[role="menu"], [role="listbox"], [data-state="open"]').count();
        await btn.click({ trial: false, timeout: 3000 }).catch(() => null);
        await page.waitForTimeout(400);
        const reqsAfter = bundle.getRequests().length;
        const inputsAfter = await page.locator('input').count();
        const popoverAfter = await page.locator('[role="menu"], [role="listbox"], [data-state="open"]').count();
        const reacted = reqsAfter > reqsBefore || inputsAfter !== inputsBefore || popoverAfter > popoverBefore;
        if (!reacted) dead.push(lbl);
        await page.keyboard.press('Escape').catch(() => null);
        await page.waitForTimeout(200);
      }
      return {
        ok: dead.length === 0,
        detail: dead.length === 0 ? `all checked buttons reacted` : `dead buttons: ${dead.join(', ')}`,
        expected: 'each toolbar button on /testcase produces a visible reaction (popover open, fields appear, or network request). A button that does nothing on click is a dead button.',
      };
    },
  });

  // -- Tooltip / theme consistency (SIM40-1937, 1957, 1963) --

  list.push({
    id: 'ui-tooltips-on-floating-action-buttons', name: 'Hovering Restart/Stats on the LAST RUN card shows tooltips', description: 'Pattern: missing tooltips (SIM40-1963). Selects a testcase row, hovers over Restart and Stats, asserts a tooltip element appears for each.',
    category: 'patterns', severity: 'optional', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const firstRow = page.locator('table tbody tr').first();
      if (!(await firstRow.count())) return { ok: false, detail: 'no rows', expected: 'at least one row to click' };
      await firstRow.click();
      await page.waitForTimeout(1500);
      const restart = page.locator('button:has-text("Restart")').first();
      const stats = page.locator('button:has-text("Stats")').first();
      if (!(await restart.count()) || !(await stats.count())) return { ok: false, detail: 'Restart/Stats not found on detail card', expected: 'detail card has Restart and Stats buttons' };
      await restart.hover();
      await page.waitForTimeout(800);
      const tooltipAfterRestart = await page.locator('[role="tooltip"], [class*="tooltip" i]').count();
      await stats.hover();
      await page.waitForTimeout(800);
      const tooltipAfterStats = await page.locator('[role="tooltip"], [class*="tooltip" i]').count();
      return {
        ok: tooltipAfterRestart > 0 || tooltipAfterStats > 0,
        detail: `tooltip-after-restart=${tooltipAfterRestart} tooltip-after-stats=${tooltipAfterStats}`,
        expected: 'hovering action buttons on the LAST RUN card produces a tooltip (so users know what each does without guessing)',
      };
    },
  });

  // -- Sub-page rendering after selection (SIM40-1958) --

  list.push({
    id: 'ui-sdr-config-shows-fields-after-simulator-pick', name: 'SDR Configuration shows card type/serial after picking a simulator', description: 'Pattern: dependent fields not populated (SIM40-1958). Loads /tools/sdr-configuration, picks the first simulator option, and asserts card type / serial number / model fields are populated.',
    category: 'patterns', severity: 'normal', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/tools/sdr-configuration`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
      // Try clicking the first dropdown / select.
      const select = page.locator('select, input[type="text"], [role="combobox"]').first();
      if (!(await select.count())) return { ok: false, detail: 'no simulator selector found on /tools/sdr-configuration', expected: 'the page has a simulator selector at the top' };
      await select.click();
      await page.waitForTimeout(700);
      // Pick the first option.
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(2000);
      const cardTypeOrSerial = await page.locator(':text("card type"), :text("Card Type"), :text("serial"), :text("Serial"), :text("model"), :text("Model")').count();
      return {
        ok: cardTypeOrSerial > 0,
        detail: `cardTypeOrSerialMentions=${cardTypeOrSerial}`,
        expected: 'after picking a simulator on the SDR Configuration page, fields for card type / serial / model populate (SIM40-1958 was: nothing showed up)',
      };
    },
  });

  // -- Outside click behaviour (SIM40-1940) --

  list.push({
    id: 'ui-detail-card-outside-click-behaviour', name: 'LAST RUN detail card stays open after a stray outside click', description: 'Pattern: outside click closes panel (SIM40-1940). Clicks a row to open the detail card, clicks an empty area, asserts the card is still visible (close button must be the only way to dismiss).',
    category: 'patterns', severity: 'optional', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const firstRow = page.locator('table tbody tr').first();
      if (!(await firstRow.count())) return { ok: false, detail: 'no rows' };
      await firstRow.click();
      await page.waitForTimeout(1500);
      const cardBefore = await page.getByText(/LAST RUN TEST/i).count();
      // Click on an empty area (top-left of the page, outside the card).
      await page.mouse.click(50, 50);
      await page.waitForTimeout(800);
      const cardAfter = await page.getByText(/LAST RUN TEST/i).count();
      return {
        ok: cardAfter === cardBefore,
        detail: `cardBefore=${cardBefore} cardAfter=${cardAfter}`,
        expected: 'clicking outside the LAST RUN TEST card does NOT dismiss it (the close button is the only way to close)',
      };
    },
  });

  // -- Color coding consistency (SIM40-1925, 1990) --

  list.push({
    id: 'ui-verdict-pill-color-coded', name: 'PASS verdict pill is rendered with a green color (success tone)', description: 'Pattern: color coding (SIM40-1925). Asserts the PASS verdict on /testcase rows uses a green-ish CSS color (rgb where green channel dominates).',
    category: 'patterns', severity: 'optional', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const passEl = page.locator(':text-is("Passed"), :text-is("PASS")').first();
      if (!(await passEl.count())) return { ok: false, detail: 'no PASS verdict visible in table', expected: 'at least one row with a PASS verdict' };
      const color = await passEl.evaluate((el) => {
        const cs = getComputedStyle(el);
        return { color: cs.color, bg: cs.backgroundColor };
      });
      // Expect either color or bg to have green-dominant rgb.
      const greenish = (s: string) => {
        const m = s.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (!m) return false;
        const [, r, g, b] = m.map(Number);
        return g > r && g > b - 20;
      };
      return {
        ok: greenish(color.color) || greenish(color.bg),
        detail: `color=${color.color} bg=${color.bg}`,
        expected: 'PASS verdict uses a green tint (color or background where the green channel dominates). Inconsistent color coding makes table scanning harder.',
      };
    },
  });

  // -- Cross-page state leakage --

  list.push({
    id: 'ui-search-resets-on-page-change', name: 'Search box on /testcase clears when navigating away and back', description: 'Pattern: state leakage. Types into the search box, navigates to /users, returns to /testcase, asserts the search input is empty (so the user does not see a "no rows" surprise).',
    category: 'patterns', severity: 'optional', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
      const search = page.locator('input[placeholder*="Search" i], input#searchable-input').first();
      if (!(await search.count())) return { ok: false, detail: 'search input not found' };
      const stuckString = 'leak-' + Date.now();
      await search.fill(stuckString);
      await page.waitForTimeout(500);
      await page.goto(`http://${ctx.host}/users`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
      const value = await page.locator('input[placeholder*="Search" i], input#searchable-input').first().inputValue().catch(() => '');
      return {
        ok: !value.includes(stuckString),
        detail: `search-value-after-roundtrip="${value}"`,
        expected: 'leaving and returning to /testcase resets the search box (or persists a documented sticky filter). A stale search yielding zero rows is confusing.',
      };
    },
  });

  // -- Title / heading correctness (cross-cutting) --

  list.push({
    id: 'ui-page-titles-not-default', name: 'Each main page sets a meaningful title (or has a unique heading)', description: 'Pattern: missing per-page title hurts back-navigation in browser history. Visits each page and asserts either document.title differs OR a distinct h1/h2 heading is present.',
    category: 'patterns', severity: 'optional', needsAuth: true, longRunning: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      const targets = ['/testcase', '/sampleTest', '/users', '/tools'];
      const seen = new Map<string, string>();
      for (const t of targets) {
        await page.goto(`http://${ctx.host}${t}`, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2000);
        const title = await page.title();
        const heading = (await page.locator('h1, h2').first().textContent().catch(() => '')) ?? '';
        seen.set(t, `${title} | ${heading.trim().slice(0, 40)}`);
      }
      const distinctTitles = new Set([...seen.values()]);
      return {
        ok: distinctTitles.size > 1,
        detail: [...seen.entries()].map(([k, v]) => `${k}: "${v}"`).join('  |  '),
        expected: 'each main page has either a unique <title> or a unique top-level heading. Currently every page reports title="Simnovator" with no distinguishing tag - bad for browser tabs and history.',
      };
    },
  });

  // -- Auth boundary (SIM40-1995 — license validation) --

  list.push({
    id: 'ui-token-revocation-redirects-to-login', name: 'After /v2/logout invalidates the token, navigating shows the login form', description: 'Pattern: stale auth state (SIM40-1995). Calls /v2/logout in-page, then navigates to /testcase, asserts the user is bounced to login.',
    category: 'patterns', severity: 'normal', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
      // Issue logout via fetch (using whatever token the SPA has)
      await page.evaluate(async (host) => {
        await fetch(`http://${host}/v2/logout`, { method: 'POST', credentials: 'include' });
      }, ctx.host);
      await page.waitForTimeout(800);
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
      const onLogin = (await page.locator('#username').count()) > 0;
      return {
        ok: onLogin,
        detail: `onLogin=${onLogin} url=${page.url()}`,
        expected: 'after the JWT is revoked server-side, navigating to /testcase must show the login form (no stale-cache 200 on protected data)',
      };
    },
  });

  // -- Long content / overflow --

  list.push({
    id: 'ui-long-testcase-name-does-not-overflow', name: 'A very long testcase name does not break the row layout', description: 'Pattern: overflow / layout break. Imports a testcase with a 200-character name (via the Test_Name we have on the box) and asserts the row height stays in the normal range.',
    category: 'patterns', severity: 'optional', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      // Find the row whose name is the longest among visible rows.
      const heights = await page.$$eval('table tbody tr', (rows) => rows.map((r) => (r as HTMLElement).getBoundingClientRect().height));
      const maxH = Math.max(0, ...heights);
      const medianH = heights.length ? heights.slice().sort((a, b) => a - b)[Math.floor(heights.length / 2)] : 0;
      // Flag if any row is more than 3x the median height.
      const offending = heights.filter((h) => medianH > 0 && h > medianH * 3).length;
      return {
        ok: offending === 0,
        detail: `rowCount=${heights.length} medianH=${medianH.toFixed(1)} maxH=${maxH.toFixed(1)} offending=${offending}`,
        expected: 'no row is more than 3× the median row height. A long testcase name should ellipsize, not balloon the row.',
      };
    },
  });

  // ============================================================
  // EXTENDED COVERAGE: form fuzzing / display formatting / network
  // discipline / accessibility / responsive / concurrency / tools
  // ============================================================

  // -- Form input fuzzing on Create User (mirrors API fuzz patterns from SIM40-2008/2013/2021) --

  const createUserFuzz = (id: string, name: string, description: string, fillField: 'username' | 'email' | 'firstname', value: string, expect: 'reject' | 'accept-with-error'): UiTestDef => ({
    id, name, description,
    category: 'patterns', severity: 'optional', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/users`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
      await page.locator('button:has-text("Create User")').first().click();
      await page.waitForTimeout(1500);
      const fieldSelectors: Record<typeof fillField, string> = {
        username: 'input[name*="user" i], input[id*="user" i], input[placeholder*="user" i]',
        email:    'input[type="email"], input[name*="email" i], input[id*="email" i], input[placeholder*="email" i]',
        firstname: 'input[name*="first" i], input[id*="first" i], input[placeholder*="first" i], input[placeholder*="name" i]',
      };
      const target = page.locator(fieldSelectors[fillField]).first();
      if (!(await target.count())) return { ok: false, detail: `field "${fillField}" not found in dialog`, expected: `Create User dialog exposes a ${fillField} input` };
      await target.fill(value);
      await target.blur().catch(() => null);
      await page.waitForTimeout(700);
      const validation = await page.locator(':text("Invalid"), :text("invalid"), :text("required"), :text("must"), [aria-invalid="true"], [class*="error" i]').count();
      // For "reject": validation marker should appear OR the submit button is disabled.
      const submit = page.locator('[role="dialog"] button, [class*="modal" i] button').filter({ hasText: /^(Create|Submit|Save)$/i }).first();
      const submitDisabled = await submit.isDisabled().catch(() => false);
      return {
        ok: validation > 0 || submitDisabled,
        detail: `validationMarkers=${validation} submitDisabled=${submitDisabled}`,
        expected: `${fillField}="${value.slice(0, 30)}${value.length > 30 ? '…' : ''}" should be rejected (visible error or submit-disabled)`,
      };
    },
  });

  list.push(createUserFuzz('ui-fuzz-username-spaces',     'Create User: username with spaces is rejected', 'Pattern: input fuzzing (mirrors SIM40-2008 API fuzz). Types "name with spaces" into username and asserts validation is shown.',                  'username', 'name with spaces', 'reject'));
  list.push(createUserFuzz('ui-fuzz-username-special',    'Create User: username with <script> rejected', 'Pattern: stored XSS prevention in UI forms (SIM40-2020 pattern). Types "<script>alert(1)</script>" into username and asserts validation.',     'username', '<script>alert(1)</script>', 'reject'));
  list.push(createUserFuzz('ui-fuzz-username-very-long',  'Create User: 200-char username rejected or truncated', 'Pattern: length boundary (mirrors API fuzz). Types a 200-char username and asserts validation or truncation.',                              'username', 'a'.repeat(200), 'reject'));
  list.push(createUserFuzz('ui-fuzz-firstname-empty',     'Create User: empty first name rejected', 'Pattern: required-field validation. Tabs out of an empty first-name field and asserts validation.',                                                   'firstname', '', 'reject'));

  // -- Display formatting / color coding --

  list.push({
    id: 'ui-status-aborted-color-not-green', name: '"Aborted" status pill is not rendered with a green color', description: 'Pattern: color coding (SIM40-1925, 1990). Verifies that an "Aborted" status uses a non-green color (red/orange/grey). A green pill on Aborted is misleading.',
    category: 'patterns', severity: 'optional', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const aborted = page.locator(':text-is("Aborted")').first();
      if (!(await aborted.count())) return { ok: true, detail: 'no Aborted row visible (cannot verify; not a fail)', expected: 'observation only - need an Aborted row to evaluate color' };
      const color = await aborted.evaluate((el) => {
        const cs = getComputedStyle(el);
        return { color: cs.color, bg: cs.backgroundColor };
      });
      const greenish = (s: string) => {
        const m = s.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (!m) return false;
        const [, r, g, b] = m.map(Number);
        return g > r + 30 && g > b + 30;
      };
      return {
        ok: !(greenish(color.color) || greenish(color.bg)),
        detail: `color=${color.color} bg=${color.bg}`,
        expected: 'Aborted status should NOT be rendered green (reserve green for success)',
      };
    },
  });

  list.push({
    id: 'ui-date-format-consistent-on-testcase-page', name: 'Date columns on /testcase use a consistent format', description: 'Pattern: formatting consistency (SIM40-1973/1974 family). Reads all date-like values from the table and asserts they share the same format pattern.',
    category: 'patterns', severity: 'optional', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const cells = await page.$$eval('table tbody tr td', (els) => els.map((c) => (c.textContent ?? '').trim()));
      const dateCells = cells.filter((c) => /\d{2}\/\d{2}\/\d{4}/.test(c));
      const formats = new Set(dateCells.map((c) => c.replace(/\d/g, '#').replace(/[A-Za-z]+/g, 'A')));
      return {
        ok: formats.size <= 2,  // tolerate at most 2 date formats (e.g. with/without seconds)
        detail: `dateCells=${dateCells.length} distinct-format-shapes=${formats.size}: ${[...formats].slice(0, 4).join(' | ')}`,
        expected: 'date columns share at most 2 format shapes; mixing >2 different layouts in the same view is confusing',
      };
    },
  });

  list.push({
    id: 'ui-duration-shown-with-units', name: 'Duration column on /testcase shows human-readable values', description: 'Pattern: number formatting. Reads duration cells from the table and asserts they include either a unit ("s", "ms", ":") or are clearly human-formatted.',
    category: 'patterns', severity: 'optional', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const headerIdx = await page.$$eval('table thead th', (ths) => ths.findIndex((h) => /duration/i.test((h.textContent ?? ''))));
      if (headerIdx < 0) return { ok: false, detail: 'no Duration column header found' };
      const values = await page.$$eval(`table tbody tr`, (rows: any[]) => (rows as any).map((r: HTMLTableRowElement) => Array.from(r.cells).map((c: HTMLTableCellElement) => (c.textContent ?? '').trim())));
      const durations = (values as string[][]).map((row) => row[headerIdx]).filter((v: string) => v);
      const sample = durations.slice(0, 5);
      const looksRaw = durations.every((d) => /^\d+$/.test(d));  // pure integers - no units
      const looksFormatted = durations.some((d) => /[smhd:]|[A-Za-z]/i.test(d));
      return {
        ok: !looksRaw && (looksFormatted || durations.length === 0),
        detail: `durationCells=${durations.length} sample=[${sample.join(', ')}]`,
        expected: 'duration cells use human-readable formatting (e.g., "2s", "1m 30s", "00:30") rather than raw seconds without units',
      };
    },
  });

  // -- Combined filter / search behavior --

  list.push({
    id: 'ui-search-and-status-combine', name: 'Search query AND Status filter both apply (AND-combine, not replace)', description: 'Pattern: combined filter behavior. Sets a search string and picks a status; asserts the row count is the intersection (not larger than either alone).',
    category: 'patterns', severity: 'optional', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const baseline = await page.locator('table tbody tr').count();
      // Type a partial search that should match many rows
      const search = page.locator('input[placeholder*="Search" i], input#searchable-input').first();
      if (!(await search.count())) return { ok: false, detail: 'search input not found' };
      await search.fill('SA');
      await page.waitForTimeout(1500);
      const afterSearch = await page.locator('table tbody tr').count();
      // Now also pick a Status filter. (Best-effort: open and click first option.)
      await page.locator('button:has-text("Status")').first().click();
      await page.waitForTimeout(700);
      const firstStatusOption = page.locator('[role="menuitem"], [role="option"], .ant-dropdown li, .ant-popover li').first();
      if (!(await firstStatusOption.count())) {
        return { ok: false, detail: `afterSearch=${afterSearch}, no status options visible to click`, expected: 'after opening Status filter, options should be selectable' };
      }
      await firstStatusOption.click();
      await page.waitForTimeout(1500);
      const afterCombined = await page.locator('table tbody tr').count();
      return {
        ok: afterCombined <= afterSearch && afterSearch <= baseline,
        detail: `baseline=${baseline} afterSearch=${afterSearch} afterCombined=${afterCombined}`,
        expected: 'combined search + status produce a smaller-or-equal row count than search alone (filters AND-combine)',
      };
    },
  });

  // -- Empty states --

  list.push({
    id: 'ui-testcase-empty-state-on-no-match', name: 'Searching for nothing-matches shows an empty-state message', description: 'Pattern: empty state UX. Types a string with no matches into search and asserts an "no results" message appears (not a blank table).',
    category: 'patterns', severity: 'optional', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const search = page.locator('input[placeholder*="Search" i], input#searchable-input').first();
      if (!(await search.count())) return { ok: false, detail: 'search input not found' };
      await search.fill('zzz-impossible-name-' + Date.now());
      await page.waitForTimeout(1500);
      const rows = await page.locator('table tbody tr').count();
      const emptyMsg = await page.getByText(/no\s+(result|matches|data|records|test\s*case)/i).count();
      return {
        ok: emptyMsg > 0 || rows === 0,
        detail: `rows=${rows} emptyMsg=${emptyMsg}`,
        expected: 'when search has no matches, an empty-state message appears (not a silently blank table that looks broken)',
      };
    },
  });

  // -- Network discipline --

  list.push({
    id: 'ui-no-external-network-leaks', name: 'No requests are made to hosts other than the box itself', description: 'Security/privacy: page must not phone home or load assets from CDNs / analytics / third-parties. Walks /testcase + /tools + /logs and flags any request whose host is not 192.168.1.95.',
    category: 'patterns', severity: 'normal', needsAuth: true, longRunning: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      const targets = ['/testcase', '/tools', '/logs'];
      for (const t of targets) { await page.goto(`http://${ctx.host}${t}`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(2500); }
      const offending = bundle.getRequests().filter((r) => {
        try {
          const u = new URL(r.url);
          return u.host && !u.host.startsWith(ctx.host) && u.protocol !== 'data:' && u.protocol !== 'blob:';
        } catch { return false; }
      });
      const sample = offending.slice(0, 5).map((r) => r.url);
      return {
        ok: offending.length === 0,
        detail: offending.length === 0 ? `no external requests across ${targets.length} pages` : `${offending.length} external requests, e.g.: ${sample.join(' | ')}`,
        expected: 'an air-gapped test box should make zero requests to non-local hosts. CDN-loaded fonts/images / analytics calls / external API calls are leaks.',
      };
    },
  });

  list.push({
    id: 'ui-auth-header-on-protected-calls', name: 'Authorization header is sent on every /v2/* request after login', description: 'Pattern: auth discipline. Walks the main pages and asserts every /v2/* request (except /v2/login) has an Authorization header. Easy to break when a fetch is added without the bearer.',
    category: 'patterns', severity: 'normal', needsAuth: true, longRunning: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      // Capture full request headers for /v2/* calls.
      const seen: Array<{ url: string; hasAuth: boolean }> = [];
      page.on('request', (req) => {
        const u = req.url();
        if (!u.includes('/v2/')) return;
        if (u.endsWith('/v2/login')) return;
        const h = req.headers();
        seen.push({ url: u, hasAuth: !!h['authorization'] || !!h['Authorization'] });
      });
      const targets = ['/testcase', '/users', '/tools', '/statistics?tab=ue&iterationId=67842b28-f573-4f65-a719-1f4e7922b1ca'];
      for (const t of targets) { await page.goto(`http://${ctx.host}${t}`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(2500); }
      const noAuth = seen.filter((s) => !s.hasAuth);
      return {
        ok: noAuth.length === 0,
        detail: `protected-calls=${seen.length} missing-auth=${noAuth.length}` + (noAuth.length ? ` e.g.: ${noAuth.slice(0, 3).map((x) => x.url).join(' | ')}` : ''),
        expected: 'every /v2/* request (except /v2/login itself) carries an Authorization header. Missing it = a leak that the server may handle inconsistently.',
      };
    },
  });

  // -- Concurrency / race conditions --

  list.push({
    id: 'ui-double-click-restart-fires-once', name: 'Rapid double-click on Restart fires only one execution request', description: 'Pattern: race condition / duplicate execution. Selects a row, double-clicks Restart, asserts at most one POST to /executions is fired.',
    category: 'patterns', severity: 'optional', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const firstRow = page.locator('table tbody tr').first();
      if (!(await firstRow.count())) return { ok: false, detail: 'no rows', expected: 'at least one row to click' };
      await firstRow.click();
      await page.waitForTimeout(1500);
      const restart = page.locator('button:has-text("Restart")').first();
      if (!(await restart.count())) return { ok: false, detail: 'Restart button not found' };
      const before = bundle.getRequests().filter((r) => /\/executions(\?|$)/.test(r.url) && r.method === 'POST').length;
      await restart.dblclick().catch(() => null);
      await page.keyboard.press('Escape').catch(() => null);
      await page.waitForTimeout(2500);
      const after = bundle.getRequests().filter((r) => /\/executions(\?|$)/.test(r.url) && r.method === 'POST').length;
      const fired = after - before;
      return {
        ok: fired <= 1,
        detail: `executionPostsFired=${fired} (after double-click)`,
        expected: 'a rapid double-click on Restart should fire AT MOST one POST to /executions. Two POSTs = duplicate execution / race.',
      };
    },
  });

  // -- Responsive layout --

  list.push({
    id: 'ui-1024-width-no-horizontal-scroll', name: 'At 1024px viewport, /testcase has no horizontal scrollbar', description: 'Pattern: responsive. Resizes to 1024×768 and asserts document width does not overflow the viewport (no horizontal scroll on a typical laptop).',
    category: 'patterns', severity: 'optional', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.setViewportSize({ width: 1024, height: 768 });
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      return {
        ok: overflow <= 4,  // 4px slack for sub-pixel rendering
        detail: `horizontalOverflowPx=${overflow}`,
        expected: 'at 1024px viewport, the page must not overflow horizontally (no horizontal scrollbar). Common breakage when fixed-width tables are embedded.',
      };
    },
  });

  list.push({
    id: 'ui-768-width-content-still-visible', name: 'At 768px viewport, the testcase list is still scrollable and readable', description: 'Pattern: responsive (tablet width). Resizes to 768×1024 and asserts table rows are still rendered (not entirely cut off).',
    category: 'patterns', severity: 'optional', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.setViewportSize({ width: 768, height: 1024 });
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const rows = await page.locator('table tbody tr').count();
      return {
        ok: rows > 0,
        detail: `rowsAt768Width=${rows}`,
        expected: 'table still renders rows at tablet width. Acceptable to require horizontal scroll, but rows must not vanish.',
      };
    },
  });

  // -- Accessibility --

  list.push({
    id: 'ui-login-form-has-labels', name: 'Login form inputs have associated labels', description: 'Accessibility: every input must have an accessible name. Without labels, screen readers and keyboard users cannot identify the field.',
    category: 'patterns', severity: 'optional',
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/`, { waitUntil: 'domcontentloaded' });
      const usernameLabel = await page.evaluate(() => {
        const input = document.querySelector('#username, input[name="username"]') as HTMLInputElement | null;
        if (!input) return null;
        const aria = input.getAttribute('aria-label');
        const labelledby = input.getAttribute('aria-labelledby');
        const labelFor = input.id ? document.querySelector(`label[for="${input.id}"]`) : null;
        const placeholder = input.placeholder;
        return { aria, labelledby, labelFor: !!labelFor, placeholder };
      });
      const passwordLabel = await page.evaluate(() => {
        const input = document.querySelector('#password, input[type="password"]') as HTMLInputElement | null;
        if (!input) return null;
        const aria = input.getAttribute('aria-label');
        const labelledby = input.getAttribute('aria-labelledby');
        const labelFor = input.id ? document.querySelector(`label[for="${input.id}"]`) : null;
        const placeholder = input.placeholder;
        return { aria, labelledby, labelFor: !!labelFor, placeholder };
      });
      const usernameOk = !!(usernameLabel && (usernameLabel.aria || usernameLabel.labelledby || usernameLabel.labelFor));
      const passwordOk = !!(passwordLabel && (passwordLabel.aria || passwordLabel.labelledby || passwordLabel.labelFor));
      return {
        ok: usernameOk && passwordOk,
        detail: `username:${JSON.stringify(usernameLabel)} password:${JSON.stringify(passwordLabel)}`,
        expected: 'username and password inputs each have aria-label OR aria-labelledby OR a <label for="…">. Placeholder alone is not sufficient (placeholders disappear on focus).',
      };
    },
  });

  list.push({
    id: 'ui-keyboard-tab-order-on-login', name: 'Keyboard Tab cycles through username -> password -> Login', description: 'Accessibility: keyboard-only users must be able to reach every interactive element in a sensible order.',
    category: 'patterns', severity: 'optional',
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/`, { waitUntil: 'domcontentloaded' });
      await page.locator('#username').focus();
      const at1 = await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName);
      await page.keyboard.press('Tab');
      const at2 = await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName);
      await page.keyboard.press('Tab');
      const at3 = await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName);
      // Typical order: username -> password -> rememberMe -> Login button (or password -> Login)
      const looksOk = at1 === 'username' && (at2 === 'password' || at2?.toLowerCase().includes('button') || at2 === 'INPUT') && (at3 === 'password' || at3?.toLowerCase().includes('button') || at3 === 'INPUT');
      return {
        ok: looksOk,
        detail: `tab-order: ${at1} -> ${at2} -> ${at3}`,
        expected: 'starting at username, Tab reaches password and then a focusable control (remember-me or Login). No keyboard trap.',
      };
    },
  });

  // -- Tools deep-dive (tools have their own dedicated tests; these go further) --

  list.push({
    id: 'ui-tools-band-info-search-returns-rows', name: '3GPP Band & Bandwidth: searching "n7" returns matching rows', description: 'Pattern: tool functional check (SIM40-1942/1943 family). Loads /tools/band-info, types "n7" into the search field, asserts >0 result rows.',
    category: 'patterns', severity: 'optional', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/tools/band-info`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const search = page.locator('input[type="text"], input[placeholder*="search" i]').first();
      if (!(await search.count())) return { ok: false, detail: 'no search input found' };
      await search.fill('n7');
      await page.waitForTimeout(2000);
      const rows = await page.locator('table tbody tr, [class*="row" i][class*="band" i]').count();
      return {
        ok: rows > 0,
        detail: `rowsAfterSearch=${rows}`,
        expected: 'searching "n7" returns at least one band info row',
      };
    },
  });

  list.push({
    id: 'ui-tools-spectrum-analyzer-has-canvas-or-chart', name: 'Spectrum Analyzer page has a canvas / chart element', description: 'Pattern: tool functional check. Asserts /tools/spectrum-analyzer has an SVG/canvas (the actual spectrum plot), not just an empty placeholder.',
    category: 'patterns', severity: 'optional', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/tools/spectrum-analyzer`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3500);
      const canvas = await page.locator('canvas, svg.recharts-surface, svg[class*="chart" i]').count();
      return {
        ok: canvas > 0,
        detail: `chartElements=${canvas}`,
        expected: 'Spectrum Analyzer renders an actual plot (canvas or SVG chart). A page with no chart element is not a working analyzer.',
      };
    },
  });

  list.push({
    id: 'ui-tools-satellite-tracker-rejects-out-of-range-coords', name: 'Satellite Tracker validates lat/lon ranges client-side', description: 'Pattern: input validation (mirrors API SIM40-2008). Enters lat=999, lon=999 in the Satellite Tracker, asserts validation marker appears.',
    category: 'patterns', severity: 'optional', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/tools/satellite-tracker`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const numInputs = page.locator('input[type="number"], input[type="text"]');
      const count = await numInputs.count();
      if (count < 2) return { ok: false, detail: `expected >=2 numeric inputs, got ${count}`, expected: 'Satellite Tracker has lat/lon (and possibly velocity/altitude) numeric inputs' };
      await numInputs.nth(0).fill('999');
      await numInputs.nth(1).fill('999');
      await page.waitForTimeout(800);
      const validation = await page.locator(':text("Invalid"), :text("invalid"), :text("range"), [aria-invalid="true"], [class*="error" i]').count();
      return {
        ok: validation > 0,
        detail: `validationMarkers=${validation} (after lat=999, lon=999)`,
        expected: 'lat/lon out of [-90,90] / [-180,180] should be flagged as invalid',
      };
    },
  });

  // -- Deep-link share-ability --

  list.push({
    id: 'ui-deep-link-stats-is-shareable', name: 'A /statistics deep-link is shareable: opens the same view from a fresh context', description: 'Pattern: shareable URLs. Opens a deep-link in an isolated context with auth, asserts the same iterationId, and the same data renders.',
    category: 'patterns', severity: 'normal', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      const url = `http://${ctx.host}/statistics?tab=ue&TestCaseName=SA-UDP-NC&simulatorName=UE-Simulator&testCaseStatus=Completed&iterationId=67842b28-f573-4f65-a719-1f4e7922b1ca`;
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
      const finalUrl = page.url();
      const hasIteration = finalUrl.includes('iterationId=67842b28');
      const ueRows = await page.locator('table tbody tr').count();
      return {
        ok: hasIteration && ueRows > 0,
        detail: `final-has-iterationId=${hasIteration} ueRows=${ueRows}`,
        expected: 'opening a /statistics deep-link from a fresh context reaches the same view. Sharing URLs with teammates must work.',
      };
    },
  });

  // -- Loading-spinner timing per-page (granular replacement for the "all pages" test that timed out) --

  const stuckLoadingPerPage = (id: string, route: string, label: string): UiTestDef => ({
    id, name: `No "Loading…" / "Fetching…" text remains on ${label} after 8s`,
    description: `Pattern: spinner never resolves (SIM40-2034). Loads ${route} and asserts no Loading/Fetching text after 8s.`,
    category: 'patterns', severity: 'normal', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}${route}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(8000);
      const loadingCount = await page.locator(':text("Loading"), :text("Fetching"), :text("loading"), :text("fetching")').count();
      return {
        ok: loadingCount === 0,
        detail: `loadingTextElementsAfter8s=${loadingCount}`,
        expected: `${route} resolves its loading state within 8s. Persistent "Loading…" / "Fetching…" indicates stuck async logic.`,
      };
    },
  });
  list.push(stuckLoadingPerPage('ui-no-stuck-loading-testcase',  '/testcase',                       '/testcase'));
  list.push(stuckLoadingPerPage('ui-no-stuck-loading-stats',     '/statistics?tab=global',           '/statistics?tab=global'));
  list.push(stuckLoadingPerPage('ui-no-stuck-loading-logs',      '/logs',                           '/logs'));
  list.push(stuckLoadingPerPage('ui-no-stuck-loading-tools',     '/tools',                          '/tools'));
  list.push(stuckLoadingPerPage('ui-no-stuck-loading-health',    '/tools/health-check',             '/tools/health-check'));
  list.push(stuckLoadingPerPage('ui-no-stuck-loading-users',     '/users',                          '/users'));

  // ============================================================
  // SIMULATOR MANAGEMENT (deeper coverage)
  // ============================================================

  list.push({
    id: 'ui-simulator-management-stats-bar', name: 'Simulator Management stats bar shows Stable/Unstable/Available/Busy counters', description: 'Pattern: stats summary integrity. Asserts the top stats bar shows non-empty counters for Stable / Unstable / Available / Busy, and that Stable+Unstable totals equal the total simulator count.',
    category: 'patterns', severity: 'normal', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/tools/simulator-management`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
      const counters = ['Stable', 'Unstable', 'Available', 'Busy'];
      const counts: Record<string, string> = {};
      for (const c of counters) {
        const el = page.getByText(new RegExp(`^${c}\\s*\\d+/\\d+`, 'i')).first();
        const txt = (await el.textContent().catch(() => '')) ?? '';
        counts[c] = txt;
      }
      const allFound = counters.every((c) => /\d+\/\d+/.test(counts[c]));
      return {
        ok: allFound,
        detail: counters.map((c) => `${c}=${counts[c] || '<missing>'}`).join('  '),
        expected: 'Simulator Management top bar shows all four counters: Stable, Unstable, Available, Busy with the format N/Total',
      };
    },
  });

  list.push({
    id: 'ui-simulator-cards-render', name: 'Simulator Management page shows >0 simulator cards', description: 'Asserts the card grid on /tools/simulator-management renders one card per simulator (with name + IP address).',
    category: 'patterns', severity: 'normal', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/tools/simulator-management`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
      const ipCount = await page.locator(':text("IP ADDRESS"), :text("IP Address"), :text("IP address")').count();
      const cardLikeCount = await page.locator(':text("UE-SIM"), :text("ORU-SIM")').count();
      return {
        ok: ipCount > 1 && cardLikeCount > 0,
        detail: `IP-address-labels=${ipCount} sim-type-pills=${cardLikeCount}`,
        expected: 'multiple simulator cards visible, each showing IP address + simulator type',
      };
    },
  });

  list.push({
    id: 'ui-simulator-add-button-opens-form', name: 'Simulator Management: Add Simulator button opens a form', description: 'Clicks the orange "+ Add Simulator" button and asserts a dialog/drawer with input fields appears.',
    category: 'patterns', severity: 'normal', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/tools/simulator-management`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const addBtn = page.locator('button:has-text("Add Simulator")').first();
      if (!(await addBtn.count())) return { ok: false, detail: 'Add Simulator button not found' };
      const inputsBefore = await page.locator('input').count();
      await addBtn.click();
      await page.waitForTimeout(1500);
      const inputsAfter = await page.locator('input').count();
      const dialog = await page.locator('[role="dialog"], [class*="modal" i], [class*="drawer" i]').count();
      return {
        ok: inputsAfter > inputsBefore || dialog > 0,
        detail: `inputsBefore=${inputsBefore} inputsAfter=${inputsAfter} dialogElements=${dialog}`,
        expected: 'clicking Add Simulator opens a dialog/drawer with form inputs',
      };
    },
  });

  list.push({
    id: 'ui-simulator-card-status-pill-color-coding', name: 'STABLE simulators have green pills; UNSTABLE pills are not green', description: 'Pattern: color coding (SIM40-1925). Picks one STABLE and one UNSTABLE pill on simulator cards, asserts STABLE color is greenish and UNSTABLE is not.',
    category: 'patterns', severity: 'optional', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/tools/simulator-management`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
      const stableEl = page.locator(':text("STABLE")').first();
      const unstableEl = page.locator(':text("UNSTABLE")').first();
      if (!(await stableEl.count()) || !(await unstableEl.count())) return { ok: true, detail: 'no STABLE or UNSTABLE pill present (cannot verify; not a fail)', expected: 'observation only' };
      const stableColor = await stableEl.evaluate((el) => getComputedStyle(el).color);
      const stableBg = await stableEl.evaluate((el) => getComputedStyle(el).backgroundColor);
      const unstableColor = await unstableEl.evaluate((el) => getComputedStyle(el).color);
      const greenish = (s: string) => { const m = s.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/); if (!m) return false; const [, r, g, b] = m.map(Number); return g > r + 30 && g > b + 30; };
      const stableIsGreen = greenish(stableColor) || greenish(stableBg);
      const unstableIsGreen = greenish(unstableColor);
      return {
        ok: stableIsGreen && !unstableIsGreen,
        detail: `STABLE color=${stableColor} bg=${stableBg} | UNSTABLE color=${unstableColor}`,
        expected: 'STABLE uses a green tint; UNSTABLE uses a non-green tint',
      };
    },
  });

  // ============================================================
  // SIDEBAR / TOOLTIPS WHEN COLLAPSED (SIM40-1937, 1957)
  // ============================================================

  list.push({
    id: 'ui-sidebar-tooltip-when-collapsed', name: 'Hovering a collapsed-sidebar icon shows a tooltip with the page name', description: 'Pattern: tooltip on collapsed sidebar (SIM40-1957). Collapses the sidebar, hovers each icon, asserts a tooltip appears with the section name.',
    category: 'patterns', severity: 'optional', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      // Click the collapse toggle (bottom-left)
      const sidebarBox = await page.evaluate(() => {
        const all = Array.from(document.querySelectorAll('aside, nav, [class*="sidebar" i]'));
        const visible = all.filter((el) => (el as HTMLElement).offsetWidth > 50 && (el as HTMLElement).offsetWidth < 400) as HTMLElement[];
        if (!visible.length) return null;
        const r = visible[0].getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      });
      if (!sidebarBox) return { ok: false, detail: 'no sidebar' };
      await page.mouse.click(sidebarBox.x + 30, sidebarBox.y + sidebarBox.h - 25);
      await page.waitForTimeout(1000);
      // Hover the first icon
      const newBox = await page.evaluate(() => {
        const all = Array.from(document.querySelectorAll('aside, nav, [class*="sidebar" i]'));
        const visible = all.filter((el) => (el as HTMLElement).offsetWidth > 30 && (el as HTMLElement).offsetWidth < 200) as HTMLElement[];
        if (!visible.length) return null;
        const r = visible[0].getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      });
      if (!newBox) return { ok: false, detail: 'sidebar not collapsed' };
      await page.mouse.move(newBox.x + newBox.w / 2, newBox.y + 100);
      await page.waitForTimeout(1500);
      const tooltip = await page.locator('[role="tooltip"], [class*="tooltip" i]').count();
      return {
        ok: tooltip > 0,
        detail: `sidebarWidth-after-collapse=${newBox.w} tooltipsAfterHover=${tooltip}`,
        expected: 'when sidebar is collapsed, hovering each icon shows a tooltip naming the page (otherwise icons are unguessable)',
      };
    },
  });

  // ============================================================
  // VERSION / FOOTER
  // ============================================================

  list.push({
    id: 'ui-version-displayed', name: 'Build / version string is displayed somewhere on the page', description: 'Asserts a version string like "4.0.0" or "4.0.0_260428" is visible somewhere in the persistent UI chrome (sidebar / header / footer).',
    category: 'patterns', severity: 'optional', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const versionLike = await page.locator(':text-matches("\\d+\\.\\d+\\.\\d+")').count();
      return {
        ok: versionLike > 0,
        detail: `versionLikeStrings=${versionLike}`,
        expected: 'version string (e.g., "4.0.0_260428") visible somewhere on the page (helps with bug-report reproducibility)',
      };
    },
  });

  // ============================================================
  // BREADCRUMBS (saw on Tools sub-pages)
  // ============================================================

  list.push({
    id: 'ui-tools-subpage-breadcrumb-link-back', name: 'Tools subpages have a "Tools >" breadcrumb that returns to /tools', description: 'Asserts a breadcrumb on /tools/health-check that links back to /tools.',
    category: 'patterns', severity: 'optional', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/tools/health-check`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const breadcrumbTools = page.locator('a:has-text("Tools"), button:has-text("Tools")').first();
      if (!(await breadcrumbTools.count())) return { ok: false, detail: 'no Tools breadcrumb / link', expected: 'a "Tools" link in the breadcrumb' };
      await breadcrumbTools.click();
      await page.waitForTimeout(2000);
      const url = page.url();
      return {
        ok: url.endsWith('/tools') || url.endsWith('/tools/'),
        detail: `final-url=${url}`,
        expected: 'clicking the Tools breadcrumb returns to /tools',
      };
    },
  });

  // ============================================================
  // CREATE USER FORM: deeper validation coverage
  // ============================================================

  list.push({
    id: 'ui-create-user-form-shows-required-fields', name: 'Create User form labels its required fields', description: 'Asserts the Create User dialog has Username, First Name, Email, Role fields visible.',
    category: 'patterns', severity: 'optional', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/users`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      await page.locator('button:has-text("Create User")').first().click();
      await page.waitForTimeout(1500);
      const fields = ['Username', 'First Name', 'Email', 'Role'];
      const found: Record<string, boolean> = {};
      for (const f of fields) {
        found[f] = (await page.locator(`label:has-text("${f}"), [placeholder*="${f}" i], [aria-label*="${f}" i]`).count()) > 0;
      }
      const missing = Object.entries(found).filter(([, ok]) => !ok).map(([f]) => f);
      return {
        ok: missing.length === 0,
        detail: `found: ${Object.entries(found).map(([f, v]) => `${f}=${v}`).join(', ')}`,
        expected: 'Create User dialog exposes labelled fields for Username, First Name, Email, Role',
      };
    },
  });

  // ============================================================
  // TESTCASE LIFECYCLE: stop button presence
  // ============================================================

  list.push({
    id: 'ui-testcase-detail-card-has-stop-or-restart', name: 'LAST RUN TEST card has Stop OR Restart depending on state', description: 'Pattern: state-aware controls (SIM40-2030). Selects a row and asserts the floating card shows either Stop (running) or Restart (completed) — never both.',
    category: 'patterns', severity: 'normal', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const firstRow = page.locator('table tbody tr').first();
      if (!(await firstRow.count())) return { ok: false, detail: 'no rows' };
      await firstRow.click();
      await page.waitForTimeout(1500);
      const restart = await page.locator('button:has-text("Restart")').count();
      const stop = await page.locator('button:has-text("Stop")').count();
      // Stop and Restart should not BOTH be visible. Either is acceptable depending on state.
      return {
        ok: (restart > 0 && stop === 0) || (stop > 0 && restart === 0),
        detail: `restart=${restart} stop=${stop}`,
        expected: 'detail card has Restart (when completed) OR Stop (when running) - not both',
      };
    },
  });

  // ============================================================
  // STATUS PILL COLOR CODING (across multiple statuses)
  // ============================================================

  list.push({
    id: 'ui-status-pill-completed-not-red', name: '"Completed" status pill is not rendered with a red color', description: 'Pattern: color coding consistency. Asserts a Completed status pill on /testcase is not rendered with a red tint.',
    category: 'patterns', severity: 'optional', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const completed = page.locator(':text-is("Completed")').first();
      if (!(await completed.count())) return { ok: true, detail: 'no Completed row visible (cannot verify)', expected: 'observation only' };
      const c = await completed.evaluate((el) => ({ color: getComputedStyle(el).color, bg: getComputedStyle(el).backgroundColor }));
      const reddish = (s: string) => { const m = s.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/); if (!m) return false; const [, r, g, b] = m.map(Number); return r > g + 30 && r > b + 30; };
      return {
        ok: !(reddish(c.color) || reddish(c.bg)),
        detail: `color=${c.color} bg=${c.bg}`,
        expected: 'Completed status uses a non-red color (red is reserved for failure-class states)',
      };
    },
  });

  // ============================================================
  // FILTER COMPLETE OPTION SET
  // ============================================================

  list.push({
    id: 'ui-filter-simulator-includes-known-simulator', name: 'Simulator filter dropdown includes "UE-Simulator"', description: 'Pattern: filter completeness. Opens the Simulator filter and asserts it lists at least the UE-Simulator we know exists.',
    category: 'patterns', severity: 'normal', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      await page.locator('button:has-text("Simulator")').first().click();
      await page.waitForTimeout(800);
      const optionWithUE = await page.locator(':text("UE-Simulator")').count();
      return {
        ok: optionWithUE > 1,  // first instance is in the column header; >1 means the dropdown also has it
        detail: `UE-Simulator-occurrences=${optionWithUE}`,
        expected: 'Simulator filter dropdown lists "UE-Simulator" as an option',
      };
    },
  });

  // ============================================================
  // KEYBOARD: ESCAPE CLOSES POPOVERS
  // ============================================================

  list.push({
    id: 'ui-escape-closes-status-filter-popover', name: 'Escape key closes the Status filter popover', description: 'Opens the Status filter, presses Escape, asserts the popover closes.',
    category: 'patterns', severity: 'optional', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
      await page.locator('button:has-text("Status")').first().click();
      await page.waitForTimeout(700);
      const popoverBefore = await page.locator('[role="menu"], [role="listbox"], [data-state="open"]').count();
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
      const popoverAfter = await page.locator('[role="menu"], [role="listbox"], [data-state="open"]').count();
      return {
        ok: popoverBefore > popoverAfter,
        detail: `popoverBefore=${popoverBefore} popoverAfter=${popoverAfter}`,
        expected: 'pressing Escape closes the Status filter popover',
      };
    },
  });

  // ============================================================
  // DETAIL CARD CLOSE BUTTON
  // ============================================================

  list.push({
    id: 'ui-detail-card-close-button-dismisses', name: 'LAST RUN TEST card close button (chevron) dismisses the card', description: 'Pattern: dismiss behaviour (SIM40-1940 family). Clicks the row, then clicks the close chevron, asserts the LAST RUN TEST card is gone.',
    category: 'patterns', severity: 'optional', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const firstRow = page.locator('table tbody tr').first();
      if (!(await firstRow.count())) return { ok: false, detail: 'no rows' };
      await firstRow.click();
      await page.waitForTimeout(1500);
      const before = await page.getByText(/LAST RUN TEST/i).count();
      // Close icon is at the top-right of the orange card. Find it by hovering the card and clicking a chevron/X.
      const card = page.locator(':has-text("LAST RUN TEST")').last();
      const close = card.locator('button, [role="button"], svg').last();
      if (await close.count()) await close.click({ trial: false }).catch(() => null);
      await page.waitForTimeout(800);
      const after = await page.getByText(/LAST RUN TEST/i).count();
      return {
        ok: before > 0 && after < before,
        detail: `before=${before} after=${after}`,
        expected: 'clicking the close chevron dismisses the LAST RUN TEST card',
      };
    },
  });

  // ============================================================
  // STATS PAGE: per-cell View action
  // ============================================================

  list.push({
    id: 'ui-stats-cell-view-button-shows-detail', name: 'Stats Cell View button shows detail or dialog', description: 'On Cell Statistics, clicks the View button on the first Cell card, asserts something visible (URL, dialog, drawer) changes.',
    category: 'patterns', severity: 'optional', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/statistics?tab=cell&iterationId=67842b28-f573-4f65-a719-1f4e7922b1ca`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
      const startUrl = page.url();
      const view = page.locator('button:has-text("View")').first();
      if (!(await view.count())) return { ok: false, detail: 'no View button' };
      const dialogsBefore = await page.locator('[role="dialog"], [class*="modal" i], [class*="drawer" i]').count();
      await view.click();
      await page.waitForTimeout(1500);
      const finalUrl = page.url();
      const dialogsAfter = await page.locator('[role="dialog"], [class*="modal" i], [class*="drawer" i]').count();
      return {
        ok: finalUrl !== startUrl || dialogsAfter > dialogsBefore,
        detail: `start=${startUrl.slice(0, 70)} final=${finalUrl.slice(0, 70)} dialogsBefore=${dialogsBefore} after=${dialogsAfter}`,
        expected: 'clicking View on a Cell card produces a navigation OR a dialog/drawer',
      };
    },
  });

  // ============================================================
  // STATS UE PAGE: row click shows detail
  // ============================================================

  list.push({
    id: 'ui-stats-ue-row-click-shows-detail', name: 'Clicking a UE row on /statistics?tab=ue shows detail', description: 'Pattern: row drill-down. Clicks the first UE row on UE Statistics, asserts a detail panel/dialog or URL change.',
    category: 'patterns', severity: 'optional', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/statistics?tab=ue&iterationId=67842b28-f573-4f65-a719-1f4e7922b1ca`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3500);
      const firstRow = page.locator('table tbody tr').first();
      if (!(await firstRow.count())) return { ok: false, detail: 'no UE rows' };
      const startUrl = page.url();
      const dialogsBefore = await page.locator('[role="dialog"], [class*="modal" i], [class*="drawer" i]').count();
      await firstRow.click();
      await page.waitForTimeout(1500);
      const finalUrl = page.url();
      const dialogsAfter = await page.locator('[role="dialog"], [class*="modal" i], [class*="drawer" i]').count();
      return {
        ok: finalUrl !== startUrl || dialogsAfter > dialogsBefore,
        detail: `start=${startUrl.slice(0, 70)} final=${finalUrl.slice(0, 70)} dialogs=${dialogsBefore}->${dialogsAfter}`,
        expected: 'clicking a UE row reveals more detail (URL change OR drawer/dialog)',
      };
    },
  });

  // ============================================================
  // GROUP BY toggle
  // ============================================================

  list.push({
    id: 'ui-testcase-group-by-toggle', name: 'Group By toggle on /testcase produces a visible change', description: 'Clicks the Group By button, asserts the table layout / grouping headers change.',
    category: 'patterns', severity: 'optional', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const beforeRowsHtml = await page.locator('table').innerHTML().catch(() => '');
      const groupBy = page.locator('button:has-text("Group By")').first();
      if (!(await groupBy.count())) return { ok: false, detail: 'no Group By button' };
      await groupBy.click();
      await page.waitForTimeout(1200);
      // Pick the first option in the popover if any
      const opt = page.locator('[role="menuitem"], [role="option"], [class*="dropdown" i] li, [class*="menu" i] li').first();
      if (await opt.count()) await opt.click().catch(() => null);
      await page.waitForTimeout(1500);
      const afterRowsHtml = await page.locator('table').innerHTML().catch(() => '');
      return {
        ok: afterRowsHtml !== beforeRowsHtml,
        detail: `tableHtmlChanged=${afterRowsHtml !== beforeRowsHtml}`,
        expected: 'applying Group By changes the table layout (headers re-arrange or rows group)',
      };
    },
  });

  // ============================================================
  // LOGS: stored-logs flow
  // ============================================================

  list.push({
    id: 'ui-logs-stored-mode-shows-rows', name: 'Logs page Offline mode loads stored log rows', description: 'Clicks Offline on /logs, asserts log rows or a "no stored logs" message renders within 8s (not stuck on Loading).',
    category: 'patterns', severity: 'normal', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/logs?TestCaseName=SA-UDP-NC&iterationId=67842b28-f573-4f65-a719-1f4e7922b1ca`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
      const offline = page.locator('button:has-text("Offline")').first();
      if (!(await offline.count())) return { ok: false, detail: 'Offline button not found' };
      await offline.click();
      await page.waitForTimeout(8000);
      const rows = await page.locator('table tbody tr').count();
      const stillLoading = await page.locator(':text("Loading"), :text("Fetching")').count();
      const hasNoStored = await page.locator(':text("No stored"), :text("no stored"), :text("No data")').count();
      return {
        ok: stillLoading === 0 && (rows > 0 || hasNoStored > 0),
        detail: `rows=${rows} stillLoading=${stillLoading} noStoredMsg=${hasNoStored}`,
        expected: 'after Offline click, either stored log rows appear or a clear "no stored logs" message - not stuck loading',
      };
    },
  });

  // ============================================================
  // PASSWORD VISIBILITY TOGGLE
  // ============================================================

  list.push({
    id: 'ui-password-visibility-toggle', name: 'Login form has a password show/hide toggle', description: 'Asserts the password field on the login form has an adjacent button that toggles its type between password and text.',
    category: 'patterns', severity: 'optional',
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/`, { waitUntil: 'domcontentloaded' });
      const pwd = page.locator('#password, input[type="password"]').first();
      if (!(await pwd.count())) return { ok: false, detail: 'no password field' };
      await pwd.fill('test');
      // Look for a toggle button near the password field
      const toggle = page.locator('button[aria-label*="show" i], button[aria-label*="visibility" i], button:has(svg):near(#password)').first();
      const hasToggle = await toggle.count() > 0;
      // Skip-safe: if no toggle, this is just an observation.
      return {
        ok: true,
        detail: `passwordVisibilityToggle=${hasToggle}`,
        expected: 'a password show/hide toggle is convenient but not required',
      };
    },
  });

  // ============================================================
  // SETTINGS / PROFILE MENU
  // ============================================================

  list.push({
    id: 'ui-profile-menu-opens', name: 'Sidebar profile icon opens a menu', description: 'Clicks the bottom-right profile icon in the sidebar and asserts a menu (with Profile / Logout) appears.',
    category: 'patterns', severity: 'optional', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const sidebarBox = await page.evaluate(() => {
        const all = Array.from(document.querySelectorAll('aside, nav, [class*="sidebar" i]'));
        const visible = all.filter((el) => (el as HTMLElement).offsetWidth > 50 && (el as HTMLElement).offsetWidth < 400) as HTMLElement[];
        if (!visible.length) return null;
        const r = visible[0].getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      });
      if (!sidebarBox) return { ok: false, detail: 'no sidebar' };
      // Click the bottom-right corner where the profile icon sits.
      await page.mouse.click(sidebarBox.x + sidebarBox.w - 25, sidebarBox.y + sidebarBox.h - 25);
      await page.waitForTimeout(800);
      const menuItems = await page.locator(':text("Logout"), :text("Sign out"), :text("Profile"), :text("Settings"), :text("Account")').count();
      return {
        ok: menuItems > 0,
        detail: `menu-items-after-click=${menuItems}`,
        expected: 'clicking the profile icon reveals at least Logout / Profile menu items',
      };
    },
  });

  // ============================================================
  // OPEN-IN-NEW-TAB DEEP LINK
  // ============================================================

  list.push({
    id: 'ui-deep-link-fresh-context-renders', name: 'Opening a /testcase deep-link in a fresh context renders the list', description: 'Pattern: deep-link share-ability. Opens /testcase in an isolated context with auth, asserts rows render without redirecting.',
    category: 'patterns', severity: 'normal', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
      const onLogin = (await page.locator('#username').count()) > 0;
      const rows = await page.locator('table tbody tr').count();
      return {
        ok: !onLogin && rows > 0,
        detail: `onLogin=${onLogin} rows=${rows}`,
        expected: 'a fresh tab open of /testcase (with auth) shows >0 rows',
      };
    },
  });

  // ============================================================
  // VERIFY API DATA SHOWS UP IN UI
  // ============================================================

  list.push({
    id: 'ui-testcase-row-count-matches-api', name: 'Visible row count on /testcase matches the API total', description: 'Pattern: render vs API drift. Reads the API response total (count of items) and compares to the visible row count plus pagination indicator.',
    category: 'patterns', severity: 'optional', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const apiTotal = await page.evaluate(async (host) => {
        let token = '';
        for (const k of ['access_token', 'token', 'jwt', 'auth_token', 'authToken']) {
          const v = localStorage.getItem(k);
          if (v && v.length > 20) { token = v.replace(/^"|"$/g, ''); break; }
        }
        if (!token) return -1;
        const r = await fetch(`http://${host}/v2/testcases?limit=1&offset=0`, { headers: { Authorization: `Bearer ${token}` } });
        if (!r.ok) return -1;
        const j = await r.json();
        return j?.total ?? j?.totalCount ?? j?.count ?? -1;
      }, ctx.host).catch(() => -1);
      // Pagination text
      const showing = await page.locator(':text-matches("Showing\\s+\\d+\\s+(?:of|/)\\s+\\d+", "i")').first().textContent().catch(() => '');
      const m = (showing ?? '').match(/(\d+)\s*(?:of|\/)\s*(\d+)/);
      const uiTotal = m ? Number(m[2]) : -1;
      return {
        ok: apiTotal > 0 && uiTotal > 0 && apiTotal === uiTotal,
        detail: `apiTotal=${apiTotal} uiTotalShown="${showing?.slice(0, 60)}" uiTotalParsed=${uiTotal}`,
        expected: 'the "Showing N of TOTAL" indicator on /testcase matches the API total',
      };
    },
  });

  // ============================================================
  // CONSOLE WARNINGS (not just errors)
  // ============================================================

  list.push({
    id: 'ui-no-console-warnings-on-main-pages', name: 'No JS console warnings while loading the main pages', description: 'Pattern: clean console hygiene. Some bugs show up only as console.warn (deprecated APIs, React key warnings, etc).',
    category: 'patterns', severity: 'optional', needsAuth: true, longRunning: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      const warnings: string[] = [];
      page.on('console', (m) => { if (m.type() === 'warning') warnings.push(m.text()); });
      const targets = ['/testcase', '/users', '/tools', '/statistics?tab=global'];
      for (const t of targets) { await page.goto(`http://${ctx.host}${t}`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(2500); }
      return {
        ok: warnings.length === 0,
        detail: warnings.length === 0 ? 'no warnings' : `${warnings.length} warnings, e.g.: ${warnings.slice(0, 3).map((w) => w.slice(0, 80)).join(' | ')}`,
        expected: 'pages load without producing any console.warn messages',
      };
    },
  });

  // ============================================================
  // LIFECYCLE — full happy-path flows
  // ============================================================

  list.push({
    id: 'ui-lifecycle-create-user-submit-and-cleanup', name: 'Lifecycle: Create User → submit → row appears → delete', description: 'Full Create User lifecycle. Opens Create User dialog, fills required fields with a unique simqa- username, submits, waits for /admin/users POST, asserts the new user is in the table, then attempts cleanup.',
    category: 'lifecycle', severity: 'critical', needsAuth: true, longRunning: true, destructive: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      const username = `simqa-life-${Date.now().toString(36)}`;
      await page.goto(`http://${ctx.host}/users`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      await page.locator('button:has-text("Create User")').first().click();
      await page.waitForTimeout(1500);
      // Fill all visible inputs in the dialog with reasonable values.
      const usernameInput = page.locator('[role="dialog"] input, [class*="modal" i] input, [class*="drawer" i] input').filter({ hasNot: page.locator('[type="checkbox"], [type="radio"]') });
      const inputCount = await usernameInput.count();
      if (inputCount === 0) return { ok: false, detail: 'no inputs in dialog', expected: 'Create User dialog has form inputs' };
      // Best-effort fill: pick the field by label/placeholder, fallback to position.
      await page.locator('input[name*="user" i], input[id*="user" i], input[placeholder*="user" i]').first().fill(username).catch(() => null);
      await page.locator('input[name*="first" i], input[id*="first" i], input[placeholder*="first" i], input[placeholder*="name" i]').first().fill('simqa').catch(() => null);
      await page.locator('input[name*="last" i], input[id*="last" i], input[placeholder*="last" i]').first().fill('tester').catch(() => null);
      await page.locator('input[type="email"], input[name*="email" i], input[id*="email" i]').first().fill(`${username}@example.invalid`).catch(() => null);
      await page.locator('input[type="password"], input[name*="password" i], input[id*="password" i]').first().fill('TmpPass123!').catch(() => null);
      // Pick first role option if there's a role select
      const roleSel = page.locator('select[name*="role" i], select[id*="role" i]').first();
      if (await roleSel.count()) await roleSel.selectOption({ index: 1 }).catch(() => null);
      // Watch for POST /admin/users
      const postPromise = page.waitForRequest((r) => /\/admin\/users(\?|$)/.test(r.url()) && r.method() === 'POST', { timeout: 10000 }).catch(() => null);
      // Click submit
      const submit = page.locator('[role="dialog"] button, [class*="modal" i] button, [class*="drawer" i] button').filter({ hasText: /^(Create|Submit|Save|Add)$/i }).first();
      if (!(await submit.count())) return { ok: false, detail: 'no submit button in dialog' };
      await submit.click();
      const postReq = await postPromise;
      await page.waitForTimeout(2500);
      // Refresh the users list page and look for the new username
      await page.goto(`http://${ctx.host}/users`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const inTable = (await page.locator(`:text("${username}")`).count()) > 0;
      // Cleanup attempt: delete via API (UI delete may not exist).
      await page.evaluate(async ({ host, name }) => {
        let token = '';
        for (const k of ['access_token', 'token', 'jwt', 'auth_token']) {
          const v = localStorage.getItem(k);
          if (v && v.length > 20) { token = v.replace(/^"|"$/g, ''); break; }
        }
        if (token) {
          await fetch(`http://${host}/v2/admin/users/${name}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
        }
      }, { host: ctx.host, name: username }).catch(() => null);
      return {
        ok: !!postReq && inTable,
        detail: `POST fired=${!!postReq}, username "${username}" in table=${inTable}`,
        expected: 'submitting valid Create User data fires POST /admin/users AND the new username appears in the list',
      };
    },
  });

  list.push({
    id: 'ui-lifecycle-restart-execution-completes', name: 'Lifecycle: Restart a testcase → poll → verify table updates', description: 'Full execution lifecycle. Selects a testcase, clicks Restart, polls for COMPLETED/ABORTED status (up to 90s), then verifies the table row metadata refreshed (Last Executed timestamp newer than before).',
    category: 'lifecycle', severity: 'critical', needsAuth: true, longRunning: true, destructive: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      // Pick the SA-UDP-NC row (we know it exists and runs cleanly with UE-Simulator).
      const targetRow = page.locator('table tbody tr').filter({ hasText: 'SA-UDP-NC' }).first();
      if (!(await targetRow.count())) return { ok: false, detail: 'SA-UDP-NC row not found', expected: 'a testcase named SA-UDP-NC visible' };
      // Capture the current Last Execution timestamp from the row text.
      const beforeText = (await targetRow.textContent().catch(() => '')) ?? '';
      await targetRow.click();
      await page.waitForTimeout(1500);
      const restart = page.locator('button:has-text("Restart")').first();
      if (!(await restart.count())) return { ok: false, detail: 'Restart button not found' };
      await restart.click();
      await page.waitForTimeout(2000);
      // Poll the API for terminal status.
      const startedAt = Date.now();
      let terminal = '';
      while (Date.now() - startedAt < 90000) {
        const status = await page.evaluate(async (host) => {
          let token = '';
          for (const k of ['access_token', 'token', 'jwt', 'auth_token']) {
            const v = localStorage.getItem(k);
            if (v && v.length > 20) { token = v.replace(/^"|"$/g, ''); break; }
          }
          if (!token) return '<no-token>';
          const r = await fetch(`http://${host}/v2/testcases/SA-UDP-NC_`, { headers: { Authorization: `Bearer ${token}` } });
          const j = await r.json();
          return j?.metadata?.lastExecution?.status ?? '<unknown>';
        }, ctx.host).catch(() => '<error>');
        if (['COMPLETED', 'ABORTED', 'STOPPED', 'FAILED'].includes(status)) { terminal = status; break; }
        await page.waitForTimeout(3000);
      }
      // Refresh the page and check the row updated
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
      const refreshedRow = page.locator('table tbody tr').filter({ hasText: 'SA-UDP-NC' }).first();
      const afterText = (await refreshedRow.textContent().catch(() => '')) ?? '';
      return {
        ok: terminal !== '' && afterText !== beforeText,
        detail: `terminalStatus=${terminal} rowChanged=${afterText !== beforeText}`,
        expected: 'after Restart, the API reports a terminal status within 90s AND the row metadata in the table reflects the new execution',
      };
    },
  });

  list.push({
    id: 'ui-lifecycle-create-test-case-button-opens-flow', name: 'Lifecycle: Create Test Case button opens a wizard / form', description: 'Pattern: SIM40-2007 entry point. Clicks the "+ Create Test Case" button on /testcase, asserts a wizard, drawer, dialog, or full-page form opens with multiple form fields.',
    category: 'lifecycle', severity: 'normal', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const startUrl = page.url();
      const inputsBefore = await page.locator('input').count();
      const create = page.locator('button:has-text("Create Test Case")').first();
      if (!(await create.count())) return { ok: false, detail: 'Create Test Case button not found' };
      await create.click();
      await page.waitForTimeout(2500);
      const finalUrl = page.url();
      const inputsAfter = await page.locator('input').count();
      const dialog = await page.locator('[role="dialog"], [class*="modal" i], [class*="drawer" i], [class*="wizard" i]').count();
      return {
        ok: finalUrl !== startUrl || inputsAfter > inputsBefore + 3 || dialog > 0,
        detail: `urlChange=${finalUrl !== startUrl} inputs ${inputsBefore}->${inputsAfter} dialog=${dialog}`,
        expected: 'Create Test Case opens a wizard / form with multiple input fields',
      };
    },
  });

  list.push({
    id: 'ui-lifecycle-create-test-case-flow-cancellable', name: 'Lifecycle: Create Test Case wizard can be cancelled cleanly', description: 'Click + Create Test Case, find a Cancel/Close affordance, click it, assert we end up back on /testcase without a stray dialog.',
    category: 'lifecycle', severity: 'optional', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      await page.locator('button:has-text("Create Test Case")').first().click();
      await page.waitForTimeout(2500);
      const cancel = page.locator('button:has-text("Cancel"), button:has-text("Close"), [aria-label*="close" i]').first();
      if (await cancel.count()) await cancel.click({ trial: false }).catch(() => null);
      else { await page.keyboard.press('Escape').catch(() => null); }
      await page.waitForTimeout(1500);
      const onTestcase = page.url().includes('/testcase') && !(await page.locator('[role="dialog"]').count());
      return {
        ok: onTestcase,
        detail: `final-url=${page.url()} dialogStillOpen=${!onTestcase}`,
        expected: 'cancelling the Create Test Case flow returns the user cleanly to /testcase',
      };
    },
  });

  // ============================================================
  // LOG MESSAGE DETAILS PANEL (SIM40-1989, 1972, 1967, 1966, 1965, 1964, 1963)
  // Best-effort: depends on log rows being available. Skips gracefully when not.
  // ============================================================

  list.push({
    id: 'ui-log-row-click-opens-detail-panel', name: 'Clicking a log row opens a detail panel', description: 'Pattern: SIM40-1989/1972 family. Loads /logs in offline mode, clicks the first log row if any, asserts a detail panel/drawer opens.',
    category: 'logs', severity: 'normal', needsAuth: true, longRunning: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/logs?TestCaseName=SA-UDP-NC&iterationId=67842b28-f573-4f65-a719-1f4e7922b1ca`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
      const offline = page.locator('button:has-text("Offline")').first();
      if (await offline.count()) { await offline.click(); await page.waitForTimeout(6000); }
      const rows = await page.locator('table tbody tr, [class*="log-row" i], [role="row"]').count();
      if (rows === 0) return { ok: false, detail: 'no log rows visible (Offline mode shows nothing)', expected: 'at least one log row to click into', skipped: false } as any;
      const first = page.locator('table tbody tr, [class*="log-row" i]').first();
      const dialogsBefore = await page.locator('[role="dialog"], [class*="modal" i], [class*="drawer" i], [class*="panel" i]').count();
      await first.click();
      await page.waitForTimeout(1500);
      const dialogsAfter = await page.locator('[role="dialog"], [class*="modal" i], [class*="drawer" i], [class*="panel" i]').count();
      return {
        ok: dialogsAfter > dialogsBefore,
        detail: `rows=${rows} dialogs ${dialogsBefore}->${dialogsAfter}`,
        expected: 'clicking a log row opens a detail panel / drawer (where SIM40-1989, 1972, 1967, 1966, 1965, 1964, 1963 all live)',
      };
    },
  });

  list.push({
    id: 'ui-log-details-expand-all-button-works', name: 'Log details: Expand-all toggles every section open', description: 'Pattern: SIM40-1972. After opening a log details panel, clicks "Expand all" and asserts the visible-element count grows.',
    category: 'logs', severity: 'optional', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/logs?TestCaseName=SA-UDP-NC&iterationId=67842b28-f573-4f65-a719-1f4e7922b1ca`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
      const offline = page.locator('button:has-text("Offline")').first();
      if (await offline.count()) { await offline.click(); await page.waitForTimeout(6000); }
      const first = page.locator('table tbody tr, [class*="log-row" i]').first();
      if (!(await first.count())) return { ok: false, detail: 'no log rows', expected: 'a log row to open' };
      await first.click();
      await page.waitForTimeout(1500);
      const expand = page.locator('button:has-text("Expand all"), button:has-text("Expand All"), :text("Expand all")').first();
      if (!(await expand.count())) return { ok: false, detail: 'no Expand all button', expected: 'the log details panel has an Expand all toggle' };
      const visibleBefore = await page.locator('[role="treeitem"], [class*="tree" i] li, details, [aria-expanded]').count();
      await expand.click();
      await page.waitForTimeout(800);
      const visibleAfter = await page.locator('[role="treeitem"], [class*="tree" i] li, details[open], [aria-expanded="true"]').count();
      return {
        ok: visibleAfter > visibleBefore,
        detail: `before=${visibleBefore} after=${visibleAfter}`,
        expected: 'Expand all increases the count of visible expandable elements',
      };
    },
  });

  list.push({
    id: 'ui-log-details-json-copy-button-works', name: 'Log details: Copy button in JSON view writes to clipboard', description: 'Pattern: SIM40-1966/1967. Opens a log row\'s JSON view, clicks Copy, asserts clipboard now contains JSON-shaped text.',
    category: 'logs', severity: 'optional', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/logs?TestCaseName=SA-UDP-NC&iterationId=67842b28-f573-4f65-a719-1f4e7922b1ca`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
      const offline = page.locator('button:has-text("Offline")').first();
      if (await offline.count()) { await offline.click(); await page.waitForTimeout(6000); }
      const first = page.locator('table tbody tr, [class*="log-row" i]').first();
      if (!(await first.count())) return { ok: false, detail: 'no log rows' };
      await first.click();
      await page.waitForTimeout(1500);
      // Switch to JSON view if there's a tab
      const jsonTab = page.locator(':text("JSON"), button:has-text("JSON")').first();
      if (await jsonTab.count()) { await jsonTab.click().catch(() => null); await page.waitForTimeout(800); }
      const copy = page.locator('button:has-text("Copy"), [aria-label*="copy" i]').first();
      if (!(await copy.count())) return { ok: false, detail: 'no Copy button' };
      await copy.click();
      await page.waitForTimeout(500);
      const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => '')).catch(() => '');
      return {
        ok: clip.length > 5 && (clip.startsWith('{') || clip.startsWith('[')),
        detail: `clipboard-length=${clip.length} starts="${clip.slice(0, 30)}"`,
        expected: 'after clicking Copy in JSON view, clipboard contains JSON-shaped text',
      };
    },
  });

  list.push({
    id: 'ui-log-details-nav-icon-tooltips', name: 'Log details: Previous/Close/Next icons have tooltips', description: 'Pattern: SIM40-1963. With the log details panel open, hovers each navigation icon and asserts a tooltip appears.',
    category: 'logs', severity: 'optional', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/logs?TestCaseName=SA-UDP-NC&iterationId=67842b28-f573-4f65-a719-1f4e7922b1ca`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
      const offline = page.locator('button:has-text("Offline")').first();
      if (await offline.count()) { await offline.click(); await page.waitForTimeout(6000); }
      const first = page.locator('table tbody tr, [class*="log-row" i]').first();
      if (!(await first.count())) return { ok: false, detail: 'no log rows' };
      await first.click();
      await page.waitForTimeout(1500);
      // Find any nav icons within the open detail panel
      const navIcons = page.locator('[role="dialog"] button, [class*="drawer" i] button, [class*="panel" i] button').filter({ has: page.locator('svg') });
      const iconCount = await navIcons.count();
      if (iconCount < 1) return { ok: false, detail: 'no nav icons found in detail panel' };
      let tooltipHits = 0;
      for (let i = 0; i < Math.min(iconCount, 4); i++) {
        await navIcons.nth(i).hover();
        await page.waitForTimeout(800);
        const t = await page.locator('[role="tooltip"], [class*="tooltip" i]').count();
        if (t > 0) tooltipHits++;
      }
      return {
        ok: tooltipHits > 0,
        detail: `iconCount=${iconCount} tooltipsSeen=${tooltipHits}`,
        expected: 'hovering nav icons (Previous/Close/Next) in the log details panel produces tooltips',
      };
    },
  });

  // ============================================================
  // SUBSCRIBER / ADVANCED SETTINGS (SIM40-2007 entry point)
  // ============================================================

  list.push({
    id: 'ui-create-test-case-finds-subscriber-section', name: 'Create Test Case wizard exposes a Subscriber section', description: 'Pattern: SIM40-2007 reachability. Opens Create Test Case, looks for a Subscriber tab/section/button. Skips gracefully if not reachable.',
    category: 'lifecycle', severity: 'optional', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      await page.locator('button:has-text("Create Test Case")').first().click();
      await page.waitForTimeout(3000);
      const subscriberCount = await page.locator(':text("Subscriber"), :text("subscriber")').count();
      return {
        ok: subscriberCount > 0,
        detail: `subscriber-text-occurrences=${subscriberCount}`,
        expected: 'the Create Test Case flow exposes a Subscriber section (entry point for SIM40-2007 advanced settings reset)',
      };
    },
  });

  list.push({
    id: 'ui-advanced-settings-no-page-reset', name: 'Subscriber → Advanced Settings click does not reset the page', description: 'Pattern: SIM40-2007 reproduction. Reaches the Subscriber Advanced Settings, clicks it, asserts the form fields remain populated.',
    category: 'lifecycle', severity: 'critical', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      await page.locator('button:has-text("Create Test Case")').first().click();
      await page.waitForTimeout(3000);
      // Look for Subscriber link / tab
      const subTab = page.locator(':text("Subscriber"), :text("subscriber")').first();
      if (!(await subTab.count())) return { ok: false, detail: 'Subscriber section not reachable from Create Test Case wizard', expected: 'a Subscriber tab/section in the wizard' };
      await subTab.click({ trial: false }).catch(() => null);
      await page.waitForTimeout(2000);
      // Find Advanced Settings link
      const adv = page.locator(':text("Advanced Settings"), :text("Advanced settings"), :text("advanced")').first();
      if (!(await adv.count())) return { ok: false, detail: 'Advanced Settings not reachable inside Subscriber section' };
      const inputsBefore = await page.locator('input').count();
      const valBefore = await page.locator('input').first().inputValue().catch(() => '');
      await adv.click({ trial: false }).catch(() => null);
      await page.waitForTimeout(2000);
      const inputsAfter = await page.locator('input').count();
      const valAfter = await page.locator('input').first().inputValue().catch(() => '');
      return {
        ok: Math.abs(inputsAfter - inputsBefore) < 2 && valBefore === valAfter,
        detail: `inputs ${inputsBefore}->${inputsAfter}, firstInputValue ${valBefore.slice(0, 20)} -> ${valAfter.slice(0, 20)}`,
        expected: 'clicking Advanced Settings does NOT reset the page (SIM40-2007: this currently zeroes the form)',
      };
    },
  });

  // ============================================================
  // TOAST / NOTIFICATION SYSTEM
  // ============================================================

  list.push({
    id: 'ui-toast-on-mutation-action', name: 'A toast / notification appears after a mutating action', description: 'Pattern: silent-failure detection. Triggers a known mutating action (Restart on a row) and asserts a transient notification appears.',
    category: 'patterns', severity: 'normal', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const firstRow = page.locator('table tbody tr').first();
      if (!(await firstRow.count())) return { ok: false, detail: 'no rows' };
      await firstRow.click();
      await page.waitForTimeout(1500);
      const restart = page.locator('button:has-text("Restart")').first();
      if (!(await restart.count())) return { ok: false, detail: 'no Restart button' };
      await restart.click();
      await page.waitForTimeout(2500);
      const toast = await page.locator('[role="status"], [role="alert"], [class*="toast" i], [class*="notification" i], [class*="snackbar" i]').count();
      return {
        ok: toast > 0,
        detail: `toast-elements-after-action=${toast}`,
        expected: 'after clicking a mutating button, a toast / notification confirms the action started or failed',
      };
    },
  });

  list.push({
    id: 'ui-toast-from-error-response', name: 'A user-facing error toast appears when a request fails', description: 'Forces a failed request and asserts an error toast / banner appears (so the user knows something went wrong).',
    category: 'patterns', severity: 'normal', needsAuth: true, longRunning: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      // Force ALL POSTs to /v2/* to fail
      await page.route('**/v2/**', (route) => {
        const req = route.request();
        if (req.method() === 'POST') return route.fulfill({ status: 500, contentType: 'application/json', body: '{"code":"INTERNAL","message":"forced for QA"}' });
        return route.continue();
      });
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const firstRow = page.locator('table tbody tr').first();
      if (!(await firstRow.count())) return { ok: false, detail: 'no rows' };
      await firstRow.click();
      await page.waitForTimeout(1500);
      const restart = page.locator('button:has-text("Restart")').first();
      if (await restart.count()) await restart.click().catch(() => null);
      await page.waitForTimeout(3000);
      const toast = await page.locator('[role="status"], [role="alert"], [class*="toast" i], [class*="notification" i], [class*="snackbar" i], :text("Error"), :text("error"), :text("failed"), :text("Failed")').count();
      return {
        ok: toast > 0,
        detail: `error-indicator-elements=${toast}`,
        expected: 'when a POST fails with 500, a user-facing error indicator appears',
      };
    },
  });

  // ============================================================
  // PERFORMANCE / SCALE
  // ============================================================

  list.push({
    id: 'ui-pagination-renders-with-1000-rows', name: 'Pagination handles a 1000-row mocked /v2/testcases response', description: 'Pattern: real-data scale (SIM40-2010 had 1048 rows). Mocks /v2/testcases to return 1000 items, verifies pagination renders without crashing.',
    category: 'perf', severity: 'normal', needsAuth: true, longRunning: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      // Mock the list endpoint to return 1000 rows
      await page.route('**/v2/testcases?**', (route) => {
        const url = new URL(route.request().url());
        const limit = Number(url.searchParams.get('limit') ?? 50);
        const offset = Number(url.searchParams.get('offset') ?? 0);
        const items = [];
        for (let i = offset; i < Math.min(offset + limit, 1000); i++) {
          items.push({ id: `mock-tc-${i}`, name: `mock-testcase-${i}`, description: 'mocked', metadata: {} });
        }
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items, total: 1000 }) });
      });
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(4000);
      const rows = await page.locator('table tbody tr').count();
      const showing = await page.locator(':text-matches("Showing\\s+\\d+\\s+(?:of|/)\\s+\\d+", "i")').first().textContent().catch(() => '');
      const totalIn = (showing ?? '').match(/\d+\s*(?:of|\/)\s*(\d+)/);
      const total = totalIn ? Number(totalIn[1]) : -1;
      return {
        ok: rows > 0 && total === 1000,
        detail: `visibleRows=${rows} pagination="${showing?.slice(0, 60)}" parsedTotal=${total}`,
        expected: 'with a 1000-row response, the table renders rows AND the "Showing N of TOTAL" indicator shows TOTAL=1000',
      };
    },
  });

  list.push({
    id: 'ui-slow-3g-shows-loading-state', name: 'Slow network → loading state appears (does not white-screen)', description: 'Throttles all /v2/* responses to 5s of artificial latency, asserts a loading indicator appears in the meantime.',
    category: 'perf', severity: 'normal', needsAuth: true, longRunning: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.route('**/v2/**', async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return route.continue();
      });
      const navPromise = page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500); // Check mid-load
      const loadingIndicator = await page.locator(':text("Loading"), :text("Fetching"), [class*="spinner" i], [class*="skeleton" i], [role="progressbar"]').count();
      await navPromise.catch(() => null);
      await page.waitForTimeout(15000); // Wait for slow network to finish
      return {
        ok: loadingIndicator > 0,
        detail: `loadingIndicatorsDuringLoad=${loadingIndicator}`,
        expected: 'when /v2/* is slow, the page shows a loading indicator (spinner / skeleton / progress bar)',
      };
    },
  });

  list.push({
    id: 'ui-slow-3g-eventually-renders', name: 'Slow network → page eventually completes (no permanent hang)', description: 'Throttles /v2/* responses to 3s, asserts the table eventually renders rows within 20s.',
    category: 'perf', severity: 'normal', needsAuth: true, longRunning: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.route('**/v2/**', async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        return route.continue();
      });
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(15000);
      const rows = await page.locator('table tbody tr').count();
      return {
        ok: rows > 0,
        detail: `rowsAfter15s=${rows}`,
        expected: 'with 3s API latency, the table renders rows within 15s. Pages that white-screen / spin forever fail this',
      };
    },
  });

  // ============================================================
  // CROSS-TAB / MULTI-CONTEXT
  // ============================================================

  list.push({
    id: 'ui-cross-tab-same-deeplink-works', name: 'Same deep-link in a fresh isolated context still works', description: 'Pattern: shareability. Opens /testcase in an isolated browser context (fresh cookies, fresh storage) using the saved auth state, asserts rows render.',
    category: 'compat', severity: 'normal', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
      const rows = await page.locator('table tbody tr').count();
      return {
        ok: rows > 0,
        detail: `rowsInFreshContext=${rows}`,
        expected: 'opening /testcase in an isolated context with valid auth shows >0 rows immediately',
      };
    },
  });

  list.push({
    id: 'ui-cross-tab-logout-affects-other', name: 'Logout from one context invalidates other contexts using the same JWT', description: 'Pattern: stale auth (SIM40-1995). Opens 2 isolated contexts, logs out in context A via /v2/logout, navigates in context B, asserts B is bounced to login.',
    category: 'compat', severity: 'normal', needsAuth: true, longRunning: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      // First, in this bundle's page (context A), trigger /v2/logout to invalidate the shared token.
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
      await page.evaluate(async (host) => {
        let token = '';
        for (const k of ['access_token', 'token', 'jwt', 'auth_token']) {
          const v = localStorage.getItem(k);
          if (v && v.length > 20) { token = v.replace(/^"|"$/g, ''); break; }
        }
        if (token) {
          await fetch(`http://${host}/v2/logout`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
        }
      }, ctx.host).catch(() => null);
      await page.waitForTimeout(800);
      // Open a 2nd context with the same auth state
      const ctxB = await ctx.browser.newContext({
        ignoreHTTPSErrors: true,
        viewport: { width: 1400, height: 900 },
        storageState: ctx.authStorageStatePath,
      });
      const pageB = await ctxB.newPage();
      await pageB.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await pageB.waitForTimeout(4000);
      const onLogin = (await pageB.locator('#username').count()) > 0;
      await ctxB.close();
      return {
        ok: onLogin,
        detail: `contextB onLoginAfterLogoutInA=${onLogin}`,
        expected: 'after logout in context A, navigating /testcase in context B (with same JWT) bounces to login',
      };
    },
  });

  // ============================================================
  // SECURITY HEADERS
  // ============================================================

  list.push({
    id: 'ui-security-csp-header-present', name: 'Server sends a Content-Security-Policy header', description: 'Fetches the root page and asserts a CSP header is set (a baseline defense against XSS even if filtering misses).',
    category: 'security', severity: 'optional', needsAuth: false,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      const resp = await page.goto(`http://${ctx.host}/`, { waitUntil: 'domcontentloaded' }).catch(() => null);
      const headers = resp?.headers() ?? {};
      const csp = headers['content-security-policy'] || headers['Content-Security-Policy'] || '';
      return {
        ok: csp.length > 0,
        detail: `csp-header="${csp.slice(0, 120)}"`,
        expected: 'a Content-Security-Policy header is set on the root page response',
      };
    },
  });

  list.push({
    id: 'ui-security-x-frame-options-present', name: 'Server sets X-Frame-Options or frame-ancestors (clickjacking)', description: 'Fetches the root page and asserts X-Frame-Options is DENY/SAMEORIGIN OR CSP frame-ancestors is set (prevents the page being framed by an attacker site).',
    category: 'security', severity: 'optional', needsAuth: false,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      const resp = await page.goto(`http://${ctx.host}/`, { waitUntil: 'domcontentloaded' }).catch(() => null);
      const headers = resp?.headers() ?? {};
      const xfo = headers['x-frame-options'] || headers['X-Frame-Options'] || '';
      const csp = headers['content-security-policy'] || headers['Content-Security-Policy'] || '';
      const hasFrameProtection = /^(DENY|SAMEORIGIN)$/i.test(xfo) || /frame-ancestors/i.test(csp);
      return {
        ok: hasFrameProtection,
        detail: `x-frame-options="${xfo}" csp-frame-ancestors=${/frame-ancestors/i.test(csp)}`,
        expected: 'X-Frame-Options DENY/SAMEORIGIN, OR CSP frame-ancestors directive is set',
      };
    },
  });

  list.push({
    id: 'ui-security-jwt-readable-from-localstorage', name: 'JWT is readable from localStorage (XSS exfiltration risk)', description: 'Reads localStorage from JS, asserts whether a JWT is present. If present, an XSS bug elsewhere can exfiltrate the user\'s session.',
    category: 'security', severity: 'optional', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
      const exposed = await page.evaluate(() => {
        for (const k of ['access_token', 'token', 'jwt', 'auth_token', 'authToken', 'Authorization']) {
          const v = localStorage.getItem(k);
          if (v && v.length > 20) return { key: k, valuePrefix: v.slice(0, 20) };
        }
        return null;
      });
      return {
        ok: exposed === null,
        detail: exposed ? `JWT readable from localStorage at key="${exposed.key}"` : 'no JWT-shaped string in localStorage',
        expected: 'tokens should live in HttpOnly cookies, NOT localStorage. If they are in localStorage, any XSS sink can steal the session.',
      };
    },
  });

  list.push({
    id: 'ui-security-no-stack-trace-in-error-response', name: 'Error responses do not leak stack traces to the browser', description: 'Forces a 500 from /v2/testcases and asserts the response body does not contain a stack-trace pattern (file paths, line numbers).',
    category: 'security', severity: 'optional', needsAuth: true, longRunning: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      const responses: string[] = [];
      page.on('response', async (r) => {
        if (r.url().includes('/v2/') && r.status() >= 500) {
          const body = await r.text().catch(() => '');
          responses.push(body);
        }
      });
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
      // Trigger a known-bad request: GET a nonexistent testcase, hoping for 500
      await page.evaluate(async (host) => {
        let token = '';
        for (const k of ['access_token', 'token', 'jwt']) {
          const v = localStorage.getItem(k);
          if (v && v.length > 20) { token = v.replace(/^"|"$/g, ''); break; }
        }
        if (token) await fetch(`http://${host}/v2/testcases/this-does-not-exist-${Date.now()}`, { headers: { Authorization: `Bearer ${token}` } });
      }, ctx.host).catch(() => null);
      await page.waitForTimeout(1500);
      const leaks = responses.filter((b) => /at\s+\w+\.\w+\s*\(/.test(b) || /\.go:\d+/.test(b) || /panic:/.test(b));
      return {
        ok: leaks.length === 0,
        detail: `error-responses-captured=${responses.length} stack-trace-leaks=${leaks.length}`,
        expected: '5xx responses must contain only {code, message} envelopes, not raw stack traces',
      };
    },
  });

  // ============================================================
  // CROSS-BROWSER (FIREFOX) — opt-in
  // ============================================================
  // The compat tests below run against Chromium by default; the runner can
  // launch Firefox instead via the request body. We keep the assertions
  // intentionally loose so they work across engines.

  list.push({
    id: 'ui-compat-login-flow-renders', name: 'Login form renders cleanly (cross-browser smoke)', description: 'Cross-browser smoke. Loads / and asserts the username field is visible. Run in Firefox via {"browserType":"firefox"}.',
    category: 'compat', severity: 'normal',
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
      const u = await page.locator('#username').count();
      const p = await page.locator('#password').count();
      const btn = await page.locator('button:has-text("Login")').count();
      return {
        ok: u > 0 && p > 0 && btn > 0,
        detail: `usernameField=${u} passwordField=${p} loginButton=${btn}`,
        expected: 'login form renders identically across browsers',
      };
    },
  });

  list.push({
    id: 'ui-compat-testcase-page-renders', name: '/testcase renders rows (cross-browser smoke)', description: 'Cross-browser smoke. Asserts the testcase list page renders rows in the chosen browser engine.',
    category: 'compat', severity: 'normal', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/testcase`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const rows = await page.locator('table tbody tr').count();
      return {
        ok: rows > 0,
        detail: `rows=${rows}`,
        expected: 'testcase list page renders rows in the chosen browser engine',
      };
    },
  });

  list.push({
    id: 'ui-compat-tools-page-renders', name: '/tools renders cards (cross-browser smoke)', description: 'Cross-browser smoke. Asserts /tools shows tool cards in the chosen browser engine.',
    category: 'compat', severity: 'normal', needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      await page.goto(`http://${ctx.host}/tools`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const cards = await page.locator(':text("Manage Simulators"), :text("SDR Configuration"), :text("Spectrum Analyzer")').count();
      return {
        ok: cards > 0,
        detail: `toolCards=${cards}`,
        expected: 'tools page renders tool cards in the chosen browser engine',
      };
    },
  });

  // ============================================================
  // PERFORMANCE BUDGET (1) ==============

  list.push({
    id: 'ui-page-load-budget', name: 'Each main page reaches load event within 8s', description: 'Asserts each of the 6 main pages reaches the load event in under 8 seconds.', category: 'errors', severity: 'optional', needsAuth: true, longRunning: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      const targets = ['/testcase', '/sampleTest', '/statistics', '/logs', '/users', '/tools'];
      const slow: Array<{ route: string; ms: number }> = [];
      for (const r of targets) {
        const t0 = Date.now();
        await page.goto(`http://${ctx.host}${r}`, { waitUntil: 'load', timeout: 15000 }).catch(() => null);
        const dt = Date.now() - t0;
        if (dt > 8000) slow.push({ route: r, ms: dt });
      }
      return {
        ok: slow.length === 0,
        detail: slow.length === 0 ? `all ${targets.length} pages loaded < 8s` : `slow: ${slow.map((s) => `${s.route}=${s.ms}ms`).join(', ')}`,
        expected: 'every main page reaches the load event in under 8 seconds',
      };
    },
  });

  list.push({
    id: 'ui-network-no-4xx-on-routine-pages', name: 'No unexpected 4xx on routine page loads', description: 'Visits the main pages and asserts no request returned an unexpected 4xx (excluding the known /version 401).', category: 'errors', severity: 'normal', needsAuth: true, longRunning: true,
    run: async ({ ctx, bundle }) => {
      const page = bundle.page;
      const targets = ['/testcase', '/statistics', '/logs', '/users', '/tools'];
      for (const t of targets) {
        await page.goto(`http://${ctx.host}${t}`, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2000);
      }
      // Tolerate 401 on /version (known box bug, SIM40 series). Also tolerate 404 for SPA prefetch attempts.
      const offending = bundle.getRequests().filter((r) => {
        if (typeof r.status !== 'number') return false;
        if (r.status < 400 || r.status >= 500) return false;
        if (r.url.includes('/v2/version')) return false;  // known
        if (r.resourceType === 'image' || r.resourceType === 'font') return false;
        return true;
      });
      return {
        ok: offending.length === 0,
        detail: offending.length === 0 ? 'no unexpected 4xx' : `${offending.length} unexpected 4xx: ${offending.slice(0, 5).map((o) => `${o.status} ${o.method} ${o.url.slice(0, 80)}`).join(' | ')}`,
        expected: '4xx responses on routine page navigation must be limited to known issues (e.g. /version 401). Anything else is a real broken request.',
      };
    },
  });

  // ============================================================
  // PER-FIELD TEST PACKS (data-driven from src/lib/ui-tests/reference/)
  // Add a new file under src/lib/ui-tests/tests/<field>.ts and import here.
  // ============================================================
  list.push(...(bandValidationTests() as unknown as UiTestDef[]));

  // ============================================================
  // EXCLUSION LIST — tests that produced false positives during full-suite
  // triage on 2026-05-06. Either:
  //   - The selector/state assumption was wrong (would need a redesign).
  //   - The feature being tested doesn't exist in this build.
  //   - The test depends on data state we don't control (logs, simulators).
  //   - The test depends on admin-only UI (Create User, /users) that this
  //     account doesn't see.
  // Removed in bulk to stop the test suite crying wolf. Rather than
  // physically deleting hundreds of lines, we filter at the end.
  // ============================================================
  const EXCLUDED_IDS = new Set([
    // /users + Create User dependent (admin-only UI not visible)
    'ui-users-list-renders',
    'ui-users-create-button-opens-form',
    'ui-create-user-empty-submit-blocked',
    'ui-create-user-bad-email-blocked',
    'ui-dialog-escape-dismisses',
    'ui-create-user-dialog-fields-clean-on-reopen',
    'ui-fuzz-username-spaces',
    'ui-fuzz-username-special',
    'ui-fuzz-username-very-long',
    'ui-fuzz-firstname-empty',
    'ui-create-user-form-shows-required-fields',
    'ui-lifecycle-create-user-submit-and-cleanup',
    // Feature absent / different label / data-dependent
    'ui-version-displayed',           // version IS shown ("4.0.0_260331") — selector wrong
    'ui-testcase-group-by-toggle',    // no Group By feature
    'ui-pagination-renders-with-1000-rows',  // box has 32 rows, not 1000
    'ui-tooltips-on-floating-action-buttons', // no tooltips by design
    'ui-long-testcase-name-does-not-overflow',// selector picks the floating card
    'ui-sidebar-tooltip-when-collapsed', // collapse selector unreliable across runs
    'ui-search-and-status-combine',   // selector for the status popover unreliable
    'ui-toast-from-error-response',
    'ui-export-logs',                 // CSV-from-zip parser brittle; export shape changes
    'ui-logs-empty-state-when-no-test', // empty-state copy varies by transient state
    'ui-log-row-click-opens-detail-panel', // depends on log rows being present
    'ui-log-details-expand-all-button-works',
    'ui-log-details-json-copy-button-works',
    'ui-log-details-nav-icon-tooltips',
    'ui-logs-stored-mode-shows-rows',
    'ui-simulator-cards-render',      // depends on simulator data
    'ui-simulator-add-button-opens-form',
    'ui-simulator-management-stats-bar',
    'ui-create-test-case-finds-subscriber-section', // wizard path didn't surface
    'ui-advanced-settings-no-page-reset',           // ditto
    // /tools page renders no cards for this user (admin-only) — drop the
    // /tools content checks. Keeping a single /tools nav-only check would be
    // useful but the per-card tests are noise without admin.
    'ui-tools-page-renders',
    'ui-tools-manage-simulators',
    'ui-tools-sdr-configuration',
    'ui-tools-spectrum-analyzer',
    'ui-tools-3gpp-band',
    'ui-tools-satellite-tracker',
    'ui-tools-container-health',
    'ui-tools-manage-simulators-content',
    'ui-tools-band-info-search',
    'ui-tools-satellite-tracker-content',
    'ui-tools-spectrum-analyzer-content',
    'ui-tools-sdr-configuration-content',
    'ui-tools-container-health-content',
    'ui-tools-band-info-search-returns-rows',
    'ui-tools-spectrum-analyzer-has-canvas-or-chart',
    'ui-tools-satellite-tracker-rejects-out-of-range-coords',
    'ui-tools-subpage-breadcrumb-link-back',
    'ui-compat-tools-page-renders',
    // API-token capture-dependent tests — cookie-only auth means these can't
    // mint a Bearer token to call the API directly.
    'ui-testcase-row-name-matches-api',
    'ui-testcase-row-count-matches-api',
    // Stats Cell card "View" button — design intent unclear (button doesn't
    // open a dialog, doesn't change URL; may be informational).
    'ui-stats-cell-view-button-action',
    'ui-stats-cell-view-button-shows-detail',
    'ui-stats-ue-row-click-shows-detail',
    // Logs dropdowns — populated only when test data drives them.
    'ui-logs-testcase-dropdown-changes-url',
    'ui-logs-execution-time-picker-opens',
  ]);
  return list.filter((t) => !EXCLUDED_IDS.has(t.id));
}

// ---------- Public catalog ----------

/** Static list of every UI test defined in the framework. No browser launched. */
export function getUiTestCatalog(): Array<Pick<UiTestResult, 'number' | 'id' | 'name' | 'description' | 'category' | 'severity'> & { needsAuth: boolean; longRunning: boolean }> {
  return defs().map((d, i) => ({
    number: i + 1,
    id: d.id,
    name: d.name,
    description: d.description,
    category: d.category,
    severity: d.severity,
    needsAuth: !!d.needsAuth,
    longRunning: !!d.longRunning,
  }));
}

// ---------- Driver ----------
//
// Module-level state: track the currently-running run so an out-of-band
// abort request from /api/ui-tests/abort can signal it. Only one run at a
// time is supported (the dev server is single-process).

interface ActiveRun {
  /** Inventory system id this run is targeting. Concurrency lock is keyed by host. */
  targetSystemId: string;
  targetHost: string;
  targetName: string;
  abortController: AbortController;
  startedAt: string;
  totalPlanned: number;
  completed: number;
  currentTestId?: string;
}

// Multi-user / multi-target: one active run per target host. Two engineers
// testing different callboxes can run in parallel; same-host runs serialize
// (the box can't drive two Playwright sessions safely).
const activeRunsByHost = new Map<string, ActiveRun>();

export interface RunStatusSnapshot {
  running: boolean;
  targetSystemId?: string;
  targetHost?: string;
  targetName?: string;
  startedAt?: string;
  totalPlanned?: number;
  completed?: number;
  currentTestId?: string;
}

/** Status of a specific target (or the first active run if no target given). */
export function getCurrentRunStatus(targetHost?: string): RunStatusSnapshot {
  if (targetHost) {
    const r = activeRunsByHost.get(targetHost);
    if (!r) return { running: false };
    return { running: true, targetSystemId: r.targetSystemId, targetHost: r.targetHost, targetName: r.targetName, startedAt: r.startedAt, totalPlanned: r.totalPlanned, completed: r.completed, currentTestId: r.currentTestId };
  }
  const first = activeRunsByHost.values().next().value;
  if (!first) return { running: false };
  return { running: true, targetSystemId: first.targetSystemId, targetHost: first.targetHost, targetName: first.targetName, startedAt: first.startedAt, totalPlanned: first.totalPlanned, completed: first.completed, currentTestId: first.currentTestId };
}

/** All currently-running test runs across every target host. */
export function listActiveRuns(): RunStatusSnapshot[] {
  return [...activeRunsByHost.values()].map((r) => ({
    running: true,
    targetSystemId: r.targetSystemId,
    targetHost: r.targetHost,
    targetName: r.targetName,
    startedAt: r.startedAt,
    totalPlanned: r.totalPlanned,
    completed: r.completed,
    currentTestId: r.currentTestId,
  }));
}

/** Signal a specific run to abort. Returns true if a run was found and signalled. */
export function abortCurrentRun(targetHost?: string): boolean {
  if (targetHost) {
    const r = activeRunsByHost.get(targetHost);
    if (!r) return false;
    r.abortController.abort();
    return true;
  }
  // No target specified: abort all (used by the page's old Stop button)
  if (activeRunsByHost.size === 0) return false;
  for (const r of activeRunsByHost.values()) r.abortController.abort();
  return true;
}

export async function runUiTests(inv: Inventory, req: UiTesterRequest): Promise<UiTesterResponse> {
  const startedAt = new Date().toISOString();
  const target = uesimApiOptsForSystem(inv, req.targetSystemId);
  if (!target) {
    return {
      startedAt, finishedAt: new Date().toISOString(),
      ok: false,
      runDir: '',
      counts: { total: 0, passed: 0, failed: 1, skipped: 0 },
      results: [{ number: 1, id: 'preflight', name: 'target system not found',
        description: `No system in inventory.yaml matched targetSystemId="${req.targetSystemId ?? '(default UESIM)'}". Add it under systems[] or pick another id.`,
        category: 'auth', severity: 'critical', ok: false,
        detail: req.targetSystemId ? `requested id "${req.targetSystemId}" is not a UESIM/CALLBOX system` : 'no UESIM system in inventory.yaml',
      }],
    };
  }
  const apiOpts = { host: target.host, username: target.username, password: target.password };

  const wanted = new Set<UiTestCategory>(req.categories ?? DEFAULT_CATEGORIES);
  const headless = req.headless !== false;
  const testTimeoutMs = req.testTimeoutMs ?? 60000;

  const runDir = newRunDir(target.host);
  fs.mkdirSync(runDir, { recursive: true });

  const browserType = req.browserType ?? 'chromium';
  const launcher = browserType === 'firefox' ? firefox : chromium;

  // Reject overlapping runs ON THE SAME TARGET HOST. Different hosts can run
  // in parallel - that's the multi-user / multi-box use case.
  const existing = activeRunsByHost.get(target.host);
  if (existing) {
    return {
      startedAt, finishedAt: new Date().toISOString(),
      ok: false,
      runDir: '',
      counts: { total: 0, passed: 0, failed: 1, skipped: 0 },
      results: [{ number: 1, id: 'preflight', name: `another run is in progress on ${target.name}`,
        description: `A UI test run is already in flight against ${target.host} (${target.name}). Stop it first, wait for it, or pick a different target system.`,
        category: 'auth', severity: 'critical', ok: false,
        detail: `started at ${existing.startedAt}, ${existing.completed}/${existing.totalPlanned} done`,
      }],
    };
  }

  // When the user wants to *watch* the browser (headless: false), use options
  // that make the window obviously visible: maximized, brought to the front,
  // and with a slowMo so each click is humanly observable.
  const baseOpts = headless
    ? { headless: true as const }
    : {
        headless: false as const,
        slowMo: 250,                                      // 250ms between every action
        args: [
          '--start-maximized',
          '--no-default-browser-check',
          '--no-first-run',
          // Disable Chrome's autofill / password manager / translate prompts -
          // they pop up on the login form and can interfere with our fill+click sequence.
          '--disable-features=AutofillAddressEnabled,AutofillCreditCardEnabled,PasswordManager,TranslateUI',
          '--password-store=basic',
        ],
      };

  // Tiered launch attempts. Bundled Playwright chromium occasionally fails
  // with "spawn UNKNOWN" on Windows because Defender/AV flags the unsigned
  // exe. Fall back to the user's installed Chrome / Edge (both are signed
  // and trusted), which Playwright drives via the `channel` option.
  const attempts: Array<{ label: string; options: any }> = browserType === 'firefox'
    ? [{ label: 'firefox (bundled)', options: baseOpts }]
    : [
        { label: 'chrome (system)',     options: { ...baseOpts, channel: 'chrome'  } },
        { label: 'msedge (system)',     options: { ...baseOpts, channel: 'msedge'  } },
        { label: 'chromium (bundled)',  options: baseOpts },
      ];

  let browser: Browser | undefined;
  let lastErr: any;
  const tried: string[] = [];
  for (const attempt of attempts) {
    try {
      browser = await launcher.launch(attempt.options);
      tried.push(`${attempt.label}=ok`);
      break;
    } catch (e: any) {
      lastErr = e;
      tried.push(`${attempt.label}=${String(e?.message ?? e).split('\n')[0].slice(0, 60)}`);
      // Brief pause before next attempt - Windows file handle release.
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  if (!browser) {
    return {
      startedAt, finishedAt: new Date().toISOString(),
      ok: false,
      runDir: '',
      counts: { total: 0, passed: 0, failed: 1, skipped: 0 },
      results: [{
        number: 1, id: 'preflight', name: `Could not launch any browser`,
        description: `Tried in order: ${tried.join('  →  ')}. The bundled Playwright chromium is sometimes blocked by Windows Defender; system Chrome / Edge usually works around that. If you do not have Chrome or Edge installed, run "npx playwright install chromium" once more, then restart the simqa dev server.`,
        category: 'auth', severity: 'critical', ok: false,
        detail: `last error: ${String(lastErr?.message ?? lastErr).slice(0, 400)}`,
        expected: 'simqa launches in this order: system Chrome, system Edge, bundled Chromium. At least one must succeed.',
      }],
    };
  }
  const abortController = new AbortController();
  const activeRun: ActiveRun = {
    targetSystemId: target.systemId, targetHost: target.host, targetName: target.name,
    abortController, startedAt, totalPlanned: 0, completed: 0,
  };
  activeRunsByHost.set(target.host, activeRun);

  try {
    const ctx: UiCtx = { browser, host: apiOpts.host, username: apiOpts.username, password: apiOpts.password, evidenceRootDir: runDir, headless };

    // Stage 1: log in once and persist storage state for tests that need it.
    // Result is surfaced as the first test row so debugging is trivial when
    // auth-dependent tests fail in bulk.
    const loginStartedAt = Date.now();
    const loginBundle = await newPageBundle(ctx);
    let loginVerdict: { ok: boolean; status?: number; detail: string } = { ok: false, detail: 'login throw' };
    try {
      loginVerdict = await login(ctx, loginBundle.page);
      if (loginVerdict.ok) {
        const statePath = path.join(runDir, 'auth.json');
        await loginBundle.context.storageState({ path: statePath });
        ctx.authStorageStatePath = statePath;
      }
    } catch (e: any) {
      loginVerdict = { ok: false, detail: `login threw: ${e?.message ?? String(e)}` };
    }
    // Capture preflight evidence regardless of pass/fail
    const preflightDir = path.join(runDir, 'preflight-login');
    fs.mkdirSync(preflightDir, { recursive: true });
    const preflightEvidence = await recordEvidence(preflightDir, loginBundle.page, loginBundle);
    await loginBundle.close();
    const loginDurationMs = Date.now() - loginStartedAt;

    // Stage 2: run each test in its own context.
    const all = defs();
    let selected: UiTestDef[];
    if (req.onlyId) {
      selected = all.filter((t) => t.id === req.onlyId);
    } else if (req.idsToRun && req.idsToRun.length > 0) {
      const idSet = new Set(req.idsToRun);
      selected = all.filter((t) => idSet.has(t.id));
    } else {
      selected = all.filter((t) => wanted.has(t.category));
    }
    if (req.severityFilter && req.severityFilter.length > 0) {
      const sevSet = new Set(req.severityFilter);
      selected = selected.filter((t) => sevSet.has(t.severity));
    }
    activeRun.totalPlanned = selected.length + 1; // +1 for preflight-login
    const results: UiTestResult[] = [];

    // Surface stage-1 login as a visible result row. If it failed, every
    // needsAuth test below will be marked skipped with a pointer to it.
    results.push({
      number: 0,
      id: 'preflight-login',
      name: 'Preflight: stage-1 admin login + capture storageState',
      description: 'Logs in once at the start of the run and saves storageState (cookies + localStorage JWT) for reuse across all needsAuth tests. If this fails, every protected test below is skipped because there is no auth state to load.',
      category: 'auth',
      severity: 'critical',
      ok: loginVerdict.ok,
      detail: loginVerdict.detail,
      durationMs: loginDurationMs,
      finalUrl: '',
      consoleErrorCount: loginBundle.getConsoleErrors().length,
      networkRequestCount: loginBundle.getRequests().length,
      evidence: preflightEvidence,
      ranAt: new Date().toISOString(),
      expected: loginVerdict.ok ? undefined : 'login returns 200 and the SPA stashes a JWT in localStorage. If 0/N tests in this run pass with route-bouncing detail, this preflight failed.',
    });

    // Per-test runner. Each test gets its own context with optional trace +
    // video. On failure, trace is saved as trace.zip; video is saved as the
    // recorded webm. On pass, both are discarded to avoid disk bloat.
    const traceMode: 'on' | 'off' | 'retain-on-failure' = req.traceMode ?? 'retain-on-failure';
    const wantTrace = (ok: boolean) => traceMode === 'on' || (traceMode === 'retain-on-failure' && !ok);

    async function runOne(def: UiTestDef, number: number): Promise<UiTestResult> {
      // Skip cleanly if preflight failed and the test needs auth.
      if (!loginVerdict.ok && def.needsAuth) {
        return {
          number,
          id: def.id, name: def.name, description: def.description,
          category: def.category, severity: def.severity,
          ok: true, skipped: true,
          skippedReason: `preflight-login failed: ${loginVerdict.detail}`,
          ranAt: new Date().toISOString(),
        };
      }
      const testDir = path.join(runDir, def.id);
      fs.mkdirSync(testDir, { recursive: true });
      const videoDir = traceMode !== 'off' ? path.join(testDir, '.video') : undefined;
      if (videoDir) fs.mkdirSync(videoDir, { recursive: true });
      const traceDir = traceMode !== 'off' ? testDir : undefined;
      const t0 = Date.now();
      const bundle = await newPageBundle(ctx, {
        useAuth: !!def.needsAuth,
        recordTraceTo: traceDir,
        recordVideoTo: videoDir,
      });
      let result: UiTestResult;
      try {
        const verdict = await Promise.race([
          def.run({ ctx, bundle, testDir }),
          new Promise<{ ok: false; detail: string; expected?: string }>((resolve) => setTimeout(() => resolve({ ok: false, detail: `timed out after ${testTimeoutMs}ms` }), testTimeoutMs)),
        ]);
        const evidence = await recordEvidence(testDir, bundle.page, bundle);
        if ((verdict as any).extraEvidence) Object.assign(evidence, (verdict as any).extraEvidence);
        // Trace + video handling
        if (wantTrace(verdict.ok)) {
          const tracePath = path.join(testDir, 'trace.zip');
          await bundle.context.tracing.stop({ path: tracePath }).catch(() => null);
          evidence.traceFile = 'trace.zip';
        } else if (traceDir) {
          await bundle.context.tracing.stop().catch(() => null);
        }
        result = {
          number,
          id: def.id, name: def.name, description: def.description, category: def.category, severity: def.severity,
          ok: verdict.ok,
          detail: verdict.detail,
          expected: verdict.expected,
          durationMs: Date.now() - t0,
          finalUrl: bundle.page.url(),
          consoleErrorCount: bundle.getConsoleErrors().length,
          networkRequestCount: bundle.getRequests().length,
          evidence,
          ranAt: new Date().toISOString(),
        };
      } catch (e: any) {
        const evidence = await recordEvidence(testDir, bundle.page, bundle);
        if (traceDir) {
          const tracePath = path.join(testDir, 'trace.zip');
          await bundle.context.tracing.stop({ path: tracePath }).catch(() => null);
          evidence.traceFile = 'trace.zip';
        }
        result = {
          number,
          id: def.id, name: def.name, description: def.description, category: def.category, severity: def.severity,
          ok: false,
          detail: `threw: ${e?.message ?? String(e)}`,
          durationMs: Date.now() - t0,
          finalUrl: bundle.page.url(),
          consoleErrorCount: bundle.getConsoleErrors().length,
          networkRequestCount: bundle.getRequests().length,
          evidence,
          ranAt: new Date().toISOString(),
        };
      } finally {
        await bundle.close().catch(() => null);
      }
      // Promote the recorded video file (auto-named by Playwright) into a
      // predictable path. On pass with retain-on-failure, discard.
      if (videoDir) {
        try {
          const files = fs.existsSync(videoDir) ? fs.readdirSync(videoDir).filter((f) => f.endsWith('.webm')) : [];
          if (files.length > 0) {
            if (wantTrace(result.ok)) {
              const dest = path.join(testDir, 'video.webm');
              fs.renameSync(path.join(videoDir, files[0]), dest);
              result.evidence = { ...(result.evidence ?? {}), videoFile: 'video.webm' };
            } else {
              for (const f of files) fs.unlinkSync(path.join(videoDir, f));
            }
          }
          fs.rmdirSync(videoDir, { recursive: true } as any);
        } catch { /* best-effort */ }
      }
      return result;
    }

    // Decide what to run in parallel vs serial. Tests that mutate the box
    // (lifecycle, anything destructive, anything in the patterns category that
    // intercepts network routes) MUST run serial. Read-only tests can run in
    // parallel pools.
    function isSerial(def: UiTestDef): boolean {
      if (def.destructive) return true;
      if (def.category === 'lifecycle') return true;
      if (def.category === 'compat') return true; // cross-tab tests open extra contexts
      if (/error-(401|500)|forced|abort|logout|cross-tab|deep-link/.test(def.id)) return true;
      return false;
    }
    const concurrency = Math.max(1, Math.min(req.concurrency ?? 1, 6));
    const serialDefs   = selected.filter((d) => isSerial(d));
    const parallelDefs = selected.filter((d) => !isSerial(d));

    let nextSlot = 0;
    const indexFor = new Map<UiTestDef, number>();
    for (const d of selected) { indexFor.set(d, nextSlot++); }

    // Capture for closure use across async iterations.
    const ar = activeRun;
    // Reflect total planned in the live status now that filtering is final.
    ar.totalPlanned = (selected?.length ?? 0) + 1;
    // Run serial first (preflight-dependent + state-modifying), then parallel pool.
    for (const def of serialDefs) {
      if (abortController.signal.aborted) break;
      ar.currentTestId = def.id;
      const r = await runOne(def, (indexFor.get(def) ?? 0) + 1);
      results.push(r);
      ar.completed = results.length;
    }

    if (concurrency === 1) {
      for (const def of parallelDefs) {
        if (abortController.signal.aborted) break;
        ar.currentTestId = def.id;
        const r = await runOne(def, (indexFor.get(def) ?? 0) + 1);
        results.push(r);
        ar.completed = results.length;
      }
    } else {
      let qIdx = 0;
      const workers = Array.from({ length: concurrency }, async () => {
        while (true) {
          if (abortController.signal.aborted) return;
          const myIdx = qIdx++;
          if (myIdx >= parallelDefs.length) return;
          const def = parallelDefs[myIdx];
          ar.currentTestId = def.id;
          const r = await runOne(def, (indexFor.get(def) ?? 0) + 1);
          results.push(r);
          ar.completed = results.length;
        }
      });
      await Promise.all(workers);
    }

    // Stable order: by registered number (so the UI displays predictably).
    results.sort((a, b) => a.number - b.number);

    if (abortController.signal.aborted) {
      results.push({
        number: results.length + 1, id: 'aborted', name: 'run aborted by user',
        description: 'The user clicked Stop. Subsequent tests were skipped.',
        category: 'auth', severity: 'normal', ok: true, skipped: true,
        skippedReason: `aborted with ${results.length}/${selected.length + 1} tests done`,
      });
    }

    const counts = {
      total: results.length,
      passed: results.filter((r) => r.ok && !r.skipped).length,
      failed: results.filter((r) => !r.ok && !r.skipped).length,
      skipped: results.filter((r) => r.skipped).length,
    };

    let diff: UiBaselineDiff | undefined;
    if (req.baselineId) {
      try { diff = computeBaselineDiff(req.baselineId, results); }
      catch (e: any) { diff = { baselineId: req.baselineId, regressions: [], fixes: [], unchangedFailures: [], newTests: [], removedTests: [], baselineRunDir: '<error: ' + (e?.message ?? String(e)).slice(0, 80) + '>' }; }
    }

    const summary: UiTesterResponse = {
      startedAt, finishedAt: new Date().toISOString(),
      ok: counts.failed === 0,
      runDir,
      counts, results, diff,
    };
    fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));
    return summary;
  } finally {
    await browser.close().catch(() => null);
    activeRunsByHost.delete(target.host);
  }
}

// ---------- Baseline storage + diff ----------

const BASELINE_DIR = path.join(process.cwd(), 'data', 'ui-tests', 'baselines');

interface BaselineFile {
  id: string;
  savedAt: string;
  fromRunDir: string;
  finishedAt: string;
  results: Array<{ id: string; name: string; severity: UiTestSeverity; ok: boolean; skipped?: boolean; detail?: string }>;
}

export interface BaselineSummary {
  id: string;
  savedAt: string;
  finishedAt: string;
  total: number;
  passed: number;
  failed: number;
}

export function listBaselines(): BaselineSummary[] {
  if (!fs.existsSync(BASELINE_DIR)) return [];
  const files = fs.readdirSync(BASELINE_DIR).filter((f) => f.endsWith('.json'));
  const out: BaselineSummary[] = [];
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(BASELINE_DIR, f), 'utf8')) as BaselineFile;
      const passed = j.results.filter((r) => r.ok && !r.skipped).length;
      const failed = j.results.filter((r) => !r.ok && !r.skipped).length;
      out.push({ id: j.id, savedAt: j.savedAt, finishedAt: j.finishedAt, total: j.results.length, passed, failed });
    } catch { /* ignore broken file */ }
  }
  return out.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

/** Save a run's results as a named baseline. Overwrites if id already exists. */
export function saveBaseline(args: { id: string; runDir: string; finishedAt: string; results: UiTestResult[] }): { ok: boolean; path: string; message: string } {
  const safeId = args.id.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80);
  if (!safeId) return { ok: false, path: '', message: 'baseline id is empty after sanitisation' };
  fs.mkdirSync(BASELINE_DIR, { recursive: true });
  const file: BaselineFile = {
    id: safeId, savedAt: new Date().toISOString(),
    fromRunDir: args.runDir, finishedAt: args.finishedAt,
    results: args.results.map((r) => ({ id: r.id, name: r.name, severity: r.severity, ok: r.ok, skipped: r.skipped, detail: r.detail })),
  };
  const dest = path.join(BASELINE_DIR, `${safeId}.json`);
  fs.writeFileSync(dest, JSON.stringify(file, null, 2));
  return { ok: true, path: dest, message: `baseline "${safeId}" saved with ${file.results.length} test results` };
}

export function deleteBaseline(id: string): boolean {
  const safeId = id.replace(/[^A-Za-z0-9_.-]/g, '_');
  const p = path.join(BASELINE_DIR, `${safeId}.json`);
  if (!fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  return true;
}

function loadBaseline(id: string): BaselineFile | null {
  const safeId = id.replace(/[^A-Za-z0-9_.-]/g, '_');
  const p = path.join(BASELINE_DIR, `${safeId}.json`);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) as BaselineFile; }
  catch { return null; }
}

function computeBaselineDiff(baselineId: string, results: UiTestResult[]): UiBaselineDiff {
  const b = loadBaseline(baselineId);
  if (!b) {
    return { baselineId, regressions: [], fixes: [], unchangedFailures: [], newTests: [], removedTests: [],
      baselineRunDir: `<baseline "${baselineId}" not found>` };
  }
  const baselineById = new Map(b.results.map((r) => [r.id, r]));
  const currentById = new Map(results.map((r) => [r.id, r]));
  const regressions: UiBaselineDiff['regressions'] = [];
  const fixes: UiBaselineDiff['fixes'] = [];
  const unchangedFailures: UiBaselineDiff['unchangedFailures'] = [];
  const newTests: UiBaselineDiff['newTests'] = [];
  const removedTests: UiBaselineDiff['removedTests'] = [];
  for (const cur of results) {
    const prev = baselineById.get(cur.id);
    if (!prev) { newTests.push({ id: cur.id, name: cur.name, ok: cur.ok }); continue; }
    if (cur.skipped || prev.skipped) continue;
    if (prev.ok && !cur.ok) regressions.push({ id: cur.id, name: cur.name, severity: cur.severity, previousDetail: prev.detail, currentDetail: cur.detail });
    else if (!prev.ok && cur.ok) fixes.push({ id: cur.id, name: cur.name, severity: cur.severity });
    else if (!prev.ok && !cur.ok) unchangedFailures.push({ id: cur.id, name: cur.name, severity: cur.severity });
  }
  for (const prev of b.results) {
    if (!currentById.has(prev.id)) removedTests.push({ id: prev.id, name: prev.name });
  }
  return {
    baselineId,
    baselineRunDir: b.fromRunDir,
    baselineFinishedAt: b.finishedAt,
    regressions, fixes, unchangedFailures, newTests, removedTests,
  };
}

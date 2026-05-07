// Build installer for SIMNOVATOR systems — Chromium + Cockpit edition.
//
// Drives the *real* Cockpit web UI (https://<host>:<port>/system/terminal)
// using a headless Chromium instance via Playwright. No SSH from this app —
// authentication, terminal access, and command execution all happen the
// same way they would for a human user opening Cockpit in their browser.
//
// Flow:
//   1. Launch Chromium with ignoreHTTPSErrors=true (Cockpit uses self-signed)
//   2. Navigate to https://<host>:<port>/
//   3. Fill in the Cockpit login form, submit
//   4. Navigate to /system/terminal
//   5. Type the wget / tar / ./install commands, one at a time
//   6. Poll xterm.js's rendered DOM for new lines, stream them as `log` events
//   7. Detect command completion with a sentinel echo (`__QAKB_DONE_<n>_$?__`)
//   8. Take a screenshot at every step as visual evidence
//   9. Persist screenshots + final log to data/builds/<buildId>/

import * as fs from 'node:fs';
import * as path from 'node:path';
import { chromium, firefox, type Browser, type Page } from 'playwright';
import type { Inventory, InventorySystem } from './inventory';
import { getSystem, isSimnovatorTarget } from './inventory';

// ───────────── Public types ─────────────

export type InstallEvent =
  | { type: 'log'; stream: 'stdout' | 'stderr' | 'info' | 'error'; line: string; ts: number }
  | { type: 'step'; step: InstallStepName; status: 'start' | 'ok' | 'fail'; detail?: string; durationMs?: number; ts: number }
  | { type: 'screenshot'; step: InstallStepName | 'final'; file: string; ts: number }
  | { type: 'done'; ok: boolean; durationMs: number; ts: number };

export type InstallStepName = 'launch' | 'login' | 'terminal' | 'fetch' | 'extract' | 'install';

export interface BuildInstallRequest {
  systemId: string;
  buildUrl: string;
  workingDir?: string;
  hosts: Array<{
    flag: '--ue' | '--app' | '--oru' | '--external';
    ip: string;
    user?: string;
    ipOnly?: boolean;
  }>;
  timezone?: string;
  maxSimulators?: string;
  skip?: { app_server?: boolean; app_manager?: boolean; simnovator?: boolean; ue?: boolean; oru?: boolean };
  restore?: boolean;
  extraArgs?: string;
  /** When true, launch Chromium in HEADED mode so the user can watch the
   *  Cockpit Terminal type the install commands. Defaults to headless. */
  headed?: boolean;
}

export interface BuildInstallContext {
  emit: (e: InstallEvent) => void;
  inv: Inventory;
  req: BuildInstallRequest;
  /** Where to drop screenshots. The endpoint creates this. */
  buildDir: string;
}

const DEFAULT_COCKPIT_USER     = 'simnovus';
const DEFAULT_COCKPIT_PASSWORD = 'admin@123';
const DEFAULT_COCKPIT_PORT     = 9090;

// ───────────── Helpers ─────────────

function nowEvent<T extends Omit<InstallEvent, 'ts'>>(e: T): InstallEvent {
  return { ...(e as any), ts: Date.now() };
}

function nameFromUrl(url: string): { fileName: string; dirName: string } {
  try {
    const u = new URL(url);
    const file = u.pathname.split('/').filter(Boolean).pop() ?? 'build.tar.gz';
    const dir = file.replace(/\.tar\.gz$|\.tgz$/i, '');
    return { fileName: file, dirName: dir };
  } catch {
    return { fileName: 'build.tar.gz', dirName: 'build' };
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export function buildInstallCommand(req: BuildInstallRequest): string {
  const parts: string[] = ['./install'];
  for (const h of req.hosts) {
    if (!h.ip) continue;
    if (h.ipOnly) parts.push(h.flag, shellQuote(h.ip));
    else {
      const user = (h.user || 'sysadmin').trim() || 'sysadmin';
      parts.push(h.flag, shellQuote(`${user}@${h.ip}`));
    }
  }
  if (req.timezone?.trim()) parts.push('-t', shellQuote(req.timezone.trim()));
  if (req.maxSimulators?.trim()) parts.push('-m', req.maxSimulators.trim());
  if (req.skip?.app_server)  parts.push('--no_app_server');
  if (req.skip?.app_manager) parts.push('--no_app_manager');
  if (req.skip?.simnovator)  parts.push('--no_simnovator');
  if (req.skip?.ue)          parts.push('--no_ue');
  if (req.skip?.oru)         parts.push('--no_oru');
  if (req.restore)           parts.push('--restore');
  if (req.extraArgs?.trim()) parts.push(req.extraArgs.trim());
  return parts.join(' ');
}

/** Cockpit creds, applying lab defaults when fields are blank in inventory. */
function cockpitCreds(target: InventorySystem): { user: string; password: string; port: number } {
  return {
    user:     target.cockpitUser     ?? DEFAULT_COCKPIT_USER,
    password: target.cockpitPassword ?? DEFAULT_COCKPIT_PASSWORD,
    port:     target.cockpitPort     ?? DEFAULT_COCKPIT_PORT,
  };
}

/** Try chrome → edge → bundled chromium → firefox until one launches. */
async function launchBrowser(headed = false): Promise<{ browser: Browser; label: string }> {
  // In headed mode the user wants to *see* the install happen, so we slow
  // each Playwright action down a touch (slowMo) — otherwise commands get
  // typed too fast to watch. Headless stays at full speed.
  const baseOpts = {
    headless: !headed,
    slowMo: headed ? 80 : 0,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  };
  const attempts: Array<{ label: string; opts: any; launcher: typeof chromium | typeof firefox }> = [
    { label: 'chrome (system)',    opts: { ...baseOpts, channel: 'chrome' }, launcher: chromium },
    { label: 'msedge (system)',    opts: { ...baseOpts, channel: 'msedge' }, launcher: chromium },
    { label: 'chromium (bundled)', opts: baseOpts,                            launcher: chromium },
    { label: 'firefox (bundled)',  opts: baseOpts,                            launcher: firefox  },
  ];
  let lastErr: any;
  for (const a of attempts) {
    try {
      const browser = await a.launcher.launch(a.opts);
      return { browser, label: a.label };
    } catch (e) { lastErr = e; }
  }
  throw new Error(`could not launch any browser: ${lastErr?.message ?? lastErr}`);
}

// ───────────── The driver ─────────────

const PROMPT_PATTERN = /\$\s*$/;            // POSIX shell prompt at EOL (rough)
const SENTINEL_PREFIX = '__QAKB_DONE__';   // sentinel echoed after each command

interface StreamingState {
  /** All visible terminal text we've already emitted, joined. */
  emitted: string;
}

/**
 * Read xterm's currently rendered + scrollback buffer as plain text.
 * Cockpit uses xterm.js with DOM rendering; .xterm-rows is the visible viewport
 * but the buffer history can be longer. We grab the whole .xterm-screen
 * innerText which the renderer keeps in sync with the buffer.
 */
async function readTerminal(page: Page): Promise<string> {
  return await page.evaluate(() => {
    // Cockpit nests the xterm container; grab whichever exists.
    const candidates = [
      '.xterm-rows', '.xterm-screen', '.xterm', '.terminal', '.ct-terminal',
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (el && el.innerText && el.innerText.length) return el.innerText;
    }
    return '';
  });
}

/** Press a string into the focused terminal, using xterm's input pipeline. */
async function termType(page: Page, text: string): Promise<void> {
  // Make sure the terminal is focused first.
  await page.evaluate(() => {
    const el = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null;
    if (el) el.focus();
  });
  await page.keyboard.type(text);
}

async function termPressEnter(page: Page): Promise<void> {
  await page.keyboard.press('Enter');
}

/**
 * Run a single shell command in the connected Cockpit Terminal, streaming
 * new output lines as `log` events. Resolves when the command finishes
 * (sentinel observed) or hard-times-out.
 */
async function runCommand(
  page: Page,
  cmd: string,
  step: InstallStepName,
  emit: (e: InstallEvent) => void,
  state: StreamingState,
  timeoutMs: number,
): Promise<{ ok: boolean; exitCode: number }> {
  const sentinelId = `${SENTINEL_PREFIX}${Math.random().toString(36).slice(2, 8)}`;
  // Wrap the user command so we always get an exit-code marker.
  const wrapped = `${cmd}; ec=$?; echo ${sentinelId}=$ec`;
  emit(nowEvent({ type: 'log', stream: 'info', line: `$ ${cmd}` }));

  await termType(page, wrapped);
  await termPressEnter(page);

  const t0 = Date.now();
  const pollIntervalMs = 350;
  let exitCode = -1;
  let ok = false;
  while (Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    const screen = await readTerminal(page);

    // Diff against what we've already streamed.
    if (screen.length > state.emitted.length && screen.startsWith(state.emitted)) {
      const fresh = screen.slice(state.emitted.length);
      const lines = fresh.split(/\r?\n/);
      for (const ln of lines) {
        if (!ln) continue;
        emit(nowEvent({ type: 'log', stream: 'stdout', line: ln }));
      }
      state.emitted = screen;
    } else if (screen.length > 0 && screen !== state.emitted) {
      // Buffer rolled (long output trims top); just emit the visible diff
      // crudely so the user sees something.
      const idx = screen.indexOf(state.emitted.slice(-200));
      if (idx > 0) {
        const fresh = screen.slice(idx + 200);
        for (const ln of fresh.split(/\r?\n/)) {
          if (ln) emit(nowEvent({ type: 'log', stream: 'stdout', line: ln }));
        }
      }
      state.emitted = screen;
    }

    // Look for the sentinel.
    const match = screen.match(new RegExp(`${sentinelId}=(\\d+)`));
    if (match) {
      exitCode = parseInt(match[1], 10);
      ok = exitCode === 0;
      break;
    }
  }
  if (exitCode === -1) {
    emit(nowEvent({ type: 'log', stream: 'error', line: `(timed out after ${Math.round((Date.now() - t0) / 1000)}s on step "${step}")` }));
  }
  return { ok, exitCode };
}

// ───────────── Main entrypoint ─────────────

export async function runBuildInstall(ctx: BuildInstallContext): Promise<{ ok: boolean }> {
  const { emit, inv, req, buildDir } = ctx;
  const t0 = Date.now();

  // ── Validate request ────────────────────────────────
  const target = getSystem(inv, req.systemId);
  if (!target) {
    emit(nowEvent({ type: 'log', stream: 'error', line: `system not found: ${req.systemId}` }));
    emit(nowEvent({ type: 'done', ok: false, durationMs: Date.now() - t0 }));
    return { ok: false };
  }
  if (!isSimnovatorTarget(target)) {
    emit(nowEvent({ type: 'log', stream: 'error', line: `target ${target.id} is type ${target.type}; install requires SIMNOVATOR` }));
    emit(nowEvent({ type: 'done', ok: false, durationMs: Date.now() - t0 }));
    return { ok: false };
  }
  if (!req.buildUrl?.trim()) {
    emit(nowEvent({ type: 'log', stream: 'error', line: 'missing buildUrl' }));
    emit(nowEvent({ type: 'done', ok: false, durationMs: Date.now() - t0 }));
    return { ok: false };
  }

  // The Simnovator installer requires --ue and --app. Refuse to launch a
  // browser at all if either of those is missing in the request — the install
  // would only fail downstream with "FAILED : Please provide UE/App credentials".
  const haveFlag = (flag: '--ue' | '--app') => req.hosts.some((h) => h.flag === flag && h.ip?.trim());
  const missing: string[] = [];
  if (!haveFlag('--ue'))  missing.push('--ue');
  if (!haveFlag('--app')) missing.push('--app');
  if (missing.length > 0) {
    emit(nowEvent({ type: 'log', stream: 'error', line: `missing required flag(s): ${missing.join(', ')}. Add the corresponding system in Inventory or type the IP into the host card on the Build Check page.` }));
    emit(nowEvent({ type: 'done', ok: false, durationMs: Date.now() - t0 }));
    return { ok: false };
  }

  const creds = cockpitCreds(target);
  const cockpitUrl = `https://${target.host}:${creds.port}`;
  const { fileName, dirName } = nameFromUrl(req.buildUrl);
  const dir = (req.workingDir?.trim() || '/tmp').replace(/\/+$/, '');
  const installLine = buildInstallCommand(req);

  emit(nowEvent({ type: 'log', stream: 'info', line: `target: ${target.name || target.id} · ${cockpitUrl}` }));

  // Helper that snaps a screenshot and emits an event.
  let shotIx = 0;
  async function snap(page: Page, step: InstallStepName | 'final', label: string): Promise<void> {
    shotIx += 1;
    const file = path.join(buildDir, `${String(shotIx).padStart(2, '0')}-${step}-${label}.png`);
    try {
      await page.screenshot({ path: file, fullPage: false });
      emit(nowEvent({ type: 'screenshot', step, file: path.basename(file) }));
    } catch (e: any) {
      emit(nowEvent({ type: 'log', stream: 'error', line: `screenshot failed: ${e?.message ?? e}` }));
    }
  }

  let browser: Browser | undefined;
  let page: Page | undefined;
  try {
    // ── Launch ──────────────────────────────────────────
    const tLaunch = Date.now();
    emit(nowEvent({ type: 'step', step: 'launch', status: 'start' }));
    const { browser: b, label } = await launchBrowser(!!req.headed);
    browser = b;
    emit(nowEvent({ type: 'log', stream: 'info', line: `using browser: ${label} (${req.headed ? 'headed — visible window' : 'headless'})` }));
    const ctxBrowser = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1440, height: 900 },
    });
    page = await ctxBrowser.newPage();
    page.setDefaultTimeout(20_000);
    page.setDefaultNavigationTimeout(60_000);
    emit(nowEvent({ type: 'step', step: 'launch', status: 'ok', durationMs: Date.now() - tLaunch }));

    // ── Login ───────────────────────────────────────────
    const tLogin = Date.now();
    emit(nowEvent({ type: 'step', step: 'login', status: 'start', detail: cockpitUrl }));
    await page.goto(`${cockpitUrl}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#login-user-input, input[name="user"]', { timeout: 30_000 });
    await snap(page, 'login', 'before');
    await page.fill('#login-user-input, input[name="user"]', creds.user);
    await page.fill('#login-password-input, input[name="password"]', creds.password);

    // Cockpit's login button is #login-button. Click it and wait for the
    // page to navigate away from the login form rather than racing on
    // arbitrary load events — Cockpit's shell loads piecewise via XHR.
    await page.click('#login-button, button[type="submit"]');

    // Confirm we're past the login form by waiting for it to detach.
    const loggedIn = await page.locator('#login-user-input').waitFor({ state: 'detached', timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    if (!loggedIn) {
      // Look for an explicit error message that Cockpit shows on bad creds.
      const errText = await page.locator('#login-error-message, .login-error, [aria-live="polite"]').first().textContent().catch(() => null);
      await snap(page, 'login', 'failed');
      emit(nowEvent({ type: 'step', step: 'login', status: 'fail', detail: `login form still visible. Cockpit error: ${(errText || '').trim() || '(none captured — check the screenshot)'}`, durationMs: Date.now() - tLogin }));
      emit(nowEvent({ type: 'done', ok: false, durationMs: Date.now() - t0 }));
      return { ok: false };
    }

    // Wait for the Cockpit shell chrome to actually mount (this is what
    // bootstraps the iframes). It can take a few seconds on first login.
    await page.waitForFunction(() => {
      const url = location.pathname;
      return url !== '/' || !!document.querySelector('iframe[name^="cockpit1:"], .pf-c-page, .ct-page, #host-apps');
    }, { timeout: 30_000 }).catch(() => null);
    await page.waitForTimeout(800); // small settle before deep-linking
    emit(nowEvent({ type: 'log', stream: 'info', line: `post-login url: ${page.url()}` }));
    await snap(page, 'login', 'after');
    emit(nowEvent({ type: 'step', step: 'login', status: 'ok', durationMs: Date.now() - tLogin }));

    // ── Terminal ────────────────────────────────────────
    const tTerm = Date.now();
    emit(nowEvent({ type: 'step', step: 'terminal', status: 'start' }));
    await page.goto(`${cockpitUrl}/system/terminal`, { waitUntil: 'domcontentloaded' });
    // Cockpit Terminal lives in an iframe inside the shell. The iframe name
    // looks like "cockpit1:localhost/system/terminal" and its URL is under
    // /cockpit/@localhost/... . Either signal is enough.
    //
    // First emit the frame inventory so when this step fails we can see
    // exactly what Cockpit rendered. Headed-mode runs typically reveal a
    // login-required prompt or a "browser unsupported" page in the iframe.
    const pageRef = page;
    const dumpFrames = async (where: string) => {
      const frames = pageRef.frames();
      emit(nowEvent({ type: 'log', stream: 'info', line: `[frames @ ${where}] count=${frames.length}` }));
      for (const f of frames) {
        let bodyPreview = '';
        try {
          bodyPreview = (await f.evaluate(() => document.body?.innerText?.slice(0, 80) ?? '')).replace(/\s+/g, ' ').trim();
        } catch { bodyPreview = '(blocked)'; }
        emit(nowEvent({ type: 'log', stream: 'info', line: `  · name="${f.name()}" url="${f.url()}" body~"${bodyPreview}"` }));
      }
    };
    await dumpFrames('initial');
    await snap(page, 'terminal', 'before-find');

    const frame = await waitForCockpitTerminalFrame(page, emit);
    if (!frame) {
      // Final dump on failure for the human reading the log.
      await dumpFrames('on-fail');
      await snap(page, 'terminal', 'iframe-not-ready');
      emit(nowEvent({ type: 'step', step: 'terminal', status: 'fail', detail: 'terminal iframe not ready (see frame inventory above + screenshot)', durationMs: Date.now() - tTerm }));
      emit(nowEvent({ type: 'done', ok: false, durationMs: Date.now() - t0 }));
      return { ok: false };
    }
    emit(nowEvent({ type: 'log', stream: 'info', line: `terminal frame: name="${frame.name()}" url="${frame.url()}"` }));
    // Click the terminal viewport to focus the xterm input.
    try {
      const clickInside = async (sel: string) => { try { await frame.click(sel, { timeout: 2000 }); return true; } catch { return false; } };
      const focused =
        await clickInside('.xterm-screen') ||
        await clickInside('.xterm') ||
        await clickInside('.terminal') ||
        await clickInside('body');
      if (!focused) emit(nowEvent({ type: 'log', stream: 'info', line: 'could not click any terminal selector to focus' }));
    } catch { /* ignore */ }
    await snap(page, 'terminal', 'ready');
    emit(nowEvent({ type: 'step', step: 'terminal', status: 'ok', durationMs: Date.now() - tTerm }));

    // The page object we type into is the iframe wrapper, but Playwright's
    // keyboard targets the focused frame, so we use the outer page.
    const state: StreamingState = { emitted: '' };

    // Pre-read the prompt so our diff baseline is current.
    state.emitted = await readTerminalIn(frame);

    // ── Fetch ──────────────────────────────────────────
    const fetchCmd =
      `mkdir -p ${shellQuote(dir)} && cd ${shellQuote(dir)} && ` +
      `wget --no-check-certificate -c -q --show-progress ${shellQuote(req.buildUrl)}`;
    const tFetch = Date.now();
    emit(nowEvent({ type: 'step', step: 'fetch', status: 'start', detail: req.buildUrl }));
    const fetched = await runCommandInFrame(page, frame, fetchCmd, 'fetch', emit, state, 15 * 60_000);
    if (!fetched.ok) {
      await snap(page, 'fetch', 'failed');
      const hint = exitCodeHint('fetch', fetched.exitCode);
      if (hint) emit(nowEvent({ type: 'log', stream: 'error', line: hint }));
      emit(nowEvent({ type: 'step', step: 'fetch', status: 'fail', detail: hint ?? `exit code ${fetched.exitCode}`, durationMs: Date.now() - tFetch }));
      emit(nowEvent({ type: 'done', ok: false, durationMs: Date.now() - t0 }));
      return { ok: false };
    }
    await snap(page, 'fetch', 'done');
    emit(nowEvent({ type: 'step', step: 'fetch', status: 'ok', durationMs: Date.now() - tFetch }));

    // ── Extract ────────────────────────────────────────
    const extractCmd = `cd ${shellQuote(dir)} && tar -zxvf ${shellQuote(fileName)} 2>&1 | tail -50`;
    const tExtract = Date.now();
    emit(nowEvent({ type: 'step', step: 'extract', status: 'start' }));
    const extracted = await runCommandInFrame(page, frame, extractCmd, 'extract', emit, state, 5 * 60_000);
    if (!extracted.ok) {
      await snap(page, 'extract', 'failed');
      const hint = exitCodeHint('extract', extracted.exitCode);
      if (hint) emit(nowEvent({ type: 'log', stream: 'error', line: hint }));
      emit(nowEvent({ type: 'step', step: 'extract', status: 'fail', detail: hint ?? `exit code ${extracted.exitCode}`, durationMs: Date.now() - tExtract }));
      emit(nowEvent({ type: 'done', ok: false, durationMs: Date.now() - t0 }));
      return { ok: false };
    }
    await snap(page, 'extract', 'done');
    emit(nowEvent({ type: 'step', step: 'extract', status: 'ok', durationMs: Date.now() - tExtract }));

    // ── Install ────────────────────────────────────────
    const installCmd = `cd ${shellQuote(`${dir}/${dirName}`)} && ${installLine}`;
    const tInstall = Date.now();
    emit(nowEvent({ type: 'step', step: 'install', status: 'start', detail: installLine.slice(0, 220) }));
    const installed = await runCommandInFrame(page, frame, installCmd, 'install', emit, state, 30 * 60_000);
    await snap(page, installed.ok ? 'install' : 'install', installed.ok ? 'done' : 'failed');
    if (!installed.ok) {
      emit(nowEvent({ type: 'step', step: 'install', status: 'fail', detail: `exit code ${installed.exitCode}`, durationMs: Date.now() - tInstall }));
      emit(nowEvent({ type: 'done', ok: false, durationMs: Date.now() - t0 }));
      return { ok: false };
    }
    emit(nowEvent({ type: 'step', step: 'install', status: 'ok', durationMs: Date.now() - tInstall }));

    await snap(page, 'final', 'success');
    emit(nowEvent({ type: 'done', ok: true, durationMs: Date.now() - t0 }));
    return { ok: true };
  } catch (e: any) {
    emit(nowEvent({ type: 'log', stream: 'error', line: `unexpected: ${e?.message ?? e}` }));
    if (page) try { await snap(page, 'final', 'crash'); } catch { /* ignore */ }
    emit(nowEvent({ type: 'done', ok: false, durationMs: Date.now() - t0 }));
    return { ok: false };
  } finally {
    try { await browser?.close(); } catch { /* ignore */ }
  }
}

// ───────────── Cockpit-iframe specifics ─────────────

import type { Frame } from 'playwright';

async function waitForCockpitTerminalFrame(page: Page, emit: (e: InstallEvent) => void): Promise<Frame | null> {
  // Cockpit nests the terminal in an iframe. Modern shells use names like
  //   "cockpit1:localhost/system/terminal"
  // with URLs like
  //   https://<host>:9090/cockpit/@localhost/system/terminal/index.html
  // Older or vendor-tweaked shells vary, so we accept anything that mentions
  // "terminal" anywhere in name OR URL, plus a fallback that probes any
  // frame for an xterm-shaped element.
  const start = Date.now();
  const maxMs = 60_000;
  let lastReport = 0;
  while (Date.now() - start < maxMs) {
    const frames = page.frames();

    // First pass: explicit terminal-named frames.
    for (const f of frames) {
      const name = f.name();
      const url = f.url();
      if (/terminal/i.test(name) || /terminal/i.test(url)) {
        try {
          await f.waitForSelector('.xterm-rows, .xterm-screen, .xterm, .xterm-helper-textarea, .terminal, .ct-terminal', { timeout: 5_000 });
          return f;
        } catch { /* try next */ }
      }
    }

    // Second pass: any frame that has xterm DOM, regardless of name.
    for (const f of frames) {
      try {
        const has = await f.evaluate(() => !!document.querySelector('.xterm, .xterm-rows, .xterm-screen, .xterm-helper-textarea'));
        if (has) return f;
      } catch { /* cross-origin or detached */ }
    }

    // Periodic progress emission (every ~5s) so the user knows we're still trying.
    const elapsed = Date.now() - start;
    if (elapsed - lastReport > 5_000) {
      lastReport = elapsed;
      emit({ type: 'log', stream: 'info', line: `[terminal] still waiting for xterm in any iframe… (${Math.round(elapsed / 1000)}s; ${frames.length} frame${frames.length === 1 ? '' : 's'} present)`, ts: Date.now() });
    }
    await new Promise((r) => setTimeout(r, 600));
  }
  return null;
}

async function readTerminalIn(frame: Frame): Promise<string> {
  return await frame.evaluate(() => {
    const candidates = ['.xterm-rows', '.xterm-screen', '.xterm', '.terminal', '.ct-terminal'];
    for (const sel of candidates) {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (el && el.innerText && el.innerText.length) return el.innerText;
    }
    return '';
  });
}

/** True when a "line" coming out of xterm-rows innerText is just visual padding
 *  (whitespace only, or a prompt with no body). Filtering those keeps the log
 *  readable. */
function isNoiseLine(s: string): boolean {
  if (!s) return true;
  const t = s.trim();
  if (t === '') return true;
  return false;
}

/** xterm renders the full viewport in its DOM, including blank rows below
 *  the cursor. Trim trailing empty rows so we don't keep re-emitting them. */
function trimTrailingBlanks(s: string): string {
  return s.replace(/(\r?\n\s*){2,}$/, '\n');
}

async function runCommandInFrame(
  page: Page,
  frame: Frame,
  cmd: string,
  step: InstallStepName,
  emit: (e: InstallEvent) => void,
  state: StreamingState,
  timeoutMs: number,
): Promise<{ ok: boolean; exitCode: number }> {
  const sentinelId = `${SENTINEL_PREFIX}${Math.random().toString(36).slice(2, 8)}`;
  const wrapped = `${cmd}; ec=$?; echo ${sentinelId}=$ec`;
  emit(nowEvent({ type: 'log', stream: 'info', line: `$ ${cmd}` }));

  // Focus the xterm input and send the command.
  await frame.evaluate(() => {
    const ta = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null;
    ta?.focus();
  });
  // insertText is atomic from xterm's POV — the whole string lands as one
  // input event rather than per-keypress, so we don't see partial commands
  // in the polled DOM. The Enter press still kicks the shell.
  await page.keyboard.insertText(wrapped);
  await page.keyboard.press('Enter');

  // Let xterm settle (full command echo + first prompt redraw) before we
  // baseline our diff cursor. Anything before this point is the typed
  // command + prompt, not output we want to stream.
  await new Promise((r) => setTimeout(r, 600));
  state.emitted = trimTrailingBlanks(await readTerminalIn(frame));

  const t0 = Date.now();
  const pollIntervalMs = 400;
  let exitCode = -1;
  let ok = false;
  while (Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    const rawScreen = await readTerminalIn(frame);
    const screen = trimTrailingBlanks(rawScreen);

    let fresh = '';
    if (screen.length > state.emitted.length && screen.startsWith(state.emitted)) {
      fresh = screen.slice(state.emitted.length);
    } else if (screen.length > 0 && screen !== state.emitted) {
      // Buffer rolled (long output trims top); look for the trailing context
      // and emit anything past it. If we can't find an anchor, emit the
      // diff against the previous screen length to avoid double-printing.
      const tail = state.emitted.slice(-160);
      const idx = tail ? screen.indexOf(tail) : -1;
      if (idx >= 0) fresh = screen.slice(idx + tail.length);
      else fresh = screen.length > state.emitted.length ? screen.slice(state.emitted.length) : '';
    }
    if (fresh) {
      for (const ln of fresh.split(/\r?\n/)) {
        if (!isNoiseLine(ln) && !ln.includes(sentinelId)) {
          emit(nowEvent({ type: 'log', stream: 'stdout', line: ln }));
        }
      }
      state.emitted = screen;
    }

    const match = rawScreen.match(new RegExp(`${sentinelId}=(\\d+)`));
    if (match) {
      exitCode = parseInt(match[1], 10);
      ok = exitCode === 0;
      break;
    }
  }
  if (exitCode === -1) {
    emit(nowEvent({ type: 'log', stream: 'error', line: `(timed out after ${Math.round((Date.now() - t0) / 1000)}s on step "${step}")` }));
  }
  return { ok, exitCode };
}

/** Map common exit codes from wget / tar / install to a human-readable hint. */
function exitCodeHint(step: InstallStepName, code: number): string | undefined {
  if (step === 'fetch') {
    // wget exit codes
    switch (code) {
      case 1: return 'wget: generic error';
      case 2: return 'wget: parse error / bad URL';
      case 3: return 'wget: file I/O error';
      case 4: return 'wget: NETWORK FAILURE — the Simnovator VM cannot reach the build server. Check routing/firewall between the VM and the build host.';
      case 5: return 'wget: SSL verification failed';
      case 6: return 'wget: authentication failure';
      case 7: return 'wget: protocol error';
      case 8: return 'wget: server response error (e.g. 404, 500). The URL may be wrong or the build is no longer published.';
    }
  }
  if (step === 'extract') {
    switch (code) {
      case 1: return 'tar: warnings (some files differ from archive)';
      case 2: return 'tar: fatal error (corrupt archive or write failure)';
    }
  }
  return undefined;
}

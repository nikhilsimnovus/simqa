// List .tar.gz / .tgz files on a Simnovator VM via Cockpit Terminal.
//
// Same Playwright/Chromium driving pattern as buildInstaller.ts: log into
// Cockpit, open /system/terminal, type a `find` command, parse the result,
// close. No SSH from this app.
//
// Cost: ~15-25s per call (browser launch + Cockpit login dominates). The
// expensive part is the browser launch — once we have it open, the find
// itself is sub-second on any sane filesystem.

import { chromium, firefox, type Browser, type Frame, type Page } from 'playwright';
import type { Inventory, InventorySystem } from './inventory';
import { getSystem, isSimnovatorTarget } from './inventory';

const DEFAULT_COCKPIT_USER     = 'simnovus';
const DEFAULT_COCKPIT_PASSWORD = 'admin@123';
const DEFAULT_COCKPIT_PORT     = 9090;

const SENTINEL_PREFIX = '__QAKB_FILES__';

export interface VmFile {
  /** Absolute path on the VM. */
  path: string;
  /** Size in bytes. */
  size: number;
  /** Last-modified time as ISO 8601. */
  mtime: string;
}

export interface ListVmFilesRequest {
  systemId: string;
  /** Directories to scan. Defaults to a sensible set of well-known build
   *  drop locations on the Simnovator VM. */
  searchDirs?: string[];
  /** Maximum recursion depth for find. Default 2 (so /tmp/builds/* but not
   *  /tmp/builds/a/b/c). */
  maxDepth?: number;
}

export interface ListVmFilesResult {
  ok: boolean;
  files: VmFile[];
  searchedDirs: string[];
  error?: string;
}

const DEFAULT_SEARCH_DIRS = [
  '/tmp',
  '/home/simnovus',
  '/home/simnovus/builds',
  '/home/simnovus/Downloads',
  '/var/tmp',
  '/opt',
];

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function cockpitCreds(target: InventorySystem): { user: string; password: string; port: number } {
  return {
    user:     target.cockpitUser     ?? DEFAULT_COCKPIT_USER,
    password: target.cockpitPassword ?? DEFAULT_COCKPIT_PASSWORD,
    port:     target.cockpitPort     ?? DEFAULT_COCKPIT_PORT,
  };
}

async function launchBrowser(): Promise<Browser> {
  const baseOpts = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] };
  const tries = [
    () => chromium.launch({ ...baseOpts, channel: 'chrome' }),
    () => chromium.launch({ ...baseOpts, channel: 'msedge' }),
    () => chromium.launch(baseOpts),
    () => firefox.launch(baseOpts),
  ];
  let lastErr: any;
  for (const t of tries) { try { return await t(); } catch (e) { lastErr = e; } }
  throw new Error(`could not launch any browser: ${lastErr?.message ?? lastErr}`);
}

async function waitForCockpitTerminalFrame(page: Page, timeoutMs = 30_000): Promise<Frame | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const f of page.frames()) {
      if (/terminal/i.test(f.name()) || /terminal/i.test(f.url())) {
        try {
          await f.waitForSelector('.xterm-rows, .xterm-screen, .xterm, .xterm-helper-textarea', { timeout: 5_000 });
          return f;
        } catch { /* try next */ }
      }
    }
    for (const f of page.frames()) {
      try {
        const has = await f.evaluate(() => !!document.querySelector('.xterm, .xterm-rows, .xterm-screen, .xterm-helper-textarea'));
        if (has) return f;
      } catch { /* cross-origin */ }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

async function readTerminal(frame: Frame): Promise<string> {
  return await frame.evaluate(() => {
    const candidates = ['.xterm-rows', '.xterm-screen', '.xterm', '.terminal', '.ct-terminal'];
    for (const sel of candidates) {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (el && el.innerText && el.innerText.length) return el.innerText;
    }
    return '';
  });
}

/**
 * Run a single command in the Cockpit terminal, wait until the sentinel
 * fires, then return the full screen text.
 */
async function runCommandCapture(page: Page, frame: Frame, cmd: string, timeoutMs: number): Promise<string> {
  const sentinelId = `${SENTINEL_PREFIX}${Math.random().toString(36).slice(2, 8)}`;
  const wrapped = `${cmd}; echo ${sentinelId}_DONE`;
  await frame.evaluate(() => {
    const ta = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null;
    ta?.focus();
  });
  await page.keyboard.insertText(wrapped);
  await page.keyboard.press('Enter');
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 350));
    const screen = await readTerminal(frame);
    if (screen.includes(`${sentinelId}_DONE`)) return screen;
  }
  return await readTerminal(frame);
}

/** Public entry point. Lists .tar.gz / .tgz files in the requested dirs. */
export async function listVmFiles(inv: Inventory, req: ListVmFilesRequest): Promise<ListVmFilesResult> {
  const target = getSystem(inv, req.systemId);
  if (!target)                        return { ok: false, files: [], searchedDirs: [], error: `system not found: ${req.systemId}` };
  if (!isSimnovatorTarget(target))    return { ok: false, files: [], searchedDirs: [], error: `target ${target.id} is not type SIMNOVATOR` };

  const creds = cockpitCreds(target);
  const cockpitUrl = `https://${target.host}:${creds.port}`;
  const dirs = (req.searchDirs?.length ? req.searchDirs : DEFAULT_SEARCH_DIRS)
    .map((d) => d.trim())
    .filter(Boolean);
  const maxDepth = Math.max(1, Math.min(req.maxDepth ?? 2, 8));

  let browser: Browser | undefined;
  try {
    browser = await launchBrowser();
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    page.setDefaultNavigationTimeout(45_000);

    // Login
    await page.goto(`${cockpitUrl}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#login-user-input, input[name="user"]', { timeout: 20_000 });
    await page.fill('#login-user-input, input[name="user"]', creds.user);
    await page.fill('#login-password-input, input[name="password"]', creds.password);
    await page.click('#login-button, button[type="submit"]');
    const loggedIn = await page.locator('#login-user-input').waitFor({ state: 'detached', timeout: 25_000 })
      .then(() => true).catch(() => false);
    if (!loggedIn) return { ok: false, files: [], searchedDirs: dirs, error: 'Cockpit login failed (check creds in Inventory)' };
    await page.waitForFunction(() => location.pathname !== '/', { timeout: 15_000 }).catch(() => null);

    // Open terminal
    await page.goto(`${cockpitUrl}/system/terminal`, { waitUntil: 'domcontentloaded' });
    const frame = await waitForCockpitTerminalFrame(page);
    if (!frame) return { ok: false, files: [], searchedDirs: dirs, error: 'Cockpit terminal iframe did not load' };
    await frame.click('body').catch(() => null);
    await new Promise((r) => setTimeout(r, 600));

    // Build the find. We use a delimiter (':::') instead of a tab character
    // because xterm.js renders tabs as visual spaces in its DOM — by the
    // time we read .innerText back, the tab columns are gone. A 3-char
    // printable delimiter survives xterm rendering reliably and is
    // virtually never present in real filesystem paths.
    //
    // We let `find` only print what we want; sorting happens client-side
    // (avoids any bash-only `$'\t'` syntax in `sort -t`).
    const SEP = ':::';
    const dirArgs = dirs.map(shellQuote).join(' ');
    const cmd =
      `find ${dirArgs} -maxdepth ${maxDepth} -type f \\( -iname '*.tar.gz' -o -iname '*.tgz' \\) ` +
      `-printf '%p${SEP}%s${SEP}%T@\\n' 2>/dev/null`;
    const output = await runCommandCapture(page, frame, cmd, 20_000);

    // Match lines that look like our printf format. Anchoring to the start
    // of the path (`/`) keeps stray prompt / banner text out, and using `m`
    // flag means we can scan the whole captured screen at once.
    const re = new RegExp('(^|\\n)(/[^\\n]+?)' + SEP + '(\\d+)' + SEP + '(\\d+(?:\\.\\d+)?)(?=\\n|$)', 'g');
    const seen = new Set<string>();
    const files: VmFile[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(output)) !== null) {
      const pathStr = m[2].trim();
      if (seen.has(pathStr)) continue;
      seen.add(pathStr);
      files.push({
        path: pathStr,
        size: Number(m[3]),
        mtime: new Date(Number(m[4]) * 1000).toISOString(),
      });
    }
    // Newest first.
    files.sort((a, b) => (b.mtime || '').localeCompare(a.mtime || ''));

    if (files.length === 0) {
      // Surface the raw screen so the user (and we) can see what find
      // actually returned. Trimmed to keep it manageable.
      const screenSnippet = output
        .split(/\r?\n/)
        .filter((s) => s.trim().length > 0)
        .slice(-30)
        .join('\n');
      return { ok: true, files, searchedDirs: dirs, error: `find returned no .tar.gz matches. Last 30 non-empty lines from terminal:\n${screenSnippet}` };
    }

    return { ok: true, files, searchedDirs: dirs };
  } catch (e: any) {
    return { ok: false, files: [], searchedDirs: dirs, error: e?.message ?? String(e) };
  } finally {
    try { await browser?.close(); } catch { /* ignore */ }
  }
}

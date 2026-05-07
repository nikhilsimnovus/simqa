// Walk the Simnovator management UI with Playwright and dump structure clues
// (URL after login, page title, role-based selectors visible) so we can write
// stable test selectors.

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const HOST = process.env.UESIM_HOST ?? '192.168.1.95';
const USER = process.env.UESIM_USER ?? 'admin';
const PASS = process.env.UESIM_PASS ?? 'admin';
const OUT = resolve(process.cwd(), 'scripts/.out/ui-probe');

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1400, height: 900 },
  });
  const page = await ctx.newPage();

  const reqs: Array<{ method: string; url: string; status?: number }> = [];
  page.on('request', (r) => reqs.push({ method: r.method(), url: r.url() }));
  page.on('response', (r) => {
    const m = reqs.find((x) => x.url === r.url() && x.status === undefined);
    if (m) m.status = r.status();
  });
  const errors: string[] = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });

  console.log(`navigating to http://${HOST}/`);
  const t0 = Date.now();
  await page.goto(`http://${HOST}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  console.log(`landed: url=${page.url()}  title=${await page.title()}  (${Date.now() - t0}ms)`);

  await page.screenshot({ path: `${OUT}/01-landing.png`, fullPage: true });

  // Try to identify login form
  const inputs = await page.$$eval('input', (els) => els.map((el) => ({
    name: (el as HTMLInputElement).name,
    type: (el as HTMLInputElement).type,
    placeholder: (el as HTMLInputElement).placeholder,
    id: el.id,
    visible: !!(el as HTMLElement).offsetParent,
  })));
  console.log('inputs on landing page:', JSON.stringify(inputs, null, 2));
  const buttons = await page.$$eval('button', (els) => els.map((el) => ({
    text: el.textContent?.trim().slice(0, 60),
    type: (el as HTMLButtonElement).type,
    visible: !!(el as HTMLElement).offsetParent,
  })));
  console.log('buttons on landing page:', JSON.stringify(buttons, null, 2));

  // Attempt login
  const userInput = page.locator('input[type="text"], input[name*="user" i], input[id*="user" i]').first();
  const passInput = page.locator('input[type="password"]').first();
  if (await userInput.count() && await passInput.count()) {
    await userInput.fill(USER);
    await passInput.fill(PASS);
    const loginBtn = page.locator('button[type="submit"], button:has-text("Login"), button:has-text("Sign in"), button:has-text("Log in")').first();
    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => null),
      loginBtn.click(),
    ]);
    console.log(`after login: url=${page.url()}  title=${await page.title()}`);
    await page.screenshot({ path: `${OUT}/02-after-login.png`, fullPage: true });
  } else {
    console.log('no login form visible; UI may already be authenticated or use a different layout');
  }

  // Inventory: links, buttons, headings, role landmarks
  const links = await page.$$eval('a', (els) => els.map((a) => ({
    text: a.textContent?.trim().slice(0, 60),
    href: a.getAttribute('href'),
    visible: !!(a as HTMLElement).offsetParent,
  })).filter((x) => x.text || x.href));
  writeFileSync(`${OUT}/links.json`, JSON.stringify(links, null, 2));
  console.log(`saw ${links.length} links (saved to ${OUT}/links.json)`);

  const headings = await page.$$eval('h1,h2,h3', (els) => els.map((h) => ({
    tag: h.tagName, text: h.textContent?.trim().slice(0, 80),
  })));
  console.log('headings:', JSON.stringify(headings, null, 2));

  // Try common nav targets to find the testcase / executions pages
  const candidates = ['Test Cases', 'Testcases', 'Test cases', 'Executions', 'Logs', 'Statistics', 'Stats', 'Simulators', 'Run', 'Runs'];
  for (const label of candidates) {
    const link = page.getByRole('link', { name: label, exact: false }).first();
    if (await link.count()) {
      console.log(`found link: "${label}"`);
    }
  }

  // Save the network log
  writeFileSync(`${OUT}/requests.json`, JSON.stringify(reqs, null, 2));
  writeFileSync(`${OUT}/console-errors.txt`, errors.join('\n'));
  console.log(`network log: ${reqs.length} requests, ${errors.length} console errors`);

  await browser.close();
  console.log(`\nartifacts in ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

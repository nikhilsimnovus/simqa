// Phase 3 probe: walk Users, Tools, Statistics, Logs in detail. Take a
// screenshot of each, dump buttons / inputs / table state.

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const HOST = process.env.UESIM_HOST ?? '192.168.1.95';
const USER = process.env.UESIM_USER ?? 'admin';
const PASS = process.env.UESIM_PASS ?? 'admin';
const OUT = resolve(process.cwd(), 'scripts/.out/ui-probe');

async function login(page: any) {
  await page.goto(`http://${HOST}/`, { waitUntil: 'domcontentloaded' });
  await page.locator('#username').fill(USER);
  await page.locator('#password').fill(PASS);
  const respPromise = page.waitForResponse((r: any) => r.url().includes('/v2/login') && r.request().method() === 'POST');
  await page.locator('button:has-text("Login")').click();
  await respPromise;
  await page.locator('#username').waitFor({ state: 'detached', timeout: 10000 }).catch(() => null);
  await page.waitForTimeout(1500);
}

async function probePage(page: any, route: string, name: string) {
  console.log(`\n=== ${name} (${route}) ===`);
  const errors: string[] = [];
  const erHandler = (m: any) => { if (m.type() === 'error') errors.push(m.text()); };
  page.on('console', erHandler);
  await page.goto(`http://${HOST}${route}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  console.log(`  url: ${page.url()}`);
  await page.screenshot({ path: `${OUT}/probe-${name}.png`, fullPage: true });

  const buttons = await page.$$eval('button', (els: any[]) => els.map((el) => ({
    text: el.textContent?.trim().slice(0, 40),
    visible: !!(el as HTMLElement).offsetParent,
  })).filter((x: any) => x.text && x.visible));
  const inputs = await page.$$eval('input,select,textarea', (els: any[]) => els.map((el: any) => ({
    tag: el.tagName, type: el.type, name: el.name, id: el.id, placeholder: el.placeholder,
    visible: !!(el as HTMLElement).offsetParent,
  })).filter((x: any) => x.visible));
  const headings = await page.$$eval('h1,h2,h3', (els: any[]) => els.map((h: any) => h.textContent?.trim().slice(0, 60)));
  const tableRows = await page.locator('table tbody tr').count();

  console.log(`  buttons (${buttons.length}):`, buttons.slice(0, 10).map((b: any) => `"${b.text}"`).join(', '));
  console.log(`  inputs (${inputs.length}):`, inputs.slice(0, 8).map((i: any) => `${i.tag}:${i.type}#${i.id}`).join(', '));
  console.log(`  headings:`, headings.slice(0, 5));
  console.log(`  table rows: ${tableRows}`);
  console.log(`  console errors: ${errors.length}`);
  if (errors.length) for (const e of errors) console.log(`     ${e.slice(0, 100)}`);
  page.off('console', erHandler);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();

  await login(page);
  console.log(`logged in: ${page.url()}`);

  await probePage(page, '/testcase', 'testcase');
  await probePage(page, '/statistics', 'statistics');
  await probePage(page, '/statistics?tab=cell', 'stats-cell');
  await probePage(page, '/statistics?tab=ue', 'stats-ue');
  await probePage(page, '/statistics?tab=global', 'stats-global');
  await probePage(page, '/logs', 'logs');
  await probePage(page, '/users', 'users');
  await probePage(page, '/tools', 'tools');
  await probePage(page, '/sample-tests', 'sample-tests');
  await probePage(page, '/my-tests', 'my-tests');

  await browser.close();
  console.log(`\nscreenshots in ${OUT}/`);
}

main().catch((e) => { console.error(e); process.exit(1); });

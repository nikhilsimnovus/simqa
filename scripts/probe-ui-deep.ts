// Deep probe: identify URLs / DOM structure for areas we haven't tested yet.
// Reference areas come from SIM40 bugs:
//   - SIM40-2007: Advanced Settings on Subscriber page
//   - SIM40-2030/2031/2034/2004: Batch run flow
//   - SIM40-1989/1972/1967/1966/1965/1964/1963: Log message details panel
//   - SIM40-1996: RAT type switching restores defaults
//   - SIM40-1937/1957: Sidebar tooltips when collapsed

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const HOST = process.env.UESIM_HOST ?? '192.168.1.95';
const USER = process.env.UESIM_USER ?? 'admin';
const PASS = process.env.UESIM_PASS ?? 'admin';
const OUT = resolve(process.cwd(), 'scripts/.out/ui-deep-probe');

async function login(page: any) {
  await page.goto(`http://${HOST}/`, { waitUntil: 'domcontentloaded' });
  await page.locator('#username').fill(USER);
  await page.locator('#password').fill(PASS);
  await Promise.all([
    page.waitForResponse((r: any) => r.url().includes('/v2/login') && r.request().method() === 'POST'),
    page.locator('button:has-text("Login")').click(),
  ]);
  await page.locator('#username').waitFor({ state: 'detached' }).catch(() => null);
  await page.waitForTimeout(2000);
}

async function probe(page: any, route: string, name: string) {
  console.log(`\n=== ${name} (${route}) ===`);
  await page.goto(`http://${HOST}${route}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  console.log(`  url after: ${page.url()}`);
  await page.screenshot({ path: `${OUT}/${name.replace(/[^\w]/g, '_')}.png`, fullPage: true });
  const onLogin = (await page.locator('#username').count()) > 0;
  if (onLogin) { console.log('  -> bounced to login'); return; }
  const headings = await page.$$eval('h1,h2,h3', (els: any[]) => els.map((h: any) => h.textContent?.trim().slice(0, 60)));
  const buttons = await page.$$eval('button', (els: any[]) => els.map((b: any) => b.textContent?.trim().slice(0, 30)).filter((t: any) => t).slice(0, 15));
  const rows = await page.locator('table tbody tr').count();
  console.log(`  headings: ${JSON.stringify(headings.slice(0, 5))}`);
  console.log(`  buttons:  ${JSON.stringify(buttons)}`);
  console.log(`  rows:     ${rows}`);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  await login(page);

  // Subscriber page candidates
  for (const r of ['/subscriber', '/subscribers', '/subscription', '/sub']) {
    await probe(page, r, `subscriber${r.replace(/\W/g, '_')}`);
  }

  // Batch run candidates
  for (const r of ['/batch', '/batchrun', '/batchRun', '/batch-run', '/batches', '/automation', '/suite']) {
    await probe(page, r, `batch${r.replace(/\W/g, '_')}`);
  }

  // Configuration / RAT switching candidates
  for (const r of ['/configuration', '/config', '/settings', '/cell-config', '/cellConfig']) {
    await probe(page, r, `config${r.replace(/\W/g, '_')}`);
  }

  // Logs - try to find log message details panel by clicking
  await page.goto(`http://${HOST}/logs?TestCaseName=SA-UDP-NC&simulatorName=UE-Simulator&testCaseStatus=Completed&iterationId=67842b28-f573-4f65-a719-1f4e7922b1ca`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);
  console.log(`\n=== logs (with deep link) ===`);
  console.log(`  url: ${page.url()}`);
  await page.screenshot({ path: `${OUT}/logs-with-deeplink.png`, fullPage: true });
  // Click the Offline button to load stored logs
  const offline = page.locator('button:has-text("Offline")').first();
  if (await offline.count()) {
    await offline.click();
    await page.waitForTimeout(3000);
    await page.screenshot({ path: `${OUT}/logs-offline.png`, fullPage: true });
    console.log(`  url after Offline click: ${page.url()}`);
    // Look for log rows
    const logRows = await page.locator('table tbody tr, [class*="log-row" i], [role="row"]').count();
    console.log(`  log rows after Offline: ${logRows}`);
    if (logRows > 0) {
      // Click first log row to open details panel
      const firstLog = page.locator('table tbody tr, [class*="log-row" i]').first();
      await firstLog.click();
      await page.waitForTimeout(2000);
      await page.screenshot({ path: `${OUT}/logs-row-clicked.png`, fullPage: true });
      console.log(`  url after row click: ${page.url()}`);
      // Inspect the details panel
      const dialogVisible = await page.locator('[role="dialog"], [class*="modal" i], [class*="drawer" i], [class*="panel" i]').count();
      console.log(`  dialog/panel count: ${dialogVisible}`);
      const expandBtn = await page.getByText(/expand all|collapse all/i).count();
      const copyBtn = await page.getByText(/^copy$/i).count();
      const jsonView = await page.getByText(/json/i).count();
      console.log(`  expand-all button=${expandBtn} copy=${copyBtn} json=${jsonView}`);
    }
  }

  // Try /tools/simulator-management to find batch / advanced settings
  for (const r of ['/tools/simulator-management', '/tools/simulator', '/simulators', '/simulator']) {
    await probe(page, r, `simctl${r.replace(/\W/g, '_')}`);
  }

  await browser.close();
  console.log(`\nartifacts: ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

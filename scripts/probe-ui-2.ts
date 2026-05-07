// Phase 2 probe: actually log in, wait for the SPA to settle, dump nav.

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
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();

  page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE ERR:', m.text()); });

  await page.goto(`http://${HOST}/`, { waitUntil: 'domcontentloaded' });
  await page.locator('#username').fill(USER);
  await page.locator('#password').fill(PASS);

  // Wait for both: the response from /v2/login AND the form to vanish.
  const [loginResp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/v2/login') && r.request().method() === 'POST', { timeout: 15000 }).catch(() => null),
    page.locator('button:has-text("Login")').click(),
  ]);
  console.log(`login response: status=${loginResp?.status()} url=${loginResp?.url()}`);

  // Wait for login form to disappear
  await page.locator('#username').waitFor({ state: 'detached', timeout: 15000 }).catch(() => null);
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => null);
  await page.waitForTimeout(2000);

  console.log(`post-login url: ${page.url()}`);
  console.log(`post-login title: ${await page.title()}`);
  await page.screenshot({ path: `${OUT}/03-post-login.png`, fullPage: true });

  // Inventory nav structure
  const links = await page.$$eval('a, [role="link"], [role="menuitem"]', (els) => els.map((el) => ({
    text: el.textContent?.trim().slice(0, 80),
    href: el.getAttribute('href') ?? '',
    role: el.getAttribute('role') ?? el.tagName,
    visible: !!(el as HTMLElement).offsetParent,
  })).filter((x) => x.text && x.visible));
  writeFileSync(`${OUT}/nav-links.json`, JSON.stringify(links, null, 2));
  console.log(`nav-relevant elements: ${links.length}`);
  for (const l of links.slice(0, 30)) console.log(`  ${l.role}: "${l.text}" -> ${l.href}`);

  // Headings
  const headings = await page.$$eval('h1,h2,h3,h4', (els) => els.map((h) => `${h.tagName}: ${h.textContent?.trim().slice(0, 80)}`));
  console.log(`\nheadings: ${headings.length}`);
  for (const h of headings) console.log(`  ${h}`);

  // Routes Anchors hint at react-router structure. Try to find the testcases page.
  const candidateRoutes = ['/testcases', '/test-cases', '/executions', '/logs', '/simulators', '/dashboard', '/home'];
  for (const r of candidateRoutes) {
    const url = `http://${HOST}${r}`;
    try {
      const t0 = Date.now();
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null);
      await page.waitForTimeout(1500);
      const finalUrl = page.url();
      const title = await page.title();
      const h1 = await page.locator('h1, h2').first().textContent().catch(() => '<none>');
      console.log(`  GET ${r}  -> ${resp?.status()}  final=${finalUrl}  title="${title}"  h1="${h1}"  (${Date.now() - t0}ms)`);
      const safeName = r.replace(/[^\w]/g, '_');
      await page.screenshot({ path: `${OUT}/route${safeName}.png`, fullPage: true });
    } catch (e: any) {
      console.log(`  GET ${r}  -> error: ${e?.message}`);
    }
  }

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });

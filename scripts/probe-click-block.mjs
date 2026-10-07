// Probe: why do some enabled controls refuse a click?
// Playwright says what intercepted the pointer, which distinguishes a real
// obstruction on the page from the test being stricter than a human.
//   node probe-click-block.mjs <host> <user> <pass>
import { chromium } from 'playwright';

const HOST = process.argv[2] ?? '192.168.1.102';
const USER = process.argv[3] ?? process.env.BOX_USER;
const PASS = process.argv[4] ?? process.env.BOX_PASS;
if (!USER || !PASS) {
  console.error('usage: node probe-click-block.mjs <host> <user> <pass>  (or set BOX_USER / BOX_PASS)');
  process.exit(2);
}

const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1500, height: 950 } });
const page = await ctx.newPage();
await page.goto(`http://${HOST}/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.locator('#username').fill(USER);
await page.locator('#password').fill(PASS);
await page.locator('button:has-text("Login")').first().click();
await page.waitForTimeout(5000);

for (const [url, names] of [
  [`http://${HOST}/tools/band-info`, ['Mode', 'Geo Area', 'More Filters', 'Sort by Band']],
  [`http://${HOST}/tools/network-topology`, ['Zoom in', 'Zoom out']],
]) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  console.log(`\n=== ${url}`);
  for (const name of names) {
    const el = page.getByRole('button', { name }).first();
    const n = await el.count().catch(() => 0);
    if (!n) { console.log(`  ${name}: not found`); continue; }
    const box = await el.boundingBox().catch(() => null);
    // What is actually at the centre of the control?
    const atPoint = box ? await page.evaluate(([x, y]) => {
      const t = document.elementFromPoint(x, y);
      if (!t) return 'nothing';
      return `${t.tagName.toLowerCase()}.${String(t.className).slice(0, 60)}`;
    }, [box.x + box.width / 2, box.y + box.height / 2]).catch(() => '?') : 'no box';
    const err = await el.click({ timeout: 4000 }).then(() => null).catch(e => String(e.message).split('\n').slice(0, 3).join(' | '));
    console.log(`  ${name}: ${err ? 'REFUSED' : 'clicked ok'}`);
    console.log(`     at its centre: ${atPoint}`);
    if (err) console.log(`     playwright: ${err.slice(0, 220)}`);
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => null);
    await page.waitForTimeout(1500);
  }
}
await browser.close();

// Probe: why does the evidence ring come out black instead of red?
import { chromium } from 'playwright';

// Credentials come from the caller, never from this file:
//   node probe-highlight.mjs <host> <user> <pass>
// or BOX_USER / BOX_PASS in the environment.
const HOST = process.argv[2] ?? '192.168.1.102';
const USER = process.argv[3] ?? process.env.BOX_USER;
const PASS = process.argv[4] ?? process.env.BOX_PASS;
if (!USER || !PASS) {
  console.error('usage: node probe-highlight.mjs <host> <user> <pass>  (or set BOX_USER / BOX_PASS)');
  process.exit(2);
}

const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1500, height: 950 } });
const page = await ctx.newPage();
await page.goto(`http://${HOST}/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.locator('#username, input[name="username"]').first().fill(USER);
await page.locator('#password, input[name="password"]').first().fill(PASS);
await page.locator('button:has-text("Login")').first().click();
await page.waitForTimeout(6000);
await page.goto(`http://${HOST}/tools`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);

const loc = page.getByRole('button', { name: 'Spectrum Analyzer' }).first();
const before = await loc.evaluate((el) => {
  const cs = getComputedStyle(el);
  return { tag: el.tagName, cls: String(el.className).slice(0, 120), outline: cs.outline, outlineColor: cs.outlineColor, boxShadow: cs.boxShadow.slice(0, 80), border: cs.border };
});
console.log('BEFORE:', JSON.stringify(before, null, 1));

const after = await loc.evaluate((el) => {
  el.style.setProperty('outline', '3px solid #ef4444', 'important');
  el.style.setProperty('outline-offset', '2px', 'important');
  el.style.setProperty('box-shadow', '0 0 0 6px rgba(239, 68, 68, 0.35)', 'important');
  const cs = getComputedStyle(el);
  return {
    inlineStyle: el.getAttribute('style'),
    outline: cs.outline, outlineColor: cs.outlineColor,
    boxShadow: cs.boxShadow.slice(0, 80),
    // Is something else painting the visible ring?
    parentOutline: el.parentElement ? getComputedStyle(el.parentElement).outline : '(no parent)',
  };
});
console.log('AFTER :', JSON.stringify(after, null, 1));

await browser.close();

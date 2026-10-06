// Probe: what does the 1.102 SPA shell actually look like?
import { chromium } from 'playwright';

const HOST = process.argv[2] ?? '192.168.1.102';
const USER = process.argv[3] ?? 'simuser';
const PASS = process.argv[4] ?? 'simuser';

const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1500, height: 950 } });
const page = await ctx.newPage();
await page.goto(`http://${HOST}/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.locator('#username, input[name="username"]').first().fill(USER);
await page.locator('#password, input[name="password"]').first().fill(PASS);
await page.locator('button:has-text("Login")').first().click();
await page.waitForTimeout(6000);
console.log('URL after login:', page.url());

const out = await page.evaluate(() => {
  const vis = (el) => el.getClientRects().length > 0;
  const txt = (el) => (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 50);
  const desc = (el) => ({
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute('role') || '',
    cls: String(el.className || '').slice(0, 90),
    href: el.getAttribute('href') || '',
    aria: el.getAttribute('aria-label') || '',
    text: txt(el),
  });

  const shellSel = 'nav, aside, header, footer, [role="navigation"], [role="banner"], .sidebar, .navbar, [class*="sidebar" i], [class*="nav" i], [data-sidebar]';
  const shells = Array.from(document.querySelectorAll(shellSel)).filter(vis).map(desc);

  const links = Array.from(document.querySelectorAll('a[href]')).filter(vis).map(desc);

  // Anything that looks like a menu row: a clickable with short text in the left third of the screen.
  const clickables = Array.from(document.querySelectorAll('a, button, [role="button"], [role="menuitem"], [role="link"], li, [data-sidebar]'))
    .filter(vis)
    .map(el => ({ ...desc(el), x: Math.round(el.getBoundingClientRect().left), y: Math.round(el.getBoundingClientRect().top), w: Math.round(el.getBoundingClientRect().width) }))
    .filter(e => e.x < 320 && e.text && e.text.length < 40);

  return {
    rootChildren: Array.from(document.getElementById('root')?.children ?? []).map(desc),
    shells,
    linkCount: links.length,
    links: links.slice(0, 60),
    clickables: clickables.slice(0, 80),
  };
});

console.log(JSON.stringify(out, null, 1));
await browser.close();

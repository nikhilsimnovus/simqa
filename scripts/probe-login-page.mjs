// Probe: what is actually on the Simnovator login page?
// Credentials are not needed — this never signs in.
//   node probe-login-page.mjs <host>
import { chromium } from 'playwright';

const HOST = process.argv[2] ?? '192.168.1.102';

const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 1400, height: 900 } });
await page.goto(`http://${HOST}/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(2500);

const out = await page.evaluate(() => {
  const vis = (el) => el.getClientRects().length > 0;
  const d = (el) => ({
    tag: el.tagName.toLowerCase(),
    type: el.getAttribute('type') || '',
    id: el.id || '',
    name: el.getAttribute('name') || '',
    placeholder: el.getAttribute('placeholder') || '',
    aria: el.getAttribute('aria-label') || '',
    required: el.required ?? false,
    disabled: !!el.disabled,
    text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60),
    href: el.getAttribute('href') || '',
  });
  return {
    url: location.href,
    title: document.title,
    inputs: Array.from(document.querySelectorAll('input, textarea, select')).filter(vis).map(d),
    buttons: Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]')).filter(vis).map(d),
    links: Array.from(document.querySelectorAll('a')).filter(vis).map(d),
    checkboxes: Array.from(document.querySelectorAll('input[type="checkbox"], [role="checkbox"]')).filter(vis).map(d),
    bodyText: (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 400),
  };
});
console.log(JSON.stringify(out, null, 1));
await browser.close();

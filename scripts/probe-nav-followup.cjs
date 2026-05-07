// Follow-up probe to nail down N3 (Statistics chevron) and N6 (logo click).
//   node scripts/probe-nav-followup.cjs

const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');

const HOST = '192.168.1.95';
const OUT = path.resolve(__dirname, '.out', 'nav-probe-2');
fs.mkdirSync(OUT, { recursive: true });
const snap = (page, name) => page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: false });

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(90000);
  const evidence = {};

  // Login
  for (let i = 1; i <= 3; i++) {
    try { await page.goto(`http://${HOST}/`, { waitUntil: 'commit', timeout: 60000 }); break; }
    catch (e) { if (i === 3) throw e; await new Promise((r) => setTimeout(r, 2000)); }
  }
  await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => null);
  const respPromise = page.waitForResponse((r) => r.url().includes('/v2/login') && r.request().method() === 'POST', { timeout: 45000 }).catch(() => null);
  await page.locator('#username').first().fill('admin');
  await page.locator('#password').first().fill('admin');
  await page.locator('button:has-text("Login")').first().click();
  const resp = await respPromise;
  console.log('login=' + (resp ? resp.status() : 'none'));
  await page.waitForFunction(() => location.pathname !== '/' && !document.querySelector('#username'), { timeout: 15000 }).catch(() => null);
  await page.waitForTimeout(3000);

  // ── N3 follow-up: click the actual chevron next to "Statistics" ─────
  await page.goto(`http://${HOST}/testcase`, { waitUntil: 'commit', timeout: 90000 }).catch(() => null);
  await page.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => null);
  await page.waitForTimeout(2500);
  await snap(page, '00-stats-before');

  // Inspect the Statistics row + its children to find the chevron.
  evidence.n3 = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('a, li, button, [role="menuitem"], div, span'));
    const labelEl = all.find((e) => (e.textContent ?? '').trim() === 'Statistics');
    if (!labelEl) return { found: false };
    // Walk up to find the row container, then dump every clickable / chevron candidate inside.
    let row = labelEl;
    for (let i = 0; i < 4 && row.parentElement; i++) row = row.parentElement;
    const out = { found: true, rowTag: row.tagName.toLowerCase(), rowCls: (row.className || '').toString(), interactive: [] };
    row.querySelectorAll('button, [role="button"], svg, [class*="chevron" i], [class*="arrow" i]').forEach((el) => {
      const r = el.getBoundingClientRect();
      out.interactive.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.className || '').toString().slice(0, 60),
        left: r.left, top: r.top, width: r.width, height: r.height,
        aria: el.getAttribute('aria-label') || '',
      });
    });
    return out;
  });

  // Click the rightmost element in the Statistics row (likely the chevron).
  const clickTarget = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('a, li, button, [role="menuitem"], div, span'));
    const labelEl = all.find((e) => (e.textContent ?? '').trim() === 'Statistics');
    if (!labelEl) return null;
    let row = labelEl;
    for (let i = 0; i < 4 && row.parentElement; i++) row = row.parentElement;
    const cands = Array.from(row.querySelectorAll('button, svg, [class*="chevron" i]')).map((el) => {
      const r = el.getBoundingClientRect();
      return { el, right: r.right, top: r.top, width: r.width, height: r.height, left: r.left };
    });
    if (!cands.length) return null;
    // Sort by rightmost
    cands.sort((a, b) => b.right - a.right);
    const c = cands[0];
    return { left: c.left, top: c.top, width: c.width, height: c.height };
  });
  if (clickTarget) {
    await page.mouse.click(clickTarget.left + clickTarget.width / 2, clickTarget.top + clickTarget.height / 2);
    await page.waitForTimeout(1200);
  }
  evidence.n3.clickTarget = clickTarget;

  evidence.n3.afterClick = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('a, li, button, [role="menuitem"], div, span'));
    const cell = all.find((e) => (e.textContent ?? '').trim() === 'Cell Statistics');
    const ue = all.find((e) => (e.textContent ?? '').trim() === 'UE Statistics');
    return {
      cellVisible: !!cell && cell.offsetParent !== null,
      ueVisible: !!ue && ue.offsetParent !== null,
    };
  });
  await snap(page, '01-stats-after');

  // ── N6 follow-up: click the actual logo IMG element ─────────────────
  await page.goto(`http://${HOST}/logs`, { waitUntil: 'commit', timeout: 90000 }).catch(() => null);
  await page.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => null);
  await page.waitForTimeout(2500);
  await snap(page, '10-logo-before');
  evidence.n6 = { startUrl: page.url() };

  // Try to find an <a> wrapping the logo, then fall back to clicking the img.
  const logoInfo = await page.evaluate(() => {
    const img = Array.from(document.querySelectorAll('img')).find((i) => /logo/i.test(i.src || '') || /logo/i.test(i.className || ''));
    if (!img) return null;
    const r = img.getBoundingClientRect();
    const wrappingA = img.closest('a');
    return {
      src: img.src, cls: img.className,
      left: r.left, top: r.top, width: r.width, height: r.height,
      hasAncestorA: !!wrappingA, ancestorHref: wrappingA ? wrappingA.getAttribute('href') : null,
      hasOnClickAttr: !!img.getAttribute('onclick'),
    };
  });
  evidence.n6.logoInfo = logoInfo;
  if (logoInfo) {
    await page.mouse.click(logoInfo.left + logoInfo.width / 2, logoInfo.top + logoInfo.height / 2);
    await page.waitForTimeout(2500);
  }
  evidence.n6.afterUrl = page.url();
  await snap(page, '11-logo-after');

  fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log('wrote ' + path.join(OUT, 'evidence.json'));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });

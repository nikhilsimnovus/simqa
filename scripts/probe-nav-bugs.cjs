// Verify suspected navigation bugs against the box, capturing rich evidence:
// for each suspect, dump full-page screenshot before+after a click + the
// DOM state of the candidate element (computed styles, dims, child count)
// so we can confidently distinguish "real product bug" from "test selector
// missed the target".
//
//   node scripts/probe-nav-bugs.cjs

const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');

const HOST = '192.168.1.95';
const OUT = path.resolve(__dirname, '.out', 'nav-probe');
fs.mkdirSync(OUT, { recursive: true });

function snap(page, name) {
  return page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: false });
}

function dumpEl(page, label, selectorJs) {
  return page.evaluate(({ label, selectorJs }) => {
    // selectorJs is a string of code that returns an Element (or null).
    let el;
    try { el = (new Function('return (' + selectorJs + ')()'))(); } catch (e) { return { label, error: String(e) }; }
    if (!el) return { label, found: false };
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      label, found: true,
      tag: el.tagName.toLowerCase(),
      cls: el.className,
      text: (el.textContent ?? '').trim().slice(0, 80),
      bg: cs.backgroundColor, color: cs.color, fontWeight: cs.fontWeight,
      width: r.width, height: r.height, left: r.left, top: r.top,
      childCount: el.children.length,
      outerHTMLPreview: el.outerHTML.slice(0, 240),
    };
  }, { label, selectorJs });
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(90000);
  const evidence = {};

  // ── Login ──────────────────────────────────────────────────
  // Box is slow today; first goto retries up to 3x.
  let loaded = false;
  for (let i = 1; i <= 3 && !loaded; i++) {
    try {
      await page.goto(`http://${HOST}/`, { waitUntil: 'commit', timeout: 60000 });
      loaded = true;
    } catch (e) {
      console.error(`goto attempt ${i} failed: ${e.message.slice(0, 80)}`);
      if (i === 3) throw e;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => null);
  await page.waitForTimeout(2000);
  const respPromise = page.waitForResponse((r) => r.url().includes('/v2/login') && r.request().method() === 'POST', { timeout: 45000 }).catch(() => null);
  await page.locator('#username, input[name="username"]').first().fill('admin');
  await page.locator('#password, input[name="password"]').first().fill('admin');
  await page.locator('button:has-text("Login")').first().click();
  const resp = await respPromise;
  console.log('login resp status=' + (resp ? resp.status() : 'none'));
  await page.waitForFunction(() => location.pathname !== '/' && !document.querySelector('#username'), { timeout: 15000 }).catch(() => null);
  await page.waitForTimeout(3000);
  await snap(page, '00-after-login');
  console.log('logged in, url=' + page.url());

  // ── N4: active sidebar item highlight ─────────────────────
  // Go to /logs and dump the styles of EVERY ancestor up to body for
  // both "Logs" and "My Tests", so we can see which level holds the highlight.
  await page.goto(`http://${HOST}/logs`, { waitUntil: 'commit', timeout: 90000 }).catch((e) => console.error('logs nav failed: ' + e.message.slice(0, 80)));
  await page.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => null);
  await page.waitForTimeout(2500);
  await snap(page, '10-logs-page');

  evidence.n4 = await page.evaluate(() => {
    const findRow = (label) => {
      const cands = Array.from(document.querySelectorAll('a, li, button, [role="menuitem"], div, span'));
      return cands.find((e) => (e.textContent ?? '').trim() === label);
    };
    const dumpChain = (label, el) => {
      if (!el) return { label, found: false };
      const chain = [];
      let cur = el;
      for (let i = 0; i < 5 && cur; i++) {
        const cs = getComputedStyle(cur);
        chain.push({
          depth: i,
          tag: cur.tagName.toLowerCase(),
          cls: (cur.className || '').toString().slice(0, 80),
          bg: cs.backgroundColor, color: cs.color, fontWeight: cs.fontWeight,
          paddingTop: cs.paddingTop, paddingLeft: cs.paddingLeft,
        });
        cur = cur.parentElement;
      }
      return { label, found: true, chain };
    };
    return {
      logs: dumpChain('Logs', findRow('Logs')),
      myTests: dumpChain('My Tests', findRow('My Tests')),
    };
  });

  // ── N2: sidebar collapse toggle ──────────────────────────
  await page.goto(`http://${HOST}/testcase`, { waitUntil: 'commit', timeout: 90000 }).catch((e) => console.error('testcase nav failed: ' + e.message.slice(0, 80)));
  await page.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => null);
  await page.waitForTimeout(2500);
  await snap(page, '20-testcase-before-collapse');
  // Get current sidebar candidates and their dimensions.
  const collapseBefore = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('aside, nav, [class*="sidebar" i]'));
    return all.slice(0, 5).map((e) => {
      const r = e.getBoundingClientRect();
      return { tag: e.tagName.toLowerCase(), cls: (e.className || '').toString().slice(0, 60), w: r.width, h: r.height, left: r.left };
    });
  });

  // Find a collapse-shaped icon at bottom-left.
  const collapseTarget = await page.evaluate(() => {
    const cands = Array.from(document.querySelectorAll('button, [role="button"], svg, [class*="collapse" i], [class*="toggle" i]'));
    const matches = [];
    for (const el of cands) {
      const r = el.getBoundingClientRect();
      if (r.left < 100 && r.top > window.innerHeight - 200 && r.width > 5 && r.width < 60) {
        matches.push({
          tag: el.tagName.toLowerCase(),
          cls: (el.className || '').toString().slice(0, 80),
          left: r.left, top: r.top, width: r.width, height: r.height,
          aria: el.getAttribute('aria-label') || '',
          title: el.getAttribute('title') || '',
        });
      }
    }
    return matches;
  });
  evidence.n2 = { collapseBefore, candidates: collapseTarget };

  // Click the most likely candidate (smallest button-shaped element bottom-left).
  if (collapseTarget.length > 0) {
    const cx = collapseTarget[0].left + collapseTarget[0].width / 2;
    const cy = collapseTarget[0].top + collapseTarget[0].height / 2;
    await page.mouse.click(cx, cy);
    await page.waitForTimeout(1200);
  }
  await snap(page, '21-testcase-after-collapse-click');
  evidence.n2.collapseAfter = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('aside, nav, [class*="sidebar" i]'));
    return all.slice(0, 5).map((e) => {
      const r = e.getBoundingClientRect();
      return { tag: e.tagName.toLowerCase(), cls: (e.className || '').toString().slice(0, 60), w: r.width, h: r.height, left: r.left };
    });
  });

  // ── N3: Statistics group collapsible ─────────────────────
  // Reset by re-visiting /testcase
  await page.goto(`http://${HOST}/testcase`, { waitUntil: 'commit', timeout: 90000 }).catch((e) => console.error('testcase nav failed: ' + e.message.slice(0, 80)));
  await page.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => null);
  await page.waitForTimeout(2500);
  await snap(page, '30-testcase-before-stats-collapse');
  evidence.n3 = await page.evaluate(() => {
    const findRow = (label) => {
      const cands = Array.from(document.querySelectorAll('a, li, button, [role="menuitem"], div, span'));
      return cands.find((e) => (e.textContent ?? '').trim() === label);
    };
    const cellBefore = findRow('Cell Statistics');
    const ueBefore = findRow('UE Statistics');
    return {
      cellBeforeVisible: !!cellBefore && cellBefore.offsetParent !== null,
      ueBeforeVisible: !!ueBefore && ueBefore.offsetParent !== null,
    };
  });
  // Click Statistics row
  const statsRow = page.locator('a, li, button, [role="menuitem"], div, span').filter({ hasText: /^Statistics$/ }).first();
  const statsCount = await statsRow.count();
  if (statsCount > 0) {
    await statsRow.click({ force: true }).catch(() => null);
    await page.waitForTimeout(1500);
  }
  evidence.n3.statsRowFound = statsCount > 0;
  await snap(page, '31-testcase-after-stats-click');
  Object.assign(evidence.n3, await page.evaluate(() => {
    const findRow = (label) => {
      const cands = Array.from(document.querySelectorAll('a, li, button, [role="menuitem"], div, span'));
      return cands.find((e) => (e.textContent ?? '').trim() === label);
    };
    const cellAfter = findRow('Cell Statistics');
    const ueAfter = findRow('UE Statistics');
    return {
      cellAfterVisible: !!cellAfter && cellAfter.offsetParent !== null,
      ueAfterVisible: !!ueAfter && ueAfter.offsetParent !== null,
    };
  }));

  // ── N6: Logo click goes home ──────────────────────────────
  await page.goto(`http://${HOST}/logs`, { waitUntil: 'commit', timeout: 90000 }).catch((e) => console.error('logs nav failed: ' + e.message.slice(0, 80)));
  await page.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => null);
  await page.waitForTimeout(2500);
  await snap(page, '40-logs-before-logo-click');
  evidence.n6 = { startUrl: page.url() };

  // Find anything top-left that looks like a logo / home link.
  const logoCands = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('img, a, [class*="logo" i], svg, [class*="brand" i]').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.top < 80 && r.left < 200 && r.width > 15) {
        out.push({
          tag: el.tagName.toLowerCase(),
          cls: (el.className || '').toString().slice(0, 80),
          href: el.getAttribute('href') || '',
          src: el.getAttribute('src') || '',
          left: r.left, top: r.top, width: r.width, height: r.height,
          isLink: el.tagName === 'A' || !!el.closest('a'),
          parentHref: el.closest('a') ? el.closest('a').getAttribute('href') : '',
        });
      }
    });
    return out;
  });
  evidence.n6.candidates = logoCands;

  if (logoCands.length > 0) {
    // Try clicking the first one
    const c = logoCands[0];
    await page.mouse.click(c.left + c.width / 2, c.top + c.height / 2);
    await page.waitForTimeout(2000);
  }
  evidence.n6.afterClickUrl = page.url();
  await snap(page, '41-logs-after-logo-click');

  // ── Done ──────────────────────────────────────────────────
  fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log('wrote evidence to ' + OUT);
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

// Running the generated checks against the live UI.
//
// Checks arrive grouped by page, because reaching a page is the expensive
// part: one navigation, then every check about that page runs against what is
// already on screen. A page that cannot be reached fails its own load check
// and reports the rest as skipped with that as the reason, rather than
// producing thirty identical failures.
//
// The risk policy from classify.ts is enforced here too, not just at planning
// time: a check marked notApplicable is reported as Not Available without the
// executor so much as resolving its selector.

import type { Page } from 'playwright';
import type { GeneratedCheck } from './types.ts';
import { looksLikeEmptyState } from './classify.ts';
import { closeAnyDialog, dialogOpen, fingerprint } from './crawl.ts';
import { runLoginCheck, type LoginForm, type StepRecord } from './login.ts';

export type CheckStatus = 'pass' | 'fail' | 'skip' | 'not-available' | 'error';

export interface CheckOutcome {
  check: GeneratedCheck;
  status: CheckStatus;
  /** What actually happened, in the operator's words. */
  actual: string;
  /** Present for 'error' and for failures with a cause worth quoting. */
  error?: string;
  reason?: string;
  durationMs: number;
  ranAt: string;
  finalUrl?: string;
  consoleErrors?: string[];
  /** Screenshot file, relative to the run dir. */
  screenshotFile?: string;
  /** For checks that walk a sequence — the login flows — what each step did
   *  and a capture of the screen at that point. */
  steps?: StepRecord[];
}

export interface ExecContext {
  page: Page;
  host: string;
  /** Console errors and XHR seen since the last reset — the capture is owned
   *  by the caller because it spans navigations. */
  consoleErrorsSince: () => string[];
  apiCallsSince: () => Array<{ method: string; url: string; status?: number }>;
  resetCapture: () => void;
  /** A page in a context with no session, for the logged-out check. */
  newAnonPage?: () => Promise<Page>;
  /** Save a screenshot and return its file name. */
  /** Save a capture and return its file name. `fullPage` off gives the
   *  viewport, which is what shows a control in the context around it. */
  shot: (name: string, opts?: { fullPage?: boolean }) => Promise<string | undefined>;
  probeRequiredFields?: boolean;
  /** Who this run signs in as — the login checks type these. */
  creds?: { host: string; username: string; password: string };
  /** What the login page offered when it was read. */
  loginForm?: LoginForm;
  /** Capture a given page (not necessarily ctx.page) for a step record. */
  shotOf?: (page: Page, name: string) => Promise<string | undefined>;
  signal?: AbortSignal;
}

/** What it means when a control cannot be found.
 *
 *  For a control that lives in a floating, state-dependent panel this is not
 *  a fault: the running-test widget is on screen while a test runs and gone
 *  afterwards, and asserting its buttons as permanent turned one quiet box
 *  into 75 failures. For anything else, missing is missing. */
function missing(c: GeneratedCheck, what: string): { status: CheckStatus; actual: string; reason?: string } {
  if (c.target?.transient) {
    return {
      status: 'skip',
      actual: what,
      reason: 'this control is part of a floating panel that only appears in some states — it was on screen when the UI was read',
    };
  }
  return { status: 'fail', actual: what };
}

/** Capture the page with this check's control ringed in red, so the picture
 *  is proof of THAT control rather than of the page it happens to sit on.
 *
 *  Twenty-four rows sharing one whole-page screenshot was the complaint, and
 *  fairly: a reviewer cannot tell from it which button was checked, or even
 *  that the right one was found. The ring is a style on one element, applied
 *  for the length of one screenshot and put back immediately — it changes
 *  nothing on the box and is never saved anywhere.
 *
 *  Falls back to a plain capture when the element cannot be resolved, which is
 *  itself the state worth seeing on a failure. */
async function shotOfCheck(ctx: ExecContext, c: GeneratedCheck): Promise<string | undefined> {
  const wantsElement = !!(c.element && c.target?.selector);
  if (!wantsElement) {
    // A page-level check is about the whole page, so show the whole page.
    return ctx.shot(c.id, { fullPage: true });
  }
  const loc = await locate(ctx.page, c).first();
  const found = await loc.count().then((n) => n > 0).catch(() => false);
  if (!found) return ctx.shot(c.id, { fullPage: true });

  await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => null);

  // Freeze transitions first. These cards animate their outline and shadow, so
  // the ring was being captured on the transition's opening frame — painted in
  // the site's own colour with the halo still fully transparent, which is why
  // it came out as a black box that looked like part of the design.
  await ctx.page.evaluate(() => {
    const s = document.createElement('style');
    s.id = 'simqa-freeze';
    s.textContent = '*,*::before,*::after{transition:none !important;animation:none !important}';
    document.head.appendChild(s);
  }).catch(() => null);

  const ringed = await loc.evaluate((el: any) => {
    el.setAttribute('data-simqa-style', el.getAttribute('style') ?? '');
    // !important, because the page's own outline and border rules otherwise
    // win and the ring comes out in the site's colour — a black box around a
    // card reads as part of the design rather than as our marker.
    el.style.setProperty('outline', '3px solid #ef4444', 'important');
    el.style.setProperty('outline-offset', '2px', 'important');
    el.style.setProperty('box-shadow', '0 0 0 6px rgba(239, 68, 68, 0.35)', 'important');
    return true;
  }).then(() => true).catch(() => false);

  try {
    return await ctx.shot(c.id, { fullPage: false });
  } finally {
    if (ringed) {
      await loc.evaluate((el: any) => {
        const prev = el.getAttribute('data-simqa-style') ?? '';
        el.removeAttribute('data-simqa-style');
        if (prev) el.setAttribute('style', prev); else el.removeAttribute('style');
      }).catch(() => null);
    }
    await ctx.page.evaluate(() => {
      document.getElementById('simqa-freeze')?.remove();
    }).catch(() => null);
  }
}

// Noise every SPA produces that is not a product defect.
const CONSOLE_NOISE = /favicon|ResizeObserver loop|Download the React DevTools|\[HMR\]|sockjs|net::ERR_ABORTED.*(png|svg|woff)/i;

const realErrors = (errs: string[]) => errs.filter(e => !CONSOLE_NOISE.test(e));

function looksLikeLogin(url: string, text: string): boolean {
  return /\/login|\/signin/.test(url) || /sign in|log in to/i.test(text.slice(0, 400));
}

async function bodyText(page: Page): Promise<string> {
  return page.evaluate('document.body ? document.body.innerText : ""')
    .then(v => String(v ?? '')).catch(() => '');
}

/** Resolve a check's element: its recorded CSS path first, then its label, so
 *  a build that reshuffled the DOM without renaming anything still matches. */
function locate(page: Page, check: GeneratedCheck) {
  const sel = check.target?.selector;
  const label = check.element;
  return {
    async first() {
      if (sel) {
        const byPath = page.locator(sel).first();
        if (await byPath.count().catch(() => 0)) return byPath;
      }
      if (label) {
        // Exact name first, then by substring. A card's accessible name is its
        // title AND its blurb — "SDR Configuration Configure SDR hardware
        // settings" — while the map records the title, so an exact-only
        // fallback finds nothing and the control reads as missing.
        for (const l of [
          page.getByRole('button', { name: label, exact: true }).first(),
          page.getByRole('tab', { name: label, exact: true }).first(),
          page.getByLabel(label, { exact: true }).first(),
          page.getByText(label, { exact: true }).first(),
          page.getByRole('button', { name: label }).first(),
          page.getByRole('tab', { name: label }).first(),
          page.getByLabel(label).first(),
          page.locator('button', { hasText: label }).first(),
          page.getByText(label).first(),
        ]) {
          if (await l.count().catch(() => 0)) return l;
        }
      }
      return sel ? page.locator(sel).first() : page.locator('__none__');
    },
  };
}

/** Get to the page a group of checks is about. Returns how it went, so the
 *  group's load check can report it and the rest can stand down. */
async function reachNode(ctx: ExecContext, any: GeneratedCheck): Promise<{ ok: boolean; how: string; detail: string }> {
  const t = any.target ?? {};
  ctx.resetCapture();
  if (t.url) {
    const ok = await ctx.page.goto(t.url, { waitUntil: 'domcontentloaded', timeout: 40000 })
      .then(() => true).catch(() => false);
    if (!ok) return { ok: false, how: 'url', detail: `could not open ${t.url}` };
    await ctx.page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => null);
    await ctx.page.waitForTimeout(400);
    return { ok: true, how: 'url', detail: `opened ${ctx.page.url()}` };
  }
  if (t.clickFromUrl && t.selector) {
    const navOk = await ctx.page.goto(t.clickFromUrl, { waitUntil: 'domcontentloaded', timeout: 40000 })
      .then(() => true).catch(() => false);
    if (!navOk) return { ok: false, how: 'click', detail: `could not open the parent page ${t.clickFromUrl}` };
    await ctx.page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => null);
    // Replay the clicks that revealed this page during discovery, in order.
    // The chain ENDS with the page's own entry, which matters for an element
    // check: its target.selector is the element, not the tab or card that
    // opens the page it lives on, so clicking that selector to "arrive" would
    // press the element and call it navigation.
    const chain = (t.clickChain ?? []).length ? t.clickChain! : [t.selector];
    let clicked = true;
    for (let i = 0; i < chain.length; i++) {
      const step = chain[i];
      const last = i === chain.length - 1;
      clicked = await ctx.page.locator(step).first().click({ timeout: last ? 10000 : 8000 })
        .then(() => true)
        .catch(async () => {
          // Only the last hop has a label we can fall back on.
          if (!last || !any.element) return false;
          return ctx.page.getByText(any.element, { exact: true }).first().click({ timeout: 6000 })
            .then(() => true).catch(() => false);
        });
      if (!clicked) {
        return last
          ? { ok: false, how: 'click', detail: `the entry "${any.element ?? step}" could not be clicked on ${t.clickFromUrl}` }
          : { ok: false, how: 'click', detail: `could not reopen the parent menu (${step}) on ${t.clickFromUrl}` };
      }
      if (!last) await ctx.page.waitForTimeout(500);
    }
    if (!clicked) return { ok: false, how: 'click', detail: `the entry "${any.element ?? t.selector}" could not be clicked on ${t.clickFromUrl}` };
    await ctx.page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => null);
    await ctx.page.waitForTimeout(400);
    return { ok: true, how: 'click', detail: `selected "${any.element ?? ''}" on ${t.clickFromUrl}` };
  }
  return { ok: false, how: 'none', detail: 'the map recorded no way to reach this page' };
}

// ------------------------------------------------------------ per check ----

/** Records one step of a check, with a capture of the screen at that point.
 *  A verdict says what happened; the steps say how it got there, which is
 *  what makes a failure actionable without reading a log. */
type Recorder = (label: string, ok: boolean, detail?: string, capture?: boolean) => Promise<void>;

async function runCheck(
  ctx: ExecContext,
  c: GeneratedCheck,
  reached: { ok: boolean; detail: string },
  rec: Recorder = async () => {},
): Promise<{ status: CheckStatus; actual: string; error?: string; reason?: string }> {
  const page = ctx.page;

  switch (c.kind) {
    case 'page-loads': {
      if (!reached.ok) return { status: 'fail', actual: reached.detail };
      const text = await bodyText(page);
      if (looksLikeLogin(page.url(), text)) {
        return { status: 'fail', actual: `landed on the login form at ${page.url()} — the session did not hold` };
      }
      if (text.trim().length < 20) {
        return { status: 'fail', actual: `the page opened but rendered almost nothing (${text.trim().length} characters of text)` };
      }
      if (/\b(404|not found|internal server error|something went wrong)\b/i.test(text.slice(0, 300))) {
        return { status: 'fail', actual: `the page shows an error: "${text.slice(0, 120).replace(/\s+/g, ' ')}"` };
      }
      return { status: 'pass', actual: `${reached.detail}, ${text.trim().length} characters of content rendered` };
    }

    case 'tab-switches': {
      if (!reached.ok) return { status: 'skip', actual: reached.detail, reason: 'the tab could not be selected' };
      const el = await locate(page, c).first();
      const state = await el.evaluate((n: any) => ({
        selected: n.getAttribute('aria-selected'),
        cls: String(n.className ?? ''),
      })).catch(() => null);
      const active = !!state && (state.selected === 'true' || /\bactive\b|\bselected\b|ant-tabs-tab-active/.test(state.cls));
      const text = await bodyText(page);
      if (!active) {
        return { status: 'fail', actual: `the tab was clicked but is not marked selected (aria-selected=${state?.selected ?? 'absent'}, class="${(state?.cls ?? '').slice(0, 60)}")` };
      }
      return { status: 'pass', actual: `the tab is selected and its content is showing (${text.trim().length} characters)` };
    }

    case 'page-no-console-errors': {
      if (!reached.ok) return { status: 'skip', actual: reached.detail, reason: 'the page was not reached' };
      const errs = realErrors(ctx.consoleErrorsSince());
      if (errs.length === 0) return { status: 'pass', actual: 'no console errors' };
      return { status: 'fail', actual: `${errs.length} console error(s): ${errs.slice(0, 3).join(' | ').slice(0, 300)}`, error: errs.join('\n') };
    }

    case 'page-api-ok': {
      if (!reached.ok) return { status: 'skip', actual: reached.detail, reason: 'the page was not reached' };
      const calls = ctx.apiCallsSince().filter(x => /\/v\d|\/api\//.test(x.url));
      const bad = calls.filter(x => (x.status ?? 0) >= 400);
      if (calls.length === 0) return { status: 'skip', actual: 'this page made no API calls of its own on this visit', reason: 'nothing to compare' };
      if (bad.length === 0) return { status: 'pass', actual: `${calls.length} API call(s), all under 400` };
      return {
        status: 'fail',
        actual: `${bad.length} of ${calls.length} API call(s) failed: ${bad.slice(0, 3).map(b => `${b.method} ${b.url} -> ${b.status}`).join(' | ')}`,
      };
    }

    case 'element-present': {
      if (!reached.ok) return { status: 'skip', actual: reached.detail, reason: 'the page was not reached' };
      const el = await locate(page, c).first();
      const n = await el.count().catch(() => 0);
      if (!n) return missing(c, `not found on the page (looked for ${c.target?.selector ?? ''} and the label "${c.element ?? ''}")`);
      const vis = await el.isVisible().catch(() => false);
      return vis
        ? { status: 'pass', actual: 'present and visible' }
        : { status: 'fail', actual: 'in the DOM but not visible' };
    }

    case 'element-enabled':
    case 'element-disabled': {
      if (!reached.ok) return { status: 'skip', actual: reached.detail, reason: 'the page was not reached' };
      const el = await locate(page, c).first();
      if (!(await el.count().catch(() => 0))) return missing(c, 'the control is not on the page at all');
      const enabled = await el.isEnabled().catch(() => false);
      const ariaDisabled = await el.getAttribute('aria-disabled').catch(() => null);
      const effectivelyEnabled = enabled && ariaDisabled !== 'true';
      const want = c.kind === 'element-enabled';
      if (effectivelyEnabled === want) {
        return { status: 'pass', actual: want ? 'enabled' : 'still disabled, as discovered' };
      }
      return { status: 'fail', actual: effectivelyEnabled ? 'enabled now — it was disabled when the UI was discovered' : 'disabled now — it was enabled when the UI was discovered' };
    }

    case 'button-responds': {
      if (!reached.ok) return { status: 'skip', actual: reached.detail, reason: 'the page was not reached' };
      const el = await locate(page, c).first();
      if (!(await el.count().catch(() => 0))) return missing(c, 'the control is not on the page');
      if (!(await el.isEnabled().catch(() => false))) {
        return { status: 'skip', actual: 'the control is disabled', reason: 'nothing to press' };
      }
      const beforeUrl = page.url();
      // A filter chip changes the TABLE, and the page fingerprint is the
      // first couple of hundred characters of the main region — the header
      // and the filter bar, which do not move when rows do. Judging a chip by
      // that alone called four working filters dead. The row count and the
      // first cell are what actually answer "did anything happen".
      const listState = () => page.evaluate(`(() => {
        const t = document.querySelector('table, [role="table"], .ant-table');
        if (!t) return 'no-table';
        const b = t.querySelector('tbody') || t;
        const rows = Array.from(b.querySelectorAll('tr, [role="row"]')).filter(r => r.getClientRects().length);
        const first = rows[0] ? (rows[0].innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80) : '';
        return rows.length + '|' + first;
      })()`).then(v => String(v ?? '')).catch(() => '');
      const beforeFp = (await fingerprint(page)) + '::' + (await listState());
      await rec(`Before: the page with "${c.element}" on it`, true, beforeUrl);
      const clicked = await el.click({ timeout: 8000 }).then(() => true).catch(() => false);
      if (!clicked) {
        await rec('Click it', false, 'the control would not take a click');
        return { status: 'fail', actual: 'the control is present and enabled but would not take a click' };
      }
      await page.waitForTimeout(900);
      await rec('After: click it and wait', true, page.url() !== beforeUrl ? `moved to ${page.url()}` : 'same URL');

      if (page.url() !== beforeUrl) {
        return { status: 'pass', actual: `it navigated to ${page.url()}` };
      }
      if (await dialogOpen(page)) {
        const closed = await closeAnyDialog(page);
        return {
          status: 'pass',
          actual: `it opened a dialog${closed ? ', which closed again' : ' that would not close'}`,
        };
      }
      // A toast can come and go, so it is looked for as well as the page body.
      const toast = await page.evaluate(`(() => {
        const sels = ['[role="status"]', '[role="alert"]', '.toast', '.Toastify__toast', '[class*="toast" i]', '[class*="snackbar" i]'];
        for (const s of sels) for (const el of document.querySelectorAll(s)) {
          if (el.getClientRects().length) return (el.textContent || '').trim().slice(0, 120);
        }
        return '';
      })()`).then(v => String(v ?? '')).catch(() => '');
      if (toast) return { status: 'pass', actual: `it showed "${toast}"` };

      const afterFp = (await fingerprint(page)) + '::' + (await listState());
      if (afterFp !== beforeFp) {
        const [, listBefore = ''] = beforeFp.split('::');
        const [, listAfter = ''] = afterFp.split('::');
        if (listBefore !== listAfter && listBefore && listAfter) {
          return { status: 'pass', actual: `the list changed in response (${listBefore.split('|')[0]} row(s) to ${listAfter.split('|')[0]})` };
        }
        return { status: 'pass', actual: 'the page changed in response to the click' };
      }
      // Nothing changed — which is not the same as broken. A filter whose
      // criterion already matches everything on screen correctly does
      // nothing: this box has one simulator, available and UE-SIM, so the
      // Available and UE-SIM chips have nothing to filter out. Calling those
      // failures put four working controls on the list and would teach an
      // operator to ignore it. Reported as inconclusive, with the screenshot
      // of the result, which is what it honestly is.
      return {
        status: 'skip',
        actual: 'clicking it produced no navigation, no dialog, no message and no visible change',
        reason: 'inconclusive: a control that changes nothing may be broken, or may be a filter whose criterion already matches everything on screen — the screenshot shows what was on it',
      };
    }

    case 'access-not-offered': {
      const url = c.target?.url;
      if (!url) return { status: 'skip', actual: 'no URL to ask for', reason: 'nothing to request' };
      const ok = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 })
        .then(() => true).catch(() => false);
      if (!ok) return { status: 'pass', actual: `the box would not serve ${url} to this login at all` };
      await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => null);
      await page.waitForTimeout(600);
      const text = await bodyText(page);
      const landed = page.url();
      if (looksLikeLogin(landed, text)) {
        return { status: 'pass', actual: 'asking for it ended at the login form' };
      }
      if (landed.replace(/\/$/, '') !== url.replace(/\/$/, '')) {
        return { status: 'pass', actual: `the box redirected to ${landed} instead of serving it` };
      }
      if (/\b(403|401|not authori[sz]ed|forbidden|permission|access denied)\b/i.test(text.slice(0, 600))) {
        return { status: 'pass', actual: 'the page answered with a refusal' };
      }
      if (text.trim().length < 60) {
        return { status: 'pass', actual: `the route resolved but rendered nothing for this login (${text.trim().length} characters)` };
      }
      // It rendered. Say precisely what was seen and name the other reading,
      // because a page missing from a login's map can also mean that login's
      // crawl simply never got to it.
      //
      // A page that serves itself and then says "admin role required" is a
      // third thing again — the action is gated, the page and its data are
      // not — and a verdict that does not mention that is misleading.
      const gated = /(admin role required|role required|permission denied|not authori[sz]ed|read[- ]only)/i.exec(text);
      return {
        status: 'fail',
        actual: `${url} was served to this login with ${text.trim().length} characters of content, although only ${c.element}'s UI offers it`
          + (gated ? ` — the page itself says "${gated[0]}", so the action is gated but the page and its contents are not` : ''),
        error: 'either the page is reachable by anyone who knows the URL and only the menu hides it, or this login can legitimately use it and its own crawl never reached it — the screenshot shows which',
      };
    }

    case 'field-labelled': {
      if (!reached.ok) return { status: 'skip', actual: reached.detail, reason: 'the page was not reached' };
      const el = await locate(page, c).first();
      if (!(await el.count().catch(() => 0))) return missing(c, 'the field is not on the page');
      const how = await el.evaluate((n: any) => {
        if (n.getAttribute('aria-label')) return 'aria-label';
        if (n.getAttribute('aria-labelledby')) return 'aria-labelledby';
        if (n.id && document.querySelector('label[for="' + n.id.replace(/"/g, '\\"') + '"]')) return 'label[for]';
        if (n.closest('label')) return 'wrapping label';
        if (n.getAttribute('placeholder')) return 'placeholder only';
        return '';
      }).catch(() => '');
      if (!how) return { status: 'fail', actual: 'no label, no aria-label and no placeholder — the field has no accessible name' };
      return { status: 'pass', actual: `named by ${how}` };
    }

    case 'select-has-options':
    case 'select-options-unique': {
      if (!reached.ok) return { status: 'skip', actual: reached.detail, reason: 'the page was not reached' };
      const el = await locate(page, c).first();
      if (!(await el.count().catch(() => 0))) return missing(c, 'the dropdown is not on the page');
      let options: string[] = await el.evaluate((n: any) =>
        Array.from(n.options ?? []).map((o: any) => String(o.textContent ?? '').trim()).filter(Boolean),
      ).catch(() => []);
      if (options.length === 0) {
        // A custom dropdown only renders its list once opened. Opening one is
        // read-only; whatever it put on screen is closed again afterwards.
        await el.click({ timeout: 6000 }).catch(() => null);
        await page.waitForTimeout(400);
        options = await page.evaluate(`(() => {
          const sels = ['[role="option"]', '.ant-select-item-option-content', '.select2-results__option', 'li[role="option"]'];
          const out = [];
          for (const s of sels) for (const el of document.querySelectorAll(s)) {
            const r = el.getClientRects();
            if (r && r.length) out.push((el.textContent || '').trim());
          }
          return out.filter(Boolean);
        })()`).then(v => (v as string[]) ?? []).catch(() => []);
        await page.keyboard.press('Escape').catch(() => null);
      }
      if (c.kind === 'select-has-options') {
        if (options.length === 0) return { status: 'fail', actual: 'the dropdown opened with no options in it' };
        const was = c.target?.options?.length;
        const changed = typeof was === 'number' && was !== options.length
          ? ` (${was} at discovery, ${options.length} now)` : '';
        return { status: 'pass', actual: `${options.length} option(s): ${options.slice(0, 6).join(', ')}${options.length > 6 ? '…' : ''}${changed}` };
      }
      if (options.length === 0) return { status: 'skip', actual: 'no options could be read', reason: 'nothing to check for duplicates' };
      const dupes = options.filter((o, i) => options.indexOf(o) !== i);
      return dupes.length
        ? { status: 'fail', actual: `duplicate option(s): ${[...new Set(dupes)].join(', ')}` }
        : { status: 'pass', actual: `${options.length} option(s), all distinct` };
    }

    case 'table-headers': {
      if (!reached.ok) return { status: 'skip', actual: reached.detail, reason: 'the page was not reached' };
      const el = await locate(page, c).first();
      if (!(await el.count().catch(() => 0))) return missing(c, 'the table is not on the page');
      const heads: string[] = await el.evaluate((n: any) =>
        Array.from(n.querySelectorAll('th, [role="columnheader"]')).map((h: any) => String(h.innerText ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean),
      ).catch(() => []);
      const expected = c.target?.columns ?? [];
      if (heads.length === 0) return { status: 'fail', actual: 'the table has no column headers' };
      if (expected.length) {
        const missing = expected.filter(x => !heads.includes(x));
        const added = heads.filter(x => !expected.includes(x));
        if (missing.length) {
          return { status: 'fail', actual: `missing column(s) ${missing.join(', ')}; now showing ${heads.join(', ')}` };
        }
        if (added.length) {
          return { status: 'pass', actual: `all expected columns present, plus new one(s): ${added.join(', ')}` };
        }
      }
      return { status: 'pass', actual: `columns: ${heads.join(', ')}` };
    }

    case 'table-rows-or-empty-state': {
      if (!reached.ok) return { status: 'skip', actual: reached.detail, reason: 'the page was not reached' };
      const el = await locate(page, c).first();
      if (!(await el.count().catch(() => 0))) return missing(c, 'the table is not on the page');
      const info = await el.evaluate((n: any) => {
        const body = n.querySelector('tbody') || n;
        const rows = Array.from(body.querySelectorAll('tr, [role="row"]')).filter((r: any) => r.getClientRects().length);
        return { rows: rows.length, text: String(n.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) };
      }).catch(() => ({ rows: 0, text: '' }));
      if (info.rows > 0) return { status: 'pass', actual: `${info.rows} row(s) of data` };
      const pageText = await bodyText(page);
      if (looksLikeEmptyState(info.text) || looksLikeEmptyState(pageText.slice(0, 600))) {
        return { status: 'pass', actual: 'no rows, and the page says so in its own empty state' };
      }
      return { status: 'fail', actual: 'no rows and no empty state — the table is blank with no explanation' };
    }

    case 'sort-reorders': {
      if (!reached.ok) return { status: 'skip', actual: reached.detail, reason: 'the page was not reached' };
      const el = await locate(page, c).first();
      if (!(await el.count().catch(() => 0))) return missing(c, 'the table is not on the page');
      const col = c.target?.columns?.[0];
      const readFirstColumn = () => el.evaluate((n: any) => {
        const body = n.querySelector('tbody') || n;
        return Array.from(body.querySelectorAll('tr')).slice(0, 12)
          .map((r: any) => String((r.querySelector('td, [role="cell"]') || {}).innerText ?? '').trim());
      }).catch(() => [] as string[]);
      const before = await readFirstColumn();
      if (before.length < 2) return { status: 'skip', actual: `${before.length} row(s) in the table`, reason: 'needs at least two rows to show a reorder' };
      const header = col
        ? el.locator(`th:has-text("${col}"), [role="columnheader"]:has-text("${col}")`).first()
        : el.locator('th, [role="columnheader"]').first();
      if (!(await header.count().catch(() => 0))) return { status: 'skip', actual: 'the header could not be located', reason: 'nothing to click' };
      const sortable = await header.evaluate((n: any) =>
        !!(n.getAttribute('aria-sort') || n.querySelector('[class*="sort"]') || /sortable|sorter/i.test(String(n.className ?? ''))),
      ).catch(() => false);
      await rec('Before: the table as it loaded', true, `first value "${before[0] ?? ''}"`);
      await header.click({ timeout: 6000 }).catch(() => null);
      await page.waitForTimeout(700);
      const after = await readFirstColumn();
      await rec(`After: clicked the "${col ?? 'first'}" header`, true, `first value "${after[0] ?? ''}"`);
      if (after.join('|') !== before.join('|')) {
        return { status: 'pass', actual: `the rows reordered on "${col ?? 'the first column'}"` };
      }
      return sortable
        ? { status: 'fail', actual: `"${col ?? 'the first column'}" is marked sortable but clicking it changed nothing` }
        : { status: 'skip', actual: 'the header carries no sort affordance', reason: 'this column is not sortable in this build' };
    }

    case 'search-filters': {
      if (!reached.ok) return { status: 'skip', actual: reached.detail, reason: 'the page was not reached' };
      const box = await locate(page, c).first();
      if (!(await box.count().catch(() => 0))) return missing(c, 'the search box is not on the page');
      const rows = () => page.evaluate(`(() => {
        const t = document.querySelector('table, [role="table"], .ant-table');
        if (!t) return { n: 0, sample: '' };
        const b = t.querySelector('tbody') || t;
        const rs = Array.from(b.querySelectorAll('tr')).filter(r => r.getClientRects().length);
        const first = rs[0];
        const cell = first ? first.querySelector('td') : null;
        return { n: rs.length, sample: cell ? (cell.innerText || '').trim() : '' };
      })()`).then(v => v as { n: number; sample: string }).catch(() => ({ n: 0, sample: '' }));
      const before = await rows();
      if (before.n === 0) return { status: 'skip', actual: 'the list is empty', reason: 'nothing to filter' };
      const token = (before.sample || '').split(/\s+/)[0]?.slice(0, 12);
      if (!token) return { status: 'skip', actual: 'could not read a value out of the first row', reason: 'no search term to type' };
      await rec(`Before: ${before.n} row(s) in the list`, true, `will search for "${token}"`);
      await box.fill(token, { timeout: 6000 }).catch(() => null);
      await page.waitForTimeout(1200);
      const during = await rows();
      await rec(`After: searched for "${token}"`, during.n > 0, `${during.n} row(s) now`);
      await box.fill('', { timeout: 6000 }).catch(() => null);
      await page.waitForTimeout(1000);
      const after = await rows();
      if (during.n === 0) {
        return { status: 'fail', actual: `searching for "${token}" — a value taken from the list itself — returned no rows` };
      }
      if (during.n > before.n) {
        return { status: 'fail', actual: `searching for "${token}" widened the list (${before.n} -> ${during.n} rows)` };
      }
      const restored = after.n >= before.n;
      return {
        status: restored ? 'pass' : 'fail',
        actual: restored
          ? `"${token}" narrowed ${before.n} rows to ${during.n}, and clearing it restored ${after.n}`
          : `"${token}" narrowed ${before.n} rows to ${during.n}, but clearing the box left only ${after.n}`,
      };
    }

    case 'pagination-advances': {
      if (!reached.ok) return { status: 'skip', actual: reached.detail, reason: 'the page was not reached' };
      const pager = await locate(page, c).first();
      if (!(await pager.count().catch(() => 0))) return missing(c, 'the pagination control is not on the page');
      const next = pager.locator('[aria-label*="next" i], li.next a, button:has-text("Next"), a:has-text("Next"), .ant-pagination-next').first();
      if (!(await next.count().catch(() => 0))) return { status: 'skip', actual: 'no next-page control', reason: 'single page of results' };
      const disabled = await next.evaluate((n: any) =>
        !!(n.disabled || n.getAttribute('aria-disabled') === 'true' || /disabled/.test(String(n.className ?? '')) || /disabled/.test(String(n.parentElement?.className ?? ''))),
      ).catch(() => false);
      if (disabled) return { status: 'skip', actual: 'the next-page control is disabled', reason: 'there is only one page of results' };
      const firstCell = () => page.evaluate(`(() => {
        const t = document.querySelector('table, [role="table"], .ant-table');
        const c = t ? t.querySelector('tbody td, td') : null;
        return c ? (c.innerText || '').trim() : '';
      })()`).then(v => String(v ?? '')).catch(() => '');
      const before = await firstCell();
      await rec('Before: the first page of results', true, `first cell "${before}"`);
      await next.click({ timeout: 8000 }).catch(() => null);
      await page.waitForTimeout(1200);
      const after = await firstCell();
      await rec('After: next page', before !== after, `first cell "${after}"`);
      const prev = pager.locator('[aria-label*="prev" i], li.prev a, button:has-text("Prev"), .ant-pagination-prev').first();
      if (await prev.count().catch(() => 0)) {
        await prev.click({ timeout: 6000 }).catch(() => null);
        await page.waitForTimeout(800);
      }
      return before !== after && after !== ''
        ? { status: 'pass', actual: `page 2 shows different rows (first cell "${before}" -> "${after}"), and Previous came back` }
        : { status: 'fail', actual: `Next was enabled but the rows did not change (first cell stayed "${before}")` };
    }

    case 'dialog-opens-and-cancels': {
      if (!reached.ok) return { status: 'skip', actual: reached.detail, reason: 'the page was not reached' };
      const trigger = await locate(page, c).first();
      if (!(await trigger.count().catch(() => 0))) return missing(c, 'the control is not on the page');
      await rec(`Before: the page with "${c.element}" on it`, true, page.url());
      const clicked = await trigger.click({ timeout: 8000 }).then(() => true).catch(() => false);
      if (!clicked) {
        await rec('Click it', false, 'the control would not take a click');
        return { status: 'fail', actual: 'the control is present but would not take a click' };
      }
      await page.waitForTimeout(800);
      await rec('After: click it', true, 'waiting for a form or a page');
      const open = await dialogOpen(page);
      if (!open) {
        // Plenty of Edit buttons route to a page instead of opening a modal.
        const text = await bodyText(page);
        if (text.trim().length > 20) {
          return { status: 'pass', actual: `no modal — it navigated to ${page.url()}, which rendered` };
        }
        return { status: 'fail', actual: 'clicking it opened neither a dialog nor a page' };
      }
      const fields = await page.evaluate(`(() => {
        const sels = ['[role="dialog"]', '.modal.show', '.modal.in', '.ant-modal', '.MuiDialog-container', 'dialog[open]'];
        let root = null;
        for (const s of sels) { const f = Array.from(document.querySelectorAll(s)).filter(e => e.getClientRects().length); if (f.length) root = f[f.length-1]; }
        if (!root) return { n: 0, names: [] };
        const els = Array.from(root.querySelectorAll('input, select, textarea'));
        return { n: els.length, names: els.map(e => e.getAttribute('name') || e.getAttribute('placeholder') || e.getAttribute('aria-label') || '').filter(Boolean).slice(0, 8) };
      })()`).then(v => v as { n: number; names: string[] }).catch(() => ({ n: 0, names: [] }));
      const closed = await closeAnyDialog(page);
      if (!closed) {
        return { status: 'fail', actual: `the form opened with ${fields.n} field(s) but neither Cancel, Close nor Escape would shut it`, error: 'dialog left open — the page was reloaded to recover' };
      }
      return { status: 'pass', actual: `opened a form with ${fields.n} field(s)${fields.names.length ? ` (${fields.names.join(', ')})` : ''}, and Cancel closed it` };
    }

    case 'required-field-blocks-submit': {
      if (!ctx.probeRequiredFields) {
        return { status: 'not-available', actual: 'not performed', reason: c.notApplicable ?? 'mandatory-field probing is off for this run' };
      }
      if (!reached.ok) return { status: 'skip', actual: reached.detail, reason: 'the form was not reached' };
      const field = await locate(page, c).first();
      if (!(await field.count().catch(() => 0))) return missing(c, 'the mandatory field is not on the form');
      await field.fill('', { timeout: 6000 }).catch(() => null);
      const save = page.getByRole('button', { name: /^(save|submit|create|add|apply|ok)$/i }).first();
      if (!(await save.count().catch(() => 0))) return { status: 'skip', actual: 'no submit button next to the field', reason: 'nothing to submit' };
      await save.click({ timeout: 8000 }).catch(() => null);
      await page.waitForTimeout(1200);
      const text = await bodyText(page);
      const complained = /required|mandatory|cannot be empty|please (enter|fill|select)|is invalid/i.test(text);
      const stillOpen = await dialogOpen(page);
      await closeAnyDialog(page);
      if (complained || stillOpen) {
        return { status: 'pass', actual: complained ? 'the UI refused and named the missing field' : 'the form stayed open and nothing was submitted' };
      }
      return { status: 'fail', actual: 'the form was accepted with a mandatory field empty', error: 'this may have created a record on the box' };
    }

    case 'back-forward-nav': {
      const url = c.target?.url;
      if (!url) return { status: 'skip', actual: 'no page to navigate from', reason: 'nothing in the map was reachable by URL' };
      const home = new URL('/', url).toString();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => null);
      await page.waitForTimeout(600);
      const firstUrl = page.url();
      await page.goto(home, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => null);
      await page.waitForTimeout(600);
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
      await page.waitForTimeout(900);
      const backUrl = page.url();
      const backText = (await bodyText(page)).trim();
      await page.goForward({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
      await page.waitForTimeout(900);
      const fwdText = (await bodyText(page)).trim();
      const backOk = backUrl.replace(/\/$/, '') === firstUrl.replace(/\/$/, '') && backText.length > 20;
      const fwdOk = fwdText.length > 20;
      if (backOk && fwdOk) return { status: 'pass', actual: `Back returned to ${backUrl} with content, Forward rendered too` };
      return {
        status: 'fail',
        actual: backOk
          ? 'Back worked but Forward came back blank'
          : `Back landed on ${backUrl} (expected ${firstUrl}) with ${backText.length} characters of content`,
      };
    }

    case 'refresh-keeps-page': {
      const url = c.target?.url;
      if (!url) return { status: 'skip', actual: 'no page to reload', reason: 'nothing in the map was reachable by URL' };
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => null);
      await page.waitForTimeout(600);
      const before = page.url();
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => null);
      await page.waitForTimeout(1200);
      const text = await bodyText(page);
      if (looksLikeLogin(page.url(), text)) {
        return { status: 'fail', actual: 'reloading a deep page bounced to the login form — the session did not survive F5' };
      }
      const sameish = page.url().replace(/\/$/, '') === before.replace(/\/$/, '');
      if (!sameish) return { status: 'fail', actual: `reload moved from ${before} to ${page.url()}` };
      if (text.trim().length < 20) return { status: 'fail', actual: 'the page came back blank after reload' };
      return { status: 'pass', actual: `${before} came back with ${text.trim().length} characters, still signed in` };
    }

    case 'session-protected': {
      if (!ctx.newAnonPage) return { status: 'skip', actual: 'no second browser context available', reason: 'cannot test without a session' };
      const url = c.target?.url;
      if (!url) return { status: 'skip', actual: 'no protected URL in the map', reason: 'nothing to request' };
      let anon: Page | undefined;
      try {
        anon = await ctx.newAnonPage();
        await anon.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => null);
        await anon.waitForTimeout(1200);
        const text = await anon.evaluate('document.body ? document.body.innerText : ""').then(v => String(v ?? '')).catch(() => '');
        const atLogin = looksLikeLogin(anon.url(), text)
          || !!(await anon.locator('#username, input[name="username"], input[type="password"]').count().catch(() => 0));
        return atLogin
          ? { status: 'pass', actual: `an unauthenticated request for ${url} ended at the login form` }
          : { status: 'fail', actual: `an unauthenticated request for ${url} was served ${text.trim().length} characters of the page` };
      } finally {
        await anon?.context().close().catch(() => null);
      }
    }

    default:
      return { status: 'skip', actual: `no executor for "${c.kind}"`, reason: 'unimplemented check kind' };
  }
}

/** Run every check for one page. The first element of `checks` is used to
 *  reach it, so they must all belong to the same node. */
export async function executeNodeChecks(ctx: ExecContext, checks: GeneratedCheck[]): Promise<CheckOutcome[]> {
  const out: CheckOutcome[] = [];
  if (checks.length === 0) return out;

  // A not-applicable check is reported without the control ever being
  // operated — but it is still worth a picture of the control it is about.
  // "Restart is offered on this page and we did not press it" is a claim, and
  // the ringed button is what backs it up. These stay in the loop rather than
  // being answered before it, so they get the same capture every other row
  // gets; only the acting is skipped, not the evidence.
  const skipAction = (c: GeneratedCheck) => !!c.notApplicable && c.kind !== 'required-field-blocks-submit';
  const toRun = checks;
  if (toRun.length === 0) return out;

  // Application-level checks do their own navigation.
  const appLevel = new Set(['back-forward-nav', 'refresh-keeps-page', 'session-protected']);
  const isLogin = (k: string) => k.startsWith('login-');

  // The login flows run in their own signed-out sessions, so they neither use
  // nor disturb the page the rest of the run is working on. Handled here and
  // returned, rather than reaching a node first: there is nothing to navigate
  // to, and reaching anything would mean being signed in.
  if (isLogin(toRun[0].kind)) {
    for (const c of toRun) {
      if (ctx.signal?.aborted) break;
      const t0 = Date.now();
      if (!ctx.creds || !ctx.loginForm || !ctx.newAnonPage || !ctx.shotOf) {
        out.push({
          check: c, status: 'skip', actual: 'the login page was not read for this run',
          reason: 'nothing to type into', durationMs: 0, ranAt: new Date().toISOString(),
        });
        continue;
      }
      const r = await runLoginCheck({
        newAnonPage: ctx.newAnonPage,
        host: ctx.creds.host,
        username: ctx.creds.username,
        password: ctx.creds.password,
        shotOf: ctx.shotOf,
      }, c, ctx.loginForm);
      out.push({
        check: c, status: r.status, actual: r.actual, error: r.error, reason: r.reason,
        durationMs: Date.now() - t0, ranAt: new Date().toISOString(),
        screenshotFile: r.screenshotFile, steps: r.steps,
      });
    }
    return out;
  }
  const reached = appLevel.has(toRun[0].kind)
    ? { ok: true, how: 'self', detail: 'navigates itself' }
    : await reachNode(ctx, toRun[0]);

  // Where the page stands once we have arrived. Several checks legitimately
  // leave it somewhere else — an Edit button that routes instead of opening a
  // modal, a card that is really a link, a search that reloads — and until
  // this was tracked, the first such check silently moved the page and every
  // later control on the node was reported missing from a page it was never
  // on. On the Tools page that was seven cards "not found" because the one
  // before them had navigated to Manage Simulators.
  const anchorUrl = reached.ok ? ctx.page.url() : '';

  // One capture of the page as it was found, shared by every check that only
  // looks at it. Taken before anything is operated, so it is the state those
  // checks actually read.
  const pageShot = reached.ok && !appLevel.has(toRun[0].kind)
    ? await ctx.shot(`${toRun[0].nodeId}__as-found`)
    : undefined;

  for (const c of toRun) {
    if (ctx.signal?.aborted) {
      out.push({
        check: c, status: 'skip', actual: 'the run was stopped', reason: 'stopped by the operator',
        durationMs: 0, ranAt: new Date().toISOString(),
      });
      continue;
    }
    // Back to the page this check is about, if the one before it wandered.
    if (reached.ok && anchorUrl && !appLevel.has(c.kind) && ctx.page.url() !== anchorUrl) {
      await closeAnyDialog(ctx.page).catch(() => null);
      if (ctx.page.url() !== anchorUrl) {
        await ctx.page.goto(anchorUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
        await ctx.page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => null);
        await ctx.page.waitForTimeout(300);
      }
    }

    const t0 = Date.now();
    const steps: StepRecord[] = [];
    let v: { status: CheckStatus; actual: string; error?: string; reason?: string };
    if (skipAction(c)) {
      v = { status: 'not-available', actual: 'not performed', reason: c.notApplicable };
    } else {
      const record: Recorder = async (label, ok, detail, capture = true) => {
        steps.push({
          n: steps.length + 1, label, ok, detail,
          screenshotFile: capture ? await ctx.shot(`${c.id}__step${steps.length + 1}`, { fullPage: false }) : undefined,
        });
      };
      try {
        v = await runCheck(ctx, c, reached, record);
        // One retry on a freshly loaded page before believing a control is
        // gone. Checks share a page, and some of them leave it changed in
        // ways a navigation does not undo — this build remembers Cards vs
        // Table view, and the filter chips only exist in one of them, so a
        // check that switched the view made every later chip "not found".
        // A control that reappears on a clean load was never missing; one
        // that does not is reported exactly as before.
        if (v.status === 'fail' && /not found on the page|not on the page/.test(v.actual) && anchorUrl) {
          await ctx.page.goto(anchorUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
          await ctx.page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => null);
          await ctx.page.waitForTimeout(500);
          const second = await runCheck(ctx, c, reached, record);
          if (second.status !== 'fail') {
            v = { ...second, actual: `${second.actual} (on a freshly loaded page; it was not there after the checks before it)` };
          }
        }
      } catch (e: any) {
        v = { status: 'error', actual: 'the check could not be completed', error: String(e?.message ?? e).slice(0, 400) };
      }
    }
    const outcome: CheckOutcome = {
      check: c,
      status: v.status,
      actual: v.actual,
      error: v.error,
      reason: v.reason,
      durationMs: Date.now() - t0,
      ranAt: new Date().toISOString(),
      finalUrl: ctx.page.url(),
      consoleErrors: v.status === 'fail' ? realErrors(ctx.consoleErrorsSince()).slice(0, 10) : undefined,
      steps: steps.length ? steps : undefined,
    };
    // Proof for every row, not only the broken ones: a pass that nobody can
    // see is an assertion, and the point of running this against real
    // hardware is to be able to show what the box looked like.
    //
    // Every row gets its own picture, taken after the check ran so it shows
    // the result: the control ringed where there is one, the whole page for a
    // page-level check. The capture of the page as it was found is only a
    // fallback for a row whose own capture could not be taken.
    outcome.screenshotFile = (await shotOfCheck(ctx, c).catch(() => undefined)) ?? pageShot;
    out.push(outcome);
  }
  return out;
}

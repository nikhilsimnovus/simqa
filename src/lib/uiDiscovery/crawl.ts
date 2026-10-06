// Reading a Simnovator's UI off the box.
//
// The crawler starts where the operator starts — signed in, on the landing
// page — finds the navigation, and walks it: every menu, every submenu it
// reveals, every tab inside a page it reaches, and the forms behind the Add
// and Edit buttons. On each stop it writes down what is there: the controls,
// their labels, which are mandatory, what a dropdown offers, a table's
// columns and row count, the API calls the page made for itself and anything
// the console complained about.
//
// Nothing about the Simnovator's structure is written down here. The walk is
// bounded by budget (pages, dialogs, wall clock), not by a list of known
// routes, so a build that adds a menu gets crawled on the next discovery.
//
// What it will not do:
//   • click anything classified 'mutate' (classify.ts) — no Delete, Save,
//     Start, Reboot, Logout, ever, not even to see what happens;
//   • submit a form;
//   • leave a dialog open — if Cancel cannot be found the page is reloaded.
//
// Those rules exist because this runs against hardware other people are
// using, and a crawler that is only mostly safe will eventually be the reason
// somebody's overnight run died.

import type { Page } from 'playwright';
import type { UiElement, UiElementKind, UiMap, UiNode } from './types.ts';
import { elementKey, normaliseLabel, riskOf, slugOf } from './classify.ts';

export interface CrawlOptions {
  /** Stop after this many pages. A big UI is still bounded. */
  maxPages?: number;
  /** Press at most this many of a page's own controls — cards, Add, Edit —
   *  to see where they lead. */
  maxEntriesPerPage?: number;
  /** Older name for the same budget. */
  maxDialogsPerPage?: number;
  /** Give up on the whole walk after this long. */
  budgetMs?: number;
  /** Open Add/Edit forms to read the fields inside them. On by default: it is
   *  the only way to see a mandatory field, and opening commits nothing. */
  openDialogs?: boolean;
  /** Per-page settle time after a navigation or click. */
  settleMs?: number;
  onProgress?: (note: string, pages: number) => void;
  /** Screenshot each node into this directory. */
  screenshotDir?: string;
  signal?: AbortSignal;
}

/** Raw descriptor as the page reports it — classification happens in Node so
 *  the risk policy stays pure and unit-tested. */
interface RawEl {
  kind: string;
  label: string;
  role?: string;
  selector: string;
  disabled?: boolean;
  required?: boolean;
  options?: string[];
  columns?: string[];
  rowCount?: number;
  note?: string;
}

interface RawNav {
  label: string;
  selector: string;
  href?: string;
  expandable?: boolean;
}

// ---------------------------------------------------------------- in-page --

/** Everything below runs inside the browser. It is one function because each
 *  page.evaluate round-trip costs a serialisation, and a 40-page crawl that
 *  made twelve of them per page would spend its budget on plumbing. */
const PAGE_SCRIPT = `(() => {
  const MAXTEXT = 80;

  function visible(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    const r = el.getClientRects();
    if (!r || r.length === 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) !== 0;
  }

  function text(el) {
    const t = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
    return t.slice(0, MAXTEXT);
  }

  // A card is a title line plus a description line, and innerText keeps the
  // break between them — so the first line is the name an operator reads.
  // This is what makes "Manage Simulators" a breadcrumb instead of "Manage
  // Simulators View and manage User Equipment simulators".
  function firstLine(el) {
    const raw = (el.innerText || el.textContent || '');
    for (const line of raw.split('\\n')) {
      const t = line.replace(/\\s+/g, ' ').trim();
      if (t) return t.slice(0, MAXTEXT);
    }
    return '';
  }

  function labelOf(el) {
    const aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria) return aria.trim();
    const lb = el.getAttribute && el.getAttribute('aria-labelledby');
    if (lb) {
      const parts = lb.split(/\\s+/).map(id => document.getElementById(id)).filter(Boolean).map(text);
      if (parts.length) return parts.join(' ').trim();
    }
    if (el.id) {
      const forLabel = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (forLabel) return text(forLabel);
    }
    const wrap = el.closest && el.closest('label');
    if (wrap) {
      const t = text(wrap);
      if (t) return t;
    }
    const ph = el.getAttribute && el.getAttribute('placeholder');
    if (ph) return ph.trim();
    const title = el.getAttribute && el.getAttribute('title');
    if (title) return title.trim();
    const name = el.getAttribute && el.getAttribute('name');
    const own = firstLine(el);
    if (own) return own;
    if (name) return name;
    return '';
  }

  // Anchored at an id or at body — never a floating fragment.
  //
  // This used to stop after eight levels, which produced selectors like
  // "div:nth-of-type(2) > div:nth-of-type(4) > button:nth-of-type(1)" with no
  // root. A query like that matches whatever subtree happens to look similar,
  // so six of the seven cards on the Tools page resolved to nothing and were
  // reported as missing controls on a page where they were plainly visible.
  function cssPath(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 24) {
      if (node.id && document.querySelectorAll('#' + CSS.escape(node.id)).length === 1) {
        parts.unshift('#' + CSS.escape(node.id));
        return parts.join(' > ');
      }
      const tag = node.tagName.toLowerCase();
      if (tag === 'body' || tag === 'html') break;
      let idx = 1;
      let sib = node.previousElementSibling;
      while (sib) { if (sib.tagName === node.tagName) idx += 1; sib = sib.previousElementSibling; }
      parts.unshift(tag + ':nth-of-type(' + idx + ')');
      node = node.parentElement;
    }
    return 'body > ' + parts.join(' > ');
  }

  // The app shell — nav, sidebar, header — is the same on every page, so it is
  // excluded from a page's own element list. Otherwise every page would report
  // the same thirty menu links and the per-page numbers would mean nothing.
  const CHROME_SEL = 'nav, aside, header, footer, [role="navigation"], [role="banner"], .sidebar, .navbar, .ant-layout-sider, .ant-menu';
  const chrome = Array.from(document.querySelectorAll(CHROME_SEL));
  function inChrome(el) { return chrome.some(c => c !== el && c.contains(el)); }

  function dialogRoot() {
    const sels = ['[role="dialog"]', '.modal.show', '.modal.in', '.ant-modal', '.MuiDialog-container', 'dialog[open]'];
    for (const s of sels) {
      const found = Array.from(document.querySelectorAll(s)).filter(visible);
      if (found.length) return found[found.length - 1];
    }
    return null;
  }

  function collect(scope) {
    const out = [];
    const seen = new Set();
    const add = (el, kind, extra) => {
      if (!visible(el)) return;
      if (scope === document && inChrome(el)) return;
      if (seen.has(el)) return;
      seen.add(el);
      const e = {
        kind: kind,
        label: labelOf(el),
        role: el.getAttribute ? (el.getAttribute('role') || undefined) : undefined,
        selector: cssPath(el),
        disabled: !!(el.disabled || el.getAttribute('aria-disabled') === 'true' || el.classList.contains('disabled')),
      };
      Object.assign(e, extra || {});
      out.push(e);
    };
    const q = (sel) => Array.from(scope.querySelectorAll(sel));

    // Tabs first: a tab that is also an <a> should be reported as a tab.
    q('[role="tab"], .nav-tabs > li, .nav-tabs a, .ant-tabs-tab, .MuiTab-root, [data-toggle="tab"]')
      .forEach(el => add(el, 'tab', {}));

    q('table, [role="table"], .ant-table').forEach(el => {
      const heads = Array.from(el.querySelectorAll('th, [role="columnheader"], .ant-table-cell'))
        .filter(visible).map(text).filter(Boolean);
      const body = el.querySelector('tbody') || el;
      const rows = Array.from(body.querySelectorAll('tr, [role="row"]')).filter(visible);
      add(el, 'table', {
        columns: Array.from(new Set(heads)).slice(0, 24),
        rowCount: rows.length,
      });
    });

    q('.pagination, .ant-pagination, [aria-label*="pagin" i], [class*="pagination"]')
      .forEach(el => add(el, 'pagination', {}));

    q('input[type="search"], input[placeholder*="search" i], input[aria-label*="search" i], input[placeholder*="filter" i]')
      .forEach(el => add(el, 'search', {}));

    q('select').forEach(el => {
      const opts = Array.from(el.options || []).map(o => (o.textContent || '').trim()).filter(Boolean);
      add(el, 'select', { options: opts.slice(0, 60), required: !!el.required });
    });
    q('[role="combobox"], .ant-select, .select2-container').forEach(el => {
      add(el, 'select', { note: 'custom dropdown — its options are read when the check runs' });
    });

    q('input[type="checkbox"], [role="checkbox"]').forEach(el => add(el, 'checkbox', {}));
    q('input[type="radio"], [role="radio"]').forEach(el => add(el, 'radio', {}));

    q('input, textarea').forEach(el => {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (['hidden', 'submit', 'button', 'reset', 'image', 'checkbox', 'radio', 'search', 'file'].includes(t)) return;
      add(el, el.tagName.toLowerCase() === 'textarea' ? 'textarea' : 'input', {
        required: !!(el.required || el.getAttribute('aria-required') === 'true'),
      });
    });
    q('input[type="file"]').forEach(el => add(el, 'input', { note: 'file picker' }));

    q('button, [role="button"], input[type="submit"], input[type="button"], a.btn, .btn')
      .forEach(el => add(el, 'button', {}));

    q('a[href]').forEach(el => {
      const href = el.getAttribute('href') || '';
      if (!href || href.startsWith('javascript:')) return;
      add(el, 'link', {});
    });

    return out;
  }

  // The menu. Deliberately broad: this build's sidebar is <aside> full of
  // bare <li> rows with no href, no role and no class anyone could rely on,
  // while older builds used anchors and other UIs use role="menuitem". So the
  // net is cast wide and then narrowed by what a menu row looks like — short
  // text, inside the shell — rather than by matching one build's markup.
  function navItems() {
    const cands = [];
    const seen = new Set();
    const consider = (el) => {
      if (!visible(el) || seen.has(el)) return;
      seen.add(el);
      const label = labelOf(el);
      if (!label || label.length > 40) return;
      const href = el.getAttribute ? (el.getAttribute('href') || undefined) : undefined;
      const r = el.getBoundingClientRect();
      cands.push({
        label: label,
        selector: cssPath(el),
        href: href && !href.startsWith('javascript:') ? href : undefined,
        expandable: !href,
        area: Math.max(1, r.width * r.height),
      });
    };
    const SEL = 'a[href], [role="menuitem"], [role="menu-item"], [role="tab"], [role="link"],'
      + ' li, button, .ant-menu-item, .ant-menu-submenu-title, .nav-link, [class*="cursor-pointer"]';
    chrome.forEach(c => c.querySelectorAll(SEL).forEach(consider));
    // A UI with no recognisable shell still has to be walkable.
    if (cands.length === 0) document.querySelectorAll('a[href]').forEach(consider);

    // One entry per label, and the innermost element that carries it: a menu
    // row is usually wrapped in two or three divs that all report the same
    // text, and clicking the outer wrapper can land in the padding.
    const best = new Map();
    for (const c of cands) {
      const k = c.label.toLowerCase();
      const prev = best.get(k);
      if (!prev || c.area < prev.area) best.set(k, c);
    }
    return Array.from(best.values()).map(c => ({
      label: c.label, selector: c.selector, href: c.href, expandable: c.expandable,
    }));
  }

  const main = document.querySelector('main, [role="main"], .content, .main-content');
  const dlg = dialogRoot();
  return {
    url: location.href,
    title: document.title,
    heading: (function () {
      const h = document.querySelector('h1, h2, .page-title, .ant-page-header-heading-title');
      return h ? text(h) : '';
    })(),
    mainText: (main ? text(main) : (document.body ? text(document.body) : '')),
    bodyTextLength: (document.body && document.body.innerText ? document.body.innerText.trim().length : 0),
    elements: collect(document),
    dialog: dlg ? { label: labelOf(dlg) || 'dialog', elements: collect(dlg) } : null,
    nav: navItems(),
  };
})()`;

// -------------------------------------------------------------- in Node ----

function toElements(raw: RawEl[]): UiElement[] {
  const used = new Map<string, number>();
  const out: UiElement[] = [];
  raw.forEach((r, i) => {
    const label = normaliseLabel(r.label);
    let key = elementKey(r.kind, label, i);
    // Two controls with the same name on one page (two Delete buttons in a
    // table) get an ordinal so the diff can still count them.
    const n = (used.get(key) ?? 0) + 1;
    used.set(key, n);
    if (n > 1) key = `${key}#${n}`;
    out.push({
      key,
      kind: (r.kind as UiElementKind),
      label,
      role: r.role,
      selector: r.selector,
      risk: riskOf(label, r.kind),
      disabled: r.disabled || undefined,
      required: r.required || undefined,
      options: r.options,
      columns: r.columns,
      rowCount: r.rowCount,
      note: r.note,
    });
  });
  return out;
}

/** Entries the crawler must never click, whatever a label says — leaving the
 *  app or signing out ends the walk. */
function isNavUsable(label: string): boolean {
  const l = normaliseLabel(label).toLowerCase();
  if (!l) return false;
  if (/log\s?out|sign\s?out|exit/.test(l)) return false;
  return riskOf(label, 'link') !== 'mutate';
}

/** Chrome controls that change how the shell looks rather than where you are:
 *  they belong in the Navigation node's element list, not in the page queue.
 *  Walking into one also risks collapsing the sidebar the rest of the crawl
 *  needs. */
function isViewControl(label: string): boolean {
  return /collapse|expand|sidebar|toggle|theme|dark mode|light mode|minimi[sz]e|maximi[sz]e|full screen|pin to|unpin/i
    .test(normaliseLabel(label));
}

/** A card's label is its title plus its blurb — "Manage Simulators View and
 *  manage User Equipment simulators". The breadcrumb wants the title, which
 *  is the run of words before the description starts. */
function shortLabel(raw: string): string {
  const l = normaliseLabel(raw);
  if (l.length <= 34) return l;
  const words = l.split(' ');
  const out: string[] = [];
  for (const w of words) {
    // A second capitalised run after three or more words is the blurb.
    if (out.length >= 3 && /^[A-Z]/.test(w) && out.join(' ').length > 12) break;
    out.push(w);
    if (out.join(' ').length >= 34) break;
  }
  return out.join(' ');
}

/** Per-widget furniture that every chart and panel on this build repeats:
 *  the settings cog, the zoom, the kebab, the series toggles. They are still
 *  discovered as controls on their page and still checked for being there —
 *  this only stops the crawler treating each one as a place to go, which on
 *  the Statistics pages alone was six dead ends per chart. */
function isWidgetChrome(label: string): boolean {
  return /open settings|zoomed view|more options|show all|hide all|hide from|pin to|stats$|restart/i
    .test(normaliseLabel(label));
}

function sameOrigin(href: string, host: string): boolean {
  if (href.startsWith('#')) return false;
  if (/^https?:\/\//i.test(href)) return href.includes(host);
  return true;
}

/** Cheap "is this the same screen" signal: how much text there is plus the
 *  start of the main region. Enough to tell a real navigation from a click
 *  that did nothing, without a screenshot diff. */
export async function fingerprint(page: Page): Promise<string> {
  // Whether something is floating above the page, plus the first of the main
  // region's text. Deliberately NOT the text length: a chart that redraws
  // changes its length by a few characters, and that was enough to make the
  // Statistics page look like a different page every time it was reached from
  // a different menu entry.
  return page.evaluate(`(() => {
    const overlay = ['[role="dialog"]', '[role="menu"]', '[role="listbox"]', '.modal.show', '.ant-modal', '[data-state="open"]']
      .some(s => Array.from(document.querySelectorAll(s)).some(e => e.getClientRects().length));
    const m = document.querySelector('main, [role="main"], .content');
    const b = document.body ? (document.body.innerText || '') : '';
    return (overlay ? 'overlay|' : '|') + ((m ? m.innerText : b) || '').replace(/\\s+/g, ' ').slice(0, 220);
  })()`).then(v => String(v ?? '')).catch(() => '');
}

async function settle(page: Page, ms: number): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: Math.max(ms, 4000) }).catch(() => null);
  await page.waitForTimeout(ms);
}

export interface CrawlResult {
  map: UiMap;
  /** Pages the walk reached, in order, for progress reporting. */
  visited: string[];
}

export async function crawlUi(
  page: Page,
  opts: {
    host: string;
    systemId?: string;
    username?: string;
    build?: string;
    consoleErrorsSince: () => string[];
    apiCallsSince: () => Array<{ method: string; url: string; status?: number }>;
    resetCapture: () => void;
  } & CrawlOptions,
): Promise<CrawlResult> {
  const t0 = Date.now();
  const maxPages = opts.maxPages ?? 40;
  const maxEntries = opts.maxEntriesPerPage ?? opts.maxDialogsPerPage ?? 6;
  const budgetMs = opts.budgetMs ?? 6 * 60_000;
  const settleMs = opts.settleMs ?? 700;
  const notes: string[] = [];
  const nodes: UiNode[] = [];
  const visited: string[] = [];
  const seenNodeIds = new Set<string>();
  const seenUrls = new Set<string>();

  const overBudget = () => Date.now() - t0 > budgetMs || !!opts.signal?.aborted;

  const shot = async (id: string): Promise<string | undefined> => {
    if (!opts.screenshotDir) return undefined;
    const file = `${id.replace(/[^A-Za-z0-9._-]/g, '_')}.png`;
    const p = `${opts.screenshotDir}/${file}`;
    const ok = await page.screenshot({ path: p, fullPage: true }).then(() => true).catch(() => false);
    // Stored with the folder it lives in, so the page can link a discovery
    // screenshot and a failure screenshot through the same route.
    return ok ? `shots/${file}` : undefined;
  };

  /** Read whatever is on screen into a node, and return what the page also
   *  told us about navigation and any open dialog. */
  async function snapshot(path: string[], kind: UiNode['kind'], reach: UiNode['reach'], parentId?: string) {
    const id = slugOf(path);
    opts.resetCapture();
    await settle(page, settleMs);
    const snap: any = await page.evaluate(PAGE_SCRIPT).catch((e: any) => ({ error: String(e?.message ?? e) }));
    if (snap?.error) {
      nodes.push({
        id, kind, path, label: path[path.length - 1], parentId, reach,
        elements: [], unreachable: `could not read the page: ${snap.error}`,
      });
      seenNodeIds.add(id);
      return { nav: [] as RawNav[], dialog: null as any };
    }
    const node: UiNode = {
      id, kind, path,
      label: path[path.length - 1],
      url: snap.url,
      parentId,
      reach,
      elements: toElements(snap.elements ?? []),
      consoleErrors: opts.consoleErrorsSince(),
      apiCalls: opts.apiCallsSince().filter(c => /\/v\d|\/api\//.test(c.url)).slice(0, 40),
      screenshotFile: await shot(id),
    };
    // A page that renders nothing is worth recording as reached-but-empty
    // rather than as a healthy page with no controls.
    if ((snap.bodyTextLength ?? 0) < 20 && node.elements.length === 0) {
      node.unreachable = 'the page opened but rendered no visible content';
    }
    nodes.push(node);
    seenNodeIds.add(id);
    visited.push(path.join(' > '));
    opts.onProgress?.(path.join(' → '), nodes.length);
    return { nav: (snap.nav ?? []) as RawNav[], dialog: snap.dialog };
  }

  /** Tabs inside the page that is currently open, each as its own node. */
  async function walkTabs(parentPath: string[], parentId: string, parentUrl: string) {
    const parent = nodes.find(n => n.id === parentId);
    const parentChain = parent?.reach.via === 'click' ? (parent.reach.chain ?? []) : [];
    const tabEls = parent?.elements.filter(e => e.kind === 'tab') ?? [];
    for (const tab of tabEls) {
      if (overBudget() || nodes.length >= maxPages) return;
      const label = tab.label;
      if (!label || !isNavUsable(label)) continue;
      const path = [...parentPath, label];
      if (seenNodeIds.has(slugOf(path))) continue;
      const clicked = await page.locator(tab.selector).first().click({ timeout: 8000 })
        .then(() => true)
        .catch(async () => page.getByRole('tab', { name: label, exact: false }).first().click({ timeout: 6000 })
          .then(() => true).catch(() => false));
      if (!clicked) {
        const id = slugOf(path);
        nodes.push({
          id, kind: 'tab', path, label, parentId,
          reach: { via: 'click', selector: tab.selector, fromUrl: parentUrl, chain: [...parentChain, tab.selector] },
          elements: [], unreachable: `the "${label}" tab could not be selected`,
        });
        seenNodeIds.add(id);
        continue;
      }
      await snapshot(path, 'tab', { via: 'click', selector: tab.selector, fromUrl: parentUrl, chain: [...parentChain, tab.selector] }, parentId);
    }
  }

  /** Forms behind Add / Edit, read and then cancelled. */
  // Where a page's own controls lead.
  //
  // On this build the Tools page is a grid of cards — "Manage Simulators",
  // "SDR Configuration", "Spectrum Analyzer" — that are plain buttons with no
  // href anywhere in sight. They are pages all the same, and they are exactly
  // the ones the requirement cares about, so a crawl that only followed the
  // sidebar would stop one level above everything interesting.
  //
  // Anything not classified 'mutate' is safe to press, so each candidate is
  // pressed and the result decides what it was:
  //   the URL changed      -> a page: queued, so it is walked like any other
  //   a dialog opened      -> a form: read, then cancelled
  //   only content changed -> an in-page panel: recorded where it is
  //   nothing changed      -> not navigation at all: left alone
  async function walkInPageEntries(parentPath: string[], parentId: string, parentUrl: string, enqueue: (c: { path: string[]; label: string; href: string; selector: string; parentId: string }) => void) {
    if (opts.openDialogs === false) return;
    const parent = nodes.find(n => n.id === parentId);
    const chain = parent?.reach.via === 'click' ? (parent.reach.chain ?? []) : [];
    const triggers = (parent?.elements ?? [])
      .filter(e => e.risk !== 'mutate' && (e.kind === 'button' || e.kind === 'link') && !e.disabled)
      .filter(e => !isViewControl(e.label) && !isWidgetChrome(e.label))
      .slice(0, maxEntries);

    for (const t of triggers) {
      if (overBudget() || nodes.length >= maxPages) return;
      // Card labels carry their whole blurb ("Manage Simulators View and
      // manage User Equipment…"); the first few words are the name.
      const label = shortLabel(t.label || t.key);
      const path = [...parentPath, label];
      if (seenNodeIds.has(slugOf(path))) continue;

      const beforeUrl = page.url();
      const beforeFp = await fingerprint(page);
      const clicked = await page.locator(t.selector).first().click({ timeout: 8000 })
        .then(() => true).catch(() => false);
      if (!clicked) continue;
      await page.waitForFunction(`location.href !== ${JSON.stringify(beforeUrl)}`, { timeout: 2500 }).catch(() => null);

      if (page.url() !== beforeUrl) {
        const landed = page.url();
        // Queued, NOT marked as seen: the queue's own visited check is what
        // marks it, and marking it here made every card on the Tools page look
        // already-visited the moment it was queued — so "Manage Simulators"
        // was found, queued, and then silently dropped, taking its Stable /
        // Unstable / Container Hosts tabs with it.
        if (!seenUrls.has(landed)) {
          enqueue({ path, label, href: landed, selector: t.selector, parentId });
        }
        await page.goto(parentUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
        await settle(page, settleMs);
        continue;
      }

      await settle(page, settleMs);
      const probe: any = await page.evaluate(PAGE_SCRIPT).catch(() => null);
      const id = slugOf(path);
      if (probe?.dialog) {
        nodes.push({
          id, kind: 'section', path, label, parentId, url: probe.url,
          reach: { via: 'click', selector: t.selector, fromUrl: parentUrl, chain: [...chain, t.selector] },
          elements: toElements(probe.dialog.elements ?? []),
          screenshotFile: await shot(id),
        });
        seenNodeIds.add(id);
        visited.push(path.join(' > '));
        opts.onProgress?.(path.join(' → '), nodes.length);
        // A dialog left open would make every later snapshot read the dialog
        // instead of the page, so if Cancel cannot be found the page is
        // reloaded rather than hoped about.
        if (!(await closeAnyDialog(page))) {
          notes.push(`${path.join(' → ')}: no Cancel or Close — reloaded the page to get out of the dialog`);
          await page.goto(parentUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
          await settle(page, settleMs);
        }
        continue;
      }

      // A panel that opened in place reports the whole page back, parent
      // included. Only what is NEW belongs to it: without this, "Clone" on My
      // Tests recorded seventy-four controls that were really My Tests', and
      // every one of them got a second set of checks under a second name.
      const parentKeys = new Set((parent?.elements ?? []).map(e => e.key));
      const fresh = toElements(probe?.elements ?? []).filter(e => !parentKeys.has(e.key));
      const changed = probe && fresh.length > 0 && (await fingerprint(page)) !== beforeFp;
      if (changed) {
        nodes.push({
          id, kind: 'section', path, label, parentId, url: probe.url,
          reach: { via: 'click', selector: t.selector, fromUrl: parentUrl, chain: [...chain, t.selector] },
          elements: fresh,
          consoleErrors: opts.consoleErrorsSince(),
          screenshotFile: await shot(id),
        });
        seenNodeIds.add(id);
        visited.push(path.join(' > '));
        opts.onProgress?.(path.join(' → '), nodes.length);
      }
      // Back to a known-good state, whatever that click did.
      //
      // Not conditional on the URL: a sort menu or a popover opens an overlay
      // at the SAME url, and this build's overlays swallow every pointer event
      // underneath them. Leaving one up made each later menu click time out,
      // so a page that had been read fine reported itself unreachable for the
      // rest of the walk. Reloading costs a second and removes the whole
      // class of problem.
      await page.keyboard.press('Escape').catch(() => null);
      await page.goto(parentUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
      await settle(page, settleMs);
    }
  }

  // Start at the root the login left us on.
  const startUrl = page.url();
  const first = await snapshot(['Home'], 'page', { via: 'url', url: startUrl });
  seenUrls.add(startUrl);

  // The navigation is read once from the shell; menu entries that only open a
  // submenu are expanded in place so their children join the queue.
  type Candidate = { path: string[]; label: string; href?: string; selector: string; parentId?: string; chain: string[] };
  const queue: Candidate[] = [];
  // The sidebar is on every page, so the menu entries a page reports are
  // mostly the same ones the landing page reported. Without this, page two
  // enqueues "Dashboard > Sample Tests", page three enqueues "Sample Tests >
  // My Tests", and a nine-item menu becomes eighty-one pages that are all the
  // same nine. Only labels that were NOT in the shell at the start count as a
  // submenu this click revealed.
  const globalNavLabels = new Set<string>();
  const enqueueNav = (navs: RawNav[], parentPath: string[], parentId?: string, parentChain: string[] = []) => {
    for (const n of navs) {
      const label = normaliseLabel(n.label);
      if (!isNavUsable(label)) continue;
      if (isViewControl(label)) continue;
      if (parentPath.length > 0 && globalNavLabels.has(label.toLowerCase())) continue;
      if (n.href && !sameOrigin(n.href, opts.host)) continue;
      const path = [...parentPath, label];
      if (seenNodeIds.has(slugOf(path))) continue;
      if (queue.some(q => slugOf(q.path) === slugOf(path))) continue;
      queue.push({ path, label, href: n.href, selector: n.selector, parentId, chain: [...parentChain, n.selector] });
    }
  };
  for (const n of first.nav) globalNavLabels.add(normaliseLabel(n.label).toLowerCase());
  enqueueNav(first.nav, []);

  // The shell itself is a page of the UI too: its menu entries and its own
  // controls (collapse, theme, the account menu) are things a build can
  // break. They are recorded as one node so they are checked for being there
  // without being walked into as if each were a page.
  if (first.nav.length) {
    const shellId = slugOf(['Navigation']);
    nodes.push({
      id: shellId, kind: 'section', path: ['Navigation'], label: 'Navigation',
      url: startUrl, reach: { via: 'url', url: startUrl },
      elements: toElements(first.nav.map(n => ({
        kind: 'link', label: n.label, selector: n.selector,
        note: isViewControl(normaliseLabel(n.label)) ? 'a view control, not a page' : undefined,
      }))),
      screenshotFile: await shot(shellId),
    });
    seenNodeIds.add(shellId);
  }

  // Pages to map, and pages whose own controls still need pressing. Two
  // queues rather than one so the walk is breadth-first across the menu
  // before it goes deep into any single page.
  const descendQueue: Array<{ path: string[]; id: string; url: string }> = [];

  // Ten minutes of walking is worth keeping even if the browser goes away in
  // the eleventh. A crashed or externally killed Chrome used to throw out of
  // the whole run, discarding every page already read and leaving the
  // operator with an error and nothing to look at; now the crash is recorded
  // as a note and the partial map is returned and stored.
  let crashed = false;
  try {
    while ((queue.length || descendQueue.length) && nodes.length < maxPages && !overBudget()) {
      while (queue.length && nodes.length < maxPages && !overBudget()) {
      const c = queue.shift()!;
      const reach: UiNode['reach'] = c.href
        ? { via: 'url', url: new URL(c.href, startUrl).toString() }
        : { via: 'click', selector: c.selector, fromUrl: page.url(), chain: c.chain };

      let arrived = false;
      const preUrl = page.url();
      const preFingerprint = c.href ? '' : await fingerprint(page);
      if (c.href) {
        const url = (reach as { url: string }).url;
        if (seenUrls.has(url)) continue;
        seenUrls.add(url);
        arrived = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 })
          .then(() => true).catch(() => false);
      } else {
        // A menu entry with no href either routes in JS or expands a submenu.
        // Either way the click is on a nav entry we have already classified as
        // safe, and what comes back tells us which it was.
        // Re-expand the parents first: a submenu entry recorded three levels
        // down is not on screen until the menus above it are open.
        let parentsOk = true;
        for (const step of c.chain.slice(0, -1)) {
          parentsOk = await page.locator(step).first().click({ timeout: 6000 }).then(() => true).catch(() => false);
          if (!parentsOk) break;
          await page.waitForTimeout(400);
        }
        arrived = parentsOk && await page.locator(c.selector).first().click({ timeout: 8000 })
          .then(() => true)
          .catch(async () => page.getByText(c.label, { exact: true }).first().click({ timeout: 6000 })
            .then(() => true).catch(() => false));
      }

      if (!arrived) {
        const id = slugOf(c.path);
        if (!seenNodeIds.has(id)) {
          nodes.push({
            id, kind: 'page', path: c.path, label: c.label, parentId: c.parentId, reach,
            elements: [], unreachable: 'the menu entry could not be opened',
          });
          seenNodeIds.add(id);
        }
        continue;
      }

      // Did that click actually take us somewhere new?
      //
      // Two menu entries can land on the same place — this build's Home and
      // Dashboard are one page — and mapping it twice doubles its checks and
      // reports every failure on it twice. But the router sets the URL a beat
      // after the click, so judging immediately would read the PREVIOUS page's
      // URL and throw away a real page: that is what hid Cell Statistics behind
      // Global Statistics, both of which live at /statistics?tab=…
      //
      // So: give the URL a moment to change. If it does, the URL decides. If it
      // never does, the content decides — a menu entry that changed what is on
      // screen without touching the URL (an account menu, a drawer) is still a
      // piece of UI worth recording, and one that changed nothing is not.
      if (!c.href) {
        await page.waitForFunction(`location.href !== ${JSON.stringify(preUrl)}`, { timeout: 2500 }).catch(() => null);
        const landed = page.url();
        if (landed !== preUrl && /^https?:/.test(landed)) {
          if (seenUrls.has(landed)) continue;
          seenUrls.add(landed);
        } else {
          await page.waitForTimeout(400);
          if (await fingerprint(page) === preFingerprint) continue;
        }
      }

      const s = await snapshot(c.path, 'page', reach, c.parentId);
      const id = slugOf(c.path);
      const here = page.url();

      // This build's sidebar has no hrefs — every menu entry is a click — but
      // the router still puts a real URL in the bar. When it does, the node is
      // recorded as reachable by URL, because replaying a click through an
      // nth-of-type path is the brittlest thing a later run could do and a
      // navigation is the sturdiest.
      if (!c.href && reach.via === 'click' && here !== reach.fromUrl && /^https?:/.test(here)) {
        const node = nodes.find(n => n.id === id);
        if (node) node.reach = { via: 'url', url: here };
        seenUrls.add(here);
      }

      // Submenu entries this click revealed — anything in the shell that was not
      // already queued or visited. This is how Tools → Simnovator Management →
      // Manage Simulators is reached without knowing the route.
      // Submenu entries this click revealed. They inherit the clicks that got
      // us here only when this node itself is click-reached — once the router
      // gave us a real URL, that URL is the shorter and sturdier way back.
      const hereNode = nodes.find(n => n.id === id);
      const inherited = hereNode?.reach.via === 'click' ? (hereNode.reach.chain ?? []) : [];
      enqueueNav(s.nav, c.path, id, inherited);

      // A nav click that opened a popover (the account menu, a submenu) leaves
      // an overlay that swallows the next click. The submenu has already been
      // read into the queue above, so it can be dismissed now.
      if (here === page.url()) await page.keyboard.press('Escape').catch(() => null);

      await walkTabs(c.path, id, here);

      // Pressing this page's own cards and buttons is the expensive part — six
      // clicks, each with a settle and a reload — so it is deferred until every
      // menu page has been mapped. Depth-first would spend the whole budget
      // inside the first page's chart widgets and never reach the last menu
      // entry, which is where Tools lives.
      descendQueue.push({ path: c.path, id, url: here });

      // Tabs and dialogs move the page around; come back to a clean copy of it
      // before the next queue item, whose selector was recorded against a
      // freshly loaded page.
      if (/^https?:/.test(here)) {
        await page.goto(here, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
        await settle(page, Math.min(settleMs, 400));
      }
      }

      // Menu pages are done (or the queue is empty for now). Take one page and
      // press its own controls; anything that turns out to be a page goes back
      // on the page queue, so Tools → Manage Simulators → its tabs is reached
      // breadth-first, one level at a time.
      const next = descendQueue.shift();
      if (!next) break;
      if (overBudget() || nodes.length >= maxPages) break;
      const back = await page.goto(next.url, { waitUntil: 'domcontentloaded', timeout: 30000 })
        .then(() => true).catch(() => false);
      if (!back) continue;
      await settle(page, settleMs);
      await walkInPageEntries(next.path, next.id, next.url, (cand) => {
        if (nodes.length + queue.length >= maxPages * 2) return;
        if (queue.some(q => slugOf(q.path) === slugOf(cand.path))) return;
        queue.push({ ...cand, chain: [cand.selector] });
      });
    }
  } catch (e: any) {
    crashed = true;
    const why = String(e?.message ?? e).split(String.fromCharCode(10))[0].slice(0, 200);
    notes.push(`the walk stopped early: ${why}${/closed/i.test(why) ? ' — the browser went away mid-crawl (killed, crashed, or the host restarted)' : ''}`);
  }

  // Both queues, because a walk can finish every page and still have pages
  // whose own cards and forms were never pressed. Counting only the page
  // queue reported "nothing left" on a crawl that stopped one step before
  // descending into Manage Simulators, which reads as a complete map of a
  // page that was never opened.
  const left = queue.length + descendQueue.length;
  if (left) {
    // Not the budget's fault when the browser went away first.
    const why = crashed ? 'the walk ended early'
      : nodes.length >= maxPages ? `page budget of ${maxPages} reached`
      : 'time budget reached';
    notes.push(
      `${why} with ${left} still to do`
      + (queue.length ? ` — ${queue.length} page(s) not opened` : '')
      + (descendQueue.length ? ` — ${descendQueue.length} page(s) opened but their own controls not followed` : ''),
    );
  }
  if (opts.signal?.aborted) notes.push('discovery was stopped by the operator');

  return {
    map: {
      host: opts.host,
      systemId: opts.systemId,
      username: opts.username,
      build: opts.build,
      discoveredAt: new Date(t0).toISOString(),
      durationMs: Date.now() - t0,
      nodes,
      notes,
      dir: opts.screenshotDir,
    },
    visited,
  };
}

/** Cancel / Close / Escape, in that order. Exported because the executor
 *  opens dialogs too and must get out of them the same way. */
export async function closeAnyDialog(page: Page): Promise<boolean> {
  const byName = page.getByRole('button', { name: /^(cancel|close|discard|back)$/i }).first();
  if (await byName.count().catch(() => 0)) {
    if (await byName.click({ timeout: 4000 }).then(() => true).catch(() => false)) {
      await page.waitForTimeout(300);
      if (!(await dialogOpen(page))) return true;
    }
  }
  const x = page.locator('[aria-label="Close"], .modal-header .close, .ant-modal-close, button:has-text("×")').first();
  if (await x.count().catch(() => 0)) {
    if (await x.click({ timeout: 4000 }).then(() => true).catch(() => false)) {
      await page.waitForTimeout(300);
      if (!(await dialogOpen(page))) return true;
    }
  }
  await page.keyboard.press('Escape').catch(() => null);
  await page.waitForTimeout(300);
  return !(await dialogOpen(page));
}

export async function dialogOpen(page: Page): Promise<boolean> {
  return page.evaluate(`(() => {
    const sels = ['[role="dialog"]', '.modal.show', '.modal.in', '.ant-modal', '.MuiDialog-container', 'dialog[open]'];
    for (const s of sels) {
      for (const el of document.querySelectorAll(s)) {
        const r = el.getClientRects();
        if (r && r.length) return true;
      }
    }
    return false;
  })()`).then(v => !!v).catch(() => false);
}

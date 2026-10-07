// Turning a discovered UI into the checks to run against it.
//
// This is where "dynamic" actually happens. Nothing here knows that the
// Simnovator has a Tools menu or a Manage Simulators page: it is handed a map
// that was read off the box minutes ago and derives, per page and per
// element, what can be verified about it. A build that adds SDR Management
// gets SDR Management checks on the next discovery without anyone editing
// this file — and a build that removes a page stops generating checks for it
// instead of reporting a permanent failure.
//
// The generated check carries everything the result table shows — section,
// page, element, what was performed, what was expected — so a row is
// readable before it has run and still readable in a saved report.
//
// Pure: no browser, no fs, no imports but types. The executor takes these.

import type {
  UiMap, UiNode, UiElement, GeneratedCheck, CheckSeverity,
} from './types.ts';
import { LOGIN_NODE_ID, loginChecks, type LoginForm } from './login.ts';
import { accessChecks } from './access.ts';

export interface PlanOptions {
  /** Operate controls that change the box (Save, Delete, Start). Off, and
   *  meant to stay off outside a setup nobody else is using. */
  includeMutating?: boolean;
  /** Submit forms with their mandatory fields empty to prove the UI rejects
   *  it. Off by default: if the product's validation is the thing that is
   *  broken, this is what creates the junk record that proves it. */
  probeRequiredFields?: boolean;
  /** Press the controls the risk policy says are safe, to see whether they
   *  do anything at all. On by default — it is the difference between "the
   *  button is there" and "the button works". */
  exerciseButtons?: boolean;
  /** Other logins' maps for this box, for the role-based access comparison. */
  otherLogins?: Array<{ username: string; map: UiMap }>;
  /** Hard ceiling, so a UI with 400 pages cannot plan a run nobody will wait
   *  for. Checks are dropped from the end of the plan, never sampled, so a
   *  truncated plan is still a complete walk of the pages it reached. */
  maxChecks?: number;
}

const sev = (s: CheckSeverity) => s;

function pageOf(node: UiNode): string {
  return node.path.join(' → ');
}

function sectionOf(node: UiNode): string {
  return node.path[0] ?? node.label;
}

/** One check, with the page's identity filled in for it. */
function mk(node: UiNode, c: Omit<GeneratedCheck, 'section' | 'page' | 'nodeId' | 'id'> & { idSuffix: string }): GeneratedCheck {
  const { idSuffix, ...rest } = c;
  return {
    id: `${node.id}::${idSuffix}`,
    section: sectionOf(node),
    page: pageOf(node),
    nodeId: node.id,
    ...rest,
  };
}

function nodeChecks(node: UiNode): GeneratedCheck[] {
  const out: GeneratedCheck[] = [];
  const target = node.reach.via === 'url'
    ? { url: node.reach.url }
    : { selector: node.reach.selector, clickFromUrl: node.reach.fromUrl, clickChain: node.reach.chain };

  out.push(mk(node, {
    idSuffix: 'page-loads',
    kind: 'page-loads',
    severity: sev('critical'),
    test: node.kind === 'tab'
      ? `Open ${pageOf(node)} by selecting the "${node.label}" tab`
      : `Navigate to ${pageOf(node)}`,
    expected: 'the page opens and renders content — no blank region, no error page, no bounce back to login',
    target,
  }));

  if (node.kind === 'tab') {
    out.push(mk(node, {
      idSuffix: 'tab-switches',
      kind: 'tab-switches',
      severity: sev('normal'),
      test: `Select the "${node.label}" tab and read what it shows`,
      expected: 'the tab becomes the selected one and its own content replaces the previous tab\'s',
      target,
    }));
  }

  out.push(mk(node, {
    idSuffix: 'console',
    kind: 'page-no-console-errors',
    severity: sev('normal'),
    test: `Watch the browser console while ${pageOf(node)} loads`,
    expected: 'no uncaught errors and no failed script or resource loads',
    target,
  }));

  if ((node.apiCalls ?? []).length > 0) {
    out.push(mk(node, {
      idSuffix: 'api',
      kind: 'page-api-ok',
      severity: sev('normal'),
      test: `Check the ${node.apiCalls!.length} API call(s) this page makes for itself`,
      expected: 'every request the page issues answers below 400 — the table you are looking at is the data the box returned',
      target,
    }));
  }

  return out;
}

function elementChecks(node: UiNode, el: UiElement, opts: PlanOptions): GeneratedCheck[] {
  const out: GeneratedCheck[] = [];
  const base = node.reach.via === 'url'
    ? { url: node.reach.url }
    : { selector: node.reach.selector, clickFromUrl: node.reach.fromUrl, clickChain: node.reach.chain };
  const base2 = { ...base, transient: el.transient };
  const at = (idSuffix: string, rest: Omit<GeneratedCheck, 'section' | 'page' | 'nodeId' | 'id' | 'element' | 'elementKind'>) =>
    mk(node, { idSuffix: `${el.key}::${idSuffix}`, element: el.label || el.key, elementKind: el.kind, ...rest });

  // Everything discovered is at least checked for still being there. This is
  // the check that catches a control a build quietly dropped.
  out.push(at('present', {
    kind: 'element-present',
    severity: sev('normal'),
    test: `Look for the ${el.kind} "${el.label || el.key}" on ${pageOf(node)}`,
    expected: 'the control is present and visible',
    target: { ...base2, selector: el.selector },
  }));

  // Enabled state is asserted as discovered: a Save that greys out until the
  // form is valid should still be grey, and one that is dead on arrival in a
  // new build is a regression.
  out.push(at(el.disabled ? 'disabled' : 'enabled', {
    kind: el.disabled ? 'element-disabled' : 'element-enabled',
    severity: sev('normal'),
    test: `Read the enabled state of "${el.label || el.key}"`,
    expected: el.disabled
      ? 'the control is still disabled, as it was when the UI was discovered'
      : 'the control is enabled and can take a click',
    target: { ...base2, selector: el.selector },
  }));

  switch (el.kind) {
    case 'input':
    case 'textarea':
      out.push(at('labelled', {
        kind: 'field-labelled',
        severity: sev('optional'),
        test: `Check that the field "${el.label || el.key}" is labelled`,
        expected: 'the field has a visible label or an accessible name — not a bare box',
        target: { ...base2, selector: el.selector },
      }));
      if (el.required) {
        out.push(at('required', {
          kind: 'required-field-blocks-submit',
          severity: sev('normal'),
          test: `Submit the form with the mandatory field "${el.label || el.key}" empty`,
          expected: 'the UI refuses and says which field is missing — nothing is saved',
          notApplicable: opts.probeRequiredFields
            ? undefined
            : 'mandatory-field probing is off for this run: submitting a form is only safe if the validation being tested works',
          target: { ...base2, selector: el.selector },
        }));
      }
      break;

    case 'select':
      out.push(at('options', {
        kind: 'select-has-options',
        severity: sev('normal'),
        test: `Open the dropdown "${el.label || el.key}" and read its options`,
        expected: (el.options?.length ?? 0) > 0
          ? `the dropdown offers choices — ${el.options!.length} were there at discovery`
          : 'the dropdown offers at least one choice',
        target: { ...base2, selector: el.selector, options: el.options },
      }));
      out.push(at('options-unique', {
        kind: 'select-options-unique',
        severity: sev('optional'),
        test: `Check the options of "${el.label || el.key}" for duplicates`,
        expected: 'no option label appears twice',
        target: { ...base2, selector: el.selector, options: el.options },
      }));
      break;

    case 'table':
      out.push(at('headers', {
        kind: 'table-headers',
        severity: sev('normal'),
        test: `Read the column headers of the table on ${pageOf(node)}`,
        expected: (el.columns?.length ?? 0) > 0
          ? `the same columns are there: ${el.columns!.join(', ')}`
          : 'the table has column headers',
        target: { ...base2, selector: el.selector, columns: el.columns, rowCount: el.rowCount },
      }));
      out.push(at('rows', {
        kind: 'table-rows-or-empty-state',
        severity: sev('normal'),
        test: 'Read the table body',
        expected: 'either rows of data, or the page\'s own empty state — never a blank table with no explanation',
        target: { ...base2, selector: el.selector, rowCount: el.rowCount },
      }));
      if ((el.columns?.length ?? 0) > 0) {
        out.push(at('sort', {
          kind: 'sort-reorders',
          severity: sev('optional'),
          test: `Click the "${el.columns![0]}" column header`,
          expected: 'the rows reorder by that column, or the header is plainly not sortable',
          target: { ...base2, selector: el.selector, columns: el.columns },
        }));
      }
      break;

    case 'search':
      out.push(at('filters', {
        kind: 'search-filters',
        severity: sev('normal'),
        test: 'Type a value from the table into the search box',
        expected: 'the list narrows to matching rows, and clearing the box restores it',
        target: { ...base2, selector: el.selector },
      }));
      break;

    case 'pagination':
      out.push(at('paging', {
        kind: 'pagination-advances',
        severity: sev('normal'),
        test: 'Go to the next page of results and back',
        expected: 'the rows change and the page indicator follows — or there is only one page, which is reported as such',
        target: { ...base2, selector: el.selector },
      }));
      break;

    default:
      break;
  }

  // Does it actually do anything?
  //
  // Checking that a button is present and enabled says nothing about whether
  // it works: a dead control looks exactly like a live one. So every control
  // the risk policy says is safe to operate gets pressed, and the page is
  // asked whether anything happened — it navigated, it opened something, or
  // it changed. Nothing at all is the answer worth reporting.
  if (el.risk === 'read' && (el.kind === 'button' || el.kind === 'link') && !el.disabled && opts.exerciseButtons !== false) {
    out.push(at('responds', {
      kind: 'button-responds',
      severity: sev('normal'),
      test: `Click "${el.label || el.key}" and watch what the page does`,
      expected: 'it navigates, opens something, or visibly changes — a control that does nothing is a broken one',
      target: { ...base2, selector: el.selector },
    }));
  }

  // Only buttons and links open things. A radio or a checkbox labelled
  // "Cards view" / "Table view" also classifies as 'open', and clicking one
  // to see whether a dialog appears silently switched the Manage Simulators
  // page into Table view for the whole run — where the Stable, Unstable,
  // Available and Busy chips do not exist, so twenty of them were reported
  // missing. A check that changes what the page is has no business being a
  // read-only check.
  // …and not one that was disabled when it was found. Asking a disabled
  // control to open a form and reporting that it would not take a click is
  // a failure the UI is entitled to: its own element-disabled check already
  // asserts it should stay that way.
  if (el.risk === 'open' && !el.disabled && (el.kind === 'button' || el.kind === 'link')) {
    out.push(at('dialog', {
      kind: 'dialog-opens-and-cancels',
      severity: sev('normal'),
      test: `Click "${el.label || el.key}", read the form it opens, then cancel`,
      expected: 'a dialog or form opens with its fields, and Cancel closes it leaving nothing behind',
      target: { ...base2, selector: el.selector },
    }));
  }

  if (el.risk === 'mutate' && !opts.includeMutating) {
    out.push(at('action', {
      kind: 'element-present',
      severity: sev('normal'),
      test: `Confirm the action "${el.label || el.key}" is offered`,
      expected: 'the action is present, labelled and in its expected enabled state',
      notApplicable: 'not operated: this control changes or destroys state on the box, so the run verifies it is offered rather than pressing it',
      target: { ...base2, selector: el.selector },
    }));
  }

  return out;
}

/** Checks that are about the application rather than any one page. Generated
 *  once per map, against the first page that was reachable by URL. */
function globalChecks(map: UiMap): GeneratedCheck[] {
  const anchor = map.nodes.find(n => n.reach.via === 'url' && !n.unreachable);
  if (!anchor) return [];
  const url = (anchor.reach as { via: 'url'; url: string }).url;
  const section = 'Application';
  const base = (id: string, rest: Omit<GeneratedCheck, 'id' | 'section' | 'page' | 'nodeId'>): GeneratedCheck => ({
    id: `app::${id}`, section, page: section, nodeId: anchor.id, ...rest,
  });
  return [
    base('back-forward', {
      kind: 'back-forward-nav',
      severity: 'normal',
      test: 'Navigate to a second page, then use the browser Back and Forward buttons',
      expected: 'both land on the right page with its content rendered — no blank SPA shell',
      target: { url },
    }),
    base('refresh', {
      kind: 'refresh-keeps-page',
      severity: 'normal',
      test: 'Reload a deep page with F5',
      expected: 'the same page comes back, still signed in',
      target: { url },
    }),
    base('session', {
      kind: 'session-protected',
      severity: 'critical',
      test: 'Request a protected page with no session',
      expected: 'the box redirects to the login form instead of serving the page',
      target: { url },
    }),
  ];
}

/** The whole plan for a map, in the order it will run: pages outermost-first,
 *  each page's own checks before its elements'. */
export function checksFromMap(map: UiMap, opts: PlanOptions = {}): GeneratedCheck[] {
  const out: GeneratedCheck[] = [];
  const seen = new Set<string>();
  const push = (c: GeneratedCheck) => {
    if (seen.has(c.id)) return;
    seen.add(c.id);
    out.push(c);
  };

  for (const node of map.nodes) {
    // The login page is not browsed like the others — it is typed into, with
    // wrong passwords and empty fields, in sessions of its own — so it brings
    // its own checks rather than the generic present-and-enabled ones.
    if (node.id === LOGIN_NODE_ID && map.loginForm) {
      for (const c of loginChecks(map.loginForm as LoginForm)) push(c);
      continue;
    }
    for (const c of nodeChecks(node)) push(c);
    // A page the crawler could not open has nothing to say about its
    // elements; the page-loads check above is what reports it.
    if (node.unreachable) continue;
    for (const el of node.elements) {
      for (const c of elementChecks(node, el, opts)) push(c);
    }
  }
  for (const c of globalChecks(map)) push(c);
  // Role-based access: what another login on this box is shown and this one
  // is not, asked for directly.
  if (opts.otherLogins?.length) {
    for (const c of accessChecks(map, opts.otherLogins)) push(c);
  }

  const cap = opts.maxChecks ?? 0;
  return cap > 0 ? out.slice(0, cap) : out;
}

/** How a plan reads before it runs — what the UI shows next to the tree. */
export function planSummary(checks: GeneratedCheck[]): {
  total: number; willRun: number; notApplicable: number;
  bySection: Array<{ section: string; total: number }>;
  byKind: Array<{ kind: string; total: number }>;
} {
  const bySection = new Map<string, number>();
  const byKind = new Map<string, number>();
  let notApplicable = 0;
  for (const c of checks) {
    bySection.set(c.section, (bySection.get(c.section) ?? 0) + 1);
    byKind.set(c.kind, (byKind.get(c.kind) ?? 0) + 1);
    if (c.notApplicable) notApplicable += 1;
  }
  return {
    total: checks.length,
    willRun: checks.length - notApplicable,
    notApplicable,
    bySection: [...bySection].map(([section, total]) => ({ section, total })).sort((a, b) => b.total - a.total),
    byKind: [...byKind].map(([kind, total]) => ({ kind, total })).sort((a, b) => b.total - a.total),
  };
}

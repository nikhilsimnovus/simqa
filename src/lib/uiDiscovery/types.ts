// What a Simnovator's UI looks like right now, as data.
//
// The old UI sweep carried ~160 hand-written tests. Every build that added a
// menu, renamed a field or moved a tab left that list quietly describing a UI
// that no longer existed — and a test list that cannot see a new page can
// never fail on it. So the shape of the UI is not written down here at all:
// it is read off the box at discovery time into a UiMap, and the checks are
// generated from that map.
//
// Two setups on different builds therefore produce different maps, different
// hierarchies and different test counts, which is the point.
//
// Types only — no values, so a module can `import type` from here without
// pulling anything into the pure, unit-tested logic.

export type UiElementKind =
  | 'button' | 'link' | 'tab' | 'input' | 'textarea' | 'select'
  | 'checkbox' | 'radio' | 'table' | 'search' | 'pagination' | 'other';

/** What acting on an element would do to the box.
 *
 *  'read'    — looking at it, or operating it, changes nothing (a tab, a
 *              search box, a sort header).
 *  'open'    — it opens a form or dialog and nothing is committed until a
 *              Save inside it, so it is safe to open and cancel (Add, Edit).
 *  'mutate'  — operating it changes or destroys lab state (Delete, Save,
 *              Start, Reboot, Install). Never operated: discovery and the
 *              checks only establish that it is there, labelled and in the
 *              expected enabled state. */
export type UiRisk = 'read' | 'open' | 'mutate';

export interface UiElement {
  /** Stable across discoveries of the same page so a diff can follow it. */
  key: string;
  kind: UiElementKind;
  label: string;
  role?: string;
  /** Playwright selector that found it, re-resolved at execution time. */
  selector: string;
  risk: UiRisk;
  disabled?: boolean;
  required?: boolean;
  /** Visible option labels, for a select. */
  options?: string[];
  /** Column headers and the row count seen at discovery, for a table. */
  columns?: string[];
  rowCount?: number;
  /** Set when the element is present but not usable for a check, with why. */
  note?: string;
}

export type UiNodeKind = 'page' | 'tab' | 'section';

export interface UiNode {
  /** Slug of the breadcrumb: tools/simnovator-management/stable. */
  id: string;
  kind: UiNodeKind;
  /** Breadcrumb as the operator reads it, outermost first. */
  path: string[];
  label: string;
  url?: string;
  parentId?: string;
  /** How the crawler got here, and how an executor gets back. */
  reach:
    | { via: 'url'; url: string }
    /** `chain` lists the clicks to replay in order from `fromUrl` — a submenu
     *  entry needs its parent menu expanded before it is there to click. */
    | { via: 'click'; selector: string; fromUrl: string; chain?: string[] };
  elements: UiElement[];
  /** Console errors seen while this node was open. */
  consoleErrors?: string[];
  /** XHR the page made for itself — the basis of the API/UI consistency check. */
  apiCalls?: Array<{ method: string; url: string; status?: number }>;
  /** Present when the crawler saw the entry but could not open it. */
  unreachable?: string;
  /** Screenshot of this node, relative to the discovery dir. */
  screenshotFile?: string;
}

export interface UiMap {
  host: string;
  systemId?: string;
  /** Which login the UI was read as — the box scopes pages per account. */
  username?: string;
  /** Build string reported by the box when this map was taken. */
  build?: string;
  discoveredAt: string;
  durationMs?: number;
  nodes: UiNode[];
  /** Where the crawl stopped short, and why (budget, risk policy, errors). */
  notes?: string[];
  /** Directory holding this discovery's screenshots. */
  dir?: string;
}

export type CheckKind =
  | 'page-loads'
  | 'page-no-console-errors'
  | 'page-api-ok'
  | 'tab-switches'
  | 'element-present'
  | 'element-enabled'
  | 'button-responds'
  | 'element-disabled'
  | 'field-labelled'
  | 'select-has-options'
  | 'select-options-unique'
  | 'table-headers'
  | 'table-rows-or-empty-state'
  | 'search-filters'
  | 'sort-reorders'
  | 'pagination-advances'
  | 'dialog-opens-and-cancels'
  | 'required-field-blocks-submit'
  | 'back-forward-nav'
  | 'refresh-keeps-page'
  | 'session-protected';

export type CheckSeverity = 'critical' | 'normal' | 'optional';

/** One generated validation. Everything the result table shows — section,
 *  page, element, what was performed, what was expected — is decided here,
 *  from the map, before anything runs. */
export interface GeneratedCheck {
  id: string;
  kind: CheckKind;
  severity: CheckSeverity;
  /** Top of the breadcrumb: the menu this lives under. */
  section: string;
  /** Full breadcrumb of the page. */
  page: string;
  nodeId: string;
  element?: string;
  elementKind?: UiElementKind;
  /** What the check performs, in the operator's words. */
  test: string;
  expected: string;
  /** Set when the check is deliberately not performed — reported as
   *  "Not Available" with this as the reason, never as a pass. */
  notApplicable?: string;
  target?: {
    url?: string;
    selector?: string;
    clickFromUrl?: string;
    /** Clicks to replay from `clickFromUrl` before the target is reachable. */
    clickChain?: string[];
    options?: string[];
    columns?: string[];
    rowCount?: number;
  };
}

export interface UiMapDiff {
  previousBuild?: string;
  previousDiscoveredAt?: string;
  currentBuild?: string;
  addedPages: Array<{ id: string; page: string }>;
  removedPages: Array<{ id: string; page: string }>;
  renamedPages: Array<{ id: string; from: string; to: string }>;
  addedElements: Array<{ id: string; page: string; element: string; kind: UiElementKind }>;
  removedElements: Array<{ id: string; page: string; element: string; kind: UiElementKind }>;
  changedElements: Array<{ id: string; page: string; element: string; what: string }>;
}

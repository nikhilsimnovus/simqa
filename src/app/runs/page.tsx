// Run History — one timeline of every execution across every test surface.
//
// Data comes from /api/history, which reads BOTH the unified historyStore
// (data/history/*.json) AND the per-surface stores that predate it
// (data/runs/*.json, data/config-fidelity/*/report.json, …) — without that
// fold-in the older config-fidelity and end-to-end runs vanish from the page.
//
// Layout note: the header, the filter bar and the table's column headings all
// stay put while only the rows scroll. The page claims the full height of the
// content column and nests one scroll pane (the table card) inside it, so the
// three are genuinely fixed rather than sticky-and-drifting — an earlier
// version stacked sticky layers at hand-computed offsets (top-14, top-[6.5rem])
// and every change to the header or filter row silently misaligned them.

'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Header } from '@/components/Header';
import { BackToDashboard } from '@/components/BackToDashboard';
import { Button } from '@/components/ui';
import { ExternalLink, ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react';
import { useColumnWidths, ResizeHandle, ColGroup } from '@/components/resizableColumns';

interface HistoryEntry {
  id: string;
  surface: string;
  label: string;
  startedAt: string;
  finishedAt: string;
  targetSystemId?: string;
  targetHost?: string;
  buildVersion?: string;
  total: number;
  passed: number;
  failed: number;
  skipped?: number;
  detailPath?: string;
  meta?: Record<string, any>;
}

interface TestSystem { id: string; name: string; host: string; type: string }

// The five surfaces this page is built around, in the order they appear in
// the Surface dropdown. Any OTHER surface present in the data (build-check,
// perf-qa) is appended at runtime rather than hidden — those rows still show
// under "All", and a filter you cannot select is worse than one extra option.
// The bulk-* sweeps are the exception: they are a developer tool, not a test
// surface, so they are kept out of the dropdown by request.
const PRIMARY_SURFACES: Array<{ value: string; label: string }> = [
  { value: 'end-to-end',       label: 'Test Case' },
  { value: 'automation-suite', label: 'Automation Suite' },
  { value: 'api-tests',        label: 'API Tests' },
  { value: 'ui-tests',         label: 'UI Tests' },
  { value: 'config-fidelity',  label: 'Config Fidelity' },
];

const SURFACE_LABELS: Record<string, string> = {
  ...Object.fromEntries(PRIMARY_SURFACES.map((s) => [s.value, s.label])),
  'bulk-generate':    'Bulk Generate',
  'bulk-validate':    'Bulk Validate',
  'bulk-validate-ui': 'Bulk Validate UI',
  'bulk-execute':     'Bulk Execute',
  'build-check':      'Build Check',
  'perf-qa':          'Perf QA',
};

/** Surfaces that never appear in the Surface dropdown. */
const HIDDEN_SURFACES = (s: string) => s.startsWith('bulk-');

/** Build-filter value standing for "this run recorded no build". */
const NO_BUILD = 'Not recorded';

/** The dropdown chevron, drawn by us because the selects are appearance-none.
 *  Inline rather than a Tailwind arbitrary background: the data URI contains
 *  spaces, which Tailwind's arbitrary-value syntax will not carry. */
const selectStyle: React.CSSProperties = {
  backgroundImage:
    "url(\"data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20' fill='none' stroke='%2364748b' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 8l4 4 4-4'/%3E%3C/svg%3E\")",
  backgroundRepeat: 'no-repeat',
  backgroundPosition: 'right 0.5rem center',
  backgroundSize: '1rem 1rem',
};

/** Every column sorts. Keys are the column, not the underlying field name. */
type SortKey = 'surface' | 'testcase' | 'execTime' | 'execDate' | 'system' | 'build' | 'passed' | 'failed' | 'skipped' | 'total';

/** Columns that should open on their HIGHEST value — a count or a date is
 *  almost always wanted newest/most-first, whereas a name is wanted A→Z. */
const NUMERIC_SORTS: ReadonlySet<SortKey> = new Set(['execTime', 'execDate', 'passed', 'failed', 'skipped', 'total']);

const COLUMNS: Array<{ key: SortKey; label: string }> = [
  { key: 'surface',  label: 'Test Category' },
  { key: 'testcase', label: 'Test Case' },
  { key: 'execTime', label: 'Execution Time' },
  { key: 'execDate', label: 'Execution Date' },
  { key: 'system',   label: 'System' },
  { key: 'build',    label: 'Build' },
  { key: 'passed',   label: 'Pass' },
  { key: 'failed',   label: 'Fail' },
  { key: 'skipped',  label: 'Skip' },
  { key: 'total',    label: 'Total' },
];

/** Starting column widths in px, in table order — the ten sortable columns
 *  above plus Preview. Every column can then be dragged wider or narrower by
 *  its right-hand edge, the way a spreadsheet does it. */
const DEFAULT_COL_WIDTHS = [132, 168, 172, 124, 124, 152, 66, 66, 66, 72, 104];

const SURFACE_TONE: Record<string, string> = {
  'end-to-end':       'bg-slate-100 text-slate-700 border-slate-200',
  'automation-suite': 'bg-indigo-50 text-indigo-700 border-indigo-200',
  'api-tests':        'bg-sky-50 text-sky-700 border-sky-200',
  'ui-tests':         'bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200',
  'config-fidelity':  'bg-amber-50 text-amber-700 border-amber-200',
};

type ExecutionWindow = 'all' | 'today' | '24h' | '7d' | '30d' | 'custom';

const EXECUTION_OPTIONS: Array<{ value: ExecutionWindow; label: string }> = [
  { value: 'all',    label: 'All' },
  { value: 'today',  label: 'Today' },
  { value: '24h',    label: 'Last 24 Hours' },
  { value: '7d',     label: 'Last 7 Days' },
  { value: '30d',    label: 'Last 30 Days' },
  { value: 'custom', label: 'Custom Date Range' },
];

/** "10:30 AM" */
function timeOf(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

/** "10:30 AM – 10:52 AM" — when the run started and when it ended. A run with
 *  no recorded finish shows only its start rather than an invented end. */
function formatExecutedTime(startIso: string, endIso?: string): string {
  const a = timeOf(startIso);
  if (!a) return startIso;
  const b = timeOf(endIso);
  return b ? `${a} – ${b}` : a;
}

/** "27 Aug 2026" */
function formatExecutedDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** Bare version, so a row written as "4.0.0_x (Build y)" by automation-suite
 *  renders the same as one written as "4.0.0_x" by the newer surfaces. */
function displayBuild(raw?: string): string {
  if (!raw) return '—';
  const m = raw.match(/^([^\s(]+)/);
  return m ? m[1] : raw;
}

/** The named thing a row is about — the testcase, suite or environment it ran.
 *  Drives the Test Case column, and is passed to the destination page on Open
 *  so the heading there reads the name instead of a raw UUID. Sweeps (API/UI)
 *  have no single subject, and return undefined. */
function subjectName(e: HistoryEntry): string | undefined {
  const m = e.meta ?? {};
  return m.testcaseName ?? m.testCaseName ?? m.suiteName ?? m.environmentName ?? undefined;
}

/** Where Open should land: the surface's own result view, scoped to this run.
 *  `from=runs` tells the destination to render a "Back to Run History" link.
 *
 *  `systemId` matters more than it looks. /testcases/[id] reads it from the
 *  query string and uses it to decide WHICH BOX to ask for the testcase; with
 *  it missing, the lookup goes to the default box, the testcase isn't found
 *  there, and the page degrades to showing the raw UUID as its title with
 *  Pick Configuration stuck on "open this from the Test Cases list". The run
 *  we're opening already knows which box it ran on, so pass it through.
 *  `name` is display-only: it keeps the heading readable while the box is
 *  being queried, and if the box is unreachable. */
function openHref(e: HistoryEntry, systemId?: string): string {
  const runId = e.meta?.runId ?? e.id;
  const q = (extra: string) => {
    const parts = [`from=runs&run=${encodeURIComponent(runId)}`];
    if (systemId) parts.push(`systemId=${encodeURIComponent(systemId)}`);
    return `${extra}${extra.includes('?') ? '&' : '?'}${parts.join('&')}`;
  };
  switch (e.surface) {
    case 'api-tests':        return q('/api-tests');
    case 'ui-tests':         return q('/ui-tests');
    case 'automation-suite': return q(e.meta?.suiteId ? `/automation-suite?suite=${encodeURIComponent(e.meta.suiteId)}` : '/automation-suite');
    case 'config-fidelity':  return q('/config-fidelity');
    case 'end-to-end': {
      if (!e.meta?.testcaseId) return q('/testcases');
      const name = subjectName(e);
      return q(`/testcases/${encodeURIComponent(e.meta.testcaseId)}`) + (name ? `&name=${encodeURIComponent(name)}` : '');
    }
    default:                 return q('/runs');
  }
}

export default function RunsPage() {
  const router = useRouter();
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [systems, setSystems] = useState<TestSystem[]>([]);
  const [error, setError] = useState<string>('');

  const [surfaceFilter, setSurfaceFilter] = useState<string>('');
  const [systemFilter, setSystemFilter] = useState<string>('');   // a host, e.g. 192.168.1.102
  const [execFilter, setExecFilter] = useState<ExecutionWindow>('all');
  const [customFrom, setCustomFrom] = useState<string>('');
  const [customTo, setCustomTo] = useState<string>('');
  const [buildFilter, setBuildFilter] = useState<string>('');
  const [sortKey, setSortKey] = useState<SortKey>('execTime');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const { colWidths, tableWidth, startResize } = useColumnWidths(DEFAULT_COL_WIDTHS);

  const load = async () => {
    try {
      const r = await fetch('/api/history?limit=500', { cache: 'no-store' });
      const d = await r.json();
      if (!d.ok) { setError(d.error ?? 'fetch failed'); return; }
      // Bulk sweeps are dropped here rather than merely hidden from the Test
      // Category dropdown, so they are out of the table, out of the build
      // counts and out of every filter — they are a developer tool, not a
      // test category, and they were the single largest surface after
      // api-tests.
      setEntries((d.entries ?? []).filter((e: HistoryEntry) => !HIDDEN_SURFACES(e.surface)));
      setError('');
    } catch (e: any) { setError(e?.message ?? String(e)); }
  };

  useEffect(() => {
    load();
    // A run finishing elsewhere should appear without a manual refresh.
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  // EVERY system, not just the Simnovators. Two different jobs are being done
  // with this list and they need different sets: the System dropdown offers
  // Simnovators only (below), but resolving a row's host from the
  // targetSystemId it recorded has to cover the whole inventory — filtering
  // first left rows that ran against a UESIM or callbox with a blank System
  // column even though the box is sitting right there in inventory.yaml.
  useEffect(() => {
    fetch('/api/ui-tests/systems')
      .then((r) => r.json())
      .then((j) => setSystems((j.systems ?? []) as TestSystem[]))
      .catch(() => setSystems([]));
  }, []);

  const hostForSystemId = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of systems) m.set(s.id, s.host);
    return m;
  }, [systems]);

  const simnovators = useMemo(
    () => systems.filter((s) => s.type === 'SIMNOVATOR' || s.type === 'SIMNOVATOR_GUI'),
    [systems],
  );

  /** Host → inventory id, for Open links. Most end-to-end rows recorded only
   *  targetHost (and some recorded a targetSystemId like "lab-uesim-102" that
   *  no longer exists in inventory), so the host is the reliable way back to
   *  the system id the destination page needs. */
  const systemIdForHost = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of systems) if (!m.has(s.host)) m.set(s.host, s.id);
    return m;
  }, [systems]);

  /** A row's host: recorded directly on newer rows, resolved via inventory for
   *  older ones that only carry targetSystemId.
   *
   *  Sanity-checked, because one end-to-end run from 2026-08-06 stored its
   *  failure text — a whole 299-character Apache 404 page — as targetHost. Left
   *  alone it renders into a single nowrap cell and stretches the table off the
   *  screen. The row still belongs in the history, so it shows with no host
   *  rather than being dropped. */
  const hostOf = (e: HistoryEntry): string | undefined => {
    const raw = e.targetHost ?? (e.targetSystemId ? hostForSystemId.get(e.targetSystemId) : undefined);
    if (!raw) return undefined;
    return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,62}$/.test(raw) ? raw : undefined;
  };

  const surfaceOptions = useMemo(() => {
    const known = new Set(PRIMARY_SURFACES.map((s) => s.value));
    const extra = Array.from(new Set((entries ?? []).map((e) => e.surface)))
      .filter((s) => !known.has(s) && !HIDDEN_SURFACES(s))
      .sort()
      .map((s) => ({ value: s, label: SURFACE_LABELS[s] ?? s }));
    return [...PRIMARY_SURFACES, ...extra];
  }, [entries]);

  // Simnovators only. The dropdown used to be widened with every host found in
  // the data, which put UE-sim and callbox hosts in a Simnovator list — and one
  // older row had recorded a whole "UESIM login failed: 404 <!DOCTYPE html>…"
  // error page as its targetHost, which then appeared as a selectable system.
  // Rows whose host is not a Simnovator are still listed under "All".
  const systemOptions = useMemo(
    () => Array.from(new Set(simnovators.map((s) => s.host))).sort(),
    [simnovators],
  );

  /** Lower bound implied by the Execution filter. */
  const timeBounds = useMemo((): { from?: number; to?: number } => {
    const now = Date.now();
    switch (execFilter) {
      case 'today': { const d = new Date(); d.setHours(0, 0, 0, 0); return { from: d.getTime() }; }
      case '24h':   return { from: now - 24 * 3600_000 };
      case '7d':    return { from: now - 7 * 24 * 3600_000 };
      case '30d':   return { from: now - 30 * 24 * 3600_000 };
      case 'custom': return {
        from: customFrom ? new Date(`${customFrom}T00:00:00`).getTime() : undefined,
        // inclusive end-of-day, so picking a single day matches that whole day
        to:   customTo   ? new Date(`${customTo}T23:59:59.999`).getTime() : undefined,
      };
      default: return {};
    }
  }, [execFilter, customFrom, customTo]);

  /** Everything except the Build filter — the Build dropdown is populated from
   *  THIS set, so the builds offered are only those the other filters can
   *  actually reach (the spec's "filtering by System or Surface should show
   *  the relevant builds"). */
  const beforeBuild = useMemo(() => {
    if (!entries) return [];
    return entries.filter((e) => {
      if (surfaceFilter && e.surface !== surfaceFilter) return false;
      if (systemFilter && hostOf(e) !== systemFilter) return false;
      const t = new Date(e.startedAt).getTime();
      if (timeBounds.from !== undefined && !(t >= timeBounds.from)) return false;
      if (timeBounds.to   !== undefined && !(t <= timeBounds.to))   return false;
      return true;
    });
  }, [entries, surfaceFilter, systemFilter, timeBounds, hostForSystemId]);

  // Builds reachable under the current Surface/System/time selection, each with
  // how many runs carry it. The count is shown in the dropdown because build
  // attribution was only added to the surfaces recently: most older rows carry
  // no build at all, so a build legitimately matching one run looks like a
  // broken filter unless the list says so. NO_BUILD makes those unattributed
  // rows selectable rather than merely invisible.
  const buildOptions = useMemo(() => {
    const counts = new Map<string, number>();
    let missing = 0;
    for (const e of beforeBuild) {
      const b = displayBuild(e.buildVersion);
      if (b === '—') { missing++; continue; }
      counts.set(b, (counts.get(b) ?? 0) + 1);
    }
    const list = Array.from(counts.entries())
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => (a.value < b.value ? 1 : a.value > b.value ? -1 : 0));
    if (missing) list.push({ value: NO_BUILD, count: missing });
    return list;
  }, [beforeBuild]);

  // A build that is no longer reachable under the current Surface/System/time
  // selection must not keep silently filtering everything out.
  useEffect(() => {
    if (buildFilter && !buildOptions.some((b) => b.value === buildFilter)) setBuildFilter('');
  }, [buildOptions, buildFilter]);

  const filtered = useMemo(() => {
    if (!buildFilter) return beforeBuild;
    if (buildFilter === NO_BUILD) return beforeBuild.filter((e) => displayBuild(e.buildVersion) === '—');
    return beforeBuild.filter((e) => displayBuild(e.buildVersion) === buildFilter);
  }, [beforeBuild, buildFilter]);

  /** Sort value for a row under a given column. Returns a number for the
   *  numeric columns and a lowercased string for the rest, so one comparator
   *  handles every column without per-column branching at compare time. */
  const sortValue = (e: HistoryEntry, key: SortKey): string | number => {
    switch (key) {
      case 'surface':  return (SURFACE_LABELS[e.surface] ?? e.surface).toLowerCase();
      case 'testcase': return (subjectName(e) ?? '').toLowerCase();
      // Time sorts chronologically, not by clock face: two runs an hour apart on
      // different days should not interleave. Date sorts by the calendar day, so
      // a day's runs stay together and the time column breaks the tie below.
      case 'execTime': return new Date(e.startedAt).getTime() || 0;
      case 'execDate': return new Date(e.startedAt).setHours(0, 0, 0, 0) || 0;
      case 'system':   return (hostOf(e) ?? '').toLowerCase();
      case 'build':    return displayBuild(e.buildVersion).toLowerCase();
      case 'passed':   return e.passed;
      case 'failed':   return e.failed;
      case 'skipped':  return e.skipped ?? 0;
      case 'total':    return e.passed + e.failed + (e.skipped ?? 0);
    }
  };

  const sorted = useMemo(() => {
    const rows = [...filtered];
    const dir = sortDir === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
      const av = sortValue(a, sortKey);
      const bv = sortValue(b, sortKey);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      // Stable tiebreak on time, so rows that match on the sorted column keep a
      // predictable order instead of shuffling between renders.
      return (new Date(b.startedAt).getTime() || 0) - (new Date(a.startedAt).getTime() || 0);
    });
    return rows;
  }, [filtered, sortKey, sortDir, hostForSystemId]);

  /** Click a heading: same column flips direction, a new column starts in the
   *  direction that is useful first — newest / highest for time and counts,
   *  A→Z for names. */
  const toggleSort = (key: SortKey) => {
    if (key === sortKey) { setSortDir((d) => (d === 'asc' ? 'desc' : 'asc')); return; }
    setSortKey(key);
    setSortDir(NUMERIC_SORTS.has(key) ? 'desc' : 'asc');
  };

  // One box, one border, all four sides, same width for every filter.
  //
  // `appearance-none` is the point of this: the native select on Windows paints
  // its own dropdown button with its own background at the right-hand end, so
  // the control read as a white box with a differently-coloured panel stuck on
  // one side rather than a single complete box. With the native chrome off we
  // draw the chevron ourselves (selectStyle below) and the border, hover and
  // focus ring all run the whole way round.
  const fieldBase =
    'h-8 w-[190px] shrink-0 rounded-md border border-slate-300 bg-white text-xs text-slate-900 ' +
    'hover:border-slate-400 focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-500/30 ' +
    'disabled:bg-slate-100 disabled:text-slate-400 disabled:border-slate-200';
  const selectCls = `${fieldBase} appearance-none pl-2 pr-8`;
  // Date fields keep their native picker button, so no appearance-none here —
  // stripping it would hide the calendar control. Everything else matches.
  const inputCls = `${fieldBase} px-2`;
  const labelCls = 'text-[10px] font-medium uppercase tracking-wider text-slate-400 mb-1';
  // One heading style and one cell style, both left-aligned, both carrying the
  // right-hand column rule that gives the table its spreadsheet grid.
  const thCls = 'relative select-none px-3 py-2 text-left font-medium border-b border-r border-slate-200 last:border-r-0 whitespace-nowrap';
  // truncate, not whitespace-nowrap: with table-fixed a narrowed column must
  // clip its content with an ellipsis instead of spilling into its neighbour.
  const tdCls = 'px-3 py-1.5 border-r border-slate-100 last:border-r-0 text-left truncate';

  return (
    // The page owns the full height of the content column and does its own
    // scrolling, so the header and the filter bar are genuinely fixed rather
    // than sticky: nothing above the table can travel, at any window size.
    <div className="flex-1 min-h-0 flex flex-col">
      <Header
        title="Run History"
        subtitle="Track every test run in one place — Test Cases, Automation Suite, API Tests, UI Tests and Config Fidelity. Click any row to open the full result."
        right={<BackToDashboard />}
      />

      {/* Filter bar — pinned under the header, never scrolls.
          Every control is the same element (a select), the same height and the
          same colours. Build used to be a list-backed text input, which is why
          it looked like a different kind of thing and had to be cleared by hand
          before another build could be chosen. */}
      <div className="shrink-0 bg-slate-50 border-b border-slate-200 px-6 py-2.5">
        {/* flex-nowrap keeps the four filters on one line; a narrow window
            scrolls this strip sideways instead of wrapping one onto a second
            row and shifting the table down. */}
        <div className="flex flex-nowrap items-end gap-3 overflow-x-auto">
          <label className="flex flex-col shrink-0">
            <span className={labelCls}>Test Category</span>
            <select value={surfaceFilter} onChange={(e) => setSurfaceFilter(e.target.value)} className={selectCls} style={selectStyle}>
              <option value="">All</option>
              {surfaceOptions.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </label>

          <label className="flex flex-col shrink-0">
            <span className={labelCls}>System</span>
            <select value={systemFilter} onChange={(e) => setSystemFilter(e.target.value)} className={selectCls} style={selectStyle}>
              <option value="">All</option>
              {systemOptions.map((h) => <option key={h} value={h}>{h}</option>)}
            </select>
          </label>

          <label className="flex flex-col shrink-0">
            <span className={labelCls}>Execution</span>
            <select value={execFilter} onChange={(e) => setExecFilter(e.target.value as ExecutionWindow)} className={selectCls} style={selectStyle}>
              {EXECUTION_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>

          <label className="flex flex-col shrink-0">
            <span className={labelCls}>Build</span>
            <select value={buildFilter} onChange={(e) => setBuildFilter(e.target.value)} className={selectCls} style={selectStyle} disabled={buildOptions.length === 0}>
              <option value="">{buildOptions.length ? 'All' : 'No builds recorded'}</option>
              {buildOptions.map((b) => (
                <option key={b.value} value={b.value}>{`${b.value} (${b.count})`}</option>
              ))}
            </select>
          </label>

          {/* Only when the Execution window is Custom. Appended at the END so
              its appearance never pushes the four standing filters around. */}
          {execFilter === 'custom' ? (
            <>
              <label className="flex flex-col shrink-0">
                <span className={labelCls}>From</span>
                <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} className={inputCls} />
              </label>
              <label className="flex flex-col shrink-0">
                <span className={labelCls}>To</span>
                <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} className={inputCls} />
              </label>
            </>
          ) : null}
        </div>
      </div>

      {/* Page body. Fills the space under the filter bar and does NOT scroll —
          the card below is the one scrolling region on the page. */}
      <div className="flex-1 min-h-0 flex flex-col px-6 py-3">
        {error ? <div className="mb-3 shrink-0 p-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded">{error}</div> : null}

        {/* The card IS the scrollport. That matters: the column headings below
            stick to the top edge of THIS element, so there is no strip of page
            above them for rows to show through on the way past — which is what
            made a sticky <thead> inside a padded scroll pane look untidy. */}
        <main className="flex-1 min-h-0 overflow-auto border border-slate-200 rounded-lg bg-white">
          {/* table-fixed is what makes the column widths below authoritative —
              with auto layout the browser re-derives them from the content and
              a dragged width springs back on the next render. */}
          <table className="text-xs table-fixed" style={{ width: tableWidth, minWidth: '100%' }}>
            <colgroup>
              {colWidths.map((w, i) => <col key={i} style={{ width: w }} />)}
            </colgroup>
            {/* Fixed column headings — only the rows travel under them. */}
            <thead className="sticky top-0 z-10 bg-slate-50 text-slate-500">
              {/* The rule under the headings is drawn per-cell (thCls carries
                  border-b): a border on a stuck <thead> or <tr> is not painted
                  by Chrome, so rows would slide up against the headings with
                  nothing separating them. */}
              <tr>
                {COLUMNS.map((c, i) => {
                  const active = sortKey === c.key;
                  return (
                    <th key={c.key} className={thCls} aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                      {/* Label left, sort arrow pinned to the right edge of the
                          cell — so the arrows line up down the right of each
                          column rather than floating after labels of differing
                          length. */}
                      <button
                        type="button"
                        onClick={() => toggleSort(c.key)}
                        className="group flex w-full items-center justify-between gap-1 font-medium hover:text-slate-900"
                        title={`Sort by ${c.label}`}
                      >
                        <span className="truncate">{c.label}</span>
                        {active
                          ? (sortDir === 'asc' ? <ChevronUp className="h-3 w-3 shrink-0 text-slate-700" /> : <ChevronDown className="h-3 w-3 shrink-0 text-slate-700" />)
                          : <ChevronsUpDown className="h-3 w-3 shrink-0 opacity-25 group-hover:opacity-60" />}
                      </button>
                      <ResizeHandle onMouseDown={startResize(i)} />
                    </th>
                  );
                })}
                <th className={thCls}>
                  Preview
                  <ResizeHandle onMouseDown={startResize(COLUMNS.length)} />
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {entries == null ? (
                <tr><td colSpan={11} className="px-3 py-6 text-slate-500">Loading…</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={11} className="px-3 py-6 text-slate-500">
                  {entries.length === 0
                    ? 'No runs recorded yet. Run an API sweep, a UI sweep, an automation suite, a config-fidelity matrix or a test case validation — each one lands here.'
                    : 'No runs match the current filters.'}
                </td></tr>
              ) : sorted.map((e) => {
                const skip = e.skipped ?? 0;
                // Total is defined as Pass + Fail + Skip rather than echoing the
                // stored total: surfaces disagree on whether `total` counts
                // skips, and a row whose columns do not add up reads as a bug.
                const total = e.passed + e.failed + skip;
                const host = hostOf(e);
                const name = subjectName(e);
                // The id the destination needs: what the row recorded, if it is
                // still a real system, otherwise resolved from the host.
                const openSystemId = (e.targetSystemId && hostForSystemId.has(e.targetSystemId))
                  ? e.targetSystemId
                  : (host ? systemIdForHost.get(host) : undefined);
                return (
                  <tr key={e.id} className="hover:bg-sky-50/60 even:bg-slate-50/40">
                    <td className={tdCls}>
                      <span className={`inline-block text-[10px] font-medium rounded border px-1.5 py-0.5 ${SURFACE_TONE[e.surface] ?? 'bg-slate-100 text-slate-600 border-slate-200'}`}>
                        {SURFACE_LABELS[e.surface] ?? e.surface}
                      </span>
                    </td>
                    <td className={`${tdCls} text-slate-800 max-w-[15rem] truncate`} title={name ?? e.label}>
                      {name ?? <span className="text-slate-400">—</span>}
                    </td>
                    <td className={`${tdCls} tabular-nums text-slate-700`} title={e.label}>{formatExecutedTime(e.startedAt, e.finishedAt)}</td>
                    <td className={`${tdCls} tabular-nums text-slate-700`}>{formatExecutedDate(e.startedAt)}</td>
                    <td className={`${tdCls} font-mono text-[11px] text-slate-600`}>{host ?? '—'}</td>
                    <td className={`${tdCls} font-mono text-[11px] text-slate-600`} title={e.buildVersion}>{displayBuild(e.buildVersion)}</td>
                    <td className={`${tdCls} tabular-nums text-emerald-700`}>{e.passed}</td>
                    <td className={`${tdCls} tabular-nums ${e.failed > 0 ? 'text-red-700 font-medium' : 'text-slate-400'}`}>{e.failed}</td>
                    <td className={`${tdCls} tabular-nums text-slate-400`}>{skip}</td>
                    <td className={`${tdCls} tabular-nums text-slate-700`}>{total}</td>
                    <td className="px-3 py-1.5 whitespace-nowrap">
                      <Button size="sm" variant="secondary" onClick={() => router.push(openHref(e, openSystemId))}>
                        <ExternalLink className="h-3.5 w-3.5" />Open
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </main>
      </div>
    </div>
  );
}

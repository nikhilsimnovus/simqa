// Run History — one timeline of every execution across every test surface.
//
// Data comes from /api/history, which reads BOTH the unified historyStore
// (data/history/*.json) AND the per-surface stores that predate it
// (data/runs/*.json, data/config-fidelity/*/report.json, …) — without that
// fold-in the older config-fidelity and end-to-end runs vanish from the page.
//
// Layout note: the header, the filter bar and the table's column headings all
// stay put while only the rows scroll. That is done with three separate
// sticky layers rather than a fixed-height scroll pane, so the table still
// behaves normally at any window size.

'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Header } from '@/components/Header';
import { Button } from '@/components/ui';
import { ExternalLink } from 'lucide-react';

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
// the Surface dropdown. Any OTHER surface present in the data (the bulk-*
// sweeps, build-check, perf-qa) is appended to the dropdown at runtime rather
// than hidden — those rows still show under "All", and a filter you cannot
// select is worse than one extra option.
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

/** "27 Aug 2026, 10:30 AM" */
function formatExecutedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const date = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  return `${date}, ${time}`;
}

/** Bare version, so a row written as "4.0.0_x (Build y)" by automation-suite
 *  renders the same as one written as "4.0.0_x" by the newer surfaces. */
function displayBuild(raw?: string): string {
  if (!raw) return '—';
  const m = raw.match(/^([^\s(]+)/);
  return m ? m[1] : raw;
}

/** Where Open should land: the surface's own result view, scoped to this run.
 *  `from=runs` tells the destination to render a "Back to Run History" link. */
function openHref(e: HistoryEntry): string {
  const runId = e.meta?.runId ?? e.id;
  const q = (extra: string) => `${extra}${extra.includes('?') ? '&' : '?'}from=runs&run=${encodeURIComponent(runId)}`;
  switch (e.surface) {
    case 'api-tests':        return q('/api-tests');
    case 'ui-tests':         return q('/ui-tests');
    case 'automation-suite': return q(e.meta?.suiteId ? `/automation-suite?suite=${encodeURIComponent(e.meta.suiteId)}` : '/automation-suite');
    case 'config-fidelity':  return q('/config-fidelity');
    case 'end-to-end':       return q(e.meta?.testcaseId ? `/testcases/${encodeURIComponent(e.meta.testcaseId)}` : '/testcases');
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

  const load = async () => {
    try {
      const r = await fetch('/api/history?limit=500', { cache: 'no-store' });
      const d = await r.json();
      if (!d.ok) { setError(d.error ?? 'fetch failed'); return; }
      setEntries(d.entries ?? []);
      setError('');
    } catch (e: any) { setError(e?.message ?? String(e)); }
  };

  useEffect(() => {
    load();
    // A run finishing elsewhere should appear without a manual refresh.
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  // Simnovator systems, for the System dropdown and for mapping the older
  // rows (which recorded only targetSystemId) onto a host so they filter too.
  useEffect(() => {
    fetch('/api/ui-tests/systems')
      .then((r) => r.json())
      .then((j) => setSystems(((j.systems ?? []) as TestSystem[]).filter((s) => s.type === 'SIMNOVATOR' || s.type === 'SIMNOVATOR_GUI')))
      .catch(() => setSystems([]));
  }, []);

  const hostForSystemId = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of systems) m.set(s.id, s.host);
    return m;
  }, [systems]);

  /** A row's host: recorded directly on newer rows, resolved via inventory for
   *  older ones that only carry targetSystemId. */
  const hostOf = (e: HistoryEntry): string | undefined =>
    e.targetHost ?? (e.targetSystemId ? hostForSystemId.get(e.targetSystemId) : undefined);

  const surfaceOptions = useMemo(() => {
    const known = new Set(PRIMARY_SURFACES.map((s) => s.value));
    const extra = Array.from(new Set((entries ?? []).map((e) => e.surface)))
      .filter((s) => !known.has(s))
      .sort()
      .map((s) => ({ value: s, label: SURFACE_LABELS[s] ?? s }));
    return [...PRIMARY_SURFACES, ...extra];
  }, [entries]);

  const systemOptions = useMemo(() => {
    const hosts = new Set<string>(systems.map((s) => s.host));
    for (const e of entries ?? []) { const h = hostOf(e); if (h) hosts.add(h); }
    return Array.from(hosts).sort();
  }, [systems, entries, hostForSystemId]);

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

  const buildOptions = useMemo(
    () => Array.from(new Set(beforeBuild.map((e) => displayBuild(e.buildVersion)).filter((b) => b !== '—'))).sort().reverse(),
    [beforeBuild],
  );

  // A build that is no longer reachable under the current Surface/System/time
  // selection must not keep silently filtering everything out.
  useEffect(() => {
    if (buildFilter && !buildOptions.includes(buildFilter)) setBuildFilter('');
  }, [buildOptions, buildFilter]);

  const filtered = useMemo(
    () => (buildFilter ? beforeBuild.filter((e) => displayBuild(e.buildVersion) === buildFilter) : beforeBuild),
    [beforeBuild, buildFilter],
  );

  const selectCls = 'h-8 rounded-md border border-slate-300 bg-white px-2 text-xs text-slate-900 min-w-[150px]';
  const labelCls = 'text-[10px] font-medium uppercase tracking-wider text-slate-400 mb-1';

  return (
    <>
      <Header
        title="Run History"
        subtitle="Track every test run in one place — Test Cases, Automation Suite, API Tests, UI Tests and Config Fidelity. Click any row to open the full result."
      />

      {/* Filter bar. top-14 clears the 14-unit-tall sticky Header above it. */}
      <div className="sticky top-14 z-10 bg-slate-50/95 backdrop-blur border-b border-slate-200 px-6 py-2.5">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col">
            <span className={labelCls}>Surface</span>
            <select value={surfaceFilter} onChange={(e) => setSurfaceFilter(e.target.value)} className={selectCls}>
              <option value="">All</option>
              {surfaceOptions.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </label>

          <label className="flex flex-col">
            <span className={labelCls}>System</span>
            <select value={systemFilter} onChange={(e) => setSystemFilter(e.target.value)} className={selectCls}>
              <option value="">All</option>
              {systemOptions.map((h) => <option key={h} value={h}>{h}</option>)}
            </select>
          </label>

          <label className="flex flex-col">
            <span className={labelCls}>Execution</span>
            <select value={execFilter} onChange={(e) => setExecFilter(e.target.value as ExecutionWindow)} className={selectCls}>
              {EXECUTION_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>

          {execFilter === 'custom' ? (
            <div className="flex items-end gap-2">
              <label className="flex flex-col">
                <span className={labelCls}>From</span>
                <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} className="h-8 rounded-md border border-slate-300 bg-white px-2 text-xs" />
              </label>
              <label className="flex flex-col">
                <span className={labelCls}>To</span>
                <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} className="h-8 rounded-md border border-slate-300 bg-white px-2 text-xs" />
              </label>
            </div>
          ) : null}

          <label className="flex flex-col">
            <span className={labelCls}>Build</span>
            {/* list-backed input: type to narrow, or pick from the builds the
                current Surface/System/time selection actually contains. */}
            <input
              list="run-history-builds"
              value={buildFilter}
              onChange={(e) => setBuildFilter(e.target.value)}
              placeholder={buildOptions.length ? 'All' : 'No builds recorded'}
              className="h-8 rounded-md border border-slate-300 bg-white px-2 text-xs min-w-[190px]"
            />
            <datalist id="run-history-builds">
              {buildOptions.map((b) => <option key={b} value={b} />)}
            </datalist>
          </label>
        </div>
      </div>

      <main className="px-6 py-3">
        {error ? <div className="mb-3 p-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded">{error}</div> : null}

        <div className="border border-slate-200 rounded-lg bg-white overflow-hidden">
          <table className="min-w-full text-xs">
            {/* top-[6.5rem] parks the column headings directly beneath the
                Header + filter bar, so only rows travel under them. */}
            <thead className="sticky top-[6.5rem] z-[9] bg-slate-50 text-slate-500 border-b border-slate-200">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Surface</th>
                <th className="px-3 py-2 text-left font-medium">Execution Time-Date</th>
                <th className="px-3 py-2 text-left font-medium">System</th>
                <th className="px-3 py-2 text-left font-medium">Build</th>
                <th className="px-3 py-2 text-right font-medium">Pass</th>
                <th className="px-3 py-2 text-right font-medium">Fail</th>
                <th className="px-3 py-2 text-right font-medium">Skip</th>
                <th className="px-3 py-2 text-right font-medium">Total</th>
                <th className="px-3 py-2 text-right font-medium">Preview</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {entries == null ? (
                <tr><td colSpan={9} className="px-3 py-6 text-slate-500">Loading…</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={9} className="px-3 py-6 text-slate-500">
                  {entries.length === 0
                    ? 'No runs recorded yet. Run an API sweep, a UI sweep, an automation suite, a config-fidelity matrix or a test case validation — each one lands here.'
                    : 'No runs match the current filters.'}
                </td></tr>
              ) : filtered.map((e) => {
                const skip = e.skipped ?? 0;
                // Total is defined as Pass + Fail + Skip rather than echoing the
                // stored total: surfaces disagree on whether `total` counts
                // skips, and a row whose columns do not add up reads as a bug.
                const total = e.passed + e.failed + skip;
                const host = hostOf(e);
                return (
                  <tr key={e.id} className="hover:bg-slate-50">
                    <td className="px-3 py-1.5 whitespace-nowrap">
                      <span className={`inline-block text-[10px] font-medium rounded border px-1.5 py-0.5 ${SURFACE_TONE[e.surface] ?? 'bg-slate-100 text-slate-600 border-slate-200'}`}>
                        {SURFACE_LABELS[e.surface] ?? e.surface}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 whitespace-nowrap text-slate-700" title={e.label}>{formatExecutedAt(e.startedAt)}</td>
                    <td className="px-3 py-1.5 whitespace-nowrap font-mono text-[11px] text-slate-600">{host ?? '—'}</td>
                    <td className="px-3 py-1.5 whitespace-nowrap font-mono text-[11px] text-slate-600" title={e.buildVersion}>{displayBuild(e.buildVersion)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-emerald-700">{e.passed}</td>
                    <td className={`px-3 py-1.5 text-right tabular-nums ${e.failed > 0 ? 'text-red-700 font-medium' : 'text-slate-400'}`}>{e.failed}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-slate-400">{skip}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-slate-700">{total}</td>
                    <td className="px-3 py-1.5 text-right">
                      <Button size="sm" variant="secondary" onClick={() => router.push(openHref(e))}>
                        <ExternalLink className="h-3.5 w-3.5" />Open
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </main>
    </>
  );
}

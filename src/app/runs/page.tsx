// Unified run history — every surface (bulk-tests, API/UI sweeps, config
// fidelity, automation suite, end-to-end, …) writes a row here when a
// run completes. This page is the one place QA can see "everything
// that's ever run against any lab" with click-through to per-surface
// detail.
//
// Data comes from /api/history which reads BOTH the new historyStore
// (data/history/*.json) AND legacy data/runs/*.json — without that
// fold-in the original config-fidelity / end-to-end runs would
// silently vanish from the page.

'use client';

import { useEffect, useMemo, useState } from 'react';

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

const SURFACE_LABELS: Record<string, string> = {
  'bulk-generate':    'Bulk Gen',
  'bulk-validate':    'Bulk Val',
  'bulk-validate-ui': 'Bulk Val-UI',
  'bulk-execute':     'Bulk Exec',
  'api-tests':        'API Sweep',
  'ui-tests':         'UI Sweep',
  'config-fidelity':  'Config Fid',
  'automation-suite': 'Automation',
  'end-to-end':       'End-to-end',
  'build-check':      'Build Check',
  'perf-qa':          'Perf QA',
};

const SURFACE_COLOR: Record<string, string> = {
  'bulk-generate':    'bg-orange-100 text-orange-800',
  'bulk-validate':    'bg-blue-100 text-blue-800',
  'bulk-validate-ui': 'bg-purple-100 text-purple-800',
  'bulk-execute':     'bg-emerald-100 text-emerald-800',
  'api-tests':        'bg-sky-100 text-sky-800',
  'ui-tests':         'bg-fuchsia-100 text-fuchsia-800',
  'config-fidelity':  'bg-amber-100 text-amber-800',
  'automation-suite': 'bg-indigo-100 text-indigo-800',
  'end-to-end':       'bg-slate-200 text-slate-800',
  'build-check':      'bg-teal-100 text-teal-800',
  'perf-qa':          'bg-rose-100 text-rose-800',
};

export default function RunsPage() {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [surfaceFilter, setSurfaceFilter] = useState<string>('');
  const [systemFilter, setSystemFilter] = useState<string>('');
  const [search, setSearch] = useState<string>('');
  const [error, setError] = useState<string>('');

  const load = async () => {
    try {
      const r = await fetch('/api/history?limit=500', { cache: 'no-store' });
      const d = await r.json();
      if (!d.ok) { setError(d.error ?? 'fetch failed'); return; }
      setEntries(d.entries ?? []);
    } catch (e: any) { setError(e?.message ?? String(e)); }
  };

  // Pre-set the surface filter from a ?surface= URL param so the
  // "Past runs →" links on the bulk-tests / config-fidelity pages land
  // already scoped to that surface.
  useEffect(() => {
    try {
      const sp = new URLSearchParams(window.location.search).get('surface');
      if (sp) setSurfaceFilter(sp);
    } catch { /* SSR / no window */ }
  }, []);

  useEffect(() => { load(); }, []);
  // Poll every 5s so a run completing elsewhere shows up here without a
  // manual refresh. Cheap — bytes are small + the file glob is fast.
  useEffect(() => {
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  const surfaces = useMemo(() => Array.from(new Set((entries ?? []).map(e => e.surface))).sort(), [entries]);
  const systems  = useMemo(() => Array.from(new Set((entries ?? []).map(e => e.targetSystemId).filter((s): s is string => !!s))).sort(), [entries]);

  const filtered = useMemo(() => {
    if (!entries) return [];
    const q = search.trim().toLowerCase();
    return entries.filter(e => {
      if (surfaceFilter && e.surface !== surfaceFilter) return false;
      if (systemFilter && e.targetSystemId !== systemFilter) return false;
      if (q) {
        const hay = `${e.label} ${e.targetSystemId ?? ''} ${e.targetHost ?? ''} ${e.buildVersion ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [entries, surfaceFilter, systemFilter, search]);

  const totals = useMemo(() => {
    let pass = 0, fail = 0, total = 0;
    for (const e of filtered) { pass += e.passed; fail += e.failed; total += e.total; }
    return { pass, fail, total };
  }, [filtered]);

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="max-w-7xl mx-auto px-6 py-8">
        <header className="mb-6">
          <h1 className="text-2xl font-bold text-slate-900">Run History</h1>
          <p className="text-sm text-slate-600 mt-1">
            Every run from every surface — bulk-tests, API sweeps, UI sweeps, config-fidelity, automation-suite, end-to-end. Click a row to open the surface's full result.
          </p>
        </header>

        {/* Controls */}
        <section className="bg-white border border-slate-200 rounded-xl p-4 mb-4 flex flex-wrap items-end gap-3">
          <label className="flex flex-col">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Surface</span>
            <select value={surfaceFilter} onChange={e => setSurfaceFilter(e.target.value)} className="border border-slate-300 rounded-md px-3 py-1.5 text-sm min-w-[180px]">
              <option value="">All</option>
              {surfaces.map(s => <option key={s} value={s}>{SURFACE_LABELS[s] ?? s}</option>)}
            </select>
          </label>
          <label className="flex flex-col">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Target system</span>
            <select value={systemFilter} onChange={e => setSystemFilter(e.target.value)} className="border border-slate-300 rounded-md px-3 py-1.5 text-sm min-w-[180px]">
              <option value="">All</option>
              {systems.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label className="flex flex-col flex-1 min-w-[220px]">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Search</span>
            <input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="label / host / build…" className="border border-slate-300 rounded-md px-3 py-1.5 text-sm" />
          </label>
          <div className="text-xs text-slate-500 ml-auto">
            <span className="font-medium text-slate-700">{filtered.length}</span> rows · {totals.pass} pass / {totals.fail} fail across {totals.total} tests
            {entries && entries.length !== filtered.length && <> (filtered from {entries.length})</>}
          </div>
        </section>

        {/* Table */}
        <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          {error && <div className="m-3 p-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded">{error}</div>}
          {entries == null ? (
            <div className="p-6 text-sm text-slate-500">Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="p-6 text-sm text-slate-500">
              {entries.length === 0
                ? 'No runs yet. Trigger an API sweep, bulk-validate, or automation suite — they\'ll show up here.'
                : 'No rows match the current filters.'}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-xs">
                <thead className="bg-slate-50 text-slate-600 text-left">
                  <tr>
                    <th className="px-3 py-2 font-medium">When</th>
                    <th className="px-3 py-2 font-medium">Surface</th>
                    <th className="px-3 py-2 font-medium">Label</th>
                    <th className="px-3 py-2 font-medium">Target</th>
                    <th className="px-3 py-2 font-medium">Build</th>
                    <th className="px-3 py-2 font-medium text-right">Pass</th>
                    <th className="px-3 py-2 font-medium text-right">Fail</th>
                    <th className="px-3 py-2 font-medium text-right">Skip</th>
                    <th className="px-3 py-2 font-medium text-right">Total</th>
                    <th className="px-3 py-2 font-medium">Detail</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filtered.map(e => {
                    const passPct = e.total > 0 ? Math.round((e.passed / e.total) * 100) : 0;
                    return (
                      <tr key={e.id} className="hover:bg-slate-50">
                        <td className="px-3 py-1.5 font-mono text-[10px] text-slate-500 whitespace-nowrap">
                          {e.startedAt.slice(0, 19).replace('T', ' ')}
                        </td>
                        <td className="px-3 py-1.5">
                          <span className={`text-[10px] uppercase tracking-wider rounded px-1.5 py-0.5 font-semibold ${SURFACE_COLOR[e.surface] ?? 'bg-slate-100 text-slate-700'}`}>
                            {SURFACE_LABELS[e.surface] ?? e.surface}
                          </span>
                        </td>
                        <td className="px-3 py-1.5 max-w-md truncate" title={e.label}>{e.label}</td>
                        <td className="px-3 py-1.5 font-mono text-[10px] text-slate-600 whitespace-nowrap">
                          {e.targetSystemId ?? '–'}{e.targetHost ? ` · ${e.targetHost}` : ''}
                        </td>
                        <td className="px-3 py-1.5 font-mono text-[10px] text-slate-500 truncate max-w-[160px]" title={e.buildVersion}>
                          {e.buildVersion ?? '–'}
                        </td>
                        <td className={`px-3 py-1.5 text-right font-mono ${e.passed === e.total && e.total > 0 ? 'text-emerald-700 font-semibold' : 'text-slate-700'}`}>{e.passed}</td>
                        <td className={`px-3 py-1.5 text-right font-mono ${e.failed > 0 ? 'text-red-700 font-semibold' : 'text-slate-500'}`}>{e.failed}</td>
                        <td className="px-3 py-1.5 text-right font-mono text-slate-500">{e.skipped ?? '–'}</td>
                        <td className="px-3 py-1.5 text-right font-mono text-slate-500">{e.total} <span className="text-slate-400">({passPct}%)</span></td>
                        <td className="px-3 py-1.5 font-mono text-[10px] text-slate-500 truncate max-w-[260px]" title={e.detailPath}>{e.detailPath ?? '–'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

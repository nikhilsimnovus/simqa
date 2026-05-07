'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Header } from '@/components/Header';
import { Card, CardBody, CardHeader, CardTitle, Button, Badge, Input } from '@/components/ui';
import {
  CheckCircle2, XCircle, Loader2, MousePointerClick, ChevronRight, ChevronDown,
  Filter, Download, AlertTriangle, Circle, Square, Play, RotateCcw,
  Eye, Globe, ShieldCheck, Activity, Search,
} from 'lucide-react';

type Category = 'auth' | 'navigation' | 'testcases' | 'stats' | 'logs' | 'simulators' | 'users' | 'tools' | 'security' | 'errors' | 'patterns' | 'lifecycle' | 'perf' | 'compat' | 'field-band';

interface CatalogEntry {
  number: number;
  id: string;
  name: string;
  description: string;
  category: Category;
  severity: 'critical' | 'normal' | 'optional';
  needsAuth: boolean;
  longRunning: boolean;
}

interface UiTestResult extends CatalogEntry {
  ok: boolean;
  skipped?: boolean;
  skippedReason?: string;
  detail?: string;
  expected?: string;
  durationMs?: number;
  finalUrl?: string;
  consoleErrorCount?: number;
  networkRequestCount?: number;
  evidence?: { screenshotFile?: string; networkFile?: string; consoleFile?: string; downloadFile?: string; videoFile?: string; traceFile?: string };
  ranAt?: string;
}

interface BaselineDiff {
  baselineId: string;
  baselineRunDir?: string;
  baselineFinishedAt?: string;
  regressions: Array<{ id: string; name: string; severity: string; previousDetail?: string; currentDetail?: string }>;
  fixes: Array<{ id: string; name: string; severity: string }>;
  unchangedFailures: Array<{ id: string; name: string; severity: string }>;
  newTests: Array<{ id: string; name: string; ok: boolean }>;
  removedTests: Array<{ id: string; name: string }>;
}

interface BaselineSummary {
  id: string; savedAt: string; finishedAt: string; total: number; passed: number; failed: number;
}

interface RunResponse {
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  runDir: string;
  counts: { total: number; passed: number; failed: number; skipped: number };
  results: UiTestResult[];
  diff?: BaselineDiff;
}

type RunProfile = 'smoke' | 'regression' | 'full' | 'custom';

interface RunStatus {
  running: boolean;
  targetSystemId?: string;
  targetHost?: string;
  targetName?: string;
  startedAt?: string;
  totalPlanned?: number;
  completed?: number;
  currentTestId?: string;
  /** All currently-active runs across every target host. */
  runs?: RunStatus[];
}

interface TestSystem {
  id: string;
  name: string;
  host: string;
  type: string;
}

const CATEGORY_META: Record<Category, { label: string; color: string }> = {
  'auth':       { label: 'Authentication',      color: 'bg-violet-100 text-violet-800 border-violet-200' },
  'navigation': { label: 'Navigation',          color: 'bg-sky-100 text-sky-800 border-sky-200' },
  'testcases':  { label: 'Test Cases',          color: 'bg-blue-100 text-blue-800 border-blue-200' },
  'stats':      { label: 'Statistics',          color: 'bg-cyan-100 text-cyan-800 border-cyan-200' },
  'logs':       { label: 'Logs',                color: 'bg-emerald-100 text-emerald-800 border-emerald-200' },
  'simulators': { label: 'Simulators',          color: 'bg-teal-100 text-teal-800 border-teal-200' },
  'users':      { label: 'Users',               color: 'bg-fuchsia-100 text-fuchsia-800 border-fuchsia-200' },
  'tools':      { label: 'Tools',               color: 'bg-pink-100 text-pink-800 border-pink-200' },
  'security':   { label: 'Security',            color: 'bg-rose-100 text-rose-800 border-rose-200' },
  'errors':     { label: 'Errors / network',    color: 'bg-orange-100 text-orange-800 border-orange-200' },
  'patterns':   { label: 'Patterns',            color: 'bg-amber-100 text-amber-800 border-amber-200' },
  'lifecycle':  { label: 'Lifecycle (E2E)',     color: 'bg-indigo-100 text-indigo-800 border-indigo-200' },
  'perf':       { label: 'Performance',         color: 'bg-yellow-100 text-yellow-800 border-yellow-200' },
  'compat':     { label: 'Cross-browser',       color: 'bg-slate-100 text-slate-800 border-slate-200' },
  'field-band': { label: 'Band → ARFCN',         color: 'bg-emerald-100 text-emerald-800 border-emerald-200' },
};

const DEFAULT_CATEGORIES: Category[] = (Object.keys(CATEGORY_META) as Category[]);

type StatusFilter = 'all' | 'failed' | 'passed' | 'pending';

export default function UiTestsPage() {
  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null);
  const [enabled, setEnabled] = useState<Set<Category>>(new Set(DEFAULT_CATEGORIES));
  const [headless, setHeadless] = useState(true);
  const [profile, setProfile] = useState<RunProfile>('full');
  const [concurrency, setConcurrency] = useState(1);
  const [busy, setBusy] = useState(false);
  const [singleRunningId, setSingleRunningId] = useState<string | null>(null);
  const [data, setData] = useState<RunResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [runStatus, setRunStatus] = useState<RunStatus>({ running: false });
  const pollerRef = useRef<NodeJS.Timeout | null>(null);
  const [baselines, setBaselines] = useState<BaselineSummary[] | null>(null);
  const [activeBaseline, setActiveBaseline] = useState<string>('');
  const [savingBaseline, setSavingBaseline] = useState(false);
  const [systems, setSystems] = useState<TestSystem[] | null>(null);
  const [targetSystemId, setTargetSystemId] = useState<string>('');
  const [otherActiveRuns, setOtherActiveRuns] = useState<RunStatus[]>([]);

  // Profile presets
  const profileSeverity: Record<RunProfile, ('critical' | 'normal' | 'optional')[] | null> = {
    smoke:      ['critical'],
    regression: ['critical', 'normal'],
    full:       null,
    custom:     null,
  };

  // Load static catalog
  useEffect(() => {
    fetch('/api/ui-tests/catalog').then((r) => r.json()).then((j) => setCatalog(j.tests)).catch(() => setCatalog([]));
  }, []);

  // Load baselines list
  const refreshBaselines = async () => {
    try {
      const r = await fetch('/api/ui-tests/baselines'); const j = await r.json();
      setBaselines(j.baselines ?? []);
    } catch { setBaselines([]); }
  };
  useEffect(() => { refreshBaselines(); }, []);

  // Load testable systems from inventory + restore last-used target from localStorage
  useEffect(() => {
    fetch('/api/ui-tests/systems').then((r) => r.json()).then((j) => {
      setSystems(j.systems ?? []);
      const stored = (typeof window !== 'undefined' ? localStorage.getItem('simqa-target-system') : null) ?? '';
      const valid = (j.systems ?? []).find((s: TestSystem) => s.id === stored);
      if (valid) setTargetSystemId(valid.id);
      else if ((j.systems ?? []).length > 0) setTargetSystemId(j.systems[0].id);
    }).catch(() => setSystems([]));
  }, []);

  useEffect(() => {
    if (typeof window !== 'undefined' && targetSystemId) localStorage.setItem('simqa-target-system', targetSystemId);
  }, [targetSystemId]);

  // Poll /status. When busy: tight 1.5s. Always: 5s for cross-target awareness.
  useEffect(() => {
    const interval = busy ? 1500 : 5000;
    const tick = async () => {
      try {
        const url = busy && targetSystemId ? `/api/ui-tests/status?targetHost=${encodeURIComponent(systems?.find((s) => s.id === targetSystemId)?.host ?? '')}` : '/api/ui-tests/status';
        const r = await fetch(url, { cache: 'no-store' });
        if (r.ok) {
          const j = await r.json();
          setRunStatus(j);
          // Surface OTHER teammates' runs (different host than ours)
          const myHost = systems?.find((s) => s.id === targetSystemId)?.host;
          const others = (j.runs ?? []).filter((r: RunStatus) => r.targetHost !== myHost);
          setOtherActiveRuns(others);
        }
      } catch { /* keep last state */ }
    };
    tick();
    pollerRef.current = setInterval(tick, interval);
    return () => {
      if (pollerRef.current) { clearInterval(pollerRef.current); pollerRef.current = null; }
    };
  }, [busy, targetSystemId, systems]);

  function toggle(c: Category) {
    const next = new Set(enabled);
    next.has(c) ? next.delete(c) : next.add(c);
    setEnabled(next);
  }
  const selectAll = () => setEnabled(new Set(Object.keys(CATEGORY_META) as Category[]));
  const clearAll = () => setEnabled(new Set());

  async function run(opts?: { onlyId?: string; idsToRun?: string[] }) {
    setBusy(true); setErr(null);
    if (!opts?.onlyId && !opts?.idsToRun) { setData(null); setExpanded(new Set()); }
    if (opts?.onlyId) setSingleRunningId(opts.onlyId);
    try {
      const body: any = { headless, categories: Array.from(enabled), concurrency };
      const sevFilter = profileSeverity[profile];
      if (sevFilter) body.severityFilter = sevFilter;
      if (activeBaseline) body.baselineId = activeBaseline;
      if (opts?.onlyId) body.onlyId = opts.onlyId;
      if (opts?.idsToRun && opts.idsToRun.length > 0) body.idsToRun = opts.idsToRun;
      if (targetSystemId) body.targetSystemId = targetSystemId;
      const r = await fetch('/api/ui-tests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const text = await r.text();
      if (!r.ok)         { setErr(`server returned ${r.status} ${r.statusText}: ${text.slice(0, 400)}`); return; }
      if (!text)         { setErr(`server returned an empty body (${r.status}). The run may have crashed or timed out.`); return; }
      let j: RunResponse;
      try { j = JSON.parse(text) as RunResponse; } catch { setErr(`server returned non-JSON (${r.status}). First 300 chars: ${text.slice(0, 300)}`); return; }
      if (!j.results)    { setErr(`server returned JSON without a results array. Body: ${JSON.stringify(j).slice(0, 400)}`); return; }
      if (opts?.onlyId && data) {
        // Merge single-run result back into existing results
        const existingResults = [...data.results];
        for (const r of j.results) {
          const idx = existingResults.findIndex((x) => x.id === r.id);
          if (idx >= 0) existingResults[idx] = r; else existingResults.push(r);
        }
        const updatedCounts = {
          total: existingResults.length,
          passed: existingResults.filter((r) => r.ok && !r.skipped).length,
          failed: existingResults.filter((r) => !r.ok && !r.skipped).length,
          skipped: existingResults.filter((r) => r.skipped).length,
        };
        setData({ ...data, results: existingResults, counts: updatedCounts, finishedAt: j.finishedAt, runDir: j.runDir });
      } else {
        setData(j);
        setExpanded(new Set(j.results.filter((x) => !x.ok).map((x) => x.id)));
      }
    } catch (e: any) {
      setErr(`fetch failed: ${e?.message ?? String(e)}`);
    } finally {
      setBusy(false);
      setSingleRunningId(null);
      setRunStatus({ running: false });
    }
  }

  async function stopRun() {
    try {
      // Abort only the run on MY target host - don't kill other teammates' runs.
      const myHost = systems?.find((s) => s.id === targetSystemId)?.host;
      const url = myHost ? `/api/ui-tests/abort?targetHost=${encodeURIComponent(myHost)}` : '/api/ui-tests/abort';
      const r = await fetch(url, { method: 'POST' });
      if (!r.ok && r.status !== 404) setErr(`abort returned ${r.status}`);
    } catch (e: any) {
      setErr(`abort failed: ${e?.message ?? String(e)}`);
    }
  }

  async function rerunFailures() {
    if (!data) return;
    const failedIds = data.results.filter((r) => !r.ok && !r.skipped).map((r) => r.id);
    if (failedIds.length === 0) return;
    await run({ idsToRun: failedIds });
  }

  async function saveAsBaseline() {
    if (!data?.runDir) return;
    const id = window.prompt('Baseline id (e.g., 4.0.0-260428):', `build-${new Date().toISOString().slice(0, 10)}`);
    if (!id) return;
    setSavingBaseline(true);
    try {
      const r = await fetch('/api/ui-tests/baselines', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, runDir: data.runDir }),
      });
      const j = await r.json();
      if (!j.ok) setErr(`Save baseline failed: ${j.message}`);
      else { await refreshBaselines(); setActiveBaseline(j.path ? id.replace(/[^A-Za-z0-9_.-]/g, '_') : id); }
    } finally {
      setSavingBaseline(false);
    }
  }

  async function deleteBaselineFn(id: string) {
    if (!window.confirm(`Delete baseline "${id}"?`)) return;
    await fetch(`/api/ui-tests/baselines/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await refreshBaselines();
    if (activeBaseline === id) setActiveBaseline('');
  }

  // Switch profile -> auto-adjust enabled categories where appropriate
  function applyProfile(p: RunProfile) {
    setProfile(p);
    if (p !== 'custom') {
      // Smoke / Regression / Full: enable ALL categories (severityFilter does the trimming)
      setEnabled(new Set(Object.keys(CATEGORY_META) as Category[]));
    }
  }

  // Compose the display rows: post-run results overlaid on catalog (so unrun rows show as pending)
  type Row = (CatalogEntry & { state: 'pending' }) | (UiTestResult & { state: 'pass' | 'fail' | 'skip' });
  const rows: Row[] = useMemo(() => {
    if (!catalog) return [];
    if (!data) return catalog.filter((c) => enabled.has(c.category)).map((c) => ({ ...c, state: 'pending' as const }));
    // After a run, build a map of results
    const byId = new Map(data.results.map((r) => [r.id, r]));
    return catalog.filter((c) => enabled.has(c.category)).map((c) => {
      const r = byId.get(c.id);
      if (!r) return { ...c, state: 'pending' as const };
      return { ...r, state: r.skipped ? 'skip' as const : (r.ok ? 'pass' as const : 'fail' as const) };
    });
  }, [data, catalog, enabled]);

  const visible = useMemo(() => {
    const ql = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (statusFilter === 'failed' && r.state !== 'fail') return false;
      if (statusFilter === 'passed' && r.state !== 'pass') return false;
      if (statusFilter === 'pending' && r.state !== 'pending') return false;
      if (ql) {
        const hay = `${r.id} ${r.name} ${r.description ?? ''} ${r.category} ${(r as any).detail ?? ''}`.toLowerCase();
        if (!hay.includes(ql)) return false;
      }
      return true;
    });
  }, [rows, statusFilter, search]);

  function toggleExpand(id: string) {
    const next = new Set(expanded);
    next.has(id) ? next.delete(id) : next.add(id);
    setExpanded(next);
  }

  function evidenceUrl(runDir: string, testId: string, file?: string): string | null {
    if (!file) return null;
    const runName = runDir.split(/[/\\]/).pop()!;
    return `/api/ui-tests/evidence/${encodeURIComponent(runName)}/${encodeURIComponent(testId)}/${encodeURIComponent(file)}`;
  }

  function downloadAll() {
    if (!data) return;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `simqa-ui-results-${data.finishedAt.replace(/[:.]/g, '-')}.json`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  // Counts for header stats (driven by the visible/data state)
  const counts = useMemo(() => {
    const total = rows.length;
    const passed = rows.filter((r) => r.state === 'pass').length;
    const failed = rows.filter((r) => r.state === 'fail').length;
    const pending = rows.filter((r) => r.state === 'pending').length;
    const passRate = total > 0 ? (passed / total) * 100 : 0;
    return { total, passed, failed, pending, passRate };
  }, [rows]);

  const selectedCount = useMemo(() => {
    if (!catalog) return 0;
    return catalog.filter((t) => enabled.has(t.category)).length;
  }, [catalog, enabled]);

  const progressPct = runStatus.running && runStatus.totalPlanned
    ? Math.round((runStatus.completed ?? 0) / runStatus.totalPlanned * 100)
    : 0;

  return (
    <>
      <Header
        title="UI Tests"
        subtitle="Browser-driven validation of the Simnovator management UI"
        right={
          <div className="flex items-center gap-2">
            {data && data.counts.failed > 0 ? (
              <Button size="sm" variant="secondary" onClick={rerunFailures} disabled={busy}>
                <RotateCcw className="h-4 w-4" />Re-run failures ({data.counts.failed})
              </Button>
            ) : null}
            {data ? (
              <Button size="sm" variant="secondary" onClick={downloadAll}>
                <Download className="h-4 w-4" />Export JSON
              </Button>
            ) : null}
            {busy ? (
              <Button size="sm" variant="secondary" onClick={stopRun} className="!bg-red-600 !text-white !border-red-600 hover:!bg-red-700">
                <Square className="h-4 w-4 fill-current" />Stop
              </Button>
            ) : (
              <Button size="sm" onClick={() => run()} disabled={selectedCount === 0}>
                <MousePointerClick className="h-4 w-4" />Run {selectedCount > 0 ? `(${selectedCount})` : ''}
              </Button>
            )}
          </div>
        }
      />

      {/* Live progress bar shown only while a run is active */}
      {busy ? (
        <div className="px-6 -mt-1">
          <div className="rounded-md border border-primary-200 bg-primary-50 px-4 py-2">
            <div className="flex items-center justify-between text-xs text-primary-900">
              <div className="flex items-center gap-2">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span className="font-medium">{singleRunningId ? `Running ${singleRunningId}` : 'Running suite'}</span>
                {runStatus.totalPlanned ? <span className="text-primary-700">— {runStatus.completed ?? 0} of {runStatus.totalPlanned} done</span> : null}
                {runStatus.currentTestId ? <span className="text-primary-700 font-mono">[{runStatus.currentTestId}]</span> : null}
              </div>
              {runStatus.startedAt ? (
                <span className="text-primary-700 tabular-nums">
                  {Math.round((Date.now() - new Date(runStatus.startedAt).getTime()) / 1000)}s elapsed
                </span>
              ) : null}
            </div>
            <div className="mt-2 h-1.5 rounded-full bg-primary-100 overflow-hidden">
              <div
                className="h-full rounded-full bg-primary-600 transition-all duration-300"
                style={{ width: progressPct ? `${progressPct}%` : undefined }}
              >
                {!progressPct ? <div className="h-full w-full bg-gradient-to-r from-primary-400 via-primary-600 to-primary-400 animate-pulse" /> : null}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <main className="p-6 grid grid-cols-1 lg:grid-cols-4 gap-4">
        {/* Sidebar */}
        <aside className="lg:col-span-1 space-y-4">
          <Card>
            <CardHeader><CardTitle>Test target</CardTitle></CardHeader>
            <CardBody className="space-y-2 text-sm">
              {!systems ? (
                <div className="text-xs text-slate-500">Loading systems…</div>
              ) : systems.length === 0 ? (
                <div className="text-xs text-red-700">No UESIM/CALLBOX systems in inventory.yaml.</div>
              ) : (
                <select
                  value={targetSystemId}
                  onChange={(e) => setTargetSystemId(e.target.value)}
                  disabled={busy}
                  className="w-full text-xs border border-slate-300 rounded px-2 py-1.5 bg-white"
                >
                  {systems.map((s) => (
                    <option key={s.id} value={s.id}>{s.name} ({s.host}) · {s.type}</option>
                  ))}
                </select>
              )}
              {otherActiveRuns.length > 0 ? (
                <div className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1.5 mt-2">
                  <div className="font-medium mb-0.5 flex items-center gap-1">
                    <Activity className="h-3 w-3 animate-pulse" />
                    {otherActiveRuns.length} other run{otherActiveRuns.length === 1 ? '' : 's'} in progress
                  </div>
                  {otherActiveRuns.slice(0, 4).map((r) => (
                    <div key={r.targetHost} className="flex items-center justify-between gap-2">
                      <span className="truncate">{r.targetName} ({r.targetHost})</span>
                      <span className="text-amber-600 tabular-nums">{r.completed ?? 0}/{r.totalPlanned ?? 0}</span>
                    </div>
                  ))}
                </div>
              ) : null}
              <div className="text-[11px] text-slate-500 leading-relaxed pt-1">
                Different teammates can target different boxes in parallel. Same box queues.
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader className="flex items-center justify-between">
              <CardTitle>Categories</CardTitle>
              <div className="flex items-center gap-1">
                <button onClick={selectAll}  className="text-[11px] px-2 py-0.5 rounded border border-slate-300 bg-white text-slate-700 hover:bg-slate-50">Select all</button>
                <button onClick={clearAll}   className="text-[11px] px-2 py-0.5 rounded border border-slate-300 bg-white text-slate-700 hover:bg-slate-50">Clear</button>
              </div>
            </CardHeader>
            <CardBody className="space-y-1">
              {(Object.entries(CATEGORY_META) as Array<[Category, { label: string; color: string }]>).map(([c, meta]) => {
                const total = catalog?.filter((t) => t.category === c).length ?? 0;
                const checked = enabled.has(c);
                return (
                  <label
                    key={c}
                    className={
                      'flex items-center gap-2 text-sm px-2 py-1.5 rounded-md cursor-pointer transition-colors ' +
                      (checked ? 'bg-slate-50 hover:bg-slate-100' : 'hover:bg-slate-50')
                    }
                  >
                    <input type="checkbox" checked={checked} onChange={() => toggle(c)} className="accent-primary-600" />
                    <span className="flex-1 text-slate-700">{meta.label}</span>
                    <span className={'text-[10px] tabular-nums px-1.5 py-0.5 rounded border ' + meta.color}>{total}</span>
                  </label>
                );
              })}
              <div className="text-[11px] text-slate-500 pt-2 mt-1 border-t border-slate-100 flex items-center justify-between">
                <span>{selectedCount} tests selected</span>
                <span className="text-slate-400">{catalog?.length ?? '?'} total</span>
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader><CardTitle>Profile</CardTitle></CardHeader>
            <CardBody className="space-y-2 text-sm">
              {([
                { id: 'smoke',      label: 'Smoke',       hint: 'critical only · ~3 min' },
                { id: 'regression', label: 'Regression',  hint: 'critical + normal · ~15 min' },
                { id: 'full',       label: 'Full',        hint: 'all 156 tests · ~25 min' },
                { id: 'custom',     label: 'Custom',      hint: 'pick categories below' },
              ] as Array<{ id: RunProfile; label: string; hint: string }>).map((p) => (
                <label key={p.id} className={'flex items-start gap-2 px-2 py-1.5 rounded-md cursor-pointer ' + (profile === p.id ? 'bg-primary-50 border border-primary-200' : 'hover:bg-slate-50 border border-transparent')}>
                  <input type="radio" name="profile" checked={profile === p.id} onChange={() => applyProfile(p.id)} className="accent-primary-600 mt-0.5" />
                  <div className="flex-1">
                    <div className="font-medium text-slate-900">{p.label}</div>
                    <div className="text-[11px] text-slate-500">{p.hint}</div>
                  </div>
                </label>
              ))}
            </CardBody>
          </Card>

          <Card>
            <CardHeader><CardTitle>Options</CardTitle></CardHeader>
            <CardBody className="space-y-2 text-sm">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={headless} onChange={(e) => setHeadless(e.target.checked)} className="accent-primary-600" />
                Headless (uncheck to watch)
              </label>
              <label className="flex items-center gap-2">
                <span className="text-slate-700">Concurrency:</span>
                <select value={concurrency} onChange={(e) => setConcurrency(Number(e.target.value))} className="text-xs border border-slate-300 rounded px-1.5 py-0.5">
                  <option value={1}>1 (sequential)</option>
                  <option value={2}>2 workers</option>
                  <option value={3}>3 workers</option>
                  <option value={4}>4 workers (~5× speedup)</option>
                </select>
              </label>
              <div className="text-[11px] text-slate-500 pt-1 leading-relaxed">
                Lifecycle / destructive tests always run sequentially. Higher concurrency speeds up read-only categories.
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader className="flex items-center justify-between">
              <CardTitle>Baseline</CardTitle>
              {data ? (
                <button onClick={saveAsBaseline} disabled={savingBaseline} className="text-[11px] px-2 py-0.5 rounded border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                  {savingBaseline ? 'Saving…' : 'Save current run'}
                </button>
              ) : null}
            </CardHeader>
            <CardBody className="space-y-2 text-sm">
              <select
                value={activeBaseline}
                onChange={(e) => setActiveBaseline(e.target.value)}
                className="w-full text-xs border border-slate-300 rounded px-2 py-1"
              >
                <option value="">— compare against — (none)</option>
                {(baselines ?? []).map((b) => (
                  <option key={b.id} value={b.id}>{b.id} ({b.passed}/{b.total} pass · {new Date(b.savedAt).toLocaleDateString()})</option>
                ))}
              </select>
              {activeBaseline ? (
                <button onClick={() => deleteBaselineFn(activeBaseline)} className="text-[11px] text-red-600 hover:text-red-700">
                  Delete this baseline
                </button>
              ) : null}
              <div className="text-[11px] text-slate-500 leading-relaxed">
                Pick a baseline → next run shows a diff banner: regressions, fixes, still-failing.
              </div>
            </CardBody>
          </Card>
        </aside>

        {/* Main column */}
        <section className="lg:col-span-3 space-y-4">
          {err ? (
            <Card>
              <CardBody>
                <div className="flex items-start gap-3">
                  <AlertTriangle className="h-5 w-5 text-red-600 mt-0.5 flex-shrink-0" />
                  <div className="text-sm text-red-700 break-all">{err}</div>
                </div>
              </CardBody>
            </Card>
          ) : null}

          {/* Baseline diff banner */}
          {data?.diff ? (
            <Card>
              <CardBody>
                <div className="flex items-start gap-3">
                  <div className="flex-shrink-0 mt-0.5">
                    {data.diff.regressions.length > 0 ? <XCircle className="h-5 w-5 text-red-600" /> :
                     data.diff.fixes.length > 0      ? <CheckCircle2 className="h-5 w-5 text-emerald-600" /> :
                                                       <Activity className="h-5 w-5 text-slate-500" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-slate-900">
                      Compared to baseline <span className="font-mono text-primary-700">{data.diff.baselineId}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-3 mt-1.5 text-xs">
                      <span className="inline-flex items-center gap-1 text-red-700"><span className="inline-block h-2 w-2 rounded-full bg-red-600" />{data.diff.regressions.length} regression{data.diff.regressions.length === 1 ? '' : 's'}</span>
                      <span className="inline-flex items-center gap-1 text-emerald-700"><span className="inline-block h-2 w-2 rounded-full bg-emerald-600" />{data.diff.fixes.length} fix{data.diff.fixes.length === 1 ? '' : 'es'}</span>
                      <span className="inline-flex items-center gap-1 text-amber-700"><span className="inline-block h-2 w-2 rounded-full bg-amber-500" />{data.diff.unchangedFailures.length} still failing</span>
                      <span className="inline-flex items-center gap-1 text-sky-700"><span className="inline-block h-2 w-2 rounded-full bg-sky-500" />{data.diff.newTests.length} new test{data.diff.newTests.length === 1 ? '' : 's'}</span>
                      {data.diff.removedTests.length > 0 ? <span className="text-slate-500">· {data.diff.removedTests.length} removed</span> : null}
                    </div>
                    {data.diff.regressions.length > 0 ? (
                      <div className="mt-3 space-y-1">
                        <div className="text-[11px] uppercase tracking-wide font-semibold text-red-700">Regressions (PASS → FAIL)</div>
                        {data.diff.regressions.slice(0, 8).map((r) => (
                          <div key={r.id} className="text-xs flex items-center gap-2">
                            <span className="text-red-600">→</span>
                            <span className="font-medium text-slate-900">{r.name}</span>
                            <span className="text-slate-500">·</span>
                            <button onClick={() => run({ onlyId: r.id })} disabled={busy} className="text-[11px] text-primary-600 hover:text-primary-700 disabled:opacity-50">re-run</button>
                          </div>
                        ))}
                        {data.diff.regressions.length > 8 ? <div className="text-[11px] text-slate-500">… +{data.diff.regressions.length - 8} more</div> : null}
                      </div>
                    ) : null}
                    {data.diff.fixes.length > 0 ? (
                      <div className="mt-3 space-y-1">
                        <div className="text-[11px] uppercase tracking-wide font-semibold text-emerald-700">Fixed (FAIL → PASS)</div>
                        {data.diff.fixes.slice(0, 5).map((r) => (
                          <div key={r.id} className="text-xs flex items-center gap-2">
                            <span className="text-emerald-600">✓</span>
                            <span className="font-medium text-slate-900">{r.name}</span>
                          </div>
                        ))}
                        {data.diff.fixes.length > 5 ? <div className="text-[11px] text-slate-500">… +{data.diff.fixes.length - 5} more</div> : null}
                      </div>
                    ) : null}
                  </div>
                </div>
              </CardBody>
            </Card>
          ) : null}

          {/* Modern stat cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatCard label="Total"   value={counts.total}   icon={<Activity className="h-4 w-4" />}      tone="slate" />
            <StatCard label="Passed"  value={counts.passed}  icon={<CheckCircle2 className="h-4 w-4" />}  tone="emerald" />
            <StatCard label="Failed"  value={counts.failed}  icon={<XCircle className="h-4 w-4" />}        tone="red" />
            <StatCard label="Pending" value={counts.pending} icon={<Circle className="h-4 w-4" />}         tone="amber" />
          </div>

          {/* Pass-rate bar (only after a run) */}
          {data ? (
            <Card>
              <CardBody>
                <div className="flex items-center justify-between text-xs text-slate-600 mb-2">
                  <span>Pass rate</span>
                  <span className="font-mono tabular-nums text-slate-900">{counts.passRate.toFixed(1)}%</span>
                </div>
                <div className="h-2 rounded-full bg-slate-100 overflow-hidden flex">
                  <div className="h-full bg-emerald-500 transition-all" style={{ width: `${counts.passed / Math.max(counts.total, 1) * 100}%` }} />
                  <div className="h-full bg-red-500 transition-all" style={{ width: `${counts.failed / Math.max(counts.total, 1) * 100}%` }} />
                  <div className="h-full bg-amber-300 transition-all" style={{ width: `${counts.pending / Math.max(counts.total, 1) * 100}%` }} />
                </div>
                <div className="flex items-center gap-4 mt-2 text-[11px] text-slate-500">
                  <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />passed {counts.passed}</span>
                  <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full bg-red-500" />failed {counts.failed}</span>
                  <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full bg-amber-300" />pending {counts.pending}</span>
                  {data.runDir ? <span className="ml-auto text-slate-400 font-mono">{data.runDir.split(/[/\\]/).pop()}</span> : null}
                </div>
              </CardBody>
            </Card>
          ) : null}

          {/* Filter / search bar */}
          <Card>
            <CardBody className="flex flex-wrap items-center gap-2">
              <Filter className="h-4 w-4 text-slate-500" />
              {(['all', 'failed', 'passed', 'pending'] as const).map((s) => {
                const n = s === 'all' ? rows.length : s === 'failed' ? counts.failed : s === 'passed' ? counts.passed : counts.pending;
                const active = statusFilter === s;
                const tone = s === 'failed' ? 'data-failed' : s === 'passed' ? 'data-passed' : '';
                return (
                  <button
                    key={s}
                    onClick={() => setStatusFilter(s)}
                    data-active={active}
                    className={
                      'px-3 h-8 text-xs rounded-full border transition-all ' +
                      (active
                        ? (s === 'failed' ? 'bg-red-600 text-white border-red-600 shadow-sm' :
                           s === 'passed' ? 'bg-emerald-600 text-white border-emerald-600 shadow-sm' :
                           s === 'pending' ? 'bg-amber-500 text-white border-amber-500 shadow-sm' :
                           'bg-slate-900 text-white border-slate-900 shadow-sm')
                        : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50')
                    }
                  >
                    {s.charAt(0).toUpperCase() + s.slice(1)} ({n})
                  </button>
                );
              })}
              <div className="ml-auto relative w-72">
                <Search className="h-3.5 w-3.5 absolute left-2.5 top-2.5 text-slate-400 pointer-events-none" />
                <input
                  className="w-full pl-8 pr-3 h-8 text-xs rounded-md border border-slate-300 bg-white text-slate-700 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-300"
                  placeholder="Search id, name, description, detail…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
            </CardBody>
          </Card>

          {/* Test rows */}
          <Card>
            <CardBody className="p-0">
              <ul className="divide-y divide-slate-100">
                {visible.map((r) => {
                  const expandable = r.state !== 'pending';
                  const dr = r as UiTestResult & { state: 'pass' | 'fail' | 'skip' };
                  const meta = CATEGORY_META[r.category];
                  const isSingleRunning = singleRunningId === r.id;
                  return (
                    <li key={r.id} className={
                      'group px-5 py-3 transition-colors ' +
                      (r.state === 'fail' ? 'hover:bg-red-50/40' : r.state === 'pass' ? 'hover:bg-emerald-50/40' : 'hover:bg-slate-50/60')
                    }>
                      <div className="flex items-start gap-3">
                        <span className="mt-0.5 inline-flex items-center justify-center min-w-[2.5rem] h-6 px-2 rounded-md bg-slate-100 text-slate-700 text-xs font-mono tabular-nums">
                          #{r.number}
                        </span>
                        <span className="mt-0.5">
                          {isSingleRunning ? <Loader2 className="h-4 w-4 text-primary-600 animate-spin" /> :
                           r.state === 'pending' ? <Circle className="h-4 w-4 text-slate-300" /> :
                           r.state === 'skip'    ? <Loader2 className="h-4 w-4 text-slate-400" /> :
                           r.state === 'pass'    ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> :
                                                   <XCircle className="h-4 w-4 text-red-600" />}
                        </span>
                        <button
                          onClick={() => expandable && toggleExpand(r.id)}
                          className={'flex-1 min-w-0 text-left ' + (expandable ? 'cursor-pointer' : 'cursor-default')}
                          disabled={!expandable}
                        >
                          <div className="flex flex-wrap items-center gap-2 text-sm">
                            {expandable ? (expanded.has(r.id) ? <ChevronDown className="h-3 w-3 text-slate-400" /> : <ChevronRight className="h-3 w-3 text-slate-400" />) : null}
                            <span className="font-medium text-slate-900">{r.name}</span>
                            <span className={'text-[10px] px-1.5 py-0.5 rounded border ' + meta.color}>{meta.label}</span>
                            <span className={
                              'text-[10px] px-1.5 py-0.5 rounded border ' +
                              (r.severity === 'critical' ? 'bg-red-50 text-red-700 border-red-200' :
                               r.severity === 'normal'   ? 'bg-amber-50 text-amber-700 border-amber-200' :
                                                            'bg-slate-50 text-slate-600 border-slate-200')
                            }>{r.severity}</span>
                            <StatePill state={r.state} />
                            {r.state !== 'pending' && (dr.consoleErrorCount ?? 0) > 0 ? (
                              <span className="inline-flex items-center gap-1 text-[10px] text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded border border-amber-200">
                                <AlertTriangle className="h-3 w-3" /> {dr.consoleErrorCount} console err
                              </span>
                            ) : null}
                          </div>
                          <div className="text-xs text-slate-600 mt-1 leading-relaxed">{r.description}</div>
                          {r.state !== 'pending' && dr.detail ? (
                            <div className="text-[11px] text-slate-500 mt-1 break-all leading-relaxed">↳ {dr.detail}</div>
                          ) : null}
                        </button>

                        <div className="flex items-center gap-1 self-start">
                          {r.state !== 'pending' ? (
                            <span className="text-[11px] text-slate-400 tabular-nums whitespace-nowrap">{dr.durationMs ?? 0}ms</span>
                          ) : null}
                          <button
                            onClick={() => run({ onlyId: r.id })}
                            disabled={busy}
                            title={`Run only #${r.number} ${r.id}`}
                            className={
                              'inline-flex items-center justify-center h-7 w-7 rounded-md border ' +
                              (busy
                                ? 'bg-slate-100 text-slate-400 border-slate-200 cursor-not-allowed'
                                : 'bg-white text-primary-700 border-slate-300 hover:bg-primary-50 hover:border-primary-300 transition-colors opacity-0 group-hover:opacity-100')
                            }
                          >
                            <Play className="h-3.5 w-3.5 fill-current" />
                          </button>
                        </div>
                      </div>

                      {/* Expanded evidence panel */}
                      {expandable && expanded.has(r.id) ? (
                        <div className="mt-3 ml-12 space-y-3">
                          {dr.expected && r.state === 'fail' ? (
                            <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                              <div className="font-medium mb-1 flex items-center gap-1.5"><Eye className="h-3 w-3" />Expected</div>
                              <div className="leading-relaxed">{dr.expected}</div>
                            </div>
                          ) : null}

                          {dr.evidence?.screenshotFile && data ? (
                            <div className="rounded-lg border border-slate-200 overflow-hidden bg-white">
                              <div className="px-3 py-2 bg-slate-50 border-b border-slate-200 text-xs font-medium text-slate-700 flex items-center gap-2">
                                <Eye className="h-3 w-3" />Final-state screenshot
                                <span className="ml-auto text-[10px] text-slate-500 font-mono">{dr.evidence.screenshotFile}</span>
                              </div>
                              <div className="bg-slate-100">
                                <img
                                  src={evidenceUrl(data.runDir, r.id, dr.evidence.screenshotFile)!}
                                  alt={`${r.id} screenshot`}
                                  className="block max-w-full cursor-zoom-in"
                                  onClick={(e) => window.open((e.currentTarget as HTMLImageElement).src, '_blank')}
                                />
                              </div>
                            </div>
                          ) : null}

                          <div className="flex flex-wrap items-center gap-2 text-xs">
                            {dr.evidence?.networkFile && data ? <EvidenceLink href={evidenceUrl(data.runDir, r.id, dr.evidence.networkFile)!} label="network.json" icon={<Globe className="h-3 w-3" />} /> : null}
                            {dr.evidence?.consoleFile && data ? <EvidenceLink href={evidenceUrl(data.runDir, r.id, dr.evidence.consoleFile)!} label="console-errors.txt" icon={<AlertTriangle className="h-3 w-3" />} /> : null}
                            {dr.evidence?.downloadFile && data ? <EvidenceLink href={evidenceUrl(data.runDir, r.id, dr.evidence.downloadFile)!} label={dr.evidence.downloadFile} icon={<Download className="h-3 w-3" />} /> : null}
                            {dr.evidence?.videoFile && data ? <EvidenceLink href={evidenceUrl(data.runDir, r.id, dr.evidence.videoFile)!} label="video.webm" icon={<Eye className="h-3 w-3" />} /> : null}
                            {dr.evidence?.traceFile && data ? (
                              <a href={`https://trace.playwright.dev/?trace=${encodeURIComponent((typeof window !== 'undefined' ? window.location.origin : '') + evidenceUrl(data.runDir, r.id, dr.evidence.traceFile)!)}`} target="_blank" rel="noreferrer"
                                 className="inline-flex items-center gap-1.5 px-2 py-1 rounded border border-purple-300 bg-purple-50 hover:bg-purple-100 text-purple-800 transition-colors">
                                <Activity className="h-3 w-3" /><span>trace.zip</span>
                              </a>
                            ) : null}
                            <button
                              onClick={() => run({ onlyId: r.id })}
                              disabled={busy}
                              className="inline-flex items-center gap-1 px-2 py-1 rounded border border-primary-300 bg-primary-50 text-primary-800 hover:bg-primary-100 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              <RotateCcw className="h-3 w-3" />Re-run this test
                            </button>
                            <span className="ml-auto text-[11px] text-slate-400">
                              {dr.finalUrl ? <>final url: <span className="font-mono">{dr.finalUrl}</span> · </> : null}
                              {dr.networkRequestCount} requests · {dr.consoleErrorCount} console errors
                            </span>
                          </div>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
                {visible.length === 0 ? (
                  <li className="px-5 py-12 text-center">
                    <div className="text-sm text-slate-500">No tests match the current filter.</div>
                    <button onClick={() => { setStatusFilter('all'); setSearch(''); }} className="text-xs text-primary-600 hover:text-primary-700 mt-1">Clear filters</button>
                  </li>
                ) : null}
              </ul>
            </CardBody>
          </Card>
        </section>
      </main>
    </>
  );
}

// ---- Inline components ----

function StatCard({ label, value, icon, tone }: { label: string; value: number; icon: React.ReactNode; tone: 'slate' | 'emerald' | 'red' | 'amber' }) {
  const styles: Record<typeof tone, string> = {
    slate:   'bg-white border-slate-200 text-slate-900',
    emerald: 'bg-emerald-50 border-emerald-200 text-emerald-900',
    red:     'bg-red-50 border-red-200 text-red-900',
    amber:   'bg-amber-50 border-amber-200 text-amber-900',
  };
  const iconTone: Record<typeof tone, string> = {
    slate:   'text-slate-500',
    emerald: 'text-emerald-600',
    red:     'text-red-600',
    amber:   'text-amber-600',
  };
  return (
    <div className={`rounded-lg border p-4 ${styles[tone]}`}>
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-wide font-medium opacity-75">{label}</span>
        <span className={iconTone[tone]}>{icon}</span>
      </div>
      <div className="text-3xl font-bold tabular-nums mt-1">{value}</div>
    </div>
  );
}

function StatePill({ state }: { state: 'pass' | 'fail' | 'skip' | 'pending' }) {
  if (state === 'pass') return <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold bg-emerald-600 text-white">PASS</span>;
  if (state === 'fail') return <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold bg-red-600 text-white">FAIL</span>;
  if (state === 'skip') return <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold bg-amber-500 text-white">SKIP</span>;
  return <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold bg-slate-200 text-slate-600">not run</span>;
}

function EvidenceLink({ href, label, icon }: { href: string; label: string; icon: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 px-2 py-1 rounded border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 transition-colors">
      {icon}<span>{label}</span>
    </a>
  );
}

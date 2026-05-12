'use client';

// Run & validate tab — lets the user pick a testcase on a selected
// Simnovator system, kick off an end-to-end validation run, and watch
// every check pass/fail live.
//
// Mirrors the live-progress pattern from /ui-tests: while the run is in
// flight we poll /api/end-to-end/status every 1.5s and merge results into
// the catalog rows so cards flip from PENDING → RUNNING → PASS/FAIL in
// real time.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Card, CardBody, CardHeader, CardTitle, Button } from '@/components/ui';
import {
  Play, Square, RefreshCw, Loader2, CheckCircle2, XCircle, Circle, AlertTriangle, Activity,
  Server, FlaskConical, Search,
} from 'lucide-react';

interface TestSystem { id: string; name: string; host: string; type: string }
interface TestcaseSummary {
  id: string;
  name: string;
  description?: string;
  lastExecutedOn?: string;
  lastResult?: string;
  lastExecutionId?: string;
  simulatorName?: string;
}

type CheckStatus = 'pending' | 'running' | 'pass' | 'fail' | 'skip';
interface CheckRow {
  id: string;
  name: string;
  phase: 'preflight' | 'trigger' | 'during' | 'completion' | 'post';
  severity: 'critical' | 'normal' | 'optional';
  description: string;
  status: CheckStatus;
  detail?: string;
  skippedReason?: string;
  durationMs?: number;
}

interface RunStatus {
  running: boolean;
  runId?: string;
  systemHost?: string;
  testcaseId?: string;
  executionId?: string;
  startedAt?: string;
  phase?: string;
  checks?: CheckRow[];
  counts?: { total: number; passed: number; failed: number; skipped: number; pending: number };
  ok?: boolean;
  finishedAt?: string;
  finalDetail?: string;
}

export function RunValidateTab() {
  // ── Picker state ──
  const [systems, setSystems] = useState<TestSystem[] | null>(null);
  const [systemId, setSystemId] = useState('');
  const [testcases, setTestcases] = useState<TestcaseSummary[] | null>(null);
  const [tcLoading, setTcLoading] = useState(false);
  const [tcErr, setTcErr] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [pickMode, setPickMode] = useState<'list' | 'last'>('list');
  const [testcaseId, setTestcaseId] = useState('');

  // ── Run state ──
  const [running, setRunning] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [status, setStatus] = useState<RunStatus | null>(null);
  const [startErr, setStartErr] = useState<string | null>(null);
  const pollerRef = useRef<NodeJS.Timeout | null>(null);

  // ── Load systems on mount ──
  useEffect(() => {
    fetch('/api/ui-tests/systems').then((r) => r.json()).then((j) => {
      const list: TestSystem[] = j.systems ?? [];
      setSystems(list);
      const stored = typeof window !== 'undefined' ? localStorage.getItem('simqa-end-to-end-system') : null;
      const valid = list.find((s) => s.id === stored);
      if (valid) setSystemId(valid.id);
      else if (list.length > 0) setSystemId(list[0].id);
    }).catch(() => setSystems([]));
  }, []);

  useEffect(() => {
    if (typeof window !== 'undefined' && systemId) localStorage.setItem('simqa-end-to-end-system', systemId);
  }, [systemId]);

  // ── Load testcases when system changes ──
  useEffect(() => {
    if (!systemId) { setTestcases(null); return; }
    setTcLoading(true); setTcErr(null);
    const q = search ? `&search=${encodeURIComponent(search)}` : '';
    fetch(`/api/end-to-end/testcases?systemId=${encodeURIComponent(systemId)}${q}`)
      .then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`); return j; })
      .then((j) => setTestcases(j.items ?? []))
      .catch((e) => { setTestcases([]); setTcErr(String(e?.message ?? e)); })
      .finally(() => setTcLoading(false));
  }, [systemId, search]);

  // ── Polling loop while running ──
  useEffect(() => {
    if (!running || !runId) {
      if (pollerRef.current) { clearInterval(pollerRef.current); pollerRef.current = null; }
      return;
    }
    const tick = async () => {
      try {
        const r = await fetch(`/api/end-to-end/status?runId=${encodeURIComponent(runId)}`, { cache: 'no-store' });
        const j: RunStatus = await r.json();
        setStatus(j);
        if (!j.running && j.runId) {
          setRunning(false);
        }
      } catch { /* swallow */ }
    };
    tick();
    pollerRef.current = setInterval(tick, 1500);
    return () => { if (pollerRef.current) { clearInterval(pollerRef.current); pollerRef.current = null; } };
  }, [running, runId]);

  // ── Actions ──
  async function startRun() {
    if (!systemId) return;
    setStartErr(null); setStatus(null);
    try {
      const body: any = { systemId };
      if (pickMode === 'last') body.useLastExecution = true;
      else if (testcaseId) body.testcaseId = testcaseId;
      else { setStartErr('Pick a testcase or switch to "Use last execution"'); return; }
      const r = await fetch('/api/end-to-end/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) { setStartErr(j.error || `HTTP ${r.status}`); return; }
      setRunId(j.runId);
      setRunning(true);
    } catch (e: any) {
      setStartErr(e?.message ?? String(e));
    }
  }

  async function abortRun() {
    if (!runId) return;
    try {
      await fetch(`/api/end-to-end/abort?runId=${encodeURIComponent(runId)}`, { method: 'POST' });
    } catch { /* swallow */ }
  }

  const selectedTc = useMemo(
    () => testcases?.find((t) => t.id === testcaseId),
    [testcases, testcaseId],
  );

  // ── Render ──
  return (
    <main className="flex-1 overflow-y-auto p-6 space-y-6 bg-slate-50">

      {/* ── Card 1: Target + testcase picker ──────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FlaskConical className="h-4 w-4 text-primary-600" />
            Pick a testcase to validate
          </CardTitle>
        </CardHeader>
        <CardBody className="space-y-4">

          {/* System picker */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-700 flex items-center gap-1.5">
              <Server className="h-3.5 w-3.5" /> Target system
            </label>
            {systems === null ? (
              <div className="text-xs text-slate-500 flex items-center gap-1.5 h-9 px-3"><Loader2 className="h-3 w-3 animate-spin" /> loading…</div>
            ) : systems.length === 0 ? (
              <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">No UESIM-capable systems in inventory.yaml.</div>
            ) : (
              <select
                value={systemId}
                onChange={(e) => { setSystemId(e.target.value); setTestcaseId(''); }}
                className="w-full md:w-[420px] border border-slate-300 rounded-md px-3 py-2 text-sm bg-white text-slate-700"
              >
                {systems.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.host}) — {s.type}</option>)}
              </select>
            )}
          </div>

          {/* Mode selector */}
          <div className="flex items-center gap-4 pt-1">
            <label className="flex items-center gap-1.5 text-xs cursor-pointer">
              <input type="radio" checked={pickMode === 'list'} onChange={() => setPickMode('list')} />
              Pick from list
            </label>
            <label className="flex items-center gap-1.5 text-xs cursor-pointer">
              <input type="radio" checked={pickMode === 'last'} onChange={() => setPickMode('last')} />
              Use last execution on this system
            </label>
          </div>

          {/* Testcase list */}
          {pickMode === 'list' ? (
            <div className="space-y-2">
              <div className="relative w-full md:w-[420px]">
                <Search className="h-3.5 w-3.5 absolute left-2.5 top-2.5 text-slate-400 pointer-events-none" />
                <input
                  className="w-full pl-8 pr-3 h-8 text-xs rounded-md border border-slate-300 bg-white text-slate-700 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-300"
                  placeholder="Search testcases by id / name…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              {tcLoading ? (
                <div className="text-xs text-slate-500 flex items-center gap-1.5"><Loader2 className="h-3 w-3 animate-spin" /> loading testcases from {systemId}…</div>
              ) : tcErr ? (
                <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">{tcErr}</div>
              ) : !testcases || testcases.length === 0 ? (
                <div className="text-xs text-slate-500 bg-slate-100 border border-slate-200 rounded px-3 py-2">No testcases on this system{search ? ` match "${search}"` : ''}.</div>
              ) : (
                <div className="rounded-lg border border-slate-200 bg-white max-h-72 overflow-y-auto">
                  <ul className="divide-y divide-slate-100">
                    {testcases.slice(0, 100).map((t) => (
                      <li key={t.id}>
                        <button
                          onClick={() => setTestcaseId(t.id)}
                          className={
                            'block w-full text-left px-3 py-2 text-xs hover:bg-slate-50 transition-colors ' +
                            (testcaseId === t.id ? 'bg-primary-50' : '')
                          }
                        >
                          <div className="flex items-center gap-2">
                            <input type="radio" checked={testcaseId === t.id} onChange={() => setTestcaseId(t.id)} className="pointer-events-none" />
                            <div className="font-medium text-slate-900">{t.name}</div>
                            {t.lastResult ? (
                              <span className={
                                'text-[10px] px-1 rounded ' +
                                (t.lastResult === 'PASS' ? 'bg-emerald-100 text-emerald-800' :
                                 t.lastResult === 'FAIL' ? 'bg-red-100 text-red-800' :
                                                            'bg-slate-100 text-slate-700')
                              }>{t.lastResult}</span>
                            ) : null}
                          </div>
                          <div className="text-[11px] text-slate-500 mt-0.5 font-mono">{t.id}</div>
                          {t.lastExecutedOn ? (
                            <div className="text-[10px] text-slate-400 mt-0.5">last run: {t.lastExecutedOn}{t.simulatorName ? ` · ${t.simulatorName}` : ''}</div>
                          ) : null}
                        </button>
                      </li>
                    ))}
                  </ul>
                  {testcases.length > 100 ? (
                    <div className="px-3 py-2 text-[10px] text-slate-400 border-t border-slate-100">Showing first 100. Refine search to see more.</div>
                  ) : null}
                </div>
              )}
            </div>
          ) : (
            <div className="text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded px-3 py-2">
              Runner will find the most recently executed testcase on {systemId} and re-run it.
            </div>
          )}

          {/* Selected testcase summary + Validate button */}
          <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-slate-100">
            <Button
              onClick={startRun}
              disabled={running || !systemId || (pickMode === 'list' && !testcaseId)}
              className="bg-primary-600 hover:bg-primary-700 text-white"
            >
              {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4 fill-current" />}
              <span className="ml-1.5">{running ? 'Running…' : 'Validate'}</span>
            </Button>
            {running ? (
              <Button onClick={abortRun} variant="secondary">
                <Square className="h-4 w-4" />
                <span className="ml-1.5">Stop</span>
              </Button>
            ) : null}
            {selectedTc && pickMode === 'list' ? (
              <span className="text-xs text-slate-500">→ <span className="font-mono">{selectedTc.id}</span></span>
            ) : null}
          </div>

          {startErr ? (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 flex gap-2">
              <AlertTriangle className="h-3.5 w-3.5 mt-0.5 flex-none" /><div>{startErr}</div>
            </div>
          ) : null}

          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-900 leading-relaxed flex gap-2">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 flex-none" />
            <div>
              <span className="font-semibold">Heads-up:</span> validation runs <em>actually execute</em> the testcase on the target system —
              it's not a dry-run. Allow up to ~{(((selectedTc?.lastExecutedOn) ? 60 : 60))}s + the testcase's configured duration before reporting back.
            </div>
          </div>
        </CardBody>
      </Card>

      {/* ── Card 2: Live progress / report ──────────────── */}
      {status ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-primary-600" />
              {status.running ? 'Running…' : (status.ok ? 'Validation passed' : 'Validation failed')}
            </CardTitle>
          </CardHeader>
          <CardBody className="space-y-3">
            {/* Counts */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
              <CountTile label="Total"   value={status.counts?.total   ?? 0} tone="slate" />
              <CountTile label="Passed"  value={status.counts?.passed  ?? 0} tone="emerald" />
              <CountTile label="Failed"  value={status.counts?.failed  ?? 0} tone="red" />
              <CountTile label="Skipped" value={status.counts?.skipped ?? 0} tone="amber" />
              <CountTile label="Pending" value={status.counts?.pending ?? 0} tone="slate" />
            </div>

            {status.executionId ? (
              <div className="text-[11px] text-slate-500 font-mono">executionId={status.executionId}</div>
            ) : null}
            {status.finalDetail ? (
              <div className={
                'rounded-md border px-3 py-2 text-xs leading-relaxed ' +
                (status.ok
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                  : 'border-red-200 bg-red-50 text-red-700')
              }>
                {status.finalDetail}
              </div>
            ) : null}

            {/* Per-check rows */}
            <ul className="divide-y divide-slate-100 border border-slate-200 rounded-lg overflow-hidden bg-white">
              {(status.checks ?? []).map((c) => <CheckRow key={c.id} row={c} />)}
            </ul>
          </CardBody>
        </Card>
      ) : null}
    </main>
  );
}

function CountTile({ label, value, tone }: { label: string; value: number; tone: 'slate' | 'emerald' | 'red' | 'amber' }) {
  const tones: Record<typeof tone, string> = {
    slate:   'border-slate-200 bg-white text-slate-900',
    emerald: 'border-emerald-200 bg-emerald-50 text-emerald-900',
    red:     'border-red-200 bg-red-50 text-red-700',
    amber:   'border-amber-200 bg-amber-50 text-amber-800',
  };
  return (
    <div className={'rounded-lg border px-3 py-2 ' + tones[tone]}>
      <div className="text-[10px] uppercase tracking-wider opacity-70">{label}</div>
      <div className="text-xl font-bold tabular-nums">{value}</div>
    </div>
  );
}

function CheckRow({ row }: { row: CheckRow }) {
  const sevTone: Record<CheckRow['severity'], string> = {
    critical: 'bg-red-50 text-red-700 border-red-200',
    normal:   'bg-amber-50 text-amber-700 border-amber-200',
    optional: 'bg-slate-50 text-slate-600 border-slate-200',
  };
  const phaseTone: Record<CheckRow['phase'], string> = {
    preflight:  'bg-sky-100 text-sky-800',
    trigger:    'bg-purple-100 text-purple-800',
    during:     'bg-blue-100 text-blue-800',
    completion: 'bg-indigo-100 text-indigo-800',
    post:       'bg-slate-100 text-slate-700',
  };
  const icon =
    row.status === 'running' ? <Loader2 className="h-4 w-4 text-primary-600 animate-spin" /> :
    row.status === 'pending' ? <Circle   className="h-4 w-4 text-slate-300" /> :
    row.status === 'pass'    ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> :
    row.status === 'skip'    ? <Loader2 className="h-4 w-4 text-slate-400" /> :
                                <XCircle className="h-4 w-4 text-red-600" />;
  return (
    <li className={
      'px-3 py-2 ' +
      (row.status === 'fail'    ? 'bg-red-50/30' :
       row.status === 'pass'    ? 'bg-emerald-50/30' :
       row.status === 'running' ? 'bg-primary-50/40' : '')
    }>
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5">{icon}</span>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-1.5 text-sm">
            <span className="font-medium text-slate-900">{row.name}</span>
            <span className={'text-[9px] px-1.5 rounded ' + phaseTone[row.phase]}>{row.phase}</span>
            <span className={'text-[9px] px-1.5 rounded border ' + sevTone[row.severity]}>{row.severity}</span>
            {row.status === 'pass' ? <span className="text-[10px] px-1.5 rounded bg-emerald-600 text-white font-semibold">PASS</span> : null}
            {row.status === 'fail' ? <span className="text-[10px] px-1.5 rounded bg-red-600 text-white font-semibold">FAIL</span> : null}
            {row.status === 'skip' ? <span className="text-[10px] px-1.5 rounded bg-amber-500 text-white font-semibold">SKIP</span> : null}
            {row.status === 'running' ? <span className="text-[10px] px-1.5 rounded bg-primary-600 text-white font-semibold animate-pulse">RUNNING</span> : null}
          </div>
          <div className="text-[11px] text-slate-600 mt-0.5 leading-relaxed">{row.description}</div>
          {row.detail ? <div className="text-[11px] text-slate-500 mt-0.5 break-all">↳ {row.detail}</div> : null}
          {row.skippedReason ? <div className="text-[11px] text-amber-700 mt-0.5">skipped: {row.skippedReason}</div> : null}
        </div>
        {row.durationMs !== undefined ? (
          <span className="text-[10px] text-slate-400 tabular-nums">{row.durationMs}ms</span>
        ) : null}
      </div>
    </li>
  );
}

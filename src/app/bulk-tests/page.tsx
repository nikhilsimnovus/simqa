// /bulk-tests — driver page for the 500+ testcase generator.
//
// Flow the user takes here:
//   1. Pick a target system (defaults to sys-6 / 10.202).
//   2. Click "Generate" → POST /api/bulk-tests/generate, then poll status.
//      Once it finishes, the page shows the manifest (created + failures).
//   3. Click "Validate (API)" → POST /api/bulk-tests/validate, poll until
//      the per-testcase verdict grid is populated.
//   4. Click "Cleanup" → POST /api/bulk-tests/cleanup to delete every
//      qa-bulk-tagged testcase from the box.

'use client';

import { useEffect, useState } from 'react';

interface SystemSummary {
  id: string;
  name: string;
  host: string;
}

interface Progress {
  startedAt: string;
  finishedAt?: string;
  total: number;
  done: number;
  passed: number;
  failed: number;
  skipped?: number;
  currentName?: string;
  aborted?: boolean;
}

interface Created { id: string; name: string; boxId: string; rat: string; category: string }
interface FailureRow { id: string; name: string; step: string; status: number; message: string }
interface SkipRow { id: string; name: string; reason: string }

interface GenResult {
  startedAt: string;
  finishedAt: string;
  targetHost: string;
  total: number; passed: number; failed: number; skipped: number;
  created: Created[];
  failures: FailureRow[];
  skips: SkipRow[];
}

interface ValStep { step: string; ok: boolean; status: number; durationMs: number; detail?: string }
interface ValRow { id: string; boxId: string; name: string; category: string; steps: ValStep[]; ok: boolean; durationMs: number }
interface ValSummary { startedAt: string; finishedAt: string; targetHost: string; total: number; passed: number; failed: number; results: ValRow[] }

interface UiStep { step: string; ok: boolean; durationMs: number; detail?: string }
interface UiRow { id: string; boxId: string; name: string; category: string; steps: UiStep[]; ok: boolean; durationMs: number; screenshotFile?: string }
interface UiSummary { startedAt: string; finishedAt: string; targetHost: string; total: number; sampleSize: number; passed: number; failed: number; results: UiRow[]; runDir: string }

export default function BulkTestsPage() {
  const [systems, setSystems] = useState<SystemSummary[]>([]);
  const [systemId, setSystemId] = useState<string>('sys-6');
  const [limit, setLimit] = useState<number>(0);   // 0 = full matrix
  const [genProgress, setGenProgress] = useState<Progress | null>(null);
  const [genResult, setGenResult] = useState<GenResult | null>(null);
  const [valProgress, setValProgress] = useState<Progress | null>(null);
  const [valResult, setValResult] = useState<ValSummary | null>(null);
  const [uiProgress, setUiProgress] = useState<Progress | null>(null);
  const [uiResult, setUiResult] = useState<UiSummary | null>(null);
  const [uiSampleSize, setUiSampleSize] = useState<number>(50);
  const [busy, setBusy] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [catFilter, setCatFilter] = useState<string>('all');

  // Load systems on mount.
  useEffect(() => {
    fetch('/api/ui-tests/systems').then(r => r.json()).then(d => {
      const list: SystemSummary[] = (d?.systems ?? []).map((s: any) => ({ id: s.id, name: s.name, host: s.host }));
      setSystems(list);
      if (list.find(s => s.id === 'sys-6')) setSystemId('sys-6');
    }).catch(() => { /* empty */ });
  }, []);

  // Status polling loop. Runs whenever we have an active gen OR val run.
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      if (stop) return;
      try {
        const r = await fetch('/api/bulk-tests/status', { cache: 'no-store' });
        const d = await r.json();
        if (d?.generation) {
          setGenProgress(d.generation.progress);
          setGenResult(d.generation.result);
        }
        if (d?.validation) {
          setValProgress(d.validation.progress);
          setValResult(d.validation.result);
        }
        if (d?.uiValidation) {
          setUiProgress(d.uiValidation.progress);
          setUiResult(d.uiValidation.result);
        }
      } catch { /* keep polling */ }
      if (!stop) setTimeout(tick, 1500);
    };
    tick();
    return () => { stop = true; };
  }, []);

  const startGenerate = async () => {
    setError(''); setBusy('generate');
    try {
      const r = await fetch('/api/bulk-tests/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ systemId, limit: limit > 0 ? limit : undefined }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) setError(d?.error ?? `generate returned ${r.status}`);
    } catch (e: any) { setError(e?.message ?? String(e)); }
    finally { setBusy(''); }
  };

  const startValidate = async () => {
    setError(''); setBusy('validate');
    try {
      const r = await fetch('/api/bulk-tests/validate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ systemId }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) setError(d?.error ?? `validate returned ${r.status}`);
    } catch (e: any) { setError(e?.message ?? String(e)); }
    finally { setBusy(''); }
  };

  const startValidateUI = async () => {
    setError(''); setBusy('validate-ui');
    try {
      const r = await fetch('/api/bulk-tests/validate-ui', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ systemId, sampleSize: uiSampleSize }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) setError(d?.error ?? `validate-ui returned ${r.status}`);
    } catch (e: any) { setError(e?.message ?? String(e)); }
    finally { setBusy(''); }
  };

  const startCleanup = async () => {
    if (!confirm(`Delete EVERY testcase on ${systemId} whose name starts with qa-bulk- or carries the qa-bulk tag?\n\nThis is irreversible.`)) return;
    setError(''); setBusy('cleanup');
    try {
      const r = await fetch('/api/bulk-tests/cleanup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ systemId }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) setError(d?.error ?? `cleanup returned ${r.status}`);
      else alert(`Deleted ${d.deletedCount} testcase(s). Failed: ${d.failedCount}.`);
    } catch (e: any) { setError(e?.message ?? String(e)); }
    finally { setBusy(''); }
  };

  const abortRun = async (which: 'generation' | 'validation') => {
    await fetch(`/api/bulk-tests/abort?which=${which}`, { method: 'POST' }).catch(() => {});
  };

  const genRunning = !!genProgress && !genProgress.finishedAt;
  const valRunning = !!valProgress && !valProgress.finishedAt;
  const uiRunning  = !!uiProgress  && !uiProgress.finishedAt;

  const filteredResults = (valResult?.results ?? []).filter(r => catFilter === 'all' || r.category === catFilter);
  const categories = Array.from(new Set((valResult?.results ?? []).map(r => r.category))).sort();

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="max-w-7xl mx-auto px-6 py-8">
        <header className="mb-8">
          <h1 className="text-2xl font-bold text-slate-900">Bulk Test Cases — 500+ generator</h1>
          <p className="text-sm text-slate-600 mt-1">
            Author 500+ valid, varied testcases programmatically via the box's create-lifecycle, then validate every one of them through the full GET → search → export → re-import → delete-clone contract.
          </p>
        </header>

        {/* Controls */}
        <section className="bg-white border border-slate-200 rounded-xl p-5 mb-6">
          <div className="flex flex-wrap items-end gap-4">
            <label className="flex flex-col">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Target system</span>
              <select className="border border-slate-300 rounded-md px-3 py-2 text-sm min-w-[200px]" value={systemId} onChange={e => setSystemId(e.target.value)}>
                {systems.length === 0 ? <option value="sys-6">sys-6 (default)</option> : systems.map(s => (
                  <option key={s.id} value={s.id}>{s.id} — {s.name} ({s.host})</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Limit (0 = full matrix)</span>
              <input type="number" min={0} className="border border-slate-300 rounded-md px-3 py-2 text-sm w-[120px]" value={limit} onChange={e => setLimit(Number(e.target.value) || 0)} />
            </label>
            <div className="flex gap-2 ml-auto">
              <button onClick={startGenerate} disabled={!!busy || genRunning} className="rounded-md bg-orange-500 hover:bg-orange-600 disabled:bg-slate-300 text-white text-sm font-medium px-4 py-2">
                {genRunning ? 'Generating…' : 'Generate'}
              </button>
              <button onClick={startValidate} disabled={!!busy || valRunning || !(genResult?.created?.length)} className="rounded-md bg-blue-500 hover:bg-blue-600 disabled:bg-slate-300 text-white text-sm font-medium px-4 py-2">
                {valRunning ? 'Validating…' : 'Validate (API)'}
              </button>
              <label className="flex items-center gap-2 text-xs text-slate-600">
                <span>UI sample</span>
                <input type="number" min={1} max={2000} value={uiSampleSize} onChange={e => setUiSampleSize(Number(e.target.value) || 50)} className="border border-slate-300 rounded-md px-2 py-1 w-[80px] text-sm" />
              </label>
              <button onClick={startValidateUI} disabled={!!busy || uiRunning || !(genResult?.created?.length)} className="rounded-md bg-purple-500 hover:bg-purple-600 disabled:bg-slate-300 text-white text-sm font-medium px-4 py-2">
                {uiRunning ? 'Validating UI…' : 'Validate (UI)'}
              </button>
              <button onClick={startCleanup} disabled={!!busy} className="rounded-md bg-red-500 hover:bg-red-600 disabled:bg-slate-300 text-white text-sm font-medium px-4 py-2">
                Cleanup
              </button>
            </div>
          </div>
          {error && <div className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">{error}</div>}
        </section>

        {/* Generation progress */}
        {genProgress && (
          <section className="bg-white border border-slate-200 rounded-xl p-5 mb-6">
            <h2 className="text-base font-semibold text-slate-900 mb-3 flex items-center gap-2">
              Generation
              {genRunning && <button onClick={() => abortRun('generation')} className="ml-auto text-xs rounded-md border border-slate-300 px-2 py-1 hover:bg-slate-50">Abort</button>}
            </h2>
            <div className="text-sm text-slate-700 mb-2">
              {genProgress.done} / {genProgress.total} done — {genProgress.passed} created · {genProgress.failed} failed · {genProgress.skipped ?? 0} skipped
              {genRunning && genProgress.currentName && <span className="text-slate-500 ml-2">· current: {genProgress.currentName}</span>}
            </div>
            <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
              <div className="h-full bg-orange-500" style={{ width: `${genProgress.total ? (100 * genProgress.done / genProgress.total) : 0}%` }} />
            </div>
            {genResult && genResult.failures.length > 0 && (
              <details className="mt-3 text-xs text-slate-600">
                <summary className="cursor-pointer">{genResult.failures.length} failure(s)</summary>
                <ul className="mt-2 ml-4 list-disc space-y-1">
                  {genResult.failures.slice(0, 50).map(f => (
                    <li key={f.id}><span className="font-mono">{f.name}</span> — step <span className="font-mono">{f.step}</span> returned {f.status}: <span className="text-slate-500">{f.message}</span></li>
                  ))}
                </ul>
              </details>
            )}
          </section>
        )}

        {/* Validation progress + per-testcase grid */}
        {valProgress && (
          <section className="bg-white border border-slate-200 rounded-xl p-5 mb-6">
            <h2 className="text-base font-semibold text-slate-900 mb-3 flex items-center gap-2">
              API validation
              {valRunning && <button onClick={() => abortRun('validation')} className="ml-auto text-xs rounded-md border border-slate-300 px-2 py-1 hover:bg-slate-50">Abort</button>}
            </h2>
            <div className="text-sm text-slate-700 mb-2">
              {valProgress.done} / {valProgress.total} done — {valProgress.passed} pass · {valProgress.failed} fail
              {valRunning && valProgress.currentName && <span className="text-slate-500 ml-2">· current: {valProgress.currentName}</span>}
            </div>
            <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
              <div className="h-full bg-blue-500" style={{ width: `${valProgress.total ? (100 * valProgress.done / valProgress.total) : 0}%` }} />
            </div>

            {valResult && valResult.results.length > 0 && (
              <>
                <div className="flex items-center gap-2 mt-4 mb-2 text-xs">
                  <span className="text-slate-500">Filter category:</span>
                  <button onClick={() => setCatFilter('all')} className={`px-2 py-0.5 rounded ${catFilter === 'all' ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-700'}`}>all</button>
                  {categories.map(c => (
                    <button key={c} onClick={() => setCatFilter(c)} className={`px-2 py-0.5 rounded ${catFilter === c ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-700'}`}>{c}</button>
                  ))}
                </div>
                <div className="overflow-x-auto border border-slate-200 rounded-md">
                  <table className="min-w-full text-xs">
                    <thead className="bg-slate-50 text-slate-600">
                      <tr>
                        <th className="text-left px-3 py-2 font-medium">#</th>
                        <th className="text-left px-3 py-2 font-medium">Name</th>
                        <th className="text-left px-3 py-2 font-medium">Category</th>
                        <th className="text-center px-3 py-2 font-medium">GET</th>
                        <th className="text-center px-3 py-2 font-medium">Search</th>
                        <th className="text-center px-3 py-2 font-medium">Export</th>
                        <th className="text-center px-3 py-2 font-medium">Import</th>
                        <th className="text-center px-3 py-2 font-medium">Del clone</th>
                        <th className="text-center px-3 py-2 font-medium">Verify gone</th>
                        <th className="text-center px-3 py-2 font-medium">Original</th>
                        <th className="text-right px-3 py-2 font-medium">ms</th>
                        <th className="text-center px-3 py-2 font-medium">Verdict</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {filteredResults.map((r, i) => {
                        const stepCell = (name: string) => {
                          const s = r.steps.find(x => x.step === name);
                          if (!s) return <td className="text-center px-2 py-1.5 text-slate-300">—</td>;
                          return <td className={`text-center px-2 py-1.5 font-mono ${s.ok ? 'text-emerald-700' : 'text-red-700'}`} title={s.detail ?? ''}>{s.ok ? '✓' : `✗ ${s.status}`}</td>;
                        };
                        return (
                          <tr key={r.id}>
                            <td className="px-3 py-1.5 text-slate-500">{i + 1}</td>
                            <td className="px-3 py-1.5 font-mono text-[11px]">{r.name}</td>
                            <td className="px-3 py-1.5">{r.category}</td>
                            {stepCell('get')}
                            {stepCell('search')}
                            {stepCell('export')}
                            {stepCell('import')}
                            {stepCell('delete-clone')}
                            {stepCell('verify-clone-gone')}
                            {stepCell('verify-original')}
                            <td className="px-3 py-1.5 text-right font-mono text-slate-500">{r.durationMs}</td>
                            <td className={`px-3 py-1.5 text-center font-semibold ${r.ok ? 'text-emerald-700' : 'text-red-700'}`}>{r.ok ? 'PASS' : 'FAIL'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </section>
        )}
        {/* UI validation grid */}
        {uiProgress && (
          <section className="bg-white border border-slate-200 rounded-xl p-5 mb-6">
            <h2 className="text-base font-semibold text-slate-900 mb-3 flex items-center gap-2">
              UI validation
              {uiRunning && <button onClick={() => abortRun('validation')} className="ml-auto text-xs rounded-md border border-slate-300 px-2 py-1 hover:bg-slate-50">Abort</button>}
            </h2>
            <div className="text-sm text-slate-700 mb-2">
              {uiProgress.done} / {uiProgress.total} done — {uiProgress.passed} pass · {uiProgress.failed} fail
              {uiRunning && uiProgress.currentName && <span className="text-slate-500 ml-2">· current: {uiProgress.currentName}</span>}
            </div>
            <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
              <div className="h-full bg-purple-500" style={{ width: `${uiProgress.total ? (100 * uiProgress.done / uiProgress.total) : 0}%` }} />
            </div>
            {uiResult && uiResult.results.length > 0 && (
              <div className="overflow-x-auto border border-slate-200 rounded-md mt-3">
                <table className="min-w-full text-xs">
                  <thead className="bg-slate-50 text-slate-600">
                    <tr>
                      <th className="text-left px-3 py-2 font-medium">#</th>
                      <th className="text-left px-3 py-2 font-medium">Name</th>
                      <th className="text-left px-3 py-2 font-medium">Category</th>
                      <th className="text-center px-3 py-2 font-medium">Navigate</th>
                      <th className="text-center px-3 py-2 font-medium">Search</th>
                      <th className="text-center px-3 py-2 font-medium">Row visible</th>
                      <th className="text-center px-3 py-2 font-medium">Name in page</th>
                      <th className="text-right px-3 py-2 font-medium">ms</th>
                      <th className="text-center px-3 py-2 font-medium">Verdict</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {uiResult.results.map((r, i) => {
                      const stepCell = (name: string) => {
                        const s = r.steps.find(x => x.step === name);
                        if (!s) return <td className="text-center px-2 py-1.5 text-slate-300">—</td>;
                        return <td className={`text-center px-2 py-1.5 font-mono ${s.ok ? 'text-emerald-700' : 'text-red-700'}`} title={s.detail ?? ''}>{s.ok ? '✓' : '✗'}</td>;
                      };
                      return (
                        <tr key={r.id}>
                          <td className="px-3 py-1.5 text-slate-500">{i + 1}</td>
                          <td className="px-3 py-1.5 font-mono text-[11px]">{r.name}</td>
                          <td className="px-3 py-1.5">{r.category}</td>
                          {stepCell('navigate-to-testcase')}
                          {stepCell('search-by-name')}
                          {stepCell('row-visible')}
                          {stepCell('verify-name-in-page')}
                          <td className="px-3 py-1.5 text-right font-mono text-slate-500">{r.durationMs}</td>
                          <td className={`px-3 py-1.5 text-center font-semibold ${r.ok ? 'text-emerald-700' : 'text-red-700'}`}>{r.ok ? 'PASS' : 'FAIL'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

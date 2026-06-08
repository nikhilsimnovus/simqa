// /automation-suite — Automation Suite builder + runner.
//
// Two flavours of suite:
//   - UESIM-only       testcases are pulled from a Simnovator's REST
//                      catalog (GET /v2/testcases). Run → POST per
//                      testcase id to /v2/testcases/{id}/executions.
//   - UESIM + Callbox  testcases ARE the .cfg files under
//                      /root/enb/config on the callbox. The wizard
//                      lists them via SSH and lets the user check the
//                      ones to include + upload extra files. Run → for
//                      each .cfg, scp uploaded blobs onto the callbox
//                      and verify picked files are still present. eNB
//                      restart is left to the operator.
//
// All system + file/testcase listings are fetched lazily on system
// selection, so the page is cheap when you're just browsing.

'use client';

import { useEffect, useState, useCallback } from 'react';

interface SystemRow {
  id: string; name: string; host: string; type: string;
}
interface SuiteRow {
  id: string; name: string;
  kind?: 'uesim-only' | 'uesim+callbox';
  uesimSystemId?: string; callboxSystemId?: string;
  uploadedConfigs?: Record<string, string>;
  callboxConfig?: string;
  testcaseIds: string[];
  stopOnFail?: boolean;
  updatedAt?: string;
}
interface UesimTestcase {
  id: string; name: string; description?: string;
  lastResult?: string | null; lastStatus?: string | null;
  lastModifiedOn?: string | null;
}
interface CallboxFile {
  name: string; size: number; mtime: string;
}
interface SuiteRunStep {
  testcaseId: string; status: number; ok: boolean;
  executionId?: string; detail?: string; durationMs: number;
}
interface SuiteRunResult {
  startedAt: string; finishedAt: string;
  suiteId: string; suiteName: string;
  kind: string; uesimHost?: string; callboxHost?: string;
  total: number; passed: number; failed: number;
  steps: SuiteRunStep[];
  runId?: string; buildVersion?: string;
  diagnostics?: { perfQaUrl: string; jobId: string; triggeredAt: string };
}
interface RunHistoryRow {
  runId: string; startedAt: string; finishedAt: string;
  kind: string; total: number; passed: number; failed: number;
  buildVersion?: string;
  diagnostics?: { perfQaUrl: string; jobId: string };
}
interface CompareRow {
  testcaseId: string;
  a?: { status: number; ok: boolean; detail?: string };
  b?: { status: number; ok: boolean; detail?: string };
  verdict: 'matched-pass' | 'matched-fail' | 'regressed' | 'fixed' | 'only-a' | 'only-b';
}
interface CompareSummary {
  a: { runId: string; buildVersion?: string; finishedAt: string; passed: number; failed: number; total: number };
  b: { runId: string; buildVersion?: string; finishedAt: string; passed: number; failed: number; total: number };
  summary: { regressed: number; fixed: number; matchedPass: number; matchedFail: number; onlyA: number; onlyB: number; totalRows: number };
  rows: CompareRow[];
}

type Kind = 'uesim-only' | 'uesim+callbox';

export default function AutomationSuitePage() {
  const [systems, setSystems] = useState<SystemRow[]>([]);
  const [suites, setSuites]   = useState<SuiteRow[]>([]);
  const [busy, setBusy]       = useState<string>('');
  const [error, setError]     = useState<string>('');
  const [showWizard, setShowWizard] = useState(false);
  const [editingId, setEditingId] = useState<string>('');

  // Wizard state ────────────────────────────────────────────────────────
  const [name, setName]               = useState<string>('');
  const [kind, setKind]               = useState<Kind>('uesim-only');
  const [uesimSystemId, setUesim]     = useState<string>('');
  const [callboxSystemId, setCbx]     = useState<string>('');

  // UESIM-only data: testcases pulled from Simnovator REST
  const [uesimTestcases, setUeTcs]    = useState<UesimTestcase[]>([]);
  const [loadingTc, setLoadingTc]     = useState(false);

  // Callbox data: file list from /root/enb/config + any blobs the user
  // is layering on top via Upload
  const [callboxFiles, setCbxFiles]   = useState<CallboxFile[]>([]);
  const [loadingCbx, setLoadingCbx]   = useState(false);
  const [uploadedConfigs, setUploads] = useState<Record<string, string>>({});

  // Selections: callbox config is single-select (radio), Simnovator
  // testcases is multi-select (Set). A uesim+callbox suite binds ONE
  // radio config and N testcases per the user's design call.
  const [selectedCfg,  setSelectedCfg]  = useState<string>('');
  const [selectedTcs,  setSelectedTcs]  = useState<Set<string>>(new Set());
  const [cbxFilter, setCbxFilter]       = useState<string>('');
  const [tcFilter,  setTcFilter]        = useState<string>('');
  const [stopOnFail, setStopOnFail]     = useState<boolean>(false);
  /** SSH error surfaced from /api/automation/callbox-configs so the user
   *  sees WHY the config list is empty (auth failure vs empty dir). */
  const [cbxLoadError, setCbxLoadError] = useState<string>('');

  // Run state ────────────────────────────────────────────────────────────
  const [runResult, setRunResult] = useState<SuiteRunResult | null>(null);
  const [running, setRunning]     = useState<string>('');
  const [collectDiagnostics, setCollectDx] = useState<boolean>(true);
  // Run history (per suite, lazy)
  const [historyFor, setHistoryFor] = useState<string>('');           // suite id whose history we're viewing
  const [history, setHistory]       = useState<RunHistoryRow[]>([]);
  // Compare selection — array of (runId) toggled, max 2
  const [compareSel, setCompareSel] = useState<Set<string>>(new Set());
  const [compareData, setCompareData] = useState<CompareSummary | null>(null);
  const [compareBusy, setCompareBusy] = useState(false);

  const loadHistory = useCallback(async (suiteId: string) => {
    setHistoryFor(suiteId); setHistory([]); setCompareSel(new Set()); setCompareData(null);
    if (!suiteId) return;
    try {
      const r = await fetch(`/api/automation/suites/${suiteId}/runs`).then(r => r.json());
      if (r?.ok) setHistory(r.runs ?? []);
    } catch { /* keep empty */ }
  }, []);

  const toggleCompare = (runId: string) => {
    const next = new Set(compareSel);
    if (next.has(runId)) { next.delete(runId); }
    else {
      // Cap at 2 — if already at 2, drop the oldest.
      if (next.size >= 2) { const first = next.values().next().value; if (first) next.delete(first); }
      next.add(runId);
    }
    setCompareSel(next);
    setCompareData(null);
  };

  const runCompare = async () => {
    if (compareSel.size !== 2) return;
    setCompareBusy(true);
    try {
      const r = await fetch('/api/automation/runs/compare', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runIds: [...compareSel] }),
      });
      const d = await r.json();
      if (r.ok && d.ok) setCompareData(d.compare); else setError(d?.error ?? `HTTP ${r.status}`);
    } finally { setCompareBusy(false); }
  };

  const refresh = useCallback(async () => {
    try {
      const [sysR, suitesR] = await Promise.all([
        fetch('/api/ui-tests/systems').then(r => r.json()),
        fetch('/api/automation/suites').then(r => r.json()),
      ]);
      const sys: SystemRow[] = (sysR?.systems ?? []).map((s: any) => ({ id: s.id, name: s.name, host: s.host, type: s.type ?? 'UESIM' }));
      setSystems(sys);
      setSuites((suitesR?.suites ?? []) as SuiteRow[]);
    } catch (e: any) { setError(e?.message ?? String(e)); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const uesimSystems = systems.filter(s => /UESIM|SIMNOVATOR/i.test(s.type));
  const callboxSystems = systems.filter(s => /CALLBOX/i.test(s.type));

  const loadCallboxConfigs = useCallback(async (sysId: string) => {
    if (!sysId) { setCbxFiles([]); setCbxLoadError(''); return; }
    setLoadingCbx(true); setCbxLoadError('');
    try {
      const r = await fetch(`/api/automation/callbox-configs?systemId=${encodeURIComponent(sysId)}`).then(r => r.json());
      setCbxFiles(r?.ok ? (r.files ?? []) : []);
      if (!r?.ok) setCbxLoadError(r?.error ?? 'failed to list callbox configs');
    } finally { setLoadingCbx(false); }
  }, []);

  const loadUesimTestcases = useCallback(async (sysId: string) => {
    if (!sysId) { setUeTcs([]); return; }
    setLoadingTc(true);
    try {
      const r = await fetch(`/api/automation/uesim-testcases?systemId=${encodeURIComponent(sysId)}`).then(r => r.json());
      setUeTcs(r?.ok ? (r.testcases ?? []) : []);
      if (!r?.ok) setError(r?.error ?? 'failed to pull testcases');
    } finally { setLoadingTc(false); }
  }, []);

  /** "Add an upload" — reads one or more files into base64 and merges
   *  them into uploadedConfigs. Pre-selects them too. */
  /** Upload a SINGLE .cfg file — bind it as the suite's callbox config.
   *  Uploads replace any prior selection (since the suite carries one
   *  config). Multi-file picks aren't allowed. */
  const onPickUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const data = String(reader.result ?? '');
      const b64 = data.includes(',') ? data.split(',', 2)[1] : btoa(data);
      setUploads({ ...uploadedConfigs, [f.name]: b64 });
      setSelectedCfg(f.name);
    };
    reader.readAsDataURL(f);
    e.target.value = '';
  }, [uploadedConfigs]);

  const removeUpload = useCallback((filename: string) => {
    const next = { ...uploadedConfigs };
    delete next[filename];
    setUploads(next);
    if (selectedCfg === filename) setSelectedCfg('');
  }, [uploadedConfigs, selectedCfg]);

  const resetWizard = useCallback(() => {
    setEditingId(''); setName(''); setKind('uesim-only');
    setUesim(''); setCbx(''); setCbxFiles([]); setUploads({}); setCbxLoadError('');
    setUeTcs([]); setSelectedCfg(''); setSelectedTcs(new Set());
    setStopOnFail(false); setCbxFilter(''); setTcFilter('');
    setError(''); setShowWizard(false);
  }, []);

  const openNew = useCallback(() => { resetWizard(); setShowWizard(true); }, [resetWizard]);
  const openEdit = useCallback((s: SuiteRow) => {
    resetWizard();
    setEditingId(s.id);
    setName(s.name);
    setKind(s.kind ?? 'uesim-only');
    setUesim(s.uesimSystemId ?? '');
    setCbx(s.callboxSystemId ?? '');
    setUploads(s.uploadedConfigs ?? {});
    setSelectedCfg(s.callboxConfig ?? '');
    setSelectedTcs(new Set(s.testcaseIds));
    setStopOnFail(!!s.stopOnFail);
    setShowWizard(true);
    if (s.callboxSystemId && s.kind === 'uesim+callbox') void loadCallboxConfigs(s.callboxSystemId);
    if (s.uesimSystemId) void loadUesimTestcases(s.uesimSystemId);
  }, [resetWizard, loadCallboxConfigs, loadUesimTestcases]);

  const saveSuite = async () => {
    if (!name.trim())     { setError('name required'); return; }
    if (!uesimSystemId)   { setError('UESIM system required'); return; }
    if (kind === 'uesim+callbox' && !callboxSystemId) { setError('callbox system required'); return; }
    const tcs = [...selectedTcs];
    const cfg = kind === 'uesim+callbox' ? selectedCfg : '';
    if (tcs.length === 0 && !cfg) {
      setError(kind === 'uesim+callbox' ? 'pick a callbox config and/or one or more Simnovator testcases' : 'pick at least one Simnovator testcase');
      return;
    }

    // Only persist the upload blob that corresponds to the selected
    // config — drop the rest so the suite record stays small.
    const trimmedUploads = (kind === 'uesim+callbox' && cfg && uploadedConfigs[cfg])
      ? { [cfg]: uploadedConfigs[cfg] }
      : undefined;

    const payload: any = {
      name: name.trim(),
      kind,
      uesimSystemId,
      callboxSystemId: kind === 'uesim+callbox' ? callboxSystemId : undefined,
      uploadedConfigs: trimmedUploads,
      callboxConfig: kind === 'uesim+callbox' ? (cfg || undefined) : undefined,
      testcaseIds: tcs,
      stopOnFail,
    };
    setBusy(editingId ? 'update' : 'create'); setError('');
    try {
      const r = editingId
        ? await fetch(`/api/automation/suites/${editingId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
        : await fetch('/api/automation/suites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d?.error ?? `HTTP ${r.status}`);
      await refresh();
      resetWizard();
    } catch (e: any) { setError(e?.message ?? String(e)); }
    finally { setBusy(''); }
  };

  const runSuite = async (s: SuiteRow) => {
    const tcN = s.testcaseIds.length;
    const summary = s.kind === 'uesim+callbox'
      ? `Push callbox config ${s.callboxConfig ? `'${s.callboxConfig}'` : '(none)'} + trigger ${tcN} Simnovator testcase${tcN === 1 ? '' : 's'}`
      : `Trigger ${tcN} Simnovator testcase${tcN === 1 ? '' : 's'}`;
    if (!window.confirm(`Run suite "${s.name}"?\n\n${summary}.\nDiagnostics: ${collectDiagnostics ? 'perf-qa collection will run alongside' : 'off'}`)) return;
    setRunning(s.id); setRunResult(null); setError('');
    try {
      const r = await fetch(`/api/automation/suites/${s.id}/run`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collectDiagnostics }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d?.error ?? `HTTP ${r.status}`);
      setRunResult(d.result);
      // Refresh history if we were viewing this suite's runs.
      if (historyFor === s.id) await loadHistory(s.id);
    } catch (e: any) { setError(e?.message ?? String(e)); }
    finally { setRunning(''); }
  };

  const deleteSuite = async (s: SuiteRow) => {
    if (!window.confirm(`Delete suite "${s.name}"?`)) return;
    setBusy('delete'); setError('');
    try {
      const r = await fetch(`/api/automation/suites/${s.id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await refresh();
    } catch (e: any) { setError(e?.message ?? String(e)); }
    finally { setBusy(''); }
  };

  // Auto-load both lists when systems change. UESIM testcases are
  // pulled in BOTH kinds now — for uesim+callbox the user picks which
  // Simnovator testcases run AFTER the callbox configs are pushed.
  useEffect(() => {
    if (kind === 'uesim+callbox' && callboxSystemId) void loadCallboxConfigs(callboxSystemId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, callboxSystemId]);
  useEffect(() => {
    if (uesimSystemId) void loadUesimTestcases(uesimSystemId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uesimSystemId]);
  // Switching kind keeps the testcase selection but clears the callbox
  // selection (since the callbox system is also potentially different).
  useEffect(() => { setSelectedCfg(''); }, [kind]);

  // Callbox file list = uploads at the top + on-box files below.
  type CfgItem = { id: string; label: string; sub?: string; upload?: boolean };
  const cfgItems: CfgItem[] = [
    ...Object.keys(uploadedConfigs).map(fn => ({ id: fn, label: fn, sub: 'uploaded — will be scp\'d on run', upload: true })),
    ...callboxFiles.map(f => ({ id: f.name, label: f.name, sub: `${f.size}B · ${f.mtime}` })),
  ];
  const filteredCfgs = cfgItems.filter(it => !cbxFilter || it.label.toLowerCase().includes(cbxFilter.toLowerCase()));
  const filteredTcs  = uesimTestcases.filter(t => !tcFilter || t.name.toLowerCase().includes(tcFilter.toLowerCase()));

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="max-w-7xl mx-auto px-6 py-8">
        <header className="mb-6">
          <h1 className="text-2xl font-bold text-slate-900">Automation Suite</h1>
          <p className="text-sm text-slate-600 mt-1">
            Build a named bundle of testcases bound to a lab setup — <strong>UESIM-only</strong> (testcases come from a
            Simnovator's REST catalog) or <strong>UESIM + Callbox</strong> (testcases are <code>.cfg</code> files under <code>/root/enb/config</code> on the callbox).
            Save once; click Run to fire the whole bundle.
          </p>
        </header>

        {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">{error}</div>}

        {/* Suite list */}
        <section className="bg-white border border-slate-200 rounded-xl p-5 mb-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-semibold text-slate-900">Saved suites ({suites.length})</h2>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 text-xs text-slate-600 cursor-pointer">
                <input type="checkbox" checked={collectDiagnostics} onChange={e => setCollectDx(e.target.checked)} />
                <span>Collect diagnostics (perf-qa) on Run</span>
              </label>
              <button onClick={openNew} className="rounded-md bg-orange-500 hover:bg-orange-600 text-white text-sm font-medium px-4 py-2">
                + New suite
              </button>
            </div>
          </div>
          {suites.length === 0 ? (
            <div className="text-sm text-slate-500 py-4 text-center">No suites yet. Click "+ New suite" to build one.</div>
          ) : (
            <div className="overflow-x-auto border border-slate-200 rounded-md">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium">Name</th>
                    <th className="text-left px-3 py-2 font-medium">Kind</th>
                    <th className="text-left px-3 py-2 font-medium">UESIM</th>
                    <th className="text-left px-3 py-2 font-medium">Callbox</th>
                    <th className="text-left px-3 py-2 font-medium">Config</th>
                    <th className="text-right px-3 py-2 font-medium">Tests</th>
                    <th className="text-right px-3 py-2 font-medium">Updated</th>
                    <th className="text-right px-3 py-2 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {suites.map(s => (
                    <tr key={s.id}>
                      <td className="px-3 py-2 font-medium">{s.name}</td>
                      <td className="px-3 py-2 text-slate-700">{s.kind ?? 'uesim-only'}</td>
                      <td className="px-3 py-2 text-slate-700 font-mono text-xs">{s.uesimSystemId ?? '–'}</td>
                      <td className="px-3 py-2 text-slate-700 font-mono text-xs">{s.callboxSystemId ?? '–'}</td>
                      <td className="px-3 py-2 font-mono text-xs">{s.callboxConfig ?? '–'}{s.callboxConfig && s.uploadedConfigs?.[s.callboxConfig] ? ' (uploaded)' : ''}</td>
                      <td className="px-3 py-2 text-right">{s.testcaseIds.length}</td>
                      <td className="px-3 py-2 text-right text-xs text-slate-500">{s.updatedAt?.slice(0, 19).replace('T', ' ') ?? '–'}</td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        <button onClick={() => runSuite(s)} disabled={running === s.id} className="rounded-md bg-blue-500 hover:bg-blue-600 disabled:bg-slate-300 text-white text-xs px-2 py-1 mr-1">
                          {running === s.id ? 'Running…' : 'Run'}
                        </button>
                        <button onClick={() => historyFor === s.id ? setHistoryFor('') : loadHistory(s.id)} className={`rounded-md text-xs px-2 py-1 mr-1 border ${historyFor === s.id ? 'bg-slate-800 text-white border-slate-800' : 'border-slate-300 hover:bg-slate-50'}`}>
                          Runs
                        </button>
                        <button onClick={() => openEdit(s)} className="rounded-md border border-slate-300 hover:bg-slate-50 text-xs px-2 py-1 mr-1">Edit</button>
                        <button onClick={() => deleteSuite(s)} className="rounded-md border border-red-300 text-red-600 hover:bg-red-50 text-xs px-2 py-1">Delete</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Run history + compare (visible when "Runs" was clicked) */}
        {historyFor && (
          <section className="bg-white border border-slate-200 rounded-xl p-5 mb-6">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-base font-semibold text-slate-900">
                Runs for <code>{historyFor}</code> ({history.length})
              </h2>
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500">
                  Check 2 runs to compare ({compareSel.size}/2)
                </span>
                <button onClick={runCompare} disabled={compareSel.size !== 2 || compareBusy}
                  className="rounded-md bg-blue-500 hover:bg-blue-600 disabled:bg-slate-300 text-white text-xs px-3 py-1">
                  {compareBusy ? 'Comparing…' : 'Compare selected'}
                </button>
                <button onClick={() => { setHistoryFor(''); setCompareData(null); setCompareSel(new Set()); }}
                  className="rounded-md border border-slate-300 hover:bg-slate-50 text-xs px-2 py-1">Close</button>
              </div>
            </div>

            {history.length === 0 ? (
              <div className="text-sm text-slate-500 py-4 text-center">No runs yet for this suite.</div>
            ) : (
              <div className="overflow-x-auto border border-slate-200 rounded-md">
                <table className="min-w-full text-xs">
                  <thead className="bg-slate-50 text-slate-600">
                    <tr>
                      <th className="px-3 py-2">✓</th>
                      <th className="text-left px-3 py-2">Run id</th>
                      <th className="text-left px-3 py-2">Finished</th>
                      <th className="text-left px-3 py-2">Build</th>
                      <th className="text-left px-3 py-2">Kind</th>
                      <th className="text-right px-3 py-2">Pass</th>
                      <th className="text-right px-3 py-2">Fail</th>
                      <th className="text-right px-3 py-2">Total</th>
                      <th className="text-left px-3 py-2">Diagnostics</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {history.map(h => (
                      <tr key={h.runId}>
                        <td className="px-3 py-1.5 text-center">
                          <input type="checkbox" checked={compareSel.has(h.runId)} onChange={() => toggleCompare(h.runId)} />
                        </td>
                        <td className="px-3 py-1.5 font-mono text-[11px]">{h.runId}</td>
                        <td className="px-3 py-1.5 text-slate-700">{h.finishedAt?.slice(0, 19).replace('T', ' ')}</td>
                        <td className="px-3 py-1.5 font-mono text-[11px]">{h.buildVersion ?? '–'}</td>
                        <td className="px-3 py-1.5">{h.kind}</td>
                        <td className="px-3 py-1.5 text-right text-emerald-700">{h.passed}</td>
                        <td className="px-3 py-1.5 text-right text-red-700">{h.failed}</td>
                        <td className="px-3 py-1.5 text-right">{h.total}</td>
                        <td className="px-3 py-1.5 text-[11px] text-slate-600">
                          {h.diagnostics
                            ? <a className="text-blue-600 hover:underline" target="_blank" rel="noreferrer" href={`${h.diagnostics.perfQaUrl}/jobs/${h.diagnostics.jobId}/stream`}>perf-qa job {h.diagnostics.jobId}</a>
                            : '–'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {compareData && (
              <div className="mt-5 border border-slate-200 rounded-md p-3 bg-slate-50/50">
                <div className="text-sm font-semibold text-slate-900 mb-2">
                  Compare: <code>{compareData.a.buildVersion ?? compareData.a.runId.slice(-8)}</code>
                  &nbsp;↔&nbsp;
                  <code>{compareData.b.buildVersion ?? compareData.b.runId.slice(-8)}</code>
                </div>
                <div className="text-xs text-slate-700 mb-3">
                  <span className="text-red-700">regressed {compareData.summary.regressed}</span> ·
                  &nbsp;<span className="text-emerald-700">fixed {compareData.summary.fixed}</span> ·
                  &nbsp;matched-pass {compareData.summary.matchedPass} ·
                  &nbsp;matched-fail {compareData.summary.matchedFail} ·
                  &nbsp;only-A {compareData.summary.onlyA} ·
                  &nbsp;only-B {compareData.summary.onlyB}
                </div>
                <div className="overflow-x-auto border border-slate-200 rounded-md bg-white max-h-96">
                  <table className="min-w-full text-xs">
                    <thead className="bg-slate-50 text-slate-600">
                      <tr>
                        <th className="text-left px-3 py-2">Testcase</th>
                        <th className="text-center px-3 py-2">Verdict</th>
                        <th className="text-center px-3 py-2">A status</th>
                        <th className="text-center px-3 py-2">A ok</th>
                        <th className="text-center px-3 py-2">B status</th>
                        <th className="text-center px-3 py-2">B ok</th>
                        <th className="text-left px-3 py-2">Detail (B)</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {compareData.rows.map(r => {
                        const verdictColor =
                          r.verdict === 'regressed'   ? 'text-red-700 font-semibold' :
                          r.verdict === 'fixed'       ? 'text-emerald-700 font-semibold' :
                          r.verdict === 'matched-pass'? 'text-emerald-600' :
                          r.verdict === 'matched-fail'? 'text-red-600' :
                          'text-slate-500';
                        return (
                          <tr key={r.testcaseId}>
                            <td className="px-3 py-1.5 font-mono text-[11px]">{r.testcaseId}</td>
                            <td className={`px-3 py-1.5 text-center ${verdictColor}`}>{r.verdict}</td>
                            <td className="px-3 py-1.5 text-center font-mono">{r.a?.status ?? '—'}</td>
                            <td className="px-3 py-1.5 text-center">{r.a ? (r.a.ok ? '✓' : '✗') : '—'}</td>
                            <td className="px-3 py-1.5 text-center font-mono">{r.b?.status ?? '—'}</td>
                            <td className="px-3 py-1.5 text-center">{r.b ? (r.b.ok ? '✓' : '✗') : '—'}</td>
                            <td className="px-3 py-1.5 text-slate-600 text-[11px] max-w-md truncate" title={r.b?.detail}>{r.b?.detail ?? ''}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </section>
        )}

        {/* Wizard */}
        {showWizard && (
          <section className="bg-white border border-slate-200 rounded-xl p-5 mb-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold text-slate-900">{editingId ? 'Edit suite' : 'New suite'}</h2>
              <button onClick={resetWizard} className="text-sm text-slate-500 hover:text-slate-900">Cancel</button>
            </div>

            <div className="grid grid-cols-2 gap-4 mb-4">
              <label className="flex flex-col">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Suite name</span>
                <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. NR-SA n78 nightly" className="border border-slate-300 rounded-md px-3 py-2 text-sm" />
              </label>
              <label className="flex flex-col">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Setup kind</span>
                <select value={kind} onChange={e => setKind(e.target.value as Kind)} className="border border-slate-300 rounded-md px-3 py-2 text-sm">
                  <option value="uesim-only">UESIM only — testcases from Simnovator REST</option>
                  <option value="uesim+callbox">UESIM + Callbox — testcases are .cfg files in /root/enb/config</option>
                </select>
              </label>
            </div>

            <div className="grid grid-cols-2 gap-4 mb-4">
              <label className="flex flex-col">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">UESIM / Simnovator system</span>
                <select value={uesimSystemId} onChange={e => setUesim(e.target.value)} className="border border-slate-300 rounded-md px-3 py-2 text-sm">
                  <option value="">— pick —</option>
                  {uesimSystems.map(s => (
                    <option key={s.id} value={s.id}>{s.id} — {s.name} ({s.host})</option>
                  ))}
                </select>
              </label>
              {kind === 'uesim+callbox' && (
                <label className="flex flex-col">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Callbox system</span>
                  <select value={callboxSystemId} onChange={e => setCbx(e.target.value)} className="border border-slate-300 rounded-md px-3 py-2 text-sm">
                    <option value="">— pick —</option>
                    {callboxSystems.map(s => (
                      <option key={s.id} value={s.id}>{s.id} — {s.name} ({s.host})</option>
                    ))}
                  </select>
                </label>
              )}
            </div>

            {/* Callbox config picker — single-select (radio). Each suite
                is scoped to ONE eNB config; campaigns spanning multiple
                configs belong in separate suites. */}
            {kind === 'uesim+callbox' && callboxSystemId && (
              <div className="mb-4 border border-slate-200 rounded-md p-3 bg-slate-50/50">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                    Pick ONE config from <code>/root/enb/config</code> on <code>{callboxSystemId}</code>
                    {selectedCfg && <> · selected: <code className="text-slate-700">{selectedCfg}</code></>}
                  </div>
                  <input type="search" placeholder="filter…" value={cbxFilter} onChange={e => setCbxFilter(e.target.value)} className="border border-slate-300 rounded-md px-2 py-1 text-xs" />
                </div>
                {cbxLoadError && (
                  <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-md px-2 py-1 mb-2">
                    SSH error: <code>{cbxLoadError}</code> — fix the callbox's SSH creds in <code>inventory.yaml</code>, or upload a .cfg file below.
                  </div>
                )}
                <div className="border border-slate-200 rounded-md bg-white max-h-60 overflow-y-auto">
                  {loadingCbx ? (
                    <div className="p-3 text-sm text-slate-500">Loading via SSH…</div>
                  ) : filteredCfgs.length === 0 ? (
                    <div className="p-3 text-sm text-slate-500">
                      No files match <code>{cbxFilter || '*'}</code> in <code>/root/enb/config</code> (or SSH failed). Use Upload below.
                    </div>
                  ) : (
                    <ul className="divide-y divide-slate-100 text-sm">
                      {filteredCfgs.map(it => (
                        <li key={it.id} className="px-3 py-1.5 flex items-center gap-2 hover:bg-slate-50 cursor-pointer"
                            onClick={() => setSelectedCfg(it.id)}>
                          <input type="radio" name="cbxcfg" checked={selectedCfg === it.id} onChange={() => setSelectedCfg(it.id)} />
                          <span className="flex-1 truncate" title={it.id}>{it.label}</span>
                          {it.upload && (
                            <button type="button" onClick={(e) => { e.stopPropagation(); removeUpload(it.id); }} className="text-[10px] text-red-600 hover:underline" title="Remove this upload">remove</button>
                          )}
                          {it.sub && <span className="text-[10px] text-slate-400 truncate">{it.sub}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="mt-3 flex items-center gap-3 text-sm">
                  <label className="cursor-pointer rounded-md border border-slate-300 px-3 py-1.5 hover:bg-slate-100">
                    Upload .cfg file…
                    <input type="file" onChange={onPickUpload} className="hidden" />
                  </label>
                  <span className="text-xs text-slate-500">
                    Uploaded file is scp'd to <code>/root/enb/config/&lt;name&gt;</code> when the suite runs.
                  </span>
                </div>
              </div>
            )}

            {/* Simnovator testcase picker — shown for BOTH kinds. In
                uesim+callbox mode these run AFTER the callbox configs
                are pushed (the runner does configs first, then tcs). */}
            {uesimSystemId && (
              <div className="mb-4 border border-slate-200 rounded-md p-3 bg-slate-50/50">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                    Simnovator testcases from <code>{uesimSystemId}</code> ({selectedTcs.size} selected of {uesimTestcases.length})
                  </div>
                  <input type="search" placeholder="filter…" value={tcFilter} onChange={e => setTcFilter(e.target.value)} className="border border-slate-300 rounded-md px-2 py-1 text-xs" />
                </div>
                <div className="border border-slate-200 rounded-md bg-white max-h-60 overflow-y-auto">
                  {loadingTc ? (
                    <div className="p-3 text-sm text-slate-500">Pulling testcases from {uesimSystemId}…</div>
                  ) : filteredTcs.length === 0 ? (
                    <div className="p-3 text-sm text-slate-500">No testcases match.</div>
                  ) : (
                    <ul className="divide-y divide-slate-100 text-sm">
                      {filteredTcs.map(t => (
                        <li key={t.id} className="px-3 py-1.5 flex items-center gap-2 hover:bg-slate-50">
                          <input type="checkbox" checked={selectedTcs.has(t.id)} onChange={e => {
                            const next = new Set(selectedTcs);
                            if (e.target.checked) next.add(t.id); else next.delete(t.id);
                            setSelectedTcs(next);
                          }} />
                          <span className="flex-1 truncate" title={t.id}>{t.name}</span>
                          {t.lastResult && <span className="text-[10px] uppercase text-slate-400">{t.lastResult}</span>}
                          {t.lastModifiedOn && <span className="text-[10px] text-slate-400 font-mono">{String(t.lastModifiedOn).slice(0, 10)}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            )}

            <label className="flex items-center gap-2 text-sm mb-4">
              <input type="checkbox" checked={stopOnFail} onChange={e => setStopOnFail(e.target.checked)} />
              <span>Stop on first failure</span>
            </label>

            <div className="flex gap-2 justify-end">
              <button onClick={resetWizard} className="rounded-md border border-slate-300 text-sm px-4 py-2">Cancel</button>
              <button onClick={saveSuite} disabled={!!busy} className="rounded-md bg-orange-500 hover:bg-orange-600 disabled:bg-slate-300 text-white text-sm font-medium px-4 py-2">
                {busy ? 'Saving…' : (editingId ? 'Update suite' : 'Save suite')}
              </button>
            </div>
          </section>
        )}

        {/* Run result */}
        {runResult && (
          <section className="bg-white border border-slate-200 rounded-xl p-5">
            <h2 className="text-base font-semibold text-slate-900 mb-3">
              Run: <code>{runResult.suiteName}</code>{' '}
              <span className="text-sm font-normal">— {runResult.passed}/{runResult.total} pass · {runResult.failed} fail</span>
            </h2>
            <div className="text-sm text-slate-700 mb-3">
              <span className="text-slate-500">Kind:</span> {runResult.kind}
              {runResult.uesimHost   && <> · <span className="text-slate-500">UESIM:</span> {runResult.uesimHost}</>}
              {runResult.callboxHost && <> · <span className="text-slate-500">Callbox:</span> {runResult.callboxHost}</>}
            </div>
            <div className="overflow-x-auto border border-slate-200 rounded-md">
              <table className="min-w-full text-xs">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    <th className="text-left px-3 py-2">#</th>
                    <th className="text-left px-3 py-2">{runResult.kind === 'uesim+callbox' ? 'Config file' : 'Testcase id'}</th>
                    <th className="text-center px-3 py-2">HTTP</th>
                    <th className="text-left px-3 py-2">Execution id</th>
                    <th className="text-right px-3 py-2">ms</th>
                    <th className="text-center px-3 py-2">Verdict</th>
                    <th className="text-left px-3 py-2">Detail</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {runResult.steps.map((s, i) => (
                    <tr key={i}>
                      <td className="px-3 py-1.5 text-slate-500">{i + 1}</td>
                      <td className="px-3 py-1.5 font-mono text-[11px]">{s.testcaseId}</td>
                      <td className="px-3 py-1.5 text-center font-mono">{s.status || '—'}</td>
                      <td className="px-3 py-1.5 font-mono text-[10px]">{s.executionId ?? '–'}</td>
                      <td className="px-3 py-1.5 text-right text-slate-500 font-mono">{s.durationMs}</td>
                      <td className={`px-3 py-1.5 text-center font-semibold ${s.ok ? 'text-emerald-700' : 'text-red-700'}`}>{s.ok ? 'PASS' : 'FAIL'}</td>
                      <td className="px-3 py-1.5 text-slate-600 text-[11px] max-w-md truncate" title={s.detail}>{s.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

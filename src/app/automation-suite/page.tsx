// /automation-suite — Automation Suite builder + runner.
//
// Workflow:
//   1. List saved suites at top, each with Run / Delete actions.
//   2. "+ New suite" → wizard:
//        a. name
//        b. setup kind: uesim-only | uesim+callbox
//        c. uesim system (always required; pulled from inventory)
//        d. (callbox path only) callbox system + eNB config —
//           either pick from /root/enb/config or upload a local file
//        e. testcase multi-select (pulled live from the chosen UESIM)
//   3. Save → POST /api/automation/suites
//   4. Run → POST /api/automation/suites/[id]/run, render verdict grid
//
// Both lists (testcases, callbox configs) are fetched lazily — only the
// chosen systems get hit, so the page is cheap when you're just browsing.

'use client';

import { useEffect, useState, useCallback } from 'react';

interface SystemRow {
  id: string; name: string; host: string; type: string;
}
interface SuiteRow {
  id: string; name: string;
  kind?: 'uesim-only' | 'uesim+callbox';
  uesimSystemId?: string; callboxSystemId?: string;
  callboxConfig?: { source: 'pick' | 'upload'; filename: string };
  testcaseIds: string[];
  stopOnFail?: boolean;
  updatedAt?: string;
}
interface UesimTestcase {
  id: string; name: string; description?: string;
  lastResult?: string | null; lastStatus?: string | null;
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
  kind: string; uesimHost: string; callboxHost?: string;
  callboxConfigName?: string; callboxConfigPushed?: boolean;
  total: number; passed: number; failed: number;
  steps: SuiteRunStep[];
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
  const [callboxFiles, setCbxFiles]   = useState<CallboxFile[]>([]);
  const [callboxConfigSource, setCfgSrc] = useState<'pick' | 'upload'>('pick');
  const [callboxConfigName, setCfgName]  = useState<string>('');
  const [callboxConfigUpload, setCfgUpload] = useState<{ filename: string; contentBase64: string } | null>(null);
  const [uesimTestcases, setUeTcs] = useState<UesimTestcase[]>([]);
  const [tcSelected, setTcSel]      = useState<Set<string>>(new Set());
  const [tcFilter, setTcFilter]     = useState<string>('');
  const [stopOnFail, setStopOnFail] = useState<boolean>(false);
  const [loadingTc, setLoadingTc]   = useState(false);
  const [loadingCbx, setLoadingCbx] = useState(false);

  // Run state ────────────────────────────────────────────────────────────
  const [runResult, setRunResult] = useState<SuiteRunResult | null>(null);
  const [running, setRunning]     = useState<string>('');

  // Initial load: systems + suites ─────────────────────────────────────
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

  // Helpers ─────────────────────────────────────────────────────────────
  const uesimSystems = systems.filter(s => /UESIM|SIMNOVATOR/i.test(s.type));
  const callboxSystems = systems.filter(s => /CALLBOX/i.test(s.type));

  const loadCallboxConfigs = useCallback(async (sysId: string) => {
    if (!sysId) { setCbxFiles([]); return; }
    setLoadingCbx(true);
    try {
      const r = await fetch(`/api/automation/callbox-configs?systemId=${encodeURIComponent(sysId)}`).then(r => r.json());
      setCbxFiles(r?.ok ? (r.files ?? []) : []);
      if (!r?.ok) setError(r?.error ?? 'failed to list callbox configs');
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

  const onPickFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) { setCfgUpload(null); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const data = String(reader.result ?? '');
      const b64 = data.includes(',') ? data.split(',', 2)[1] : btoa(data);
      setCfgUpload({ filename: f.name, contentBase64: b64 });
    };
    reader.readAsDataURL(f);
  }, []);

  const resetWizard = useCallback(() => {
    setEditingId(''); setName(''); setKind('uesim-only');
    setUesim(''); setCbx(''); setCbxFiles([]);
    setCfgSrc('pick'); setCfgName(''); setCfgUpload(null);
    setUeTcs([]); setTcSel(new Set()); setStopOnFail(false);
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
    setCfgSrc(s.callboxConfig?.source ?? 'pick');
    setCfgName(s.callboxConfig?.filename ?? '');
    setTcSel(new Set(s.testcaseIds));
    setStopOnFail(!!s.stopOnFail);
    setShowWizard(true);
    if (s.callboxSystemId) void loadCallboxConfigs(s.callboxSystemId);
    if (s.uesimSystemId) void loadUesimTestcases(s.uesimSystemId);
  }, [resetWizard, loadCallboxConfigs, loadUesimTestcases]);

  const saveSuite = async () => {
    if (!name.trim()) { setError('name required'); return; }
    if (!uesimSystemId) { setError('UESIM system required'); return; }
    if (kind === 'uesim+callbox' && !callboxSystemId) { setError('callbox system required'); return; }
    if (kind === 'uesim+callbox' && callboxConfigSource === 'pick' && !callboxConfigName) { setError('pick a config file from /root/enb/config'); return; }
    if (kind === 'uesim+callbox' && callboxConfigSource === 'upload' && !callboxConfigUpload) { setError('choose a file to upload'); return; }

    const payload: any = {
      name: name.trim(),
      kind,
      uesimSystemId,
      callboxSystemId: kind === 'uesim+callbox' ? callboxSystemId : undefined,
      callboxConfig: kind === 'uesim+callbox' ? (
        callboxConfigSource === 'pick'
          ? { source: 'pick', filename: callboxConfigName }
          : { source: 'upload', filename: callboxConfigUpload!.filename, contentBase64: callboxConfigUpload!.contentBase64 }
      ) : undefined,
      testcaseIds: [...tcSelected],
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
    if (!window.confirm(`Run suite "${s.name}" (${s.testcaseIds.length} testcase${s.testcaseIds.length === 1 ? '' : 's'})?`)) return;
    setRunning(s.id); setRunResult(null); setError('');
    try {
      const r = await fetch(`/api/automation/suites/${s.id}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d?.error ?? `HTTP ${r.status}`);
      setRunResult(d.result);
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

  // Auto-load callbox configs when callbox system changes
  useEffect(() => {
    if (kind === 'uesim+callbox' && callboxSystemId) void loadCallboxConfigs(callboxSystemId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, callboxSystemId]);
  // Auto-load testcases when uesim system changes
  useEffect(() => { if (uesimSystemId) void loadUesimTestcases(uesimSystemId); }, [uesimSystemId, loadUesimTestcases]);

  const filteredTcs = uesimTestcases.filter(t => !tcFilter || t.name.toLowerCase().includes(tcFilter.toLowerCase()));

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="max-w-7xl mx-auto px-6 py-8">
        <header className="mb-6">
          <h1 className="text-2xl font-bold text-slate-900">Automation Suite</h1>
          <p className="text-sm text-slate-600 mt-1">
            Build named bundles of testcases bound to a specific lab setup — UESIM-only or UESIM + callbox.
            Save once; click Run to fire the whole bundle against the box.
          </p>
        </header>

        {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">{error}</div>}

        {/* Suite list */}
        <section className="bg-white border border-slate-200 rounded-xl p-5 mb-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-semibold text-slate-900">Saved suites ({suites.length})</h2>
            <button onClick={openNew} className="rounded-md bg-orange-500 hover:bg-orange-600 text-white text-sm font-medium px-4 py-2">
              + New suite
            </button>
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
                    <th className="text-left px-3 py-2 font-medium">eNB config</th>
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
                      <td className="px-3 py-2 text-slate-700 font-mono text-xs">{s.callboxConfig?.filename ?? '–'}</td>
                      <td className="px-3 py-2 text-right">{s.testcaseIds.length}</td>
                      <td className="px-3 py-2 text-right text-xs text-slate-500">{s.updatedAt?.slice(0, 19).replace('T', ' ') ?? '–'}</td>
                      <td className="px-3 py-2 text-right">
                        <button onClick={() => runSuite(s)} disabled={running === s.id} className="rounded-md bg-blue-500 hover:bg-blue-600 disabled:bg-slate-300 text-white text-xs px-2 py-1 mr-1">
                          {running === s.id ? 'Running…' : 'Run'}
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

        {/* Wizard */}
        {showWizard && (
          <section className="bg-white border border-slate-200 rounded-xl p-5 mb-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold text-slate-900">{editingId ? 'Edit suite' : 'New suite'}</h2>
              <button onClick={resetWizard} className="text-sm text-slate-500 hover:text-slate-900">Cancel</button>
            </div>

            {/* Step 1: name */}
            <div className="grid grid-cols-2 gap-4 mb-4">
              <label className="flex flex-col">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Suite name</span>
                <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. NR-SA n78 nightly" className="border border-slate-300 rounded-md px-3 py-2 text-sm" />
              </label>
              <label className="flex flex-col">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Setup kind</span>
                <select value={kind} onChange={e => setKind(e.target.value as Kind)} className="border border-slate-300 rounded-md px-3 py-2 text-sm">
                  <option value="uesim-only">UESIM only — pull testcases from a Simnovator</option>
                  <option value="uesim+callbox">UESIM + Callbox — also bind an eNB config</option>
                </select>
              </label>
            </div>

            {/* Step 2: systems */}
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

            {/* Step 3: callbox config (callbox path only) */}
            {kind === 'uesim+callbox' && callboxSystemId && (
              <div className="mb-4 border border-slate-200 rounded-md p-3 bg-slate-50/50">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-2">eNB config</div>
                <div className="flex gap-4 text-sm mb-3">
                  <label className="flex items-center gap-1 cursor-pointer">
                    <input type="radio" checked={callboxConfigSource === 'pick'} onChange={() => setCfgSrc('pick')} />
                    <span>Pick from <code>/root/enb/config</code> on callbox</span>
                  </label>
                  <label className="flex items-center gap-1 cursor-pointer">
                    <input type="radio" checked={callboxConfigSource === 'upload'} onChange={() => setCfgSrc('upload')} />
                    <span>Upload my own</span>
                  </label>
                </div>
                {callboxConfigSource === 'pick' && (
                  <div>
                    {loadingCbx ? (
                      <div className="text-sm text-slate-500">Loading config files via SSH…</div>
                    ) : callboxFiles.length === 0 ? (
                      <div className="text-sm text-slate-500">No files (or SSH failed). Confirm the callbox has SSH creds in inventory.yaml.</div>
                    ) : (
                      <select value={callboxConfigName} onChange={e => setCfgName(e.target.value)} className="border border-slate-300 rounded-md px-3 py-2 text-sm w-full">
                        <option value="">— pick a config file —</option>
                        {callboxFiles.map(f => (
                          <option key={f.name} value={f.name}>{f.name} ({f.size} bytes, {f.mtime})</option>
                        ))}
                      </select>
                    )}
                  </div>
                )}
                {callboxConfigSource === 'upload' && (
                  <div>
                    <input type="file" onChange={onPickFile} className="text-sm" />
                    {callboxConfigUpload && (
                      <div className="text-xs text-slate-500 mt-1">
                        Selected: <code>{callboxConfigUpload.filename}</code> ({Math.round(callboxConfigUpload.contentBase64.length * 0.75)} bytes)
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Step 4: testcase multi-select */}
            {uesimSystemId && (
              <div className="mb-4 border border-slate-200 rounded-md p-3 bg-slate-50/50">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                    Testcases from {uesimSystemId} ({tcSelected.size} selected of {uesimTestcases.length})
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
                          <input type="checkbox" checked={tcSelected.has(t.id)} onChange={e => {
                            const next = new Set(tcSelected);
                            if (e.target.checked) next.add(t.id); else next.delete(t.id);
                            setTcSel(next);
                          }} />
                          <span className="flex-1 truncate" title={t.id}>{t.name}</span>
                          {t.lastResult && <span className="text-[10px] uppercase text-slate-400">{t.lastResult}</span>}
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
              <span className="text-slate-500">UESIM:</span> {runResult.uesimHost}
              {runResult.callboxHost && <> · <span className="text-slate-500">Callbox:</span> {runResult.callboxHost}</>}
              {runResult.callboxConfigName && <> · <span className="text-slate-500">Config:</span> <code>{runResult.callboxConfigName}</code></>}
            </div>
            <div className="overflow-x-auto border border-slate-200 rounded-md">
              <table className="min-w-full text-xs">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    <th className="text-left px-3 py-2">#</th>
                    <th className="text-left px-3 py-2">Testcase</th>
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

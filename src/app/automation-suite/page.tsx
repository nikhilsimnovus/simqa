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
  kind: string; uesimHost?: string; callboxHost?: string;
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

  // UESIM-only data: testcases pulled from Simnovator REST
  const [uesimTestcases, setUeTcs]    = useState<UesimTestcase[]>([]);
  const [loadingTc, setLoadingTc]     = useState(false);

  // Callbox data: file list from /root/enb/config + any blobs the user
  // is layering on top via Upload
  const [callboxFiles, setCbxFiles]   = useState<CallboxFile[]>([]);
  const [loadingCbx, setLoadingCbx]   = useState(false);
  const [uploadedConfigs, setUploads] = useState<Record<string, string>>({});

  // Common: the set of selected items (interpreted per-kind)
  const [selected, setSelected]       = useState<Set<string>>(new Set());
  const [filter, setFilter]           = useState<string>('');
  const [stopOnFail, setStopOnFail]   = useState<boolean>(false);

  // Run state ────────────────────────────────────────────────────────────
  const [runResult, setRunResult] = useState<SuiteRunResult | null>(null);
  const [running, setRunning]     = useState<string>('');

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

  /** "Add an upload" — reads one or more files into base64 and merges
   *  them into uploadedConfigs. Pre-selects them too. */
  const onPickUploads = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    let done = 0;
    const next: Record<string, string> = { ...uploadedConfigs };
    const sel = new Set(selected);
    for (const f of files) {
      const reader = new FileReader();
      reader.onload = () => {
        const data = String(reader.result ?? '');
        const b64 = data.includes(',') ? data.split(',', 2)[1] : btoa(data);
        next[f.name] = b64;
        sel.add(f.name);
        done += 1;
        if (done === files.length) { setUploads(next); setSelected(sel); }
      };
      reader.readAsDataURL(f);
    }
    // Reset so the same file can be re-uploaded.
    e.target.value = '';
  }, [uploadedConfigs, selected]);

  const removeUpload = useCallback((filename: string) => {
    const next = { ...uploadedConfigs };
    delete next[filename];
    setUploads(next);
    const sel = new Set(selected); sel.delete(filename); setSelected(sel);
  }, [uploadedConfigs, selected]);

  const resetWizard = useCallback(() => {
    setEditingId(''); setName(''); setKind('uesim-only');
    setUesim(''); setCbx(''); setCbxFiles([]); setUploads({});
    setUeTcs([]); setSelected(new Set()); setStopOnFail(false); setFilter('');
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
    setSelected(new Set(s.testcaseIds));
    setStopOnFail(!!s.stopOnFail);
    setShowWizard(true);
    if (s.callboxSystemId && s.kind === 'uesim+callbox') void loadCallboxConfigs(s.callboxSystemId);
    if (s.uesimSystemId   && s.kind === 'uesim-only')    void loadUesimTestcases(s.uesimSystemId);
  }, [resetWizard, loadCallboxConfigs, loadUesimTestcases]);

  const saveSuite = async () => {
    if (!name.trim())     { setError('name required'); return; }
    if (!uesimSystemId)   { setError('UESIM system required'); return; }
    if (kind === 'uesim+callbox' && !callboxSystemId) { setError('callbox system required'); return; }
    if (selected.size === 0) { setError('pick at least one testcase / config'); return; }

    const payload: any = {
      name: name.trim(),
      kind,
      uesimSystemId,
      callboxSystemId: kind === 'uesim+callbox' ? callboxSystemId : undefined,
      uploadedConfigs: kind === 'uesim+callbox' ? uploadedConfigs : undefined,
      testcaseIds: [...selected],
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
    const what = s.kind === 'uesim+callbox' ? 'config file(s) onto the callbox' : 'testcase(s) on the Simnovator';
    if (!window.confirm(`Run suite "${s.name}" — fires ${s.testcaseIds.length} ${what}?`)) return;
    setRunning(s.id); setRunResult(null); setError('');
    try {
      const r = await fetch(`/api/automation/suites/${s.id}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
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

  // Auto-load the right kind of testcase list when systems change.
  useEffect(() => {
    if (kind === 'uesim+callbox' && callboxSystemId) void loadCallboxConfigs(callboxSystemId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, callboxSystemId]);
  useEffect(() => {
    if (kind === 'uesim-only' && uesimSystemId) void loadUesimTestcases(uesimSystemId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, uesimSystemId]);
  // Switching kind wipes selections (they mean different things in each mode)
  useEffect(() => { setSelected(new Set()); }, [kind]);

  // Build the unified "items to select" list for the multi-select.
  // UESIM-only: Simnovator testcases. Callbox: the on-box files + any
  // upload entries the user added (uploads bubble to the top + are tagged).
  type Item = { id: string; label: string; sub?: string; upload?: boolean };
  const items: Item[] = kind === 'uesim+callbox'
    ? [
        ...Object.keys(uploadedConfigs).map(fn => ({ id: fn, label: fn, sub: 'uploaded — will be scp\'d on run', upload: true })),
        ...callboxFiles.map(f => ({ id: f.name, label: f.name, sub: `${f.size}B · ${f.mtime}` })),
      ]
    : uesimTestcases.map(t => ({ id: t.id, label: t.name, sub: t.lastResult ? `last: ${t.lastResult}` : undefined }));
  const filteredItems = items.filter(it => !filter || it.label.toLowerCase().includes(filter.toLowerCase()));

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
                    <th className="text-right px-3 py-2 font-medium">Tests</th>
                    <th className="text-right px-3 py-2 font-medium">Uploads</th>
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
                      <td className="px-3 py-2 text-right">{s.testcaseIds.length}</td>
                      <td className="px-3 py-2 text-right">{Object.keys(s.uploadedConfigs ?? {}).length}</td>
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

            {/* The big multi-select — items differ by kind */}
            {((kind === 'uesim-only' && uesimSystemId) || (kind === 'uesim+callbox' && callboxSystemId)) && (
              <div className="mb-4 border border-slate-200 rounded-md p-3 bg-slate-50/50">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                    {kind === 'uesim-only'
                      ? <>Testcases from <code>{uesimSystemId}</code> ({selected.size} selected of {uesimTestcases.length})</>
                      : <>Configs in <code>/root/enb/config</code> on <code>{callboxSystemId}</code> ({selected.size} selected of {items.length})</>}
                  </div>
                  <input type="search" placeholder="filter…" value={filter} onChange={e => setFilter(e.target.value)} className="border border-slate-300 rounded-md px-2 py-1 text-xs" />
                </div>

                <div className="border border-slate-200 rounded-md bg-white max-h-72 overflow-y-auto">
                  {(loadingTc || loadingCbx) ? (
                    <div className="p-3 text-sm text-slate-500">Loading…</div>
                  ) : filteredItems.length === 0 ? (
                    <div className="p-3 text-sm text-slate-500">
                      {kind === 'uesim+callbox' ? 'No files in /root/enb/config (or SSH failed). Add some via Upload below.' : 'No testcases match.'}
                    </div>
                  ) : (
                    <ul className="divide-y divide-slate-100 text-sm">
                      {filteredItems.map(it => (
                        <li key={it.id} className="px-3 py-1.5 flex items-center gap-2 hover:bg-slate-50">
                          <input type="checkbox" checked={selected.has(it.id)} onChange={e => {
                            const next = new Set(selected);
                            if (e.target.checked) next.add(it.id); else next.delete(it.id);
                            setSelected(next);
                          }} />
                          <span className="flex-1 truncate" title={it.id}>{it.label}</span>
                          {it.upload && (
                            <button type="button" onClick={() => removeUpload(it.id)} className="text-[10px] text-red-600 hover:underline" title="Remove this upload">remove</button>
                          )}
                          {it.sub && <span className="text-[10px] text-slate-400 truncate">{it.sub}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                {/* Upload-only when callbox kind */}
                {kind === 'uesim+callbox' && (
                  <div className="mt-3 flex items-center gap-3 text-sm">
                    <label className="cursor-pointer rounded-md border border-slate-300 px-3 py-1.5 hover:bg-slate-100">
                      Upload .cfg file(s)…
                      <input type="file" multiple onChange={onPickUploads} className="hidden" />
                    </label>
                    <span className="text-xs text-slate-500">
                      Uploaded files are scp'd to <code>/root/enb/config/&lt;name&gt;</code> on the callbox when the suite runs.
                    </span>
                  </div>
                )}
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

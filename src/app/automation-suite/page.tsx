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
import { cn } from '@/lib/cn';

interface SystemRow {
  id: string; name: string; host: string; type: string;
}
interface SuiteItem {
  id: string;
  name: string;
  simnovatorTcId: string;
  callboxCfg?: string;
  durationSec?: number;
}
interface SuiteRow {
  id: string; name: string;
  kind?: 'uesim-only' | 'uesim+callbox';
  uesimSystemId?: string; callboxSystemId?: string;
  uploadedConfigs?: Record<string, string>;
  callboxConfig?: string;
  testcaseIds: string[];
  defaultDurationSec?: number;
  testcaseDurations?: Record<string, number>;
  items?: SuiteItem[];
  stopOnFail?: boolean;
  removeConfigAfterRun?: boolean;
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
  executionId?: string;
  verdict?: string; boxStatus?: string; stopped?: boolean;
  detail?: string; durationMs: number;
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
  const [invWarnings, setInvWarnings] = useState<string[]>([]);
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
  /** Non-fatal notice when the box served fewer testcases than it claims to
   *  hold (the REST list is capped at ~1000 rows — see uesim-testcases route). */
  const [tcNotice, setTcNotice]       = useState('');

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
  // Default ON: after each item the runner removes the simqa-deployed
  // cfg + enb.cfg symlink so the callbox stays tidy.
  const [removeCfgAfterRun, setRemoveCfgAfterRun] = useState<boolean>(true);
  // Duration controls
  const [defaultDur, setDefaultDur]     = useState<number>(10);
  const [perTcDur,   setPerTcDur]       = useState<Record<string, number>>({});
  const [massDurInput, setMassDurInput] = useState<string>('10');
  // ── Items list (new): each row pairs (Simnovator tc + callbox cfg).
  const [items, setItems]               = useState<SuiteItem[]>([]);
  // "Add row" picker state
  const [addTcId,  setAddTcId]          = useState<string>('');
  const [addCfg,   setAddCfg]           = useState<string>('');
  // Wizard tab state
  const [tab, setTab]                   = useState<'setup' | 'testcases' | 'results'>('setup');
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
      setInvWarnings(((sysR?.warnings ?? []) as Array<{ message: string }>).map((w) => w.message));
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
      setTcNotice(r?.ok && r.truncated
        ? `showing ${r.total} of ${r.serverTotal} testcases — the box's REST list cannot serve rows past ~1000; older testcases are not selectable here`
        : '');
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
    setStopOnFail(false); setRemoveCfgAfterRun(true); setCbxFilter(''); setTcFilter('');
    setDefaultDur(10); setPerTcDur({}); setMassDurInput('10');
    setItems([]); setAddTcId(''); setAddCfg('');
    setTab('setup');
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
    setDefaultDur(s.defaultDurationSec ?? 10);
    setPerTcDur(s.testcaseDurations ?? {});
    setMassDurInput(String(s.defaultDurationSec ?? 10));
    setRemoveCfgAfterRun(s.removeConfigAfterRun !== false);
    // Items: prefer the new items[]; if absent (legacy suite), synthesize
    // from the flat testcaseIds list + shared callboxConfig.
    if (s.items && s.items.length > 0) {
      setItems(s.items);
    } else {
      const synth: SuiteItem[] = s.testcaseIds.map((tcId, i) => ({
        id: `item-${i}-${Math.random().toString(36).slice(2, 8)}`,
        name: tcId,                       // user can rename
        simnovatorTcId: tcId,
        callboxCfg: s.kind === 'uesim+callbox' ? s.callboxConfig : undefined,
        durationSec: s.testcaseDurations?.[tcId],
      }));
      setItems(synth);
    }
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
    if (items.length === 0 && tcs.length === 0) {
      setError('add at least one testcase row on the Testcases tab');
      return;
    }

    // Only persist the upload blob that corresponds to the selected
    // config — drop the rest so the suite record stays small.
    const trimmedUploads = (kind === 'uesim+callbox' && cfg && uploadedConfigs[cfg])
      ? { [cfg]: uploadedConfigs[cfg] }
      : undefined;

    // Trim per-testcase durations to ONLY the selected testcases so the
    // suite record doesn't carry stale entries for tcs we unchecked.
    const trimmedDurs: Record<string, number> = {};
    for (const id of tcs) if (perTcDur[id] && perTcDur[id] > 0) trimmedDurs[id] = perTcDur[id];

    // Keep ALL referenced uploads in the saved suite — each item can
    // reference a different uploaded cfg, so don't trim by selectedCfg.
    const itemUploads: Record<string, string> = {};
    if (kind === 'uesim+callbox') {
      for (const it of items) {
        if (it.callboxCfg && uploadedConfigs[it.callboxCfg]) {
          itemUploads[it.callboxCfg] = uploadedConfigs[it.callboxCfg];
        }
      }
    }
    const trimmedItemUploads = Object.keys(itemUploads).length ? itemUploads : undefined;

    const payload: any = {
      name: name.trim(),
      kind,
      uesimSystemId,
      callboxSystemId: kind === 'uesim+callbox' ? callboxSystemId : undefined,
      uploadedConfigs: trimmedItemUploads ?? trimmedUploads,
      // Legacy fields stay populated for old consumers, but the runner
      // prefers items[] when present.
      callboxConfig: kind === 'uesim+callbox' ? (cfg || undefined) : undefined,
      testcaseIds: items.length > 0 ? items.map(it => it.simnovatorTcId) : tcs,
      defaultDurationSec: defaultDur > 0 ? defaultDur : 10,
      testcaseDurations: Object.keys(trimmedDurs).length ? trimmedDurs : undefined,
      items: items.length > 0 ? items : undefined,
      stopOnFail,
      removeConfigAfterRun: removeCfgAfterRun,
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
    const dur = s.defaultDurationSec ?? 10;
    const summary = s.kind === 'uesim+callbox'
      ? `Push callbox cfg ${s.callboxConfig ? `'${s.callboxConfig}'` : '(none)'} → ln -sf enb.cfg → service lte restart → trigger ${tcN} testcase${tcN === 1 ? '' : 's'} (poll up to ${dur}s each)`
      : `Trigger ${tcN} Simnovator testcase${tcN === 1 ? '' : 's'} (poll up to ${dur}s each)`;
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
    // uesim-only (or no callbox selected): clear any callbox configs left over
    // from a previously-opened uesim+callbox suite so the cfg picker never
    // shows another system's configs.
    else { setCbxFiles([]); setCbxLoadError(''); }
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

        {invWarnings.length > 0 && (
          <div className="mb-4 text-sm text-amber-900 bg-amber-50 border border-amber-300 rounded-md px-3 py-2">
            <div className="font-semibold mb-1">⚠ Inventory needs attention</div>
            <ul className="list-disc pl-5 space-y-0.5">
              {invWarnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          </div>
        )}

        {/* Suite list */}
        <section className="bg-surface border border-slate-200 rounded-xl p-5 mb-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-semibold text-slate-900">Saved suites ({suites.length})</h2>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 text-xs text-slate-600 cursor-pointer">
                <input type="checkbox" checked={collectDiagnostics} onChange={e => setCollectDx(e.target.checked)} />
                <span>Collect diagnostics (perf-qa) on Run</span>
              </label>
              <button onClick={openNew} className="rounded-md bg-orange-500 hover:bg-orange-600 text-on-accent text-sm font-medium px-4 py-2">
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
                      <td className="px-3 py-2 font-mono text-xs">
                        {s.items?.some(it => it.callboxCfg) ? `${new Set(s.items.filter(it => it.callboxCfg).map(it => it.callboxCfg)).size} cfg(s)` : (s.callboxConfig ?? '–')}
                      </td>
                      <td className="px-3 py-2 text-right">{s.items?.length ?? s.testcaseIds.length}</td>
                      <td className="px-3 py-2 text-right text-xs text-slate-500">{s.updatedAt?.slice(0, 19).replace('T', ' ') ?? '–'}</td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        <button onClick={() => runSuite(s)} disabled={running === s.id} className="rounded-md bg-blue-500 hover:bg-blue-600 disabled:bg-slate-300 text-on-accent text-xs px-2 py-1 mr-1">
                          {running === s.id ? 'Running…' : 'Run'}
                        </button>
                        <button onClick={() => historyFor === s.id ? setHistoryFor('') : loadHistory(s.id)} className={`rounded-md text-xs px-2 py-1 mr-1 border ${historyFor === s.id ? 'bg-slate-800 text-on-accent border-slate-800' : 'border-slate-300 hover:bg-slate-50'}`}>
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
          <section className="bg-surface border border-slate-200 rounded-xl p-5 mb-6">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-base font-semibold text-slate-900">
                Runs for <code>{historyFor}</code> ({history.length})
              </h2>
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500">
                  Check 2 runs to compare ({compareSel.size}/2)
                </span>
                <button onClick={runCompare} disabled={compareSel.size !== 2 || compareBusy}
                  className="rounded-md bg-blue-500 hover:bg-blue-600 disabled:bg-slate-300 text-on-accent text-xs px-3 py-1">
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
                <div className="overflow-x-auto border border-slate-200 rounded-md bg-surface max-h-96">
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
          <section className="bg-surface border border-slate-200 rounded-xl p-5 mb-6">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-base font-semibold text-slate-900">{editingId ? 'Edit suite' : 'New suite'}</h2>
              <button onClick={resetWizard} className="text-sm text-slate-500 hover:text-slate-900">Cancel</button>
            </div>

            {/* Tab strip — explicit step counter so the user sees the flow */}
            <div className="flex items-center gap-1 border-b border-slate-200 mb-5">
              {([
                { id: 'setup',     label: '① Setup',      hint: 'name · systems · radio config' },
                { id: 'testcases', label: '② Testcases',  hint: 'pick + durations' },
                { id: 'results',   label: '③ Run',        hint: editingId ? 'history + diagnostics' : 'after Save you can run from the list' },
              ] as const).map(t => (
                <button key={t.id} type="button" onClick={() => setTab(t.id)}
                  className={cn(
                    'px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors',
                    tab === t.id ? 'border-orange-500 text-slate-900' : 'border-transparent text-slate-500 hover:text-slate-700',
                  )}
                  title={t.hint}>
                  {t.label}
                </button>
              ))}
            </div>

            {/* ── Tab 1: Setup ─────────────────────────────────── */}
            {tab === 'setup' && (<>
            <div className="grid grid-cols-2 gap-4 mb-4">
              <label className="flex flex-col">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Suite name</span>
                <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. NR-SA n78 nightly" className="border border-slate-300 rounded-md px-3 py-2 text-sm" />
              </label>
              <label className="flex flex-col">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Setup kind</span>
                <select value={kind} onChange={e => setKind(e.target.value as Kind)} className="border border-slate-300 rounded-md px-3 py-2 text-sm">
                  <option value="uesim-only">UESIM only — testcases from Simnovator REST</option>
                  <option value="uesim+callbox">UESIM + Callbox — also bind an eNB .cfg</option>
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

            {/* Setup tab is now JUST about systems — per-row eNB cfg
                lives on the Testcases tab where each row pairs a
                Simnovator testcase with its own callbox cfg. */}
            {kind === 'uesim+callbox' && callboxSystemId && (
              <div className="text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-md px-3 py-2 mb-4">
                Each testcase row pairs a Simnovator testcase with an eNB cfg file —
                pick those on the <strong>Testcases</strong> tab. (eNB cfg list is fetched
                via SSH from <code>/root/enb/config</code> on <code>{callboxSystemId}</code>.)
              </div>
            )}

            <div className="flex justify-end mt-4">
              <button onClick={() => setTab('testcases')} className="rounded-md bg-slate-800 hover:bg-slate-900 text-on-accent text-sm px-4 py-2">Next: Testcases →</button>
            </div>
            </>)}

            {/* ── Tab 2: Testcases (items table) ─────────────────── */}
            {tab === 'testcases' && (<>
            {!uesimSystemId ? (
              <div className="text-sm text-slate-500 py-6 text-center">
                Pick a UESIM/Simnovator system on the Setup tab first.
              </div>
            ) : (<>
              {tcNotice && (
                <div className="mb-3 rounded-md border border-amber-300 bg-amber-50 text-amber-800 text-xs px-3 py-2">
                  ⚠ {tcNotice}
                </div>
              )}
              {/* Default duration knob (suite-wide) */}
              <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
                <label className="flex items-center gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Default duration (sec)</span>
                  <input type="number" min={1} value={defaultDur} onChange={e => setDefaultDur(Math.max(1, Number(e.target.value) || 1))} className="border border-slate-300 rounded-md px-2 py-1 w-[80px] text-sm" />
                </label>
                <span className="text-xs text-slate-400">|</span>
                <label className="flex items-center gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Apply to all rows</span>
                  <input type="number" min={1} value={massDurInput} onChange={e => setMassDurInput(e.target.value)} className="border border-slate-300 rounded-md px-2 py-1 w-[80px] text-sm" />
                  <button type="button" onClick={() => {
                    const n = Math.max(1, Number(massDurInput) || 1);
                    setItems(items.map(it => ({ ...it, durationSec: n })));
                  }} disabled={items.length === 0} className="rounded-md bg-slate-800 hover:bg-slate-900 disabled:bg-slate-300 text-on-accent text-xs px-2 py-1">Apply</button>
                </label>
                <button type="button" onClick={() => setItems(items.map(it => ({ ...it, durationSec: undefined })))} className="text-xs text-slate-500 hover:text-slate-900 underline">clear all overrides</button>
              </div>

              {/* Items table — one row = (simnovator tc + callbox cfg + display name + duration) */}
              <div className="mb-3 border border-slate-200 rounded-md bg-surface overflow-x-auto">
                <table className="min-w-full text-xs">
                  <thead className="bg-slate-50 text-slate-600">
                    <tr>
                      <th className="px-2 py-1.5 text-left w-8">#</th>
                      <th className="px-2 py-1.5 text-left">Display name (editable)</th>
                      <th className="px-2 py-1.5 text-left">Simnovator testcase</th>
                      {kind === 'uesim+callbox' && <th className="px-2 py-1.5 text-left">eNB cfg</th>}
                      <th className="px-2 py-1.5 text-right">Duration (s)</th>
                      <th className="px-2 py-1.5"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {items.length === 0 ? (
                      <tr><td colSpan={kind === 'uesim+callbox' ? 6 : 5} className="px-3 py-4 text-center text-slate-500">No testcases yet. Add one below.</td></tr>
                    ) : items.map((it, i) => {
                      const tc = uesimTestcases.find(t => t.id === it.simnovatorTcId);
                      const updateItem = (patch: Partial<SuiteItem>) => {
                        const next = [...items]; next[i] = { ...it, ...patch }; setItems(next);
                      };
                      return (
                        <tr key={it.id} className="hover:bg-slate-50">
                          <td className="px-2 py-1 text-slate-400">{i + 1}</td>
                          <td className="px-2 py-1">
                            <input value={it.name} onChange={e => updateItem({ name: e.target.value })}
                              className="border border-slate-300 rounded px-2 py-1 text-xs w-full" />
                          </td>
                          <td className="px-2 py-1 font-mono text-[11px] text-slate-600 truncate max-w-[260px]" title={it.simnovatorTcId}>
                            {tc?.name ?? it.simnovatorTcId}
                          </td>
                          {kind === 'uesim+callbox' && (
                            <td className="px-2 py-1 font-mono text-[11px] text-slate-600">
                              {it.callboxCfg ?? <span className="text-slate-400 italic">(none)</span>}
                              {it.callboxCfg && uploadedConfigs[it.callboxCfg] && <span className="text-[9px] text-emerald-700 ml-1">[upload]</span>}
                            </td>
                          )}
                          <td className="px-2 py-1 text-right">
                            <input type="number" min={1} placeholder={String(defaultDur)} value={it.durationSec ?? ''}
                              onChange={e => updateItem({ durationSec: e.target.value === '' ? undefined : Math.max(1, Number(e.target.value) || 1) })}
                              className="border border-slate-300 rounded px-1 py-0.5 w-[64px] text-xs text-right" />
                          </td>
                          <td className="px-2 py-1 text-right">
                            <button type="button" onClick={() => setItems(items.filter((_, j) => j !== i))} className="text-xs text-red-600 hover:underline">remove</button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Add-row picker */}
              <div className="mb-4 border border-slate-200 rounded-md p-3 bg-slate-50/50">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-2">Add a testcase row</div>
                <div className="grid grid-cols-3 gap-2 items-end">
                  <label className="flex flex-col text-xs">
                    <span className="text-slate-500 mb-1">Simnovator testcase</span>
                    <select value={addTcId} onChange={e => setAddTcId(e.target.value)} className="border border-slate-300 rounded-md px-2 py-1 text-xs">
                      <option value="">— pick —</option>
                      {uesimTestcases.map(t => (
                        <option key={t.id} value={t.id}>{t.name}</option>
                      ))}
                    </select>
                  </label>
                  {kind === 'uesim+callbox' && (
                    <label className="flex flex-col text-xs">
                      <span className="text-slate-500 mb-1">eNB cfg (/root/enb/config or upload)</span>
                      <select value={addCfg} onChange={e => setAddCfg(e.target.value)} className="border border-slate-300 rounded-md px-2 py-1 text-xs">
                        <option value="">— pick —</option>
                        {Object.keys(uploadedConfigs).map(fn => (
                          <option key={fn} value={fn}>{fn} (uploaded)</option>
                        ))}
                        {callboxFiles.map(f => (
                          <option key={f.name} value={f.name}>{f.name} · {f.mtime}</option>
                        ))}
                      </select>
                    </label>
                  )}
                  <div className="flex gap-2">
                    <button type="button" onClick={async () => {
                      if (!addTcId) return;
                      const tc = uesimTestcases.find(t => t.id === addTcId);
                      const cfgName = kind === 'uesim+callbox' && addCfg ? addCfg : undefined;
                      // If the user picked an EXISTING file on the callbox
                      // (i.e. not already in uploadedConfigs), pull it DOWN
                      // first + stash in uploadedConfigs so the suite is
                      // self-contained. Runner deploys from the local
                      // blob with a sanitized name + cleans up after.
                      let nextUploads = uploadedConfigs;
                      if (cfgName && !uploadedConfigs[cfgName] && callboxSystemId) {
                        try {
                          const r = await fetch('/api/automation/callbox-configs/download', {
                            method: 'POST', headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ systemId: callboxSystemId, filename: cfgName }),
                          });
                          const d = await r.json();
                          if (d.ok && d.contentBase64) {
                            nextUploads = { ...uploadedConfigs, [cfgName]: d.contentBase64 };
                            setUploads(nextUploads);
                          } else {
                            // Surface the failure but still let the user
                            // add the row — the runner's legacy cp path
                            // can deploy it from the box at runtime.
                            setError('cfg download failed: ' + (d.error ?? 'unknown') + ' (suite will fall back to in-place cp at run time)');
                          }
                        } catch (e: any) {
                          setError('cfg download threw: ' + (e?.message ?? e));
                        }
                      }
                      const newItem: SuiteItem = {
                        id: `item-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
                        name: tc?.name ?? addTcId,
                        simnovatorTcId: addTcId,
                        callboxCfg: cfgName,
                      };
                      setItems([...items, newItem]);
                      setAddTcId(''); setAddCfg('');
                    }} disabled={!addTcId || (kind === 'uesim+callbox' && !addCfg)} className="rounded-md bg-orange-500 hover:bg-orange-600 disabled:bg-slate-300 text-on-accent text-sm px-3 py-1.5">
                      + Add
                    </button>
                    {kind === 'uesim+callbox' && (
                      <label className="cursor-pointer rounded-md border border-slate-300 px-3 py-1.5 hover:bg-slate-100 text-sm">
                        Upload cfg…
                        <input type="file" onChange={onPickUpload} className="hidden" />
                      </label>
                    )}
                  </div>
                </div>
                {kind === 'uesim+callbox' && cbxLoadError && (
                  <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-md px-2 py-1 mt-2">
                    SSH error listing /root/enb/config: <code>{cbxLoadError}</code> — Upload below works either way.
                  </div>
                )}
              </div>
            </>)}

            <label className="flex items-center gap-2 text-sm mb-2">
              <input type="checkbox" checked={stopOnFail} onChange={e => setStopOnFail(e.target.checked)} />
              <span>Stop on first failure (skip remaining items)</span>
            </label>
            <label className="flex items-center gap-2 text-sm mb-4" title="When checked (default), after each item the runner removes the simqa-deployed cfg + enb.cfg symlink so the callbox is left tidy. Uncheck to keep the files in place for post-mortem inspection.">
              <input type="checkbox" checked={removeCfgAfterRun} onChange={e => setRemoveCfgAfterRun(e.target.checked)} />
              <span>Remove deployed cfg from callbox after each item (recommended)</span>
            </label>

            <div className="flex justify-between mt-4">
              <button onClick={() => setTab('setup')} className="rounded-md border border-slate-300 text-sm px-4 py-2">← Back: Setup</button>
              <button onClick={() => setTab('results')} className="rounded-md bg-slate-800 hover:bg-slate-900 text-on-accent text-sm px-4 py-2" disabled={!editingId}>Run history →</button>
            </div>
            </>)}

            {/* ── Tab 3: Run results / history ─────────────────── */}
            {tab === 'results' && (<>
            {!editingId ? (
              <div className="text-sm text-slate-500 py-6 text-center">
                Save the suite first, then click <b>Runs</b> next to it in the list to see history.
              </div>
            ) : (
              <div className="text-sm text-slate-700 py-4 text-center">
                Run history for this suite lives in the <b>Runs</b> button beside the suite row.
                Close this wizard to access it.
              </div>
            )}
            <div className="flex justify-between mt-4">
              <button onClick={() => setTab('testcases')} className="rounded-md border border-slate-300 text-sm px-4 py-2">← Back: Testcases</button>
            </div>
            </>)}

            {/* Save / Cancel — sticky across all tabs */}
            <div className="flex gap-2 justify-end mt-5 pt-4 border-t border-slate-100">
              <button onClick={resetWizard} className="rounded-md border border-slate-300 text-sm px-4 py-2">Cancel</button>
              <button onClick={saveSuite} disabled={!!busy} className="rounded-md bg-orange-500 hover:bg-orange-600 disabled:bg-slate-300 text-on-accent text-sm font-medium px-4 py-2">
                {busy ? 'Saving…' : (editingId ? 'Update suite' : 'Save suite')}
              </button>
            </div>
          </section>
        )}

        {/* Run result */}
        {runResult && (
          <section className="bg-surface border border-slate-200 rounded-xl p-5">
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
                    <th className="text-left px-3 py-2">Testcase</th>
                    <th className="text-center px-3 py-2">HTTP</th>
                    <th className="text-left px-3 py-2">Execution id</th>
                    <th className="text-right px-3 py-2">ms</th>
                    <th className="text-center px-3 py-2" title="Box's final result/status after the test stopped">Verdict</th>
                    <th className="text-center px-3 py-2" title="Was the test stopped by simqa (vs. ended on its own)?">Stop</th>
                    <th className="text-left px-3 py-2">Detail</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {runResult.steps.map((s, i) => {
                    // Verdict cell: prefer the box-reported verdict (PASS/FAIL/
                    // INCOMPLETE/ABORTED/STOPPED/TIMEOUT/…) when present,
                    // else fall back to ok→PASS/FAIL for bring-up rows.
                    const verdict = s.verdict || (s.ok ? 'PASS' : 'FAIL');
                    const verdictColor = verdict === 'PASS' ? 'text-emerald-700'
                      : verdict === 'FAIL' || verdict === 'ERROR' ? 'text-red-700'
                      : verdict === 'STOPPED' || verdict === 'ABORTED' ? 'text-amber-700'
                      : 'text-slate-700';
                    return (
                      <tr key={i}>
                        <td className="px-3 py-1.5 text-slate-500">{i + 1}</td>
                        <td className="px-3 py-1.5 font-mono text-[11px]">{s.testcaseId}</td>
                        <td className="px-3 py-1.5 text-center font-mono">{s.status || '—'}</td>
                        <td className="px-3 py-1.5 font-mono text-[10px]">{s.executionId ?? '–'}</td>
                        <td className="px-3 py-1.5 text-right text-slate-500 font-mono">{s.durationMs}</td>
                        <td className={`px-3 py-1.5 text-center font-semibold ${verdictColor}`} title={s.boxStatus ? `box status: ${s.boxStatus}` : ''}>{verdict}</td>
                        <td className="px-3 py-1.5 text-center text-xs text-slate-500">{s.stopped ? 'simqa' : '–'}</td>
                        <td className="px-3 py-1.5 text-slate-600 text-[11px] max-w-md truncate" title={s.detail}>{s.detail}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

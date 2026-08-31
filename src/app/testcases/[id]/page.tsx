'use client';

import { use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Header } from '@/components/Header';
import { BackToRunHistory } from '@/components/BackToRunHistory';
import { Card, CardBody, CardHeader, CardTitle, Button } from '@/components/ui';
import { ChevronLeft, FileText, Download, Square, Play, Loader2 } from 'lucide-react';
import {
  type RunStatus, type PastRunSummary, type LiveEntry,
  PastRunsPanel,
} from '@/app/run-validate/ValidationReport';

interface PreviewBundle {
  files: Record<string, string>;
  summary: {
    testcaseId: string;
    ratType: string;
    cells: number;
    cellTypes: string[];
    dataTypes: string[];
    ueCount: number;
    plmn: string;
    apns: string[];
    ims: boolean;
    realm: string;
    pcscf: string;
    notes: string[];
  };
}

interface CallboxConfigs {
  callboxId: string;
  callboxHost: string;
  radioFiles: string[];
  coreFiles: string[];
  current: { enb?: string; mme?: string; ims?: string };
}

export default function TestcaseDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const decoded = decodeURIComponent(id);
  const router = useRouter();
  // Carried from the list page so the lookup hits the box you were browsing.
  const systemId = useSearchParams().get('systemId') ?? '';
  const boxQs = systemId ? `?systemId=${encodeURIComponent(systemId)}` : '';
  const [tc, setTc] = useState<any>(null);
  const [bundle, setBundle] = useState<PreviewBundle | null>(null);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // What the BOX is executing (not what this page started). The box runs one
  // testcase at a time, so this drives both the warning and the Stop button.
  const [busy, setBusy] = useState<{ simulatorName?: string; simulatorId: string; testCaseId?: string; testCaseName?: string } | null>(null);
  const [stopping, setStopping] = useState(false);

  const pollBusy = useCallback(async () => {
    try {
      const r = await fetch(`/api/executions${boxQs}`, { cache: 'no-store' });
      const d = await r.json();
      setBusy(d?.busy ? d.execution : null);
    } catch { /* leave the last known state */ }
  }, [boxQs]);

  useEffect(() => {
    pollBusy();
    const t = setInterval(pollBusy, 5000);
    return () => clearInterval(t);
  }, [pollBusy]);

  async function stopTest() {
    if (!confirm(`Stop the execution running on the box?`)) return;
    setStopping(true);
    try {
      // Cancels SimQA's own validation-run tracking (if this page started
      // one) AND the real execution on the box — abortRun() alone only stops
      // SimQA from polling, it doesn't touch the box (see endToEnd/runner.ts).
      await abortRun();
      const r = await fetch(`/api/executions${boxQs}`, { method: 'POST' });
      const d = await r.json();
      // A 409 "nothing is running" just means the box had already moved past
      // whatever SimQA was watching — e.g. the run was cancelled before it
      // ever triggered a real execution. Not a failure: the thing the user
      // wanted stopped is, in fact, stopped.
      const alreadyStopped = r.status === 409 && /nothing is running/i.test(d.error ?? '');
      if (!d.ok && !alreadyStopped) throw new Error(d.error ?? 'stop failed');
      await pollBusy();
    } catch (e: any) {
      alert(`Stop failed: ${e?.message ?? e}`);
    } finally {
      setStopping(false);
    }
  }

  const loadPreview = useCallback(async () => {
    try {
      const [t, b] = await Promise.all([
        fetch(`/api/testcases/${encodeURIComponent(decoded)}${boxQs}`).then((r) => r.json()),
        fetch(`/api/testcases/${encodeURIComponent(decoded)}/preview${boxQs}`).then((r) => r.json()),
      ]);
      setTc(t);
      // Only accept a real bundle. The endpoint answers { error } on a bad
      // systemId or an unreachable box, and storing that as the bundle made
      // the render crash on `summary.ratType` instead of showing the error.
      if (b?.files && b?.summary) {
        setBundle(b);
        setActiveFile((prev) => (prev && b.files[prev] ? prev : Object.keys(b.files)[0] ?? null));
      } else {
        setBundle(null);
        if (b?.error) setErr(String(b.error));
      }
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    }
  }, [decoded, boxQs]);

  useEffect(() => { loadPreview(); }, [loadPreview]);

  /** Tab label only — the real file key (used for activeFile / downloads /
   *  everything else) is untouched. Role tabs read as short acronyms (UE,
   *  ENB, MME, IMS, DB); testcase.json keeps its literal filename since it
   *  isn't one. */
  const TAB_LABELS: Record<string, string> = {
    ue: 'UE', enb: 'ENB', gnb: 'GNB', mme: 'MME', ims: 'IMS', 'default ue_db': 'DB',
  };
  function displayFileName(file: string): string {
    return TAB_LABELS[file] ?? file;
  }

  /** Prefix downloads with the testcase so files from different testcases don't
   *  collide in the browser's download folder. File names are plain now — a
   *  collected file replaces the generated one of the same name, so there is no
   *  decorated label left to unpick. */
  function downloadName(file: string): string {
    const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
    return `${safe(tc?.name ?? decoded)}__${safe(file)}`;
  }

  function downloadFile(name: string) {
    const text = bundle?.files[name];
    if (text == null) return;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = downloadName(name);
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoke late — revoking synchronously can cancel the download in Safari.
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function downloadAll() {
    for (const name of Object.keys(bundle?.files ?? {})) {
      downloadFile(name);
      // Browsers throttle rapid-fire downloads; a short gap keeps them all.
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  // ── Edit testcase.json → delete + recreate on the Simnovator ──
  // The box has no update API (see duplicateTestcase.ts): the only way an
  // edit takes effect is to delete the testcase and recreate it, which
  // always assigns a new id.
  const [editingTcJson, setEditingTcJson] = useState(false);
  const [tcJsonDraft, setTcJsonDraft] = useState('');
  const [tcJsonErr, setTcJsonErr] = useState<string | null>(null);
  const [savingTcJson, setSavingTcJson] = useState(false);
  const [saveErr, setSaveErr] = useState<{ failedStep?: string; error?: string } | null>(null);

  // Leaving the testcase.json tab mid-edit would otherwise leave the edit UI
  // stuck open next time the tab is reselected.
  useEffect(() => {
    if (activeFile !== 'testcase.json' && editingTcJson) { setEditingTcJson(false); setTcJsonErr(null); }
  }, [activeFile, editingTcJson]);

  function startEditTcJson() {
    setTcJsonDraft(bundle?.files['testcase.json'] ?? '');
    setEditingTcJson(true);
    setTcJsonErr(null);
    setSaveErr(null);
  }

  function editTcJsonDraft(text: string) {
    setTcJsonDraft(text);
    try { JSON.parse(text); setTcJsonErr(null); } catch (e: any) { setTcJsonErr(e?.message ?? String(e)); }
  }

  async function saveTestcaseJson() {
    let parsed: any;
    try { parsed = JSON.parse(tcJsonDraft); } catch (e: any) { setTcJsonErr(e?.message ?? String(e)); return; }
    const ok = confirm(
      'This deletes the current testcase on the Simnovator and recreates it from your edited testcase.json.\n\n' +
      'The testcase ID WILL CHANGE — any saved links, playlists, or references to the current ID will break.\n\n' +
      'If a step partway through the recreate fails, the testcase may be left deleted with nothing to replace it.\n\n' +
      'Continue?',
    );
    if (!ok) return;
    setSavingTcJson(true); setSaveErr(null);
    try {
      const r = await fetch(`/api/testcases/${encodeURIComponent(decoded)}/recreate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ systemId: systemId || undefined, testcaseJson: parsed }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) {
        setSaveErr({ failedStep: j.failedStep, error: j.error ?? `HTTP ${r.status}` });
        return;
      }
      // New id on success — carry the box along and land on the replacement.
      router.replace(`/testcases/${encodeURIComponent(j.testCaseId)}${boxQs}`);
    } catch (e: any) {
      setSaveErr({ error: e?.message ?? String(e) });
    } finally {
      setSavingTcJson(false);
    }
  }

  // ── Run Configuration: real cfg files already on the bound callbox ──
  const [cfgOpts, setCfgOpts] = useState<CallboxConfigs | null>(null);
  const [cfgErr, setCfgErr] = useState<string | null>(null);
  const [selEnb, setSelEnb] = useState('');
  const [selMme, setSelMme] = useState('');
  const [selIms, setSelIms] = useState('');

  const loadCfgOpts = useCallback(async (): Promise<CallboxConfigs | null> => {
    if (!systemId) { setCfgOpts(null); setCfgErr(null); return null; }
    try {
      const j = await fetch(`/api/testcases/${encodeURIComponent(decoded)}/callbox-configs?systemId=${encodeURIComponent(systemId)}`).then((r) => r.json());
      if (j.ok) {
        setCfgOpts(j);
        setCfgErr(null);
        return j;
      }
      setCfgOpts(null);
      setCfgErr(j.error ?? 'failed to load callbox configs');
      return null;
    } catch (e: any) {
      setCfgOpts(null);
      setCfgErr(e?.message ?? String(e));
      return null;
    }
  }, [decoded, systemId]);

  useEffect(() => {
    let cancelled = false;
    loadCfgOpts().then((j) => {
      if (cancelled || !j) return;
      setSelEnb(j.current?.enb ?? '');
      setSelMme(j.current?.mme ?? '');
      setSelIms(j.current?.ims ?? '');
    });
    return () => { cancelled = true; };
  }, [loadCfgOpts]);

  // ── Edit a live cfg file (enb/gnb/mme/ims) → upload as a NEW pickable
  //    file on the callbox. The box has no "update a cfg" concept, same as
  //    testcase.json above — a new file is the only way an edit is real. ──
  const [editingCfgFile, setEditingCfgFile] = useState<string | null>(null);
  const [cfgFileDraft, setCfgFileDraft] = useState('');
  const [savingCfgFile, setSavingCfgFile] = useState(false);
  const [cfgSaveErr, setCfgSaveErr] = useState<string | null>(null);
  const [cfgSaveOk, setCfgSaveOk] = useState<string | null>(null);

  useEffect(() => {
    setEditingCfgFile(null);
    setCfgSaveErr(null);
    setCfgSaveOk(null);
  }, [activeFile]);

  /** Which callbox directory / Run Configuration select a file tab maps to,
   *  or null when it's not one of the picker's roles (e.g. "ue", "ue_db") —
   *  those have nowhere to plug back into, so they stay read-only. */
  function cfgRoleOf(label: string): 'enb' | 'mme' | 'ims' | null {
    const stripped = label.replace(/^default\s+/, '');
    if (stripped === 'enb' || stripped === 'gnb') return 'enb';
    if (stripped === 'mme') return 'mme';
    if (stripped === 'ims') return 'ims';
    return null;
  }

  function startEditCfgFile() {
    if (!activeFile || !bundle) return;
    setCfgFileDraft(bundle.files[activeFile] ?? '');
    setEditingCfgFile(activeFile);
    setCfgSaveErr(null);
    setCfgSaveOk(null);
  }

  async function saveCfgFileAsNew() {
    if (!editingCfgFile || !systemId) return;
    const role = cfgRoleOf(editingCfgFile);
    if (!role) return;
    const suggested = `${editingCfgFile.replace(/^default\s+/, '')}.cfg`;
    const filename = prompt('Save as a new file on the callbox:', suggested);
    if (!filename?.trim()) return;

    setSavingCfgFile(true); setCfgSaveErr(null); setCfgSaveOk(null);
    try {
      const r = await fetch(`/api/testcases/${encodeURIComponent(decoded)}/callbox-configs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ systemId, role, filename, content: cfgFileDraft }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) { setCfgSaveErr(j.error ?? `HTTP ${r.status}`); return; }

      setCfgSaveOk(`Saved as ${j.filename} on the callbox.`);
      setEditingCfgFile(null);

      // Refresh the picker so the new file appears, and select it — this is
      // what makes the edit "count": it becomes the file the next Run uses.
      const fresh = await loadCfgOpts();
      if (fresh) {
        if (role === 'enb') setSelEnb(j.filename);
        else if (role === 'mme') setSelMme(j.filename);
        else if (role === 'ims') setSelIms(j.filename);
      }
    } catch (e: any) {
      setCfgSaveErr(e?.message ?? String(e));
    } finally {
      setSavingCfgFile(false);
    }
  }

  // ── Run + live validation status ──
  const [runId, setRunId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<RunStatus | null>(null);
  const [startErr, setStartErr] = useState<string | null>(null);
  const pollerRef = useRef<NodeJS.Timeout | null>(null);

  // Re-attach to a run already in flight for THIS testcase — mirrors the
  // pattern on /run-validate, scoped so this page doesn't adopt someone
  // else's validation run on a different testcase.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/end-to-end/status', { cache: 'no-store' });
        const j: RunStatus = await r.json();
        if (cancelled || !j.running || !j.runId || j.testcaseId !== decoded) return;
        setRunId(j.runId);
        setRunning(true);
        setStatus(j);
      } catch { /* no active run to adopt — stay idle */ }
    })();
    return () => { cancelled = true; };
  }, [decoded]);

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
        if (!j.running && j.runId) setRunning(false);
      } catch { /* swallow */ }
    };
    tick();
    pollerRef.current = setInterval(tick, 1500);
    return () => { if (pollerRef.current) { clearInterval(pollerRef.current); pollerRef.current = null; } };
  }, [running, runId]);

  // Once a run finishes, the box's real files may have changed (a passing
  // run turns "default X" previews into live ones — see Phase 2). Refresh
  // Generated Configs so the page reflects what's actually on the box now.
  useEffect(() => {
    if (status && !status.running && status.runId) void loadPreview();
  }, [status?.running, status?.runId, loadPreview]);

  async function startValidation() {
    if (!systemId) { setStartErr('Open this testcase from the Test Cases list so SimQA knows which system to run it on.'); return; }
    setStartErr(null); setStatus(null);
    try {
      const body = {
        systemId,
        testcaseId: decoded,
        cfgSelection: { enb: selEnb || undefined, mme: selMme || undefined, ims: selIms || undefined },
      };
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

  // ── Validation history for THIS testcase ──
  const [allRuns, setAllRuns] = useState<PastRunSummary[] | null>(null);
  const loadRuns = useCallback(async () => {
    try {
      const r = await fetch('/api/end-to-end/runs', { cache: 'no-store' });
      const j = await r.json();
      setAllRuns(j.runs ?? []);
    } catch { setAllRuns([]); }
  }, []);
  useEffect(() => { loadRuns(); }, [loadRuns]);
  useEffect(() => {
    if (status && !status.running && status.runId) loadRuns();
  }, [status?.running, status?.runId, loadRuns]);

  const runsForThisTestcase = useMemo(() => {
    if (!allRuns) return null;
    return allRuns.filter((r) => r.testcaseId === decoded && (!systemId || r.systemId === systemId));
  }, [allRuns, decoded, systemId]);

  // One validation, not a growing history: re-running replaces what's shown
  // rather than adding beside it. While a run is live, the live entry IS
  // that one row — the previous historical result is hidden until this run
  // finishes and its own report takes that same single slot.
  const visibleValidationRuns = running ? [] : runsForThisTestcase;

  // A testcase can have real execution history on the box (shown as "Last
  // Result" / "Last Executed" on the Test Cases list, from tc.metadata)
  // without ever having been run through SimQA's own validation engine —
  // e.g. it was executed from the Simnovator's own GUI, or before this
  // page existed. That run has no check-by-check report to show, but the
  // panel should say so plainly instead of implying nothing ever ran.
  const lastBoxExecution = tc?.metadata?.lastExecution;
  const validationEmptyMessage = lastBoxExecution?.executedOn ? (
    <>
      Last executed on the Simnovator {new Date(lastBoxExecution.executedOn).toLocaleString()}
      {lastBoxExecution.result ? <> — result <span className="font-medium text-slate-700">{lastBoxExecution.result}</span></> : null}.
      {' '}That run didn't go through SimQA's validation engine, so there's no check-by-check report for it — click Run above for a full validation.
    </>
  ) : 'No validation runs for this testcase yet. Run it above to see a full pass/fail report here.';

  return (
    <>
      <Header
        title={tc?.name ?? decoded}
        left={<BackToRunHistory />}
        right={
          <div className="flex items-center gap-2">
            {/* Carry the box back with you — returning to an unqualified
                /testcases would reset the SIM picker to the first UESIM. */}
            <Link href={`/testcases${boxQs}`}>
              <Button size="sm" variant="ghost"><ChevronLeft className="h-4 w-4" />Back</Button>
            </Link>
            {/* One toggle, not two buttons: Stop covers both "the box is
                busy" and "SimQA is mid-validation" — stopTest() handles
                both regardless of which (or both) is true. */}
            {busy || running ? (
              <Button size="sm" onClick={stopTest} disabled={stopping}
                className="!bg-red-600 hover:!bg-red-700 !border-red-600">
                <Square className="h-4 w-4" />{stopping ? 'Stopping…' : 'Stop'}
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={() => startValidation()}
                disabled={!systemId}
                className="bg-primary-600 hover:bg-primary-700 text-white"
                title="Symlink the selected configs into place on the callbox, restart, then execute this testcase with full validation checks."
              >
                <Play className="h-4 w-4 fill-current" />
                <span className="ml-1.5">Run</span>
              </Button>
            )}
          </div>
        }
      />
      <main className="p-6 space-y-3">
        {err ? <div className="rounded bg-red-50 text-red-700 p-3 text-sm">{err}</div> : null}

        {busy ? (
          <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            A test case is already running
            {busy.testCaseId === decoded
              ? ' — this one.'
              : busy.testCaseName ? ` — testcase ${busy.testCaseName}.`
              : busy.testCaseId ? ` — testcase ${busy.testCaseId}.` : '.'}
            {' '}Stop it before starting another, or try again once it finishes.
          </div>
        ) : null}

        {/* ── Pick Configuration: real cfg files on the callbox, symlink + run.
            Run/Stop live in the header beside Back — what's running is shown
            in Validation below instead, as just another entry in that list. ── */}
        <Card>
          <CardHeader className="py-3"><CardTitle>Pick Configuration</CardTitle></CardHeader>
          <CardBody className="space-y-3 py-4">
            {!systemId ? (
              <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
                Open this testcase from the Test Cases list so SimQA knows which Simnovator — and its bound callbox — to run against.
              </div>
            ) : cfgErr ? (
              <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">{cfgErr}</div>
            ) : !cfgOpts ? (
              <div className="text-xs text-slate-500 flex items-center gap-1.5"><Loader2 className="h-3 w-3 animate-spin" /> loading callbox configs…</div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-700">ENB Configuration</label>
                  <select
                    value={selEnb}
                    onChange={(e) => setSelEnb(e.target.value)}
                    disabled={running}
                    className="w-full border border-slate-300 rounded-md px-3 py-1.5 text-sm bg-white text-slate-700 disabled:bg-slate-100 disabled:text-slate-400"
                  >
                    <option value="">— none —</option>
                    {cfgOpts.radioFiles.map((f) => <option key={f} value={f}>{f}</option>)}
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-700">MME Configuration</label>
                  <select
                    value={selMme}
                    onChange={(e) => setSelMme(e.target.value)}
                    disabled={running}
                    className="w-full border border-slate-300 rounded-md px-3 py-1.5 text-sm bg-white text-slate-700 disabled:bg-slate-100 disabled:text-slate-400"
                  >
                    <option value="">— none —</option>
                    {cfgOpts.coreFiles.map((f) => <option key={f} value={f}>{f}</option>)}
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-700">IMS Configuration</label>
                  <select
                    value={selIms}
                    onChange={(e) => setSelIms(e.target.value)}
                    disabled={running}
                    className="w-full border border-slate-300 rounded-md px-3 py-1.5 text-sm bg-white text-slate-700 disabled:bg-slate-100 disabled:text-slate-400"
                  >
                    <option value="">— none —</option>
                    {cfgOpts.coreFiles.map((f) => <option key={f} value={f}>{f}</option>)}
                  </select>
                </div>
              </div>
            )}

            {startErr ? (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{startErr}</div>
            ) : null}
          </CardBody>
        </Card>

        {/* ── Validation: one entry for this testcase, not a growing history.
            Re-running replaces what's shown here rather than adding beside
            it — click to expand and see the full pass/fail report, live or
            from the last run. Stop lives in the header beside Back, not
            here. ── */}
        <PastRunsPanel
          runs={visibleValidationRuns}
          onRefresh={loadRuns}
          title="Validation"
          limit={1}
          emptyMessage={validationEmptyMessage}
          liveEntry={running && status && runId ? {
            runId,
            testcaseId: decoded,
            testcaseName: tc?.name,
            systemId: status.systemId ?? systemId,
            systemHost: status.systemHost,
            startedAt: status.startedAt ?? new Date().toISOString(),
            executionId: status.executionId,
            configuredDurationSec: status.configuredDurationSec,
            currentPhase: status.phase,
            checks: status.checks ?? [],
            counts: status.counts,
          } : undefined}
        />

        {bundle ? (
          <Card>
            <CardHeader className="flex flex-wrap items-center justify-between gap-2 py-3">
              <CardTitle>Generated Configs</CardTitle>
              <div className="flex items-center gap-1.5 flex-wrap">
                {Object.keys(bundle.files).map((name) => (
                  <span key={name} className="inline-flex items-stretch rounded-md border overflow-hidden border-slate-300">
                    <button
                      onClick={() => setActiveFile(name)}
                      className={
                        'px-3 h-8 text-xs ' +
                        (activeFile === name
                          ? 'bg-slate-900 text-on-accent'
                          : 'bg-surface text-slate-700 hover:bg-slate-50')
                      }
                    >
                      <span className="inline-flex items-center gap-1.5">
                        <FileText className="h-3.5 w-3.5" />
                        {displayFileName(name)}
                      </span>
                    </button>
                    {/* Per-file download, so you can grab just the cfg you need. */}
                    <button
                      onClick={() => downloadFile(name)}
                      title={`Download ${name}`}
                      aria-label={`Download ${name}`}
                      className="px-2 h-8 bg-surface text-slate-500 hover:bg-slate-100 hover:text-slate-800 border-l border-slate-300"
                    >
                      <Download className="h-3.5 w-3.5" />
                    </button>
                  </span>
                ))}
                <Button size="sm" variant="secondary" onClick={downloadAll}>
                  <Download className="h-4 w-4" />Download all
                </Button>
              </div>
            </CardHeader>
            <CardBody className="space-y-2 py-4">
              {activeFile === 'testcase.json' ? (
                <>
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[11px] text-slate-500">
                      {editingTcJson
                        ? 'Editing — Save deletes and recreates this testcase on the Simnovator with a new ID.'
                        : 'This is the box\'s own testcase export. Edits are applied by deleting and recreating the testcase.'}
                    </div>
                    {editingTcJson ? (
                      <div className="flex items-center gap-2 flex-none">
                        <Button size="sm" variant="ghost" onClick={() => { setEditingTcJson(false); setTcJsonErr(null); }} disabled={savingTcJson}>
                          Cancel
                        </Button>
                        <Button size="sm" onClick={saveTestcaseJson} disabled={!!tcJsonErr || savingTcJson}>
                          {savingTcJson ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                          <span className={savingTcJson ? 'ml-1.5' : ''}>{savingTcJson ? 'Saving…' : 'Save & Apply to Simnovator'}</span>
                        </Button>
                      </div>
                    ) : (
                      <Button size="sm" variant="secondary" onClick={startEditTcJson} className="flex-none">
                        Edit
                      </Button>
                    )}
                  </div>
                  {editingTcJson ? (
                    <>
                      <textarea
                        value={tcJsonDraft}
                        onChange={(e) => editTcJsonDraft(e.target.value)}
                        spellCheck={false}
                        disabled={savingTcJson}
                        className="w-full min-h-[420px] font-mono text-xs leading-relaxed bg-slate-900 text-slate-200 p-4 rounded-lg resize-y outline-none focus:ring-2 focus:ring-primary-500"
                      />
                      {tcJsonErr ? (
                        <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">Invalid JSON: {tcJsonErr}</div>
                      ) : null}
                    </>
                  ) : (
                    <pre className="cfg">{bundle.files['testcase.json']}</pre>
                  )}
                  {saveErr ? (
                    <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
                      {saveErr.failedStep ? <span className="font-semibold">Failed at step "{saveErr.failedStep}": </span> : null}
                      {saveErr.error}
                      {saveErr.failedStep && saveErr.failedStep !== 'delete' ? ' — the old testcase was already deleted; check the Simnovator catalogue before retrying.' : ''}
                    </div>
                  ) : null}
                </>
              ) : activeFile && cfgRoleOf(activeFile) ? (
                <>
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[11px] text-slate-500">
                      {editingCfgFile === activeFile
                        ? 'Editing — Save writes this as a NEW file on the callbox and selects it in Run Configuration above.'
                        : 'Edits are saved as a new file on the callbox, not applied in place — the original is left untouched.'}
                    </div>
                    {editingCfgFile === activeFile ? (
                      <div className="flex items-center gap-2 flex-none">
                        <Button size="sm" variant="ghost" onClick={() => setEditingCfgFile(null)} disabled={savingCfgFile}>
                          Cancel
                        </Button>
                        <Button size="sm" onClick={saveCfgFileAsNew} disabled={savingCfgFile || !systemId}>
                          {savingCfgFile ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                          <span className={savingCfgFile ? 'ml-1.5' : ''}>{savingCfgFile ? 'Saving…' : 'Save as new file'}</span>
                        </Button>
                      </div>
                    ) : (
                      <Button size="sm" variant="secondary" onClick={startEditCfgFile} className="flex-none" disabled={!systemId}
                        title={!systemId ? 'Open this testcase from the Test Cases list so SimQA knows which callbox to save to.' : undefined}>
                        Edit
                      </Button>
                    )}
                  </div>
                  {editingCfgFile === activeFile ? (
                    <textarea
                      value={cfgFileDraft}
                      onChange={(e) => setCfgFileDraft(e.target.value)}
                      spellCheck={false}
                      disabled={savingCfgFile}
                      className="w-full min-h-[420px] font-mono text-xs leading-relaxed bg-slate-900 text-slate-200 p-4 rounded-lg resize-y outline-none focus:ring-2 focus:ring-primary-500"
                    />
                  ) : (
                    <pre className="cfg">{bundle.files[activeFile]}</pre>
                  )}
                  {cfgSaveErr ? (
                    <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">{cfgSaveErr}</div>
                  ) : null}
                  {cfgSaveOk ? (
                    <div className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-3 py-2">{cfgSaveOk}</div>
                  ) : null}
                </>
              ) : activeFile ? (
                <pre className="cfg">{bundle.files[activeFile]}</pre>
              ) : (
                <div className="text-sm text-slate-500">No file selected.</div>
              )}
            </CardBody>
          </Card>
        ) : !err ? (
          <Card><CardBody><div className="text-sm text-slate-500">Generating preview…</div></CardBody></Card>
        ) : null}
      </main>
    </>
  );
}

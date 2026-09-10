'use client';

import { use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Header } from '@/components/Header';
import { BackToRunHistory } from '@/components/BackToRunHistory';
import { SearchableSelect } from '@/components/SearchableSelect';
import { Card, CardBody, CardHeader, CardTitle, Button } from '@/components/ui';
import { ChevronLeft, FileText, Download, Square, Play, Loader2 } from 'lucide-react';
import {
  type RunStatus, type PastRunSummary, type LiveEntry, type FullReport, type CheckRowData,
  PastRunsPanel,
} from '@/app/run-validate/ValidationReport';
import { boxExecutionsOf } from '@/lib/boxExecutions';
import { boxMetricName, explainBoxCheck } from '@/lib/checkExplain';

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
  // Display-only, passed by Run History, which already knows the name. Used
  // solely as the heading fallback so this page never titles itself with a raw
  // UUID while the box is being queried — or if the box can't be reached.
  const nameHint = useSearchParams().get('name') || undefined;
  const [tc, setTc] = useState<any>(null);
  const [bundle, setBundle] = useState<PreviewBundle | null>(null);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // What the BOX is executing (not what this page started). The box runs one
  // testcase at a time, so this drives both the warning and the Stop button.
  const [busy, setBusy] = useState<{ simulatorName?: string; simulatorId: string; testCaseId?: string; testCaseName?: string; executionId?: string } | null>(null);
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

  /** Just the testcase record — the half that carries executionHistory. The
   *  preview bundle is the expensive call and does not change while a run is in
   *  flight, so the poll below re-reads only this. */
  const loadTestcaseOnly = useCallback(async () => {
    try {
      const t = await fetch(`/api/testcases/${encodeURIComponent(decoded)}${boxQs}`, { cache: 'no-store' }).then((r) => r.json());
      // An error payload would wipe the metadata we already have and blank the
      // Validation panel mid-run; keep what is on screen instead.
      if (t && !t.error) setTc(t);
    } catch { /* keep what we have */ }
  }, [decoded, boxQs]);

  /**
   * Re-read the testcase when the box stops executing.
   *
   * The box's execution history — and therefore the Validation entry for a run
   * started from the Simnovator's own GUI — lives on the testcase record, which
   * is otherwise fetched once on mount. Without this, a colleague running the
   * testcase from the box while this page is open shows up only after a manual
   * reload. pollBusy already watches the box every 5s, so the transition from
   * executing to idle is the signal; nothing new is polled for it.
   */
  // Holds the testcase the box was last seen executing. It has to be the id
  // captured WHILE busy, not read on the falling edge — by then `busy` is null
  // and there is nothing left to compare against.
  const busyTestcaseRef = useRef<string | null>(null);
  useEffect(() => {
    const previous = busyTestcaseRef.current;
    const mine = (id: string | null) => id !== null && (id === '' || id === decoded);

    if (busy) {
      const now = busy.testCaseId ?? '';
      busyTestcaseRef.current = now;
      // Rising edge: refetch so the run APPEARS while it is still going. The
      // testcase is otherwise read once on mount, so starting it from the
      // Simnovator with this page already open showed nothing at all until a
      // manual reload.
      if (previous === null && mine(now)) loadPreview();
      return;
    }

    busyTestcaseRef.current = null;
    // Falling edge: refetch so the running entry becomes the finished verdict.
    // The check uses the id captured while busy — by now the box reports
    // nothing to compare against. An unattributed finish still refetches: the
    // box runs one testcase at a time, so a redundant read is cheaper than
    // leaving a stale "Running" on screen.
    if (mine(previous)) loadPreview();
  }, [busy, decoded, loadPreview]);

  /**
   * Keep re-reading the testcase while the box is executing it.
   *
   * The rising-edge refetch above fires the instant the box reports BUSY, and
   * that is usually too early: starting an execution takes the box ~26s, so its
   * executionHistory often has no entry for the new run yet. One read at that
   * moment leaves the panel showing the PREVIOUS verdict for the whole run —
   * which is what "no validation while it is executing" looks like.
   *
   * `busyForThis` is a boolean rather than the busy object, because that object
   * is replaced every 5s poll: keying the effect on it would tear down and
   * rebuild the interval before it ever fired.
   */
  const busyForThis = !!busy && (!busy.testCaseId || busy.testCaseId === decoded);
  useEffect(() => {
    if (!busyForThis) return;
    const t = setInterval(loadTestcaseOnly, 10_000);
    return () => clearInterval(t);
  }, [busyForThis, loadTestcaseOnly]);

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

  /**
   * Start a validation.
   *
   * `attach` validates the execution the box is ALREADY running instead of
   * starting one — for a testcase launched from the Simnovator's own GUI. The
   * runner adopts that execution and runs the same During / Completion / After
   * checks against it, so a run SimQA did not start still gets a real
   * validation rather than only the box's own verdict. No cfg selection is
   * sent: the run is already under way and its configs are on the boxes.
   */
  async function startValidation(attach = false) {
    if (!systemId) { setStartErr('Open this testcase from the Test Cases list so SimQA knows which system to run it on.'); return; }
    setStartErr(null); setStatus(null);
    try {
      // The selection goes with an attach too, even though nothing will be
      // linked: the cfg check reports which files were NOT applied, and it can
      // only name them if it is told. Sending them does not link them — see
      // preflight-cfg-bring-up, which refuses outright while attached.
      const cfgSelection = { enb: selEnb || undefined, mme: selMme || undefined, ims: selIms || undefined };
      const body = attach
        ? { systemId, testcaseId: decoded, attach: true, cfgSelection }
        : {
          systemId,
          testcaseId: decoded,
          cfgSelection,
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


  /**
   * Attach SimQA's validation to an execution the box is running, unasked.
   *
   * This was a "Validate this run" button, on the reasoning that pointing our
   * polling at whatever a colleague launched was not SimQA's call to make. The
   * ask is the opposite: a testcase executed from the Simnovator should be
   * validated the same as one executed from here, without anyone remembering
   * to click. So it attaches itself.
   *
   * Once per execution, and only when nothing is already validating — the
   * server runs one validation at a time, and the adopt-on-mount effect above
   * resolves asynchronously, so a second tab could otherwise race it. The
   * status call settles that immediately before starting.
   */
  const autoAttachedRef = useRef<string | null>(null);
  useEffect(() => {
    const execId = busy?.executionId ?? '';
    if (!busyForThis || running || !systemId || !execId) return;
    if (autoAttachedRef.current === execId) return;
    autoAttachedRef.current = execId;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/end-to-end/status', { cache: 'no-store' });
        const j: RunStatus = await r.json();
        if (cancelled || j?.running) return;
      } catch { /* status unavailable — attaching is still the right default */ }
      if (!cancelled) void startValidation(true);
    })();
    return () => { cancelled = true; };
    // startValidation is stable for a given testcase/box; re-running this on
    // its identity would re-attach on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busyForThis, running, systemId, busy?.executionId]);

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

  // One SimQA validation, not a growing history: re-running replaces what's
  // shown rather than adding beside it. While a run is live, the live entry IS
  // that row — the previous historical result is hidden until this run
  // finishes and its own report takes that same slot.
  /**
   * The box's own executions, shaped so they sit in the Validation panel
   * alongside SimQA's runs.
   *
   * A testcase run from the Simnovator's GUI never touched SimQA's validation
   * engine, so there is no data/runs record to fetch — but the box does keep a
   * verdict and the checks behind it, on the testcase itself. Those become the
   * report, handed to the panel directly via prefetchedReports.
   *
   * Each check carries its numbers (required vs measured), because the verdict
   * alone is not enough to judge a run by: a testcase whose only condition is
   * Avg_DL_BLER<=5% passes with a measured BLER of 0, which is also what zero
   * attached UEs produces.
   */
  const boxValidation = useMemo(() => {
    const summaries: PastRunSummary[] = [];
    const reports: Record<string, FullReport> = {};

    for (const x of boxExecutionsOf(tc?.metadata)) {
      const runId = `box:${x.executionId || x.startedAt || Math.random()}`;
      const passed = x.checks.filter((c) => c.verdict).length;
      const failed = x.checks.length - passed;

      // Decided in boxExecutions.ts, where it is unit-tested — a run the box is
      // still executing reports no result, no checks and an empty details blob,
      // and treated as finished that came out as "0 failures, therefore PASS".
      const isRunning = x.running;

      // The box's own PASS/FAIL is the authority on the verdict; the checks
      // explain it. With neither — still running, or finished having recorded
      // nothing — the verdict stays UNKNOWN rather than being inferred from an
      // empty check list.
      const ok = isRunning ? undefined
        : x.result ? x.result.toUpperCase() === 'PASS'
        : x.checks.length > 0 ? failed === 0
        : undefined;

      // Rendered by the same RunProgress as a SimQA validation, so these land
      // in the five-stage flow with the same per-stage "N/M Passed" counts.
      //
      // 'during' rather than 'completion': every condition the box evaluates —
      // BLER, message counters, throughput — is measured on the traffic while
      // the test runs, which is exactly what the During Test stage describes.
      // Filing them under Test Completion put them in the stage that confirms
      // the execution finished, which is not what they check.
      //
      // 'critical' because these ARE the box's pass/fail conditions: one not
      // met is why it reports FAIL, so it must not read as a non-critical fail.
      const measured: CheckRowData[] = x.checks.map((c, i) => ({
        id: `${runId}:${c.group}:${c.name}:${i}`,
        // Achieved_Avg_DL_Throughput is a field name, not something to read.
        name: boxMetricName(c.name),
        phase: 'during',
        severity: 'critical',
        description: c.condition || `${c.group} check`,
        status: c.verdict ? 'pass' : 'fail',
        // A failing condition says what fell short, in words. The raw numbers
        // stay in `detail` as the evidence behind it — replacing them made the
        // technical details echo the sentence instead of backing it up.
        plain: c.verdict ? undefined : explainBoxCheck(c.name, c.condition, c.demand, c.achieved),
        detail: [
          c.demand !== undefined ? `required ${c.demand}` : null,
          c.achieved !== undefined ? `measured ${c.achieved}` : null,
        ].filter(Boolean).join(' · ') || undefined,
      }));

      // ONLY what the box actually measured.
      //
      // An earlier version synthesised the other four stages from fields on the
      // execution record, so a box-driven run rendered the full Before /
      // Starting / During / Completion / After flow. That flow is SimQA's own
      // validation, and presenting a reconstruction of it for a run SimQA never
      // performed reads as though it had. The honest report for a run started
      // on the Simnovator is the box's own success conditions — and if you want
      // the real five-stage validation, "Validate this run" attaches SimQA to
      // the live execution and produces a genuine one.
      //
      // boxStageChecks() in boxExecutions.ts built those rows and is now
      // unused; it is kept, with its tests, in case the reconstruction is
      // wanted somewhere it cannot be confused for a SimQA run.
      const results: CheckRowData[] = measured;

      summaries.push({
        runId,
        startedAt: x.startedAt ?? '',
        finishedAt: x.finishedAt,
        ok,
        systemId: systemId || '',
        systemHost: tc?.host,
        testcaseId: decoded,
        testcaseName: tc?.name,
        // Carried so the merge below can recognise this as the same event as a
        // SimQA validation that drove it.
        executionId: x.executionId,
        running: isRunning,
        // Counts describe what is actually rendered, including the stages SimQA
        // did not observe — a row saying "1 Passed · 0 Failed" above a report
        // listing five skips would not add up.
        // Omitted while running: "0 Passed · 0 Failed" reads as a finished run
        // that measured nothing, rather than one still in flight.
        counts: isRunning ? undefined : {
          total: results.length,
          passed: results.filter((r) => r.status === 'pass').length,
          failed: results.filter((r) => r.status === 'fail').length,
          skipped: results.filter((r) => r.status === 'skip').length,
        },
      });

      reports[runId] = {
        runId,
        startedAt: x.startedAt ?? '',
        finishedAt: x.finishedAt,
        ok,
        systemId: systemId || '',
        systemHost: tc?.host ?? '',
        testcaseId: decoded,
        testcaseName: tc?.name,
        executionId: x.executionId,
        // The box's own verdict, in the box's own words. Not derived from `ok`:
        // INCOMPLETE and ABORTED are neither a pass nor a fail, and the point of
        // showing this field is that it says what the Simnovator says.
        verdict: x.result,
        finalDetail: x.parseError
          ? `Executed on the Simnovator — ${x.parseError}`
          : isRunning
            // Say what is happening and what will replace it. A running box
            // execution has no checks yet, so the stage flow below is empty —
            // without this the panel would expand to nothing at all.
            ? `Running on the Simnovator, started ${x.startedAt ? new Date(x.startedAt).toLocaleTimeString() : 'just now'}. Its verdict and the checks behind it appear here as soon as the box finishes.`
            : x.checks.length === 0
              ? `Executed on the Simnovator, which recorded no success conditions for this run — there is nothing to check it against.`
              : `Executed on the Simnovator. Its verdict means the success conditions below held, not that the test exercised the network.`,
        observedDurationSec: x.durationSec,
        results,
      };
    }

    return { summaries, reports };
  }, [tc, decoded, systemId]);

  /**
   * Exactly ONE validation: the most recent execution of this testcase, from
   * whichever source ran it.
   *
   * Both sources are candidates and the newest timestamp wins — a run started
   * from this page and a run started from the Simnovator's own GUI are the same
   * event class, so the panel shows the latest state of the testcase rather
   * than one entry per tool. Executing it again anywhere replaces what's here.
   */
  const visibleValidationRuns = useMemo(() => {
    if (running) return [];
    const simqa = runsForThisTestcase ?? [];
    if (runsForThisTestcase === null && boxValidation.summaries.length === 0) return null;

    // A run SimQA drove appears TWICE — once as its own validation, once as the
    // execution the box recorded for it. They are one event, and the SimQA
    // record is strictly richer: it carries the box's verdict plus its own
    // Before/Starting/During/Completion/After checks. Sorting them together let
    // the box's copy win on a timestamp a minute later, so finishing a run from
    // this page replaced the live During Test checks with the box's eight
    // derived rows. Drop the box's copy of an execution SimQA already has.
    const simqaExecutions = new Set(simqa.map((r) => r.executionId).filter(Boolean));
    const boxOnly = boxValidation.summaries.filter((b) => !b.executionId || !simqaExecutions.has(b.executionId));

    return [...simqa, ...boxOnly]
      .sort((a, b) => (Date.parse(b.startedAt) || 0) - (Date.parse(a.startedAt) || 0))
      .slice(0, 1);
  }, [running, runsForThisTestcase, boxValidation]);

  // Reached only when the testcase has NEITHER a SimQA validation NOR any
  // execution on the box. It used to carry a "last executed on the Simnovator,
  // but no report exists" explanation; that case now produces a real entry in
  // the panel above, built from the box's own verdict, so the explanation
  // would never be seen.
  const validationEmptyMessage =
    'No validation runs for this testcase yet. Run it above, or execute it from the Simnovator, to see a result here.';

  return (
    // The page owns the full height of the app shell's content column and
    // scrolls inside itself, so the Header stays put. As a bare fragment it was
    // the shell's column that scrolled and the Header — which is only `sticky`
    // — travelled with it, taking Run/Stop and Back out of reach.
    <div className="flex-1 min-h-0 flex flex-col">
      <Header
        title={tc?.name ?? nameHint ?? decoded}
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
            {/* "Validate this run" used to live here, for the case where the
                box is executing this testcase and SimQA is not validating it.
                It is automatic now — see the attach effect above — so there is
                no button: an execution started from the Simnovator gets
                validated wherever it was started from. */}
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
      {/* The only scrolling region on the page. */}
      <main className="flex-1 min-h-0 overflow-y-auto p-6 space-y-3">
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
                {/* All three are searchable: the callbox carries 108 radio cfg
                    files and 27 core ones, with long shared prefixes, so
                    picking one out of a native dropdown meant scrolling and
                    reading rather than typing what you already know. */}
                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-700">ENB Configuration</label>
                  <SearchableSelect
                    ariaLabel="ENB Configuration"
                    value={selEnb}
                    onChange={setSelEnb}
                    options={cfgOpts.radioFiles}
                    disabled={running}
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-700">MME Configuration</label>
                  <SearchableSelect
                    ariaLabel="MME Configuration"
                    value={selMme}
                    onChange={setSelMme}
                    options={cfgOpts.coreFiles}
                    disabled={running}
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-700">IMS Configuration</label>
                  <SearchableSelect
                    ariaLabel="IMS Configuration"
                    value={selIms}
                    onChange={setSelIms}
                    options={cfgOpts.coreFiles}
                    disabled={running}
                  />
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
          prefetchedReports={boxValidation.reports}
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
    </div>
  );
}

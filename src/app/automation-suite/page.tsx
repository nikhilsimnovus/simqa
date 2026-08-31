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

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { cn } from '@/lib/cn';
import { BackToRunHistory } from '@/components/BackToRunHistory';

interface SystemRow {
  id: string; name: string; host: string; type: string;
}
/** Shortest power-on duration a row may ask for — below this the UEs cannot come
 *  up and still pass traffic. Mirrors MIN_POWER_ON_SEC in duplicateTestcase. */
const MIN_POWER_ON = 20;

/** Remembers which testcases are ticked, across refreshes. */
const LS_PICKED = 'simqa-suite-picked';

interface SuiteProgress {
  suiteId: string;
  suiteName: string;
  done: number;
  total: number;
  current?: string;
  statuses: Record<string, 'running' | 'passed' | 'failed' | 'skipped' | 'pending'>;
  finished?: boolean;
}
interface SuiteItem {
  id: string;
  name: string;
  /** Suite this row belongs to, captured when it was added. Rows added under
   *  different suite names save as separate suites. */
  suiteName?: string;
  simnovatorTcId: string;
  callboxCfg?: string;
  /** Core cfgs from /root/mme/config, bound per row alongside the radio one. */
  mmeCfg?: string;
  imsCfg?: string;
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
  /** Attribution — who made this playlist and who last changed it. */
  createdBy?: string;
  updatedBy?: string;
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
  /** Topology profiles — the only place a Simnovator is tied to its callbox. */
  const [profiles, setProfiles] = useState<Array<{ id: string; simnovator?: string; uesim?: string; callbox?: string }>>([]);
  const [showWizard, setShowWizard] = useState(false);
  const [editingId, setEditingId] = useState<string>('');
  /** The name the edited suite had when it was opened. Save updates the group
   *  matching THIS name in place; any other group becomes a new suite. */
  const [editingName, setEditingName] = useState<string>('');

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
  /** /root/mme/config — the mme + ims cfgs live here, not with the radio one. */
  const [mmeFiles, setMmeFiles]       = useState<CallboxFile[]>([]);
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
  const [addMme,   setAddMme]           = useState<string>('');
  const [addIms,   setAddIms]           = useState<string>('');
  /** Optional name for the copy created on the box — blank reuses the source. */
  const [addDisplayName, setAddDisplayName] = useState<string>('');
  // Wizard tab state
  const [tab, setTab]                   = useState<'setup' | 'testcases'>('setup');
  /** SSH error surfaced from /api/automation/callbox-configs so the user
   *  sees WHY the config list is empty (auth failure vs empty dir). */
  const [cbxLoadError, setCbxLoadError] = useState<string>('');

  // Run state ────────────────────────────────────────────────────────────
  const [runResult, setRunResult] = useState<SuiteRunResult | null>(null);
  const [running, setRunning]     = useState<string>('');
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
      const [sysR, suitesR, invR] = await Promise.all([
        fetch('/api/ui-tests/systems').then(r => r.json()),
        fetch('/api/automation/suites').then(r => r.json()),
        // Topology profiles say which callbox belongs to which Simnovator.
        fetch('/api/inventory').then(r => r.json()),
      ]);
      const sys: SystemRow[] = (sysR?.systems ?? []).map((s: any) => ({ id: s.id, name: s.name, host: s.host, type: s.type ?? 'UESIM' }));
      setSystems(sys);
      setInvWarnings(((sysR?.warnings ?? []) as Array<{ message: string }>).map((w) => w.message));
      setSuites((suitesR?.suites ?? []) as SuiteRow[]);
      setProfiles((invR?.profiles ?? []) as Array<{ id: string; simnovator?: string; uesim?: string; callbox?: string }>);
    } catch (e: any) { setError(e?.message ?? String(e)); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  // Simnovators only. `UESIM` now means a UE host (no REST API), and the
  // loose regex matched it — so the picker auto-selected 192.168.1.101 and
  // every testcase fetch died with "login: 404".
  /** What each suite's Simnovator is currently executing, keyed by system id.
   *  The box allows one testcase at a time, so a busy system means Run would
   *  409 — polled so the block clears on its own once the run finishes. */
  const [busyBySystem, setBusyBySystem] = useState<Record<string, { host: string; testCaseName: string } | null>>({});
  /** Last polled busy map, for spotting the busy -> idle transition without
   *  making the poll depend on its own state. */
  const busyRef = useRef<Record<string, { host: string; testCaseName: string } | null>>({});

  useEffect(() => {
    const ids = Array.from(new Set(suites.map(s => s.uesimSystemId).filter(Boolean))) as string[];
    if (ids.length === 0) { setBusyBySystem({}); return; }
    let cancelled = false;
    // Never let ticks overlap. Each request talks to the box over the network,
    // so a slow box with a fixed interval would stack requests faster than they
    // drain — the failure mode that wedged the dev server. The in-flight guard
    // is what prevents that; it deliberately does NOT skip while the tab is
    // hidden, which silently froze the In Progress status whenever the window
    // was in the background.
    let inFlight = false;
    const poll = async () => {
      if (inFlight || cancelled) return;
      inFlight = true;
      try {
        const entries = await Promise.all(ids.map(async id => {
          try {
            // Client-side cap too, so a hung response can't pin the tick open.
            const r = await fetch(`/api/executions?systemId=${encodeURIComponent(id)}`, {
              signal: AbortSignal.timeout(20_000),
            }).then(r => r.json());
            if (!r?.ok || !r.busy || !r.execution) return [id, null] as const;
            return [id, { host: r.host, testCaseName: r.execution.testCaseName ?? r.execution.testCaseId ?? 'a test case' }] as const;
          } catch { return [id, null] as const; }
        }));
        if (cancelled) return;
        const next = Object.fromEntries(entries);
        // Busy -> idle means whatever was executing has finished. Re-read the
        // saved per-row results so the row flips from In Progress to its actual
        // verdict, even when the run was started outside this page.
        const wasBusy = Object.values(busyRef.current).some(Boolean);
        const nowBusy = Object.values(next).some(Boolean);
        busyRef.current = next;
        setBusyBySystem(next);
        if (wasBusy && !nowBusy) setStatusNonce(n => n + 1);
      } finally { inFlight = false; }
    };
    void poll();
    const t = setInterval(() => void poll(), 15_000);
    // Coming back to the tab should show the truth immediately rather than
    // whatever was true up to 15s ago.
    const onVisible = () => { if (!document.hidden) void poll(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { cancelled = true; clearInterval(t); document.removeEventListener('visibilitychange', onVisible); };
  }, [suites]);

  /** Inline editor for one row of a SAVED suite: which row, plus the draft. */
  const [editRow, setEditRow] = useState<{ suiteId: string; itemId: string } | null>(null);
  const [rowDraft, setRowDraft] = useState<Partial<SuiteItem>>({});

  /** Live progress of the suite currently running, polled while a run is in
   *  flight. The run itself is one long POST that says nothing until it ends. */
  const [progress, setProgress] = useState<SuiteProgress | null>(null);
  /** Status of each row from the LAST saved run, keyed suiteId → name → passed?
   *  Used to colour the table when nothing is running. */
  const [lastStatus, setLastStatus] = useState<Record<string, Record<string, boolean>>>({});
  /** Row being dragged, so a drop knows what to move. */
  const [dragRow, setDragRow] = useState<{ suiteId: string; itemId: string } | null>(null);

  /** Bumped to re-read each suite's saved per-row status. */
  const [statusNonce, setStatusNonce] = useState(0);
  /** True once this run's progress has actually been seen on the server. Guards
   *  the race right after starting a run, where the POST has not yet registered
   *  progress and a "not running" reply would otherwise cancel the UI state. */
  const sawProgress = useRef(false);

  // Poll progress only while a run is in flight — `running` is the suite id.
  useEffect(() => {
    if (!running) { setProgress(null); sawProgress.current = false; return; }
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch(`/api/automation/suites/${running}/progress`).then(r => r.json());
        if (cancelled) return;
        if (r?.progress) { sawProgress.current = true; setProgress(r.progress); }
        // The run ended — possibly in another tab, or before this page loaded.
        // Drop out of the running state and re-read the saved statuses, so a
        // page that only watched the run still ends up correct.
        if (r?.ok && !r.running && sawProgress.current) {
          setRunning('');
          setStatusNonce(n => n + 1);
        }
      } catch { /* transient */ }
    };
    void tick();
    const t = setInterval(tick, 3_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [running]);

  // Re-attach to a run already in flight. Without this a refresh mid-run shows
  // nothing: the progress lives on the server, but the page only polls for a
  // run IT started. Runs once the suite list is known and nothing is tracked.
  useEffect(() => {
    if (running || suites.length === 0) return;
    let cancelled = false;
    (async () => {
      for (const s of suites) {
        try {
          const r = await fetch(`/api/automation/suites/${s.id}/progress`).then(r => r.json());
          if (cancelled) return;
          if (r?.ok && r.running && r.progress) {
            sawProgress.current = true;
            setProgress(r.progress);
            setRunning(s.id);
            return;
          }
        } catch { /* a suite we can't reach simply isn't adopted */ }
      }
    })();
    return () => { cancelled = true; };
  }, [suites, running]);

  /** Pull each suite's most recent run so the Status column means something
   *  before you press Run. One request per suite, only when the list changes. */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const out: Record<string, Record<string, boolean>> = {};
      for (const s of suites) {
        try {
          // Dedicated endpoint: /runs returns summaries WITHOUT steps, so the
          // per-row outcome has to be computed server-side.
          const r = await fetch(`/api/automation/suites/${s.id}/status`).then(r => r.json());
          if (r?.ok && r.statuses) out[s.id] = r.statuses;
        } catch { /* a suite with no history is fine */ }
      }
      if (!cancelled) setLastStatus(out);
    })();
    return () => { cancelled = true; };
  }, [suites, statusNonce]);

  /** What to show in the Status column for one row. */
  const statusOf = useCallback((s: SuiteRow, it: SuiteItem): { label: string; dot: string; cls: string } => {
    // The box itself is the most reliable signal that a row is executing right
    // now: it survives a page refresh and is true even when the run was started
    // from the Simnovator's own GUI rather than here.
    const busy = s.uesimSystemId ? busyBySystem[s.uesimSystemId] : null;
    if (busy && busy.testCaseName === it.name) {
      return { label: 'In Progress', dot: '🟡', cls: 'text-amber-700' };
    }
    const livePr = progress && progress.suiteId === s.id ? progress.statuses?.[it.name] : undefined;
    if (livePr === 'running') return { label: 'In Progress', dot: '🟡', cls: 'text-amber-700' };
    if (livePr === 'passed')  return { label: 'Passed',  dot: '🟢', cls: 'text-emerald-700' };
    if (livePr === 'failed')  return { label: 'Failed',  dot: '🔴', cls: 'text-red-700' };
    if (livePr === 'skipped') return { label: 'Skipped', dot: '⚫', cls: 'text-slate-500' };
    const prev = lastStatus[s.id]?.[it.name];
    if (prev === true)  return { label: 'Passed', dot: '🟢', cls: 'text-emerald-700' };
    if (prev === false) return { label: 'Failed', dot: '🔴', cls: 'text-red-700' };
    return { label: 'Not Run', dot: '⚪', cls: 'text-slate-400' };
  }, [progress, lastStatus]);

  /** Rough wall-clock estimate for a run.
   *
   *  The configured duration is a small part of it: each row restarts lte and
   *  waits ~15s to settle, gives the UEs ~55s to attach, then polls for
   *  duration + 180s. Quoting the bare sum of durations would promise 40s for
   *  something that takes 20 minutes. */
  const estimateSeconds = useCallback((s: SuiteRow, rows: SuiteItem[]) => {
    const PER_ROW_OVERHEAD = 250;
    return rows.reduce((acc, it) => acc + (it.durationSec ?? s.defaultDurationSec ?? 10) + PER_ROW_OVERHEAD, 0);
  }, []);

  /** Suite + rows awaiting confirmation in the Run dialog. `rows` undefined
   *  means the whole suite. */
  const [confirmRun, setConfirmRun] = useState<{ suite: SuiteRow; rows?: SuiteItem[] } | null>(null);

  /** Stop the suite: ends the execution on the box AND cancels the rows that
   *  have not started. Stopping only the box execution would just let the next
   *  row begin. */
  const stopRun = useCallback(async (s: SuiteRow) => {
    if (!window.confirm(`Stop "${s.name}"?\n\nThe running test case is stopped and the remaining ones are skipped.`)) return;
    setError('');
    try {
      const r = await fetch(`/api/automation/suites/${s.id}/stop`, { method: 'POST' });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d?.error ?? `HTTP ${r.status}`);
      if (d.stopError) setError(`stop: ${d.stopError}`);
    } catch (e: any) { setError(e?.message ?? String(e)); }
  }, []);

  /** Ticked testcases per suite. Only these run under "Run Selected".
   *  Persisted so a page refresh doesn't silently clear your selection — losing
   *  it is how you end up running the whole suite by accident. */
  const [picked, setPicked] = useState<Record<string, Set<string>>>({});

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(LS_PICKED);
      if (!raw) return;
      const parsed: Record<string, string[]> = JSON.parse(raw);
      setPicked(Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, new Set(v)])));
    } catch { /* nothing remembered */ }
  }, []);

  useEffect(() => {
    try {
      const plain = Object.fromEntries(
        Object.entries(picked).filter(([, v]) => v.size > 0).map(([k, v]) => [k, [...v]]),
      );
      window.localStorage.setItem(LS_PICKED, JSON.stringify(plain));
    } catch { /* private mode — selection just won't persist */ }
  }, [picked]);
  const pickedIn = useCallback((suiteId: string) => picked[suiteId] ?? new Set<string>(), [picked]);
  const togglePick = useCallback((suiteId: string, itemId: string) => {
    setPicked(prev => {
      const cur = new Set(prev[suiteId] ?? []);
      if (cur.has(itemId)) cur.delete(itemId); else cur.add(itemId);
      return { ...prev, [suiteId]: cur };
    });
  }, []);
  const toggleAllPicks = useCallback((s: SuiteRow) => {
    setPicked(prev => {
      const all = (s.items ?? []).map(i => i.id);
      const cur = prev[s.id] ?? new Set<string>();
      return { ...prev, [s.id]: cur.size === all.length ? new Set<string>() : new Set(all) };
    });
  }, []);

  /** Persist a reordered row list. */
  const persistOrder = useCallback(async (s: SuiteRow, next: SuiteItem[]) => {
    setBusy('update'); setError('');
    try {
      const r = await fetch(`/api/automation/suites/${s.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: next, testcaseIds: next.map(x => x.simnovatorTcId) }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await refresh();
    } catch (e: any) { setError(e?.message ?? String(e)); }
    finally { setBusy(''); }
  }, [refresh]);

  /** Drop `dragRow` onto `target`, reordering and saving. */
  const dropOn = useCallback((s: SuiteRow, target: SuiteItem) => {
    if (!dragRow || dragRow.suiteId !== s.id || dragRow.itemId === target.id) { setDragRow(null); return; }
    const cur = [...(s.items ?? [])];
    const from = cur.findIndex(x => x.id === dragRow.itemId);
    const to = cur.findIndex(x => x.id === target.id);
    if (from < 0 || to < 0) { setDragRow(null); return; }
    const [moved] = cur.splice(from, 1);
    cur.splice(to, 0, moved);
    setDragRow(null);
    void persistOrder(s, cur);
  }, [dragRow, persistOrder]);

  /** Busy boxes, deduped by host: two suites on the same Simnovator are one
   *  box being busy, not two. */
  const busyHosts = (() => {
    const seen = new Map<string, { host: string; testCaseName: string }>();
    for (const b of Object.values(busyBySystem)) {
      if (b && !seen.has(b.host)) seen.set(b.host, b);
    }
    return [...seen.values()];
  })();

  /** Systems are stored by id on a suite, but an id means nothing to an
   *  operator — show the IP the row actually talks to. */
  const hostOf = useCallback((id?: string) => {
    if (!id) return '–';
    return systems.find(s => s.id === id)?.host ?? id;
  }, [systems]);

  const uesimSystems = systems.filter(s => s.type === 'SIMNOVATOR' || s.type === 'SIMNOVATOR_GUI');
  const callboxSystems = systems.filter(s => /CALLBOX/i.test(s.type));

  // ── Wizard step gating ───────────────────────────────────────────────
  // Each step unlocks the next: you can't pick testcases before the systems
  // they'd come from are chosen, and there's nothing to run until at least
  // one testcase row exists.
  const setupComplete = Boolean(
    name.trim() && uesimSystemId && (kind === 'uesim-only' || callboxSystemId),
  );
  const testcasesComplete = setupComplete && items.length > 0;

  const stepBlockedReason = (id: 'setup' | 'testcases'): string => {
    if (id === 'testcases' && !setupComplete) {
      return !name.trim() ? 'Enter a suite name first'
        : !uesimSystemId ? 'Choose a Simnovator system first'
        : 'Choose a callbox system first';
    }
    return '';
  };

  // The selects have no "— pick —" row, so a browser showing the first option
  // must be backed by real state — otherwise Save would submit an empty id.
  useEffect(() => {
    if (!uesimSystemId && uesimSystems.length) setUesim(uesimSystems[0].id);
  }, [uesimSystemId, uesimSystems]);
  // Pair the callbox to the chosen Simnovator via its topology profile, so
  // picking 192.168.1.102 selects ITS callbox rather than whichever happens to
  // be first in inventory. Falls back to the first callbox when the Simnovator
  // has no profile.
  //
  // Only fires when the Simnovator actually CHANGES — the earlier version ran
  // on every render and reset the dropdown, making it impossible to pick a
  // different callbox by hand. The suggestion is a default, not a lock.
  const pairedFor = useRef<string>('');
  useEffect(() => {
    if (kind !== 'uesim+callbox' || !uesimSystemId) return;
    if (pairedFor.current === uesimSystemId && callboxSystemId) return;
    const profile = profiles.find((p) => p.simnovator === uesimSystemId || p.uesim === uesimSystemId);
    const paired = profile?.callbox && callboxSystems.some((c) => c.id === profile.callbox)
      ? profile.callbox
      : undefined;
    const next = paired ?? callboxSystems[0]?.id;
    if (next) {
      pairedFor.current = uesimSystemId;
      if (next !== callboxSystemId) setCbx(next);
    }
  }, [kind, uesimSystemId, profiles, callboxSystems, callboxSystemId]);

  const loadCallboxConfigs = useCallback(async (sysId: string) => {
    if (!sysId) { setCbxFiles([]); setMmeFiles([]); setCbxLoadError(''); return; }
    setLoadingCbx(true); setCbxLoadError('');
    try {
      // Two directories: the radio cfgs and the core (mme + ims) cfgs.
      const [enbR, mmeR] = await Promise.all([
        fetch(`/api/automation/callbox-configs?systemId=${encodeURIComponent(sysId)}&dir=enb`).then(r => r.json()),
        fetch(`/api/automation/callbox-configs?systemId=${encodeURIComponent(sysId)}&dir=mme`).then(r => r.json()),
      ]);
      setCbxFiles(enbR?.ok ? (enbR.files ?? []) : []);
      setMmeFiles(mmeR?.ok ? (mmeR.files ?? []) : []);
      if (!enbR?.ok) setCbxLoadError(enbR?.error ?? 'failed to list callbox configs');
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
  /** Upload a SINGLE .cfg file and bind it to one of the three pickers.
   *  `target` says which — the core cfgs (mme/ims) land in /root/mme/config and
   *  the radio one in /root/enb/config, so the runner needs to know which the
   *  blob belongs to as well as which dropdown to preselect. */
  const onPickUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>, target: 'gnb' | 'mme' | 'ims') => {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const data = String(reader.result ?? '');
      const b64 = data.includes(',') ? data.split(',', 2)[1] : btoa(data);
      setUploads({ ...uploadedConfigs, [f.name]: b64 });
      if (target === 'gnb') { setSelectedCfg(f.name); setAddCfg(f.name); }
      else if (target === 'mme') setAddMme(f.name);
      else setAddIms(f.name);
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
    setEditingId(''); setName(''); setEditingName(''); setKind('uesim-only');
    setUesim(''); setCbx(''); setCbxFiles([]); setUploads({}); setCbxLoadError('');
    setUeTcs([]); setSelectedCfg(''); setSelectedTcs(new Set());
    setStopOnFail(false); setRemoveCfgAfterRun(true); setCbxFilter(''); setTcFilter('');
    setDefaultDur(10); setPerTcDur({}); setMassDurInput('10');
    setItems([]); setAddTcId(''); setAddCfg('');
    setTab('setup');
    setError(''); setShowWizard(false);
  }, []);

  const openNew = useCallback(() => { resetWizard(); setShowWizard(true); }, [resetWizard]);
  /** Open a saved suite in the wizard. `startTab` picks which step to land on —
   *  "Add" jumps straight to Testcases, since the systems are already chosen. */
  const openEdit = useCallback((s: SuiteRow, startTab: 'setup' | 'testcases' = 'setup') => {
    resetWizard();
    setEditingId(s.id);
    setName(s.name);
    setEditingName(s.name);
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
    // Existing rows belong to the suite being edited, so stamp them with its
    // name — otherwise Save would regroup them under whatever is typed next.
    if (s.items && s.items.length > 0) {
      setItems(s.items.map(it => ({ ...it, suiteName: it.suiteName || s.name })));
    } else {
      const synth: SuiteItem[] = s.testcaseIds.map((tcId, i) => ({
        id: `item-${i}-${Math.random().toString(36).slice(2, 8)}`,
        name: tcId,                       // user can rename
        suiteName: s.name,
        simnovatorTcId: tcId,
        callboxCfg: s.kind === 'uesim+callbox' ? s.callboxConfig : undefined,
        durationSec: s.testcaseDurations?.[tcId],
      }));
      setItems(synth);
    }
    setShowWizard(true);
    setTab(startTab);
    if (s.callboxSystemId && s.kind === 'uesim+callbox') void loadCallboxConfigs(s.callboxSystemId);
    if (s.uesimSystemId) void loadUesimTestcases(s.uesimSystemId);
  }, [resetWizard, loadCallboxConfigs, loadUesimTestcases]);

  /** Open the row editor, loading that suite's cfg lists so the dropdowns have
   *  something to offer. */
  const startEditRow = useCallback((s: SuiteRow, it: SuiteItem) => {
    setEditRow({ suiteId: s.id, itemId: it.id });
    setRowDraft({ ...it });
    if (s.callboxSystemId) void loadCallboxConfigs(s.callboxSystemId);
    if (s.uesimSystemId) void loadUesimTestcases(s.uesimSystemId);
  }, [loadCallboxConfigs, loadUesimTestcases]);

  /** Persist the drafted row back into its suite. `move` optionally repositions
   *  it — execution follows the stored order, so moving a row to the top makes
   *  it run first. */
  const saveEditRow = useCallback(async (s: SuiteRow, move?: 'first' | 'up' | 'down') => {
    if (!editRow) return;
    const cur = s.items ?? [];
    const i = cur.findIndex(x => x.id === editRow.itemId);
    if (i < 0) { setEditRow(null); return; }
    const next = cur.map(x => x.id === editRow.itemId ? { ...x, ...rowDraft } : x);
    if (move) {
      const [row] = next.splice(i, 1);
      const to = move === 'first' ? 0 : move === 'up' ? Math.max(0, i - 1) : Math.min(next.length, i + 1);
      next.splice(to, 0, row);
    }
    setBusy('update'); setError('');
    try {
      const r = await fetch(`/api/automation/suites/${s.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: next, testcaseIds: next.map(x => x.simnovatorTcId) }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await refresh();
      setEditRow(null); setRowDraft({});
    } catch (e: any) { setError(e?.message ?? String(e)); }
    finally { setBusy(''); }
  }, [editRow, rowDraft, refresh]);

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

    // Rows are grouped by the suite name they were added under, so one wizard
    // session can produce several suites: add two rows as "SA", rename to "uu",
    // add more, and Save writes SA and uu as separate suites with their own
    // testcases. Only the group matching the suite being edited updates in
    // place; the rest are created.
    const groups = new Map<string, SuiteItem[]>();
    for (const it of items) {
      const key = it.suiteName || name.trim() || '(unnamed)';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(it);
    }
    if (groups.size === 0) groups.set(name.trim(), []);

    const basePayload = {
      kind,
      uesimSystemId,
      callboxSystemId: kind === 'uesim+callbox' ? callboxSystemId : undefined,
      uploadedConfigs: trimmedItemUploads ?? trimmedUploads,
      // Legacy fields stay populated for old consumers, but the runner
      // prefers items[] when present.
      callboxConfig: kind === 'uesim+callbox' ? (cfg || undefined) : undefined,
      defaultDurationSec: defaultDur > 0 ? defaultDur : 10,
      testcaseDurations: Object.keys(trimmedDurs).length ? trimmedDurs : undefined,
      stopOnFail,
      removeConfigAfterRun: removeCfgAfterRun,
    };

    setBusy(editingId ? 'update' : 'create'); setError('');
    try {
      for (const [suiteName, groupItems] of groups) {
        const payload: any = {
          ...basePayload,
          name: suiteName,
          testcaseIds: groupItems.length > 0 ? groupItems.map(it => it.simnovatorTcId) : tcs,
          items: groupItems.length > 0 ? groupItems : undefined,
        };
        // Update in place only when this group IS the suite we opened for edit.
        const isEdited = !!editingId && suiteName === editingName;
        const r = isEdited
          ? await fetch(`/api/automation/suites/${editingId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
          : await fetch('/api/automation/suites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const d = await r.json();
        if (!r.ok || !d.ok) throw new Error(`${suiteName}: ${d?.error ?? `HTTP ${r.status}`}`);
      }
      await refresh();
      resetWizard();
    } catch (e: any) { setError(e?.message ?? String(e)); }
    finally { setBusy(''); }
  };

  /** Run a whole suite, or — when `rows` is given — only those testcases.
   *  Confirmation happens in the dialog that calls this, not here. */
  const runSuite = async (s: SuiteRow, rows?: SuiteItem[]) => {
    setConfirmRun(null);
    setRunning(s.id); setRunResult(null); setError('');
    try {
      // perf-qa collection stays available on the API for callers that have
      // perf-qa deployed; the UI no longer offers it.
      const r = await fetch(`/api/automation/suites/${s.id}/run`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rows?.length ? { itemIds: rows.map(r => r.id) } : {}),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d?.error ?? `HTTP ${r.status}`);
      setRunResult(d.result);
      // Update the Status column straight from the result. The background
      // loader only refires when the suite LIST changes, which a run doesn't do
      // — without this the row sat at "Not Run" after passing. Merged rather
      // than replaced so running one row doesn't blank the others.
      const fresh: Record<string, boolean> = {};
      for (const st of d.result?.steps ?? []) if (st?.testcaseId) fresh[st.testcaseId] = !!st.ok;
      setLastStatus(prev => ({ ...prev, [s.id]: { ...(prev[s.id] ?? {}), ...fresh } }));
      // Refresh history if we were viewing this suite's runs.
      if (historyFor === s.id) await loadHistory(s.id);
    } catch (e: any) { setError(e?.message ?? String(e)); }
    finally { setRunning(''); }
  };

  /** Drop one testcase from a saved suite, leaving the rest intact. Deleting the
   *  last row would leave a suite with nothing to run, so that removes the
   *  suite instead — after saying so. */
  const deleteItem = async (s: SuiteRow, it: SuiteItem) => {
    const remaining = (s.items ?? []).filter(x => x.id !== it.id);
    const msg = remaining.length === 0
      ? `"${it.name}" is the only testcase in "${s.name}". Delete the whole suite?`
      : `Remove "${it.name}" from suite "${s.name}"?`;
    if (!window.confirm(msg)) return;
    setBusy('delete'); setError('');
    try {
      const r = remaining.length === 0
        ? await fetch(`/api/automation/suites/${s.id}`, { method: 'DELETE' })
        : await fetch(`/api/automation/suites/${s.id}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items: remaining, testcaseIds: remaining.map(x => x.simnovatorTcId) }),
          });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await refresh();
    } catch (e: any) { setError(e?.message ?? String(e)); }
    finally { setBusy(''); }
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

  /** The display name the row would create, folded to the box's charset — or ''
   *  when the user hasn't typed one (the source testcase's own name is reused,
   *  which by definition already exists and is handled by the runner). */
  const addNameNormalized = addDisplayName.trim().replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  /** Non-empty when another row in this wizard already claims the name. Two rows
   *  cannot share one — names are unique on the box, so they would be the same
   *  testcase. A name that exists ON THE BOX is fine: the runner reuses it
   *  rather than creating a copy. */
  const addNameTaken = addNameNormalized && items.some(it => it.name === addNameNormalized)
    ? addNameNormalized
    : '';

  /** Set when the name matches a testcase already on the Simnovator — not an
   *  error, just worth saying that the run will execute that one. */
  const addNameReuses = addNameNormalized && !addNameTaken
    && uesimTestcases.some(t => t.name === addNameNormalized)
    ? addNameNormalized
    : '';

  /** Wizard rows grouped by the suite name they were added under, in insertion
   *  order. Each group is rendered — and saved — as its own suite. */
  const itemGroups: Array<[string, SuiteItem[]]> = (() => {
    const m = new Map<string, SuiteItem[]>();
    for (const it of items) {
      const key = it.suiteName || name.trim() || '(unnamed)';
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(it);
    }
    return [...m.entries()];
  })();

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="max-w-7xl mx-auto px-6 py-8">
        <header className="mb-6">
          <div className="mb-1"><BackToRunHistory /></div>
          <h1 className="text-2xl font-bold text-slate-900">Automation Suite</h1>
          <p className="text-sm text-slate-600 mt-1">
            Create a collection of test cases for a selected simnovator and run them together with a single click.
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

        {/* Run confirmation. Spells out what will happen and roughly how long —
            the configured duration is a small fraction of the real wall clock,
            so quoting it alone would badly mislead. */}
        {confirmRun && (() => {
          const s = confirmRun.suite;
          const subset = confirmRun.rows;                     // undefined = whole suite
          const rows = subset ?? (s.items ?? []);
          const secs = estimateSeconds(s, rows);
          const pretty = secs >= 90 ? `${Math.round(secs / 60)} minutes` : `${secs} seconds`;
          const title = !subset ? `Run suite “${s.name}”?`
            : rows.length === 1 ? `Run “${rows[0].name}”?`
            : `Run ${rows.length} selected test cases from “${s.name}”?`;
          return (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4"
              onClick={() => setConfirmRun(null)}>
              <div className="bg-white rounded-xl shadow-xl border border-slate-200 max-w-md w-full p-5"
                onClick={e => e.stopPropagation()}>
                <h3 className="text-base font-semibold text-slate-900">{title}</h3>
                <p className="mt-2 text-sm text-slate-600">
                  {rows.length} test case{rows.length === 1 ? '' : 's'} will be executed sequentially
                  {subset && (s.items ?? []).length > rows.length
                    ? ` — the other ${(s.items ?? []).length - rows.length} in this suite will not run.`
                    : '.'}
                </p>
                {subset && rows.length > 1 && (
                  <ul className="mt-1 text-[11px] text-slate-500 list-decimal pl-5">
                    {rows.map(r => <li key={r.id}>{r.name}</li>)}
                  </ul>
                )}
                <p className="mt-1 text-sm text-slate-600">
                  Estimated duration: <span className="font-medium text-slate-900">~{pretty}</span>
                </p>
                <p className="mt-2 text-[11px] text-slate-500">
                  Each test case creates or reuses its testcase on {hostOf(s.uesimSystemId)}
                  {s.kind === 'uesim+callbox' && <>, symlinks its gnb/mme/ims cfgs on {hostOf(s.callboxSystemId)} and restarts lte</>}
                  , then executes. Most of the time is bring-up, not the configured duration.
                </p>
                <div className="mt-4 flex justify-end gap-2">
                  <button onClick={() => setConfirmRun(null)}
                    className="rounded-md border border-slate-300 hover:bg-slate-50 text-sm px-4 py-2">Cancel</button>
                  <button onClick={() => runSuite(s, subset)}
                    className="rounded-md bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold px-4 py-2">
                    ▶ {!subset ? 'Run Suite' : rows.length === 1 ? 'Run Test Case' : 'Run Selected'}
                  </button>
                </div>
              </div>
            </div>
          );
        })()}

        {/* Suite list */}
        <section className="bg-white border border-slate-200 rounded-xl p-5 mb-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-semibold text-slate-900">Saved suites ({suites.length})</h2>
            <div className="flex items-center gap-3">
              <button onClick={openNew} className="rounded-md bg-orange-500 hover:bg-orange-600 text-white text-sm font-medium px-4 py-2">
                Create New Suite
              </button>
            </div>
          </div>
          {/* Live progress of the running suite. The run is one long request, so
              this is polled separately — without it the page looks frozen for
              the ~5 minutes each row takes. */}
          {progress && (
            <div className="mb-3 rounded-md border border-blue-200 bg-blue-50 px-3 py-2">
              <div className="flex items-baseline justify-between text-xs text-blue-900 gap-3">
                <span className="font-semibold">
                  Running {Math.min(progress.done + 1, progress.total)} of {progress.total} · {progress.suiteName}
                </span>
                <span className="flex items-center gap-2">
                  <span>{Math.round((progress.done / Math.max(1, progress.total)) * 100)}%</span>
                  {(() => {
                    const s = suites.find(x => x.id === progress.suiteId);
                    return s ? (
                      <button onClick={() => stopRun(s)}
                        className="rounded bg-red-600 hover:bg-red-700 text-white text-[11px] font-semibold px-2 py-0.5">
                        ⏹ Stop
                      </button>
                    ) : null;
                  })()}
                </span>
              </div>
              <div className="mt-1 h-2 w-full rounded bg-blue-100 overflow-hidden">
                <div className="h-full bg-blue-600 transition-all duration-500"
                  style={{ width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%` }} />
              </div>
              <div className="mt-1 text-[11px] text-blue-800">
                {progress.current ? `${progress.current} — running…` : 'starting…'}
              </div>
            </div>
          )}

          {/* One notice per busy box, not per suite — several suites can point at
              the same Simnovator, and repeating the same warning for each of
              them is just noise. */}
          {busyHosts.map(b => (
            <div key={b.host} className="mb-3 rounded-md border border-amber-300 bg-amber-50 text-amber-800 text-xs px-3 py-2">
              Already a test case is in progress on {b.host} — “{b.testCaseName}”. Suites on this Simnovator cannot run until it finishes.
            </div>
          ))}
          {suites.length === 0 ? (
            <div className="text-sm text-slate-500 py-4 text-center">No suites yet, Click on Create New Suite to build one.</div>
          ) : (
            <div className="overflow-x-auto border border-slate-200 rounded-md">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium">Suite Name</th>
                    <th className="text-right px-3 py-2 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {suites.map(s => {
                    // The box runs one testcase at a time. If something is
                    // already executing on this suite's Simnovator, Run would
                    // just 409 — so block it and say why.
                    const busy = s.uesimSystemId ? busyBySystem[s.uesimSystemId] : null;
                    return (
                    <React.Fragment key={s.id}>
                    <tr>
                      <td className="px-3 py-2 font-medium">
                        {s.name}
                        {/* Setup kind + the systems it targets used to be their
                            own columns; kept here as a subtitle so the table
                            stays two columns without losing the context. */}
                        <div className="text-[11px] font-normal text-slate-500">
                          {s.kind === 'uesim+callbox' ? 'UESIM + CALLBOX' : 'UESIM only'}
                          {' · '}{hostOf(s.uesimSystemId)}
                          {s.kind === 'uesim+callbox' && <> · {hostOf(s.callboxSystemId)}</>}
                          {/* Who made it. Suites saved before sign-in existed
                              have no author, so say nothing rather than guess. */}
                          {s.createdBy ? <> · created by <span className="text-slate-600">{s.createdBy}</span></> : null}
                          {s.updatedBy && s.updatedBy !== s.createdBy
                            ? <> · last edited by <span className="text-slate-600">{s.updatedBy}</span></>
                            : null}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        {/* Stop replaces Run while this suite is going — the two
                            are never both useful, and a Run that does nothing is
                            worse than no button. */}
                        {running === s.id || (busy && progress?.suiteId === s.id) ? (
                          <button onClick={() => stopRun(s)}
                            title="Stop the running test case and skip the rest"
                            className="rounded-md bg-red-600 hover:bg-red-700 text-white text-xs font-semibold px-3 py-1.5 mr-1">
                            ⏹ Stop
                          </button>
                        ) : (
                          <button onClick={() => setConfirmRun({ suite: s })} disabled={!!busy}
                            title={busy ? `${busy.testCaseName} is already running on ${busy.host}` : 'Run every testcase in this suite'}
                            className="rounded-md bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 text-white text-xs font-semibold px-3 py-1.5 mr-1">
                            ▶ Run Suite
                          </button>
                        )}
                        {/* Only the ticked rows. Disabled until something is
                            ticked, so it can never silently mean "all". */}
                        <button
                          onClick={() => setConfirmRun({
                            suite: s,
                            rows: (s.items ?? []).filter(i => pickedIn(s.id).has(i.id)),
                          })}
                          disabled={running === s.id || !!busy || pickedIn(s.id).size === 0}
                          title={pickedIn(s.id).size === 0 ? 'Tick one or more testcases first' : `Run the ${pickedIn(s.id).size} ticked testcase(s)`}
                          className="rounded-md border border-blue-600 text-blue-700 hover:bg-blue-50 disabled:border-slate-300 disabled:text-slate-400 text-xs font-semibold px-3 py-1.5 mr-1">
                          ▶ Run Selected{pickedIn(s.id).size > 0 ? ` (${pickedIn(s.id).size})` : ''}
                        </button>
                        {/* Opens the wizard straight on the Testcases step — from
                            the suite list the thing you want is another row, not
                            the systems you already picked. */}
                        <button onClick={() => openEdit(s, 'testcases')} className="rounded-md border border-slate-300 hover:bg-slate-50 text-xs px-2 py-1 mr-1">Add</button>
                        <button onClick={() => deleteSuite(s)} className="rounded-md border border-red-300 text-red-600 hover:bg-red-50 text-xs px-2 py-1">Delete</button>
                      </td>
                    </tr>
                    {/* The suite's testcases listed underneath rather than as a
                        bare count, so a 2-row suite shows both names. */}
                    {(s.items ?? []).length > 0 && (
                      <tr className="bg-slate-50/60">
                        <td colSpan={2} className="px-3 pb-2 pt-0">
                          <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1">
                            {(s.items ?? []).length} test case{(s.items ?? []).length === 1 ? '' : 's'}
                          </div>
                          <table className="min-w-full text-xs border border-slate-200 rounded bg-white">
                            <thead className="bg-slate-50 text-slate-500">
                              <tr>
                                <th className="px-2 py-1 text-left w-6">
                                  <input
                                    type="checkbox"
                                    title="Select all / none"
                                    checked={(s.items ?? []).length > 0 && pickedIn(s.id).size === (s.items ?? []).length}
                                    onChange={() => toggleAllPicks(s)}
                                  />
                                </th>
                                <th className="px-2 py-1 text-left w-6"></th>
                                <th className="px-2 py-1 text-left w-8">#</th>
                                <th className="px-2 py-1 text-left">Display name in Simnovator</th>
                                <th className="px-2 py-1 text-left">gnb.cfg</th>
                                <th className="px-2 py-1 text-left">mme.cfg</th>
                                <th className="px-2 py-1 text-left">ims.cfg</th>
                                <th className="px-2 py-1 text-right">Power-on duration (s)</th>
                                <th className="px-2 py-1 text-left">Status</th>
                                <th className="px-2 py-1 text-right">Actions</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                              {(s.items ?? []).map((it, i) => {
                                const editing = editRow?.suiteId === s.id && editRow?.itemId === it.id;
                                if (editing) {
                                  return (
                                    <tr key={it.id} className="bg-amber-50/60">
                                      <td className="px-2 py-1" />
                                      <td className="px-1 py-1" />
                                      <td className="px-2 py-1 text-slate-400 align-top">{i + 1}</td>
                                      <td className="px-2 py-1 align-top">
                                        <div className="font-medium text-slate-800">{it.name}</div>
                                        {/* Setup Kind is a property of the SUITE, not of one row —
                                            every row shares the same systems. Editing it here
                                            changes the suite, so it is labelled as such. */}
                                        <label className="block mt-1 text-[10px] text-slate-500">
                                          Setup Kind (whole suite)
                                          <select
                                            value={s.kind ?? 'uesim-only'}
                                            onChange={async e => {
                                              await fetch(`/api/automation/suites/${s.id}`, {
                                                method: 'PUT', headers: { 'Content-Type': 'application/json' },
                                                body: JSON.stringify({ kind: e.target.value }),
                                              });
                                              await refresh();
                                            }}
                                            className="mt-0.5 w-full border border-slate-300 rounded px-1 py-0.5 text-[11px]">
                                            <option value="uesim-only">UESIM only</option>
                                            <option value="uesim+callbox">UESIM + CALLBOX</option>
                                          </select>
                                        </label>
                                        <label className="block mt-1 text-[10px] text-slate-500">
                                          Simnovator testcase
                                          <select
                                            value={rowDraft.simnovatorTcId ?? it.simnovatorTcId}
                                            onChange={e => setRowDraft({ ...rowDraft, simnovatorTcId: e.target.value })}
                                            className="mt-0.5 w-full border border-slate-300 rounded px-1 py-0.5 text-[11px]">
                                            {uesimTestcases.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                                          </select>
                                        </label>
                                      </td>
                                      {([['callboxCfg', callboxFiles], ['mmeCfg', mmeFiles], ['imsCfg', mmeFiles]] as const).map(([field, list]) => (
                                        <td key={field} className="px-2 py-1 align-top">
                                          <select
                                            value={(rowDraft[field] ?? it[field] ?? '') as string}
                                            onChange={e => setRowDraft({ ...rowDraft, [field]: e.target.value || undefined })}
                                            className="w-full border border-slate-300 rounded px-1 py-0.5 text-[11px]">
                                            <option value="">— none —</option>
                                            {list.map(f => <option key={f.name} value={f.name}>{f.name}</option>)}
                                          </select>
                                        </td>
                                      ))}
                                      <td className="px-2 py-1 text-right align-top">
                                        <input type="number" min={MIN_POWER_ON}
                                          value={rowDraft.durationSec ?? it.durationSec ?? ''}
                                          placeholder={String(s.defaultDurationSec ?? MIN_POWER_ON)}
                                          onChange={e => setRowDraft({ ...rowDraft, durationSec: e.target.value === '' ? undefined : Math.max(MIN_POWER_ON, Number(e.target.value) || MIN_POWER_ON) })}
                                          className="border border-slate-300 rounded px-1 py-0.5 w-[60px] text-[11px] text-right" />
                                      </td>
                                      <td className="px-2 py-1" />
                                      <td className="px-2 py-1 text-right whitespace-nowrap align-top">
                                        <button onClick={() => saveEditRow(s)} disabled={!!busy}
                                          className="rounded bg-orange-500 hover:bg-orange-600 disabled:bg-slate-300 text-white text-[11px] px-2 py-0.5 mr-1">Save</button>
                                        {i > 0 && (
                                          <button onClick={() => saveEditRow(s, 'first')} disabled={!!busy}
                                            title="Save and move to position 1 — it will then execute first"
                                            className="rounded border border-slate-300 hover:bg-slate-100 text-[11px] px-2 py-0.5 mr-1">Save &amp; make first</button>
                                        )}
                                        <button onClick={() => { setEditRow(null); setRowDraft({}); }}
                                          className="rounded border border-slate-300 hover:bg-slate-100 text-[11px] px-2 py-0.5">Cancel</button>
                                      </td>
                                    </tr>
                                  );
                                }
                                const st = statusOf(s, it);
                                return (
                                  <tr key={it.id}
                                    onDragOver={e => { if (dragRow?.suiteId === s.id) e.preventDefault(); }}
                                    onDrop={() => dropOn(s, it)}
                                    className={dragRow?.itemId === it.id ? 'opacity-40' : ''}>
                                    <td className="px-2 py-1">
                                      <input
                                        type="checkbox"
                                        checked={pickedIn(s.id).has(it.id)}
                                        onChange={() => togglePick(s.id, it.id)}
                                      />
                                    </td>
                                    {/* Drag handle. Only the handle starts a drag, so
                                        selecting text in a cell still works. */}
                                    <td className="px-1 py-1 text-slate-400 cursor-grab select-none"
                                      draggable
                                      onDragStart={() => setDragRow({ suiteId: s.id, itemId: it.id })}
                                      onDragEnd={() => setDragRow(null)}
                                      title="Drag to reorder — rows execute top to bottom">⋮⋮</td>
                                    <td className="px-2 py-1 text-slate-400">{i + 1}</td>
                                    <td className="px-2 py-1 font-medium text-slate-800">{it.name}</td>
                                    <td className="px-2 py-1 font-mono text-[11px] text-slate-600">{it.callboxCfg ?? '–'}</td>
                                    <td className="px-2 py-1 font-mono text-[11px] text-slate-600">{it.mmeCfg ?? '–'}</td>
                                    <td className="px-2 py-1 font-mono text-[11px] text-slate-600">{it.imsCfg ?? '–'}</td>
                                    <td className="px-2 py-1 text-right">{it.durationSec ?? s.defaultDurationSec ?? 10}</td>
                                    <td className={`px-2 py-1 whitespace-nowrap ${st.cls}`}>{st.dot} {st.label}</td>
                                    <td className="px-2 py-1 text-right whitespace-nowrap">
                                      <button
                                        onClick={() => setConfirmRun({ suite: s, rows: [it] })}
                                        disabled={running === s.id || !!busy}
                                        title={busy ? `${busy.testCaseName} is already running on ${busy.host}` : `Run only "${it.name}"`}
                                        className="rounded bg-blue-500 hover:bg-blue-600 disabled:bg-slate-300 text-white text-[11px] px-2 py-0.5 mr-1">
                                        Run
                                      </button>
                                      <button onClick={() => startEditRow(s, it)} disabled={running === s.id}
                                        className="rounded border border-slate-300 hover:bg-slate-100 disabled:opacity-40 text-[11px] px-2 py-0.5 mr-1">
                                        Edit
                                      </button>
                                      <button
                                        onClick={() => deleteItem(s, it)}
                                        disabled={running === s.id}
                                        className="rounded border border-red-300 text-red-600 hover:bg-red-50 disabled:opacity-40 text-[11px] px-2 py-0.5">
                                        Delete
                                      </button>
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                    </React.Fragment>
                    );
                  })}
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
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-base font-semibold text-slate-900">{editingId ? 'Edit suite' : 'New suite'}</h2>
              <button onClick={resetWizard} className="text-sm text-slate-500 hover:text-slate-900">Cancel</button>
            </div>

            {/* Tab strip — explicit step counter so the user sees the flow */}
            <div className="flex items-center gap-1 border-b border-slate-200 mb-5">
              {([
                { id: 'setup',     label: '① Setup',      hint: 'name · systems · radio config' },
                { id: 'testcases', label: '② Testcases',  hint: 'pick + durations' },
              ] as const).map(t => {
                const blocked = stepBlockedReason(t.id);
                return (
                  <button key={t.id} type="button" onClick={() => setTab(t.id)} disabled={!!blocked}
                    className={cn(
                      'px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors',
                      blocked
                        ? 'border-transparent text-slate-300 cursor-not-allowed'
                        : tab === t.id ? 'border-orange-500 text-slate-900' : 'border-transparent text-slate-500 hover:text-slate-700',
                    )}
                    title={blocked || t.hint}>
                    {t.label}
                  </button>
                );
              })}
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
                  <option value="uesim+callbox">UESIM + CALLBOX - Bind with gnb.cfg, mme.cfg and Ims.cfg</option>
                </select>
              </label>
            </div>

            <div className="grid grid-cols-2 gap-4 mb-4">
              <label className="flex flex-col">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Simnovator system</span>
                <select value={uesimSystemId} onChange={e => setUesim(e.target.value)} className="border border-slate-300 rounded-md px-3 py-2 text-sm">
                  {uesimSystems.map(s => (
                    <option key={s.id} value={s.id}>{s.name} ({s.host})</option>
                  ))}
                </select>
              </label>
              {kind === 'uesim+callbox' && (
                <label className="flex flex-col">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Callbox system</span>
                  <select value={callboxSystemId} onChange={e => setCbx(e.target.value)} className="border border-slate-300 rounded-md px-3 py-2 text-sm">
                    {callboxSystems.map(s => (
                      <option key={s.id} value={s.id}>{s.name} ({s.host})</option>
                    ))}
                  </select>
                </label>
              )}
            </div>

            {/* Setup tab is now JUST about systems — per-row eNB cfg
                lives on the Testcases tab where each row pairs a
                Simnovator testcase with its own callbox cfg. */}

            <div className="flex items-center justify-end gap-3 mt-4">
              {!setupComplete && <span className="text-xs text-slate-500">{stepBlockedReason('testcases')}</span>}
              <button
                onClick={() => setTab('testcases')}
                disabled={!setupComplete}
                className="rounded-md bg-slate-800 hover:bg-slate-900 disabled:bg-slate-300 disabled:cursor-not-allowed text-white text-sm px-4 py-2"
              >
                Next: Testcases →
              </button>
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
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Power-on duration (sec)</span>
                  <input type="number" min={MIN_POWER_ON} value={defaultDur}
                    onChange={e => setDefaultDur(Math.max(MIN_POWER_ON, Number(e.target.value) || MIN_POWER_ON))}
                    className="border border-slate-300 rounded-md px-2 py-1 w-[80px] text-sm" />
                </label>
                <span className="text-[11px] text-slate-500">
                  How long the UEs stay powered on. The user-plane session is derived from it — minimum {MIN_POWER_ON}s.
                </span>
                <span className="text-xs text-slate-400">|</span>
                <label className="flex items-center gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Apply to all rows</span>
                  <input type="number" min={MIN_POWER_ON} value={massDurInput} onChange={e => setMassDurInput(e.target.value)} className="border border-slate-300 rounded-md px-2 py-1 w-[80px] text-sm" />
                  <button type="button" onClick={() => {
                    const n = Math.max(MIN_POWER_ON, Number(massDurInput) || MIN_POWER_ON);
                    setItems(items.map(it => ({ ...it, durationSec: n })));
                  }} disabled={items.length === 0} className="rounded-md bg-slate-800 hover:bg-slate-900 disabled:bg-slate-300 text-white text-xs px-2 py-1">Apply</button>
                </label>
              </div>

              {/* One table PER suite name — rows added under "SA" group into the
                  SA table, rows added after renaming to "uu" get their own. Each
                  table is exactly what will be saved as that suite, numbered
                  from 1, so the suite name appears once rather than on every
                  row. Execution order within a suite is top to bottom. */}
              {items.length === 0 ? (
                <div className="mb-3 border border-slate-200 rounded-md bg-white px-3 py-4 text-center text-slate-500 text-xs">
                  No testcases yet. Add one below.
                </div>
              ) : itemGroups.map(([groupName, groupItems]) => (
                <div key={groupName} className="mb-3 border border-slate-200 rounded-md bg-white overflow-x-auto">
                  <div className="px-3 py-1.5 bg-slate-100 border-b border-slate-200 flex items-baseline gap-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Suite Name</span>
                    <span className="text-sm font-semibold text-slate-900">{groupName}</span>
                    <span className="text-[11px] text-slate-500">
                      · {groupItems.length} test case{groupItems.length === 1 ? '' : 's'}, run in this order
                    </span>
                  </div>
                  <table className="min-w-full text-xs">
                    <thead className="bg-slate-50 text-slate-600">
                      <tr>
                        <th className="px-2 py-1.5 text-left w-8">#</th>
                        <th className="px-2 py-1.5 text-left">Display name in Simnovator</th>
                        <th className="px-2 py-1.5 text-left">Setup Kind</th>
                        <th className="px-2 py-1.5 text-left">Simnovator testcase</th>
                        {kind === 'uesim+callbox' && <th className="px-2 py-1.5 text-left">gnb.cfg</th>}
                        {kind === 'uesim+callbox' && <th className="px-2 py-1.5 text-left">mme.cfg</th>}
                        {kind === 'uesim+callbox' && <th className="px-2 py-1.5 text-left">ims.cfg</th>}
                        <th className="px-2 py-1.5 text-right">Power-on duration (s)</th>
                        <th className="px-2 py-1.5"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {groupItems.map((it, n) => {
                        const tc = uesimTestcases.find(t => t.id === it.simnovatorTcId);
                        // Edits address the row by identity, not by its position
                        // inside the group — the groups are a view over one list.
                        const updateItem = (patch: Partial<SuiteItem>) =>
                          setItems(items.map(x => x.id === it.id ? { ...x, ...patch } : x));
                        return (
                          <tr key={it.id} className="hover:bg-slate-50">
                            <td className="px-2 py-1 text-slate-400">{n + 1}</td>
                            <td className="px-2 py-1">
                              <input value={it.name} onChange={e => updateItem({ name: e.target.value })}
                                className="border border-slate-300 rounded px-2 py-1 text-xs w-full" />
                            </td>
                            <td className="px-2 py-1 text-[11px] text-slate-600 whitespace-nowrap">
                              {kind === 'uesim+callbox' ? 'UESIM + CALLBOX' : 'UESIM only'}
                            </td>
                            <td className="px-2 py-1 font-mono text-[11px] text-slate-600 truncate max-w-[260px]" title={it.simnovatorTcId}>
                              {tc?.name ?? it.simnovatorTcId}
                            </td>
                            {kind === 'uesim+callbox' && (<>
                              <td className="px-2 py-1 font-mono text-[11px] text-slate-600">
                                {it.callboxCfg ?? <span className="text-slate-400 italic">(none)</span>}
                                {it.callboxCfg && uploadedConfigs[it.callboxCfg] && <span className="text-[9px] text-emerald-700 ml-1">[upload]</span>}
                              </td>
                              <td className="px-2 py-1 font-mono text-[11px] text-slate-600">
                                {it.mmeCfg ?? <span className="text-slate-400 italic">(none)</span>}
                              </td>
                              <td className="px-2 py-1 font-mono text-[11px] text-slate-600">
                                {it.imsCfg ?? <span className="text-slate-400 italic">(none)</span>}
                              </td>
                            </>)}
                            <td className="px-2 py-1 text-right">
                              <input type="number" min={MIN_POWER_ON} placeholder={String(defaultDur)} value={it.durationSec ?? ''}
                                onChange={e => updateItem({ durationSec: e.target.value === '' ? undefined : Math.max(MIN_POWER_ON, Number(e.target.value) || MIN_POWER_ON) })}
                                className="border border-slate-300 rounded px-1 py-0.5 w-[64px] text-xs text-right" />
                            </td>
                            <td className="px-2 py-1 text-right">
                              <button type="button" onClick={() => setItems(items.filter(x => x.id !== it.id))} className="text-xs text-red-600 hover:underline">remove</button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ))}

              {/* Add-row picker */}
              <div className="mb-4 border border-slate-200 rounded-md p-3 bg-slate-50/50">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-2">Add a TestCase</div>
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
                  <label className="flex flex-col text-xs">
                    <span className="text-slate-500 mb-1">Display name in Simnovator</span>
                    <input
                      value={addDisplayName}
                      onChange={e => setAddDisplayName(e.target.value)}
                      placeholder={uesimTestcases.find(t => t.id === addTcId)?.name ?? 'same as testcase'}
                      className="border border-slate-300 rounded-md px-2 py-1 text-xs"
                    />
                    {/* The box only accepts letters, numbers, _ and - in a
                        testcase name, and names must be unique. The runner folds
                        anything else to "_" and appends _2/_3 on re-runs, so show
                        what will actually be created rather than letting the box
                        reject it after the row has already been added. */}
                    {addDisplayName.trim() && !/^[A-Za-z0-9_-]+$/.test(addDisplayName.trim()) && (
                      <span className="text-[10px] text-amber-700 mt-1">
                        will be created as “{addDisplayName.trim().replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '')}”
                        — only letters, numbers, _ and - are allowed
                      </span>
                    )}
                    {/* Names are unique on the box, so a name that already exists
                        can't be created — say so here rather than letting the row
                        be added and fail at run time. */}
                    {addNameTaken && (
                      <span className="text-[10px] text-red-700 mt-1">
                        “{addNameTaken}” is already used by another row — display names must be unique
                      </span>
                    )}
                    {addNameReuses && (
                      <span className="text-[10px] text-slate-500 mt-1">
                        “{addNameReuses}” already exists on the Simnovator — the run will execute that
                        testcase instead of creating a new one
                      </span>
                    )}
                  </label>
                  {kind === 'uesim+callbox' && (<>
                    <label className="flex flex-col text-xs">
                      <span className="text-slate-500 mb-1 flex items-center justify-between">
                        gnb.cfg
                        <label className="cursor-pointer text-[10px] text-blue-700 hover:underline">
                          upload…
                          <input type="file" onChange={e => onPickUpload(e, 'gnb')} className="hidden" />
                        </label>
                      </span>
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
                    {/* mme + ims live in /root/mme/config — a test needs the core
                        brought up as well as the radio. */}
                    <label className="flex flex-col text-xs">
                      <span className="text-slate-500 mb-1 flex items-center justify-between">
                        mme.cfg
                        <label className="cursor-pointer text-[10px] text-blue-700 hover:underline">
                          upload…
                          <input type="file" onChange={e => onPickUpload(e, 'mme')} className="hidden" />
                        </label>
                      </span>
                      <select value={addMme} onChange={e => setAddMme(e.target.value)} className="border border-slate-300 rounded-md px-2 py-1 text-xs">
                        <option value="">— pick —</option>
                        {Object.keys(uploadedConfigs).map(fn => (
                          <option key={fn} value={fn}>{fn} (uploaded)</option>
                        ))}
                        {mmeFiles.map(f => (
                          <option key={f.name} value={f.name}>{f.name} · {f.mtime}</option>
                        ))}
                      </select>
                    </label>
                    <label className="flex flex-col text-xs">
                      <span className="text-slate-500 mb-1 flex items-center justify-between">
                        ims.cfg
                        <label className="cursor-pointer text-[10px] text-blue-700 hover:underline">
                          upload…
                          <input type="file" onChange={e => onPickUpload(e, 'ims')} className="hidden" />
                        </label>
                      </span>
                      <select value={addIms} onChange={e => setAddIms(e.target.value)} className="border border-slate-300 rounded-md px-2 py-1 text-xs">
                        <option value="">— pick —</option>
                        {Object.keys(uploadedConfigs).map(fn => (
                          <option key={fn} value={fn}>{fn} (uploaded)</option>
                        ))}
                        {mmeFiles.map(f => (
                          <option key={f.name} value={f.name}>{f.name} · {f.mtime}</option>
                        ))}
                      </select>
                    </label>
                  </>)}
                  <div className="col-span-3 flex gap-2 justify-end">
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
                        name: addDisplayName.trim() || tc?.name || addTcId,
                        // Bind the row to the suite name as it stands now. Change
                        // the name afterwards and the next rows form a new suite.
                        suiteName: name.trim() || '(unnamed)',
                        simnovatorTcId: addTcId,
                        callboxCfg: cfgName,
                        mmeCfg: kind === 'uesim+callbox' ? (addMme || undefined) : undefined,
                        imsCfg: kind === 'uesim+callbox' ? (addIms || undefined) : undefined,
                      };
                      setItems([...items, newItem]);
                      setAddTcId(''); setAddCfg(''); setAddMme(''); setAddIms(''); setAddDisplayName('');
                    }}
                    // All three cfgs are required: a run needs the radio AND the
                    // core, so a row bound to only some of them can't execute.
                    // A name already on the box can't be created either.
                    disabled={!addTcId || !!addNameTaken || (kind === 'uesim+callbox' && (!addCfg || !addMme || !addIms))}
                    className="rounded-md bg-orange-500 hover:bg-orange-600 disabled:bg-slate-300 text-white text-sm px-3 py-1.5">
                      Add
                    </button>
                  </div>
                </div>
                {kind === 'uesim+callbox' && cbxLoadError && (
                  <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-md px-2 py-1 mt-2">
                    SSH error listing /root/enb/config: <code>{cbxLoadError}</code> — Upload below works either way.
                  </div>
                )}
              </div>
            </>)}

            <label className="flex items-center gap-2 text-sm mb-2" title="After the UEs have had time to come up, the runner checks the UE simulator's log for registrations. If none attached, the testcase is stopped instead of being left to run out its duration, and the remaining rows are skipped.">
              <input type="checkbox" checked={stopOnFail} onChange={e => setStopOnFail(e.target.checked)} />
              <span>Stop if UE does not Attach (recommended)</span>
            </label>
            <label className="flex items-center gap-2 text-sm mb-4" title="Once the execution has completed, put the callbox symlinks back to whatever they pointed at before the run.">
              <input type="checkbox" checked={removeCfgAfterRun} onChange={e => setRemoveCfgAfterRun(e.target.checked)} />
              <span>Remove deployed cfg from callbox after each item</span>
            </label>

            <div className="flex justify-between mt-4">
              <button onClick={() => setTab('setup')} className="rounded-md border border-slate-300 text-sm px-4 py-2">← Back: Setup</button>
            </div>
            </>)}

            {/* Save / Cancel — only on the Testcases step. Setup has its own
                "Next: Testcases" and there's nothing worth saving until at
                least the systems and a row are chosen. */}
            {tab === 'testcases' && (
              <div className="flex gap-2 justify-end mt-5 pt-4 border-t border-slate-100">
                <button onClick={resetWizard} className="rounded-md border border-slate-300 text-sm px-4 py-2">Cancel</button>
                <button onClick={saveSuite} disabled={!!busy} className="rounded-md bg-orange-500 hover:bg-orange-600 disabled:bg-slate-300 text-white text-sm font-medium px-4 py-2">
                  {busy ? 'Saving…' : (editingId ? 'Update suite' : 'Save suite')}
                </button>
              </div>
            )}
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

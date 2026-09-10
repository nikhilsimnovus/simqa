// Watch every Simnovator for executions started from its own GUI, and capture
// the config fidelity of each one.
//
// This is the PASSIVE counterpart to src/lib/configFidelity/runner.ts. That one
// creates a testcase, runs it and reads the cfg back — it owns the execution.
// This one owns nothing: somebody else pressed Run, and our job is to notice in
// time to collect the evidence.
//
// READ-ONLY ON THE LAB, without exception. The active flow deletes the remote
// ue.cfg before each run so it cannot read a stale one (ueCfg.ts removeRemote)
// and always stops the execution afterwards. Neither is available to us: the
// execution belongs to the user, and deleting their cfg or stopping their run
// would be this feature breaking the thing it exists to observe. We solve the
// staleness problem by ATTRIBUTION instead — see waitForOurUeCfg.
//
// Structure copied from stationMonitor.ts and src/lib/backup/scheduler.ts:
// globalThis singleton so HMR cannot start a second poller, in-flight guard so
// ticks never overlap, lazy start because middleware forces an Edge bundle that
// cannot resolve node builtins from instrumentation.ts.

import {
  loadInventory, getSystem, uesimApiCredentials,
  type Inventory, type InventorySystem,
} from '../inventory';
import { ensureToken, exportTestcaseConfig, listSimulators, resolveTestcaseIdByName } from '../uesimClient';
import { readRemoteFile } from '../configFidelity/ssh';
import { UE_CFG_PATH_DEFAULT } from '../configFidelity/ueCfg';
import { compareCapture } from './compare';
import { writeCapture, toCaptureId, readIndex, type CaptureSummary, type FidelityVerdict } from './store';

/** Seconds between polls. Executions run for minutes and the cfg lands about
 *  30s in, so 20s catches one comfortably while staying cheap. */
const POLL_SEC = Math.max(5, Number(process.env.SIMQA_FIDELITY_POLL_SEC) || 20);

/**
 * How long to keep looking for a ue.cfg that belongs to THIS execution.
 *
 * Usually satisfied on the first read: the cfg is written BEFORE the API reports
 * the execution as started — measured 23s earlier on .121 and 15s earlier on
 * .101 — so by the time we notice, the file is already there. The window exists
 * for the case where we caught the run unusually early, and matches the 90s the
 * active flow already uses in this lab.
 */
const CFG_WAIT_MS = Math.max(30_000, Number(process.env.SIMQA_FIDELITY_CFG_WAIT_MS) || 90_000);

const CFG_POLL_MS = 2_500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface WatcherState {
  timer: ReturnType<typeof setInterval> | null;
  inFlight: Promise<void> | null;
  /** Execution keys already captured or being captured, per Simnovator host.
   *  Kept in memory only as a fast path — the on-disk index is the real
   *  dedupe, so a restart cannot produce a duplicate capture. */
  seen: Record<string, Set<string>>;
  /** Captures currently in progress, so a slow one cannot be started twice. */
  active: Set<string>;
  lastTick: { at: number; ms: number; watched: number; started: number; error?: string } | null;
}

const GLOBAL_KEY = '__simqaFidelityWatcher__';

function state(): WatcherState {
  const g = globalThis as any;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = { timer: null, inFlight: null, seen: {}, active: new Set(), lastTick: null } as WatcherState;
  }
  return g[GLOBAL_KEY] as WatcherState;
}

// ── what the box tells us about a running execution ──────────────────────────

export interface RunningExecution {
  /** iteration / execution id, when the box supplies one. */
  executionId?: string;
  testcaseId?: string;
  testcaseName?: string;
  simulatorName?: string;
  status?: string;
  startedAt?: string;
}

const str = (v: unknown) => (v === undefined || v === null ? undefined : String(v));

/**
 * Ask a Simnovator what it is running right now.
 *
 * POST /v2/testcases/search with an execution_status filter. One 623-byte call
 * answers everything a capture needs: the row's top-level `id` is the UUID that
 * /v2/testcases/export accepts, and metadata.lastExecution carries the execution
 * id, the simulator and the real start time.
 *
 * TWO TRAPS, both verified live:
 *
 *  - The filter is { field, operator, value }. Passing { execution_status: … }
 *    or { testCaseName: … } is not rejected — the box ignores the unknown shape
 *    and returns ALL 894 testcases, with the one you wanted often sorted first.
 *    That reads exactly like a working filter until the day it does not.
 *
 *  - The VALUE must be Title Case "In Progress". "IN_PROGRESS" returns 400,
 *    even though the status field in the response comes back as IN_PROGRESS.
 *    The box has two status vocabularies and this endpoint wants the display one.
 */
export async function pollRunning(host: string, username: string, password: string): Promise<RunningExecution[]> {
  const token = await ensureToken(host, username, password);
  const res = await fetch(`http://${host}/v2/testcases/search`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pageNumber: 1,
      pageSize: 50,
      filter: { field: 'execution_status', operator: '=', value: 'In Progress' },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.ok) {
    const j: any = await res.json();
    const items: any[] = j?.items ?? j?.testcases ?? j?.data ?? [];
    const rows = items.map((t) => {
      const le = t?.metadata?.lastExecution ?? {};
      return {
        executionId: str(le.executionId ?? le.iterationId),
        testcaseId: str(t?.id),
        testcaseName: str(t?.name),
        // lastExecution.simulatorName is the real name; the one inside
        // executionHistory[] is mislabelled and holds the simulator ID.
        simulatorName: str(le.simulatorName),
        status: str(le.status ?? t?.status),
        startedAt: str(le.executedOn ?? t?.metadata?.lastExecutedOn),
      } as RunningExecution;
    }).filter((e) => e.testcaseId || e.testcaseName);
    if (rows.length || j?.total === 0 || Array.isArray(items)) return rows;
  }

  // Fallback for a build whose search does not support the filter. It reports
  // test_case_name and NO id of any kind, so captureExecution has to resolve
  // the name — which is why this is the fallback and not the primary.
  return pollRunningLegacy(host, token);
}

async function pollRunningLegacy(host: string, token: string): Promise<RunningExecution[]> {
  const res = await fetch(`http://${host}/secureAPI/v1.0/executor/latest_testcase_details?page_number=1`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`latest_testcase_details: ${res.status}`);
  const j: any = await res.json();
  const rows: any[] = Array.isArray(j?.testcase) ? j.testcase
    : Array.isArray(j?.data) ? j.data
    : Array.isArray(j?.items) ? j.items
    : [];

  // Field names verified against a live in-progress payload on .95:
  //   {"testcase":[{"test_case_name":"…","simulator_name":"UE-Simulator",
  //     "execution_status":"In Progress","execution_start_time":"2026-…Z", …}]}
  return rows.map((r) => ({
    executionId: str(r?.iteration_id ?? r?.iterationId ?? r?.execution_id),
    testcaseId: str(r?.test_id ?? r?.testId ?? r?.testcase_id),
    testcaseName: str(r?.test_case_name ?? r?.test_name ?? r?.testCaseName ?? r?.name),
    simulatorName: str(r?.simulator_name ?? r?.simulatorName),
    status: str(r?.execution_status ?? r?.status ?? r?.testCaseStatus),
    startedAt: str(r?.execution_start_time ?? r?.start_time ?? r?.startTime),
  })).filter((e) => e.testcaseName || e.testcaseId);
}

/** A status the box uses for "this is running now". */
function isRunning(status: string | undefined): boolean {
  const s = (status ?? '').toUpperCase().replace(/[\s-]/g, '_');
  if (!s) return true;   // the in-progress endpoint returned it at all
  return s === 'IN_PROGRESS' || s === 'INPROGRESS' || s === 'RUNNING' || s === 'STARTED' || s === 'EXECUTING';
}

/** Stable key for one execution, so a long run is captured once. */
function execKey(e: RunningExecution): string {
  return e.executionId ?? `${e.testcaseName ?? e.testcaseId ?? 'unknown'}@${e.startedAt ?? ''}`;
}

// ── attribution: is this ue.cfg the one this execution generated? ────────────

/** The testcase name a ue.cfg encodes in its log_filename (/tmp/<name>.log).
 *  This is the ONLY place the testcase's identity reaches the cfg, which makes
 *  it both the attribution key and the staleness check. */
export function ueCfgLogName(raw: string): string | undefined {
  const m = raw.match(/"log_filename"\s*:\s*"([^"]+)"/);
  return m ? m[1].split('/').pop()?.replace(/\.log$/, '') : undefined;
}

/**
 * Poll the UE-sim until its ue.cfg is the one THIS execution wrote.
 *
 * We cannot pre-delete the file the way the active flow does, so a cfg being
 * present proves nothing on its own — it may be the previous run's. The
 * log_filename gate is what makes the capture trustworthy: we accept the file
 * only once it names this testcase. If it never does, the caller records
 * 'unattributed' rather than diffing against someone else's config, because a
 * confident wrong table is worse than an honest gap.
 */
async function waitForOurUeCfg(
  ueSim: InventorySystem, expectedName: string | undefined, deadline: number,
): Promise<{ raw?: string; attributed: boolean; sawName?: string }> {
  let lastRaw: string | undefined;
  let lastName: string | undefined;
  while (Date.now() < deadline) {
    const raw = await readRemoteFile(ueSim, UE_CFG_PATH_DEFAULT).catch(() => undefined);
    if (raw && raw.trim()) {
      lastRaw = raw;
      lastName = ueCfgLogName(raw);
      if (!expectedName || lastName === expectedName) return { raw, attributed: true, sawName: lastName };
    }
    await sleep(CFG_POLL_MS);
  }
  return { raw: lastRaw, attributed: false, sawName: lastName };
}

// ── one capture ──────────────────────────────────────────────────────────────

/** Resolve the UE-sim for a Simnovator: the topology profile is authoritative
 *  (that is what the requirement says), with the simulator's self-reported
 *  node address used only to explain a mismatch. */
export function resolveUeSim(inv: Inventory, sim: InventorySystem): { ue?: InventorySystem; via: string } {
  const profile = inv.profiles.find((p) => p.simnovator === sim.id);
  const ue = profile?.uesim ? getSystem(inv, profile.uesim) : undefined;
  if (ue) return { ue, via: `topology "${profile?.name ?? profile?.id}"` };
  return { ue: undefined, via: profile ? `topology "${profile.name}" has no UE system` : 'no topology profile' };
}

export async function captureExecution(
  inv: Inventory, sim: InventorySystem, exec: RunningExecution,
): Promise<CaptureSummary | undefined> {
  const startedAt = exec.startedAt || new Date().toISOString();
  const captureId = toCaptureId(execKey(exec), startedAt);
  const { ue, via } = resolveUeSim(inv, sim);

  const base: CaptureSummary = {
    captureId,
    simnovatorIp: sim.host,
    simnovatorName: sim.name,
    ueSimIp: ue?.host,
    ueSimName: ue?.name,
    testcaseId: exec.testcaseId,
    testcaseName: exec.testcaseName,
    executionId: exec.executionId,
    simulatorName: exec.simulatorName,
    startedAt,
    capturedAt: new Date().toISOString(),
    verdict: 'error',
    compared: 0,
    differences: 0,
    hasTestcase: false,
    hasUeCfg: false,
    ueCfgPath: UE_CFG_PATH_DEFAULT,
  };

  if (!ue) {
    return writeCapture({ ...base, verdict: 'error', reason: `no UE-sim for ${sim.name}: ${via}` }, {});
  }

  const opts = {
    host: sim.host,
    ...uesimApiCredentials(sim),
  };

  // Start the cfg wait FIRST. The cfg is written at execution start and we may
  // already be part-way through that window, so exporting the testcase before
  // we start watching would spend the budget we need.
  const deadline = Date.now() + CFG_WAIT_MS;
  const cfgP = waitForOurUeCfg(ue, exec.testcaseName, deadline);

  let testcaseJson: string | undefined;
  let exportError: string | undefined;
  // The in-progress endpoint gives a name and no id, so resolve one. Cached per
  // host, so this costs its nine round-trips at most once per five minutes.
  let tcId = exec.testcaseId;
  if (!tcId && exec.testcaseName) {
    tcId = await resolveTestcaseIdByName(opts, exec.testcaseName)
      .catch((e: any) => { exportError = `could not resolve "${exec.testcaseName}" to a testcase id: ${String(e?.message ?? e).slice(0, 160)}`; return undefined; });
    if (!tcId && !exportError) exportError = `no testcase named "${exec.testcaseName}" is in this box's list, so it could not be exported`;
  }
  if (tcId) {
    testcaseJson = await exportTestcaseConfig(opts, tcId, exec.testcaseName ?? tcId)
      .catch((e: any) => { exportError = String(e?.message ?? e).slice(0, 300); return undefined; });
  } else if (!exportError) {
    exportError = 'the box reported neither a testcase id nor a name for this execution';
  }

  const cfg = await cfgP;
  const capturedAt = new Date().toISOString();

  let verdict: FidelityVerdict = 'error';
  let reason: string | undefined;
  let comparison: any;
  let compared = 0, differences = 0;

  if (!testcaseJson && !cfg.raw) {
    reason = `neither artefact could be captured${exportError ? ` — ${exportError}` : ''}`;
  } else if (!testcaseJson) {
    verdict = 'unattributed';
    reason = `ue.cfg captured but the testcase export failed${exportError ? ` — ${exportError}` : ''}`;
  } else if (!cfg.raw) {
    verdict = 'unattributed';
    reason = `testcase exported but no ue.cfg appeared on ${ue.host} within ${Math.round(CFG_WAIT_MS / 1000)}s`;
  } else if (!cfg.attributed) {
    // The decisive case: a cfg exists but names a different testcase.
    verdict = 'unattributed';
    reason = `the ue.cfg on ${ue.host} names "${cfg.sawName ?? 'an unknown testcase'}", not "${exec.testcaseName}" —`
      + ' it belongs to a different execution, so no comparison is shown';
  } else {
    try {
      const parsedCfg = JSON.parse(cfg.raw);
      const parsedTc = JSON.parse(testcaseJson);
      const result = compareCapture(parsedCfg, parsedTc);
      comparison = result;
      compared = result.compared;
      differences = result.differences;
      verdict = result.ok ? 'passed' : 'failed';
    } catch (e: any) {
      verdict = 'error';
      reason = `could not parse a captured file: ${String(e?.message ?? e).slice(0, 200)}`;
    }
  }

  return writeCapture(
    {
      ...base, capturedAt, verdict, reason, compared, differences,
      hasTestcase: !!testcaseJson, hasUeCfg: !!cfg.raw,
    },
    { testcaseJson, ueCfg: cfg.raw, comparison },
  );
}

// ── the poll ─────────────────────────────────────────────────────────────────

/**
 * The Simnovators to poll, deduped by host.
 *
 * SIMNOVATOR and SIMNOVATOR_GUI only — deliberately NOT isUesimLike(), which is
 * also true for a UESIM box. A UE-sim has no GUI and starts nothing; polling it
 * for in-progress testcases only produced three permanently-empty rows in the
 * watch list. It is the far end of this feature, not a source of executions.
 */
export function watchTargets(inv: Inventory): InventorySystem[] {
  return inv.systems
    .filter((s) => s.type === 'SIMNOVATOR' || s.type === 'SIMNOVATOR_GUI')
    .filter((s, i, all) => all.findIndex((o) => o.host === s.host) === i);
}

async function pollOne(inv: Inventory, sim: InventorySystem): Promise<number> {
  const s = state();
  const opts = {
    host: sim.host,
    ...uesimApiCredentials(sim),
  };

  let running = await pollRunning(sim.host, opts.username, opts.password).catch(() => [] as RunningExecution[]);
  running = running.filter((e) => isRunning(e.status));

  if (!running.length) {
    // Fall back to the simulator's own availability. It cannot name the
    // testcase, so it produces no capture on its own — but it tells the status
    // strip that something IS running, which is the difference between "quiet
    // lab" and "we are missing executions".
    const busy = await listSimulators(opts)
      .then((r) => (r.items ?? []).some((x: any) => String(x?.availability ?? '').toUpperCase() === 'BUSY'))
      .catch(() => false);
    if (busy) s.lastTick = { ...(s.lastTick ?? { at: Date.now(), ms: 0, watched: 0, started: 0 }), error: `${sim.host} is BUSY but reported no in-progress testcase` };
    return 0;
  }

  const seen = (s.seen[sim.host] ??= new Set<string>());
  // The on-disk index is the authority across restarts.
  for (const c of readIndex(sim.host).captures) seen.add(c.captureId);

  let started = 0;
  for (const exec of running) {
    const key = toCaptureId(execKey(exec), exec.startedAt || new Date().toISOString());
    const guard = `${sim.host}::${key}`;
    if (seen.has(key) || s.active.has(guard)) continue;
    s.active.add(guard);
    started += 1;
    // Deliberately not awaited: a capture waits up to 90s for the cfg, and the
    // poll must keep visiting the other Simnovators meanwhile.
    void captureExecution(inv, sim, exec)
      .then((c) => { if (c) seen.add(c.captureId); })
      .catch((e: any) => console.error('[fidelity] capture failed:', e?.message ?? e))
      .finally(() => { s.active.delete(guard); });
  }
  return started;
}

export async function pollOnce(): Promise<void> {
  const inv = loadInventory();
  const targets = watchTargets(inv);
  const t0 = Date.now();
  let started = 0;
  for (const sim of targets) {
    try { started += await pollOne(inv, sim); }
    catch (e: any) { console.error(`[fidelity] poll ${sim.host}:`, e?.message ?? e); }
  }
  state().lastTick = { at: t0, ms: Date.now() - t0, watched: targets.length, started };
}

export function tick(): Promise<void> {
  const s = state();
  if (s.inFlight) return s.inFlight;
  s.inFlight = pollOnce()
    .catch((e: any) => { console.error('[fidelity] tick failed:', e?.message ?? e); })
    .finally(() => { s.inFlight = null; });
  return s.inFlight;
}

export function startFidelityWatcher(): void {
  const s = state();
  if (s.timer) return;
  s.timer = setInterval(tick, POLL_SEC * 1000);
  (s.timer as any).unref?.();
  const kick = setTimeout(tick, 5_000);
  (kick as any).unref?.();
  console.log(`[fidelity] watching for GUI-started executions every ${POLL_SEC}s`);
}

export function stopFidelityWatcher(): void {
  const s = state();
  if (s.timer) { clearInterval(s.timer); s.timer = null; }
}

export function ensureFidelityWatcher(): void {
  if (process.env.SIMQA_DISABLE_FIDELITY_WATCH === '1') return;
  startFidelityWatcher();
}

export function watcherStatus() {
  const s = state();
  return {
    running: !!s.timer,
    pollSec: POLL_SEC,
    cfgWaitSec: Math.round(CFG_WAIT_MS / 1000),
    capturing: s.active.size,
    lastTick: s.lastTick,
  };
}

// runner.ts — orchestrator for End-to-End validation runs.
//
// Public surface mirrors the UI Tests runner (src/lib/uiTester.ts):
//   • startRun(req)                 — kicks off, returns runId immediately
//   • getRunStatus(runId)           — current snapshot for /api/end-to-end/status
//   • abortRun(runId)               — signal cancellation
//   • listRuns() / loadRun(runId)   — past runs from disk
//
// Live progress is exposed via an in-memory map keyed by runId. The page polls
// /api/end-to-end/status every ~1.5s while a run is in flight and gets back
// the same shape uiTester serves (catalog rows with per-row status + counts).

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Inventory } from '../inventory';
import { loadInventory, uesimApiOptsForSystem } from '../inventory';
import { ALL_CHECKS, type CheckDef } from './checks';
import { tryLaunchBrowser } from './browser';
import type { RunCtx } from './ctx';
import type {
  CheckResult, FinalReport, RunOptions, RunRequest, RunStatusSnapshot,
} from './types';

// ───────────── Active-runs registry ─────────────

interface ActiveRun {
  runId: string;
  systemId: string;
  systemHost: string;
  systemName: string;
  testcaseId: string;
  testcaseName?: string;
  startedAt: string;
  finishedAt?: string;
  ok?: boolean;
  finalDetail?: string;
  options: RunOptions;
  ctx: RunCtx;
  canceled: boolean;
  /** Per-check status map keyed by check.id. Updated live as checks progress
   *  so the status endpoint can render running spinners. */
  liveStatus: Map<string, { status: 'pending' | 'running' | 'pass' | 'fail' | 'skip'; result?: CheckResult }>;
  /** Which check ids are part of THIS run (the catalogue filtered by
   *  options.uiChecks + onlyCheckIds). Used by the status endpoint to know
   *  which checks to emit rows for (skipping the ones we didn't plan to run). */
  plannedIds: string[];
  /** Captured catalog metadata at run-creation time so the status endpoint
   *  can render names/descriptions without re-walking checks.ts. */
  catalog: Pick<CheckDef, 'id' | 'name' | 'phase' | 'severity' | 'description'>[];
}

// Park activeRuns on globalThis so it survives Next.js dev-mode module reloads
// between requests. Without this, POST /run sets an entry in Map-instance-A,
// but the next GET /status reads from a freshly-imported Map-instance-B (the
// HMR layer reloads the module) and finds nothing — so the live-progress
// poll loop on the page always sees `{running: false, counts: 0/0/0/0}`
// until the run finishes and writes report.json to disk. The fix is the
// same pattern Next.js docs recommend for any in-memory state that must
// outlive HMR boundaries.
const __sg = globalThis as unknown as { __simqaEndToEndActive?: Map<string, ActiveRun> };
const activeRuns: Map<string, ActiveRun> = __sg.__simqaEndToEndActive ?? (__sg.__simqaEndToEndActive = new Map<string, ActiveRun>());

// ───────────── Public entry points ─────────────

export async function startRun(req: RunRequest): Promise<{ ok: boolean; runId?: string; error?: string }> {
  const inv = loadInventory();
  const target = uesimApiOptsForSystem(inv, req.systemId);
  if (!target) return { ok: false, error: `system "${req.systemId}" not found or not UESIM-capable` };

  // Resolve testcaseId. Two paths:
  //   • req.testcaseId provided → use it
  //   • req.useLastExecution true → discover from /v2/testcases ordered by
  //     metadata.lastExecution.executedOn
  let testcaseId = req.testcaseId?.trim();
  if (!testcaseId && req.useLastExecution) {
    try {
      testcaseId = await findLastExecutedTestcase(target);
    } catch (e: any) {
      return { ok: false, error: `could not find a previously-executed testcase: ${e?.message ?? e}` };
    }
  }
  if (!testcaseId) return { ok: false, error: 'either testcaseId or useLastExecution must be set' };

  const runId = newRunId();
  const evidenceDir = path.join(process.cwd(), 'data', 'end-to-end', runId);
  fs.mkdirSync(evidenceDir, { recursive: true });

  const options: RunOptions = {
    apiChecks: true,
    uiChecks: false,
    saveEvidence: true,
    pollIntervalMs: 5000,
    completionGraceMs: 5 * 60_000,
    ...(req.options ?? {}),
  };

  // Build the planned check list (id -> filter) up front so the status
  // endpoint knows what to render even before checks start firing.
  const planned = filterChecks(ALL_CHECKS, options, req.onlyCheckIds);
  const plannedIds = planned.map((c) => c.id);
  const liveStatus = new Map<string, { status: 'pending' | 'running' | 'pass' | 'fail' | 'skip'; result?: CheckResult }>();
  for (const c of planned) liveStatus.set(c.id, { status: 'pending' });

  const ctx: RunCtx = {
    runId,
    systemId: target.systemId,
    systemHost: target.host,
    systemName: target.name,
    apiUser: target.username,
    apiPass: target.password,
    testcaseId,
    evidenceDir,
    isCanceled: () => activeRuns.get(runId)?.canceled === true,
    emit: () => { /* runner manages liveStatus directly; checks don't need to emit */ },
  };

  const startedAt = new Date().toISOString();
  const ar: ActiveRun = {
    runId,
    systemId: target.systemId,
    systemHost: target.host,
    systemName: target.name,
    testcaseId,
    startedAt,
    options,
    ctx,
    canceled: false,
    liveStatus,
    plannedIds,
    catalog: planned.map((c) => ({ id: c.id, name: c.name, phase: c.phase, severity: c.severity, description: c.description })),
  };
  activeRuns.set(runId, ar);

  // Fire-and-forget — the orchestrator runs in the background. The page polls
  // /status to see progress. We catch top-level errors so a thrown check
  // doesn't kill the dev server.
  void runOrchestrator(ar, planned).catch((e) => {
    console.error(`[end-to-end] ${runId} threw at top level:`, e);
    ar.ok = false;
    ar.finalDetail = `runner threw: ${e?.message ?? e}`;
    ar.finishedAt = new Date().toISOString();
    saveReport(ar);
  });

  return { ok: true, runId };
}

export function getRunStatus(runId?: string): RunStatusSnapshot {
  if (!runId) {
    const first = activeRuns.values().next().value;
    if (!first) return { running: false };
    return snapshotOf(first);
  }
  const r = activeRuns.get(runId);
  if (!r) return { running: false };
  return snapshotOf(r);
}

export function abortRun(runId: string): boolean {
  const r = activeRuns.get(runId);
  if (!r) return false;
  r.canceled = true;
  return true;
}

export function listRuns(): Array<{ runId: string; startedAt: string; finishedAt?: string; ok?: boolean; systemId: string; testcaseId: string; counts?: { total: number; passed: number; failed: number; skipped: number } }> {
  const root = path.join(process.cwd(), 'data', 'end-to-end');
  if (!fs.existsSync(root)) return [];
  const dirs = fs.readdirSync(root).filter((n) => /^run-\d{8}-\d{6}-/.test(n));
  return dirs
    .map((d) => {
      const reportPath = path.join(root, d, 'report.json');
      if (!fs.existsSync(reportPath)) return null;
      try {
        const r = JSON.parse(fs.readFileSync(reportPath, 'utf-8')) as FinalReport;
        return {
          runId: r.runId,
          startedAt: r.startedAt,
          finishedAt: r.finishedAt,
          ok: r.ok,
          systemId: r.systemId,
          testcaseId: r.testcaseId,
          counts: r.counts,
        };
      } catch { return null; }
    })
    .filter((x): x is NonNullable<typeof x> => !!x)
    .sort((a, b) => (b.startedAt > a.startedAt ? 1 : -1));
}

export function loadRun(runId: string): FinalReport | undefined {
  const p = path.join(process.cwd(), 'data', 'end-to-end', runId, 'report.json');
  if (!fs.existsSync(p)) return undefined;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')) as FinalReport; } catch { return undefined; }
}

// ───────────── Orchestrator (internal) ─────────────

async function runOrchestrator(ar: ActiveRun, planned: CheckDef[]): Promise<void> {
  const results: CheckResult[] = [];

  // Browser launch is lazy: only fire it up if UI checks are planned. If the
  // launch fails (no Chrome / no Edge / no bundled browser), UI checks will
  // see ctx.browser=undefined and skip themselves with a clear reason —
  // the run still proceeds with API-only checks.
  const needsBrowser = planned.some((c) => c.requiresBrowser);
  if (needsBrowser) {
    const launch = await tryLaunchBrowser();
    if ('browser' in launch) {
      ar.ctx.browser = launch.browser;
    } else {
      // Stick the error onto every UI check's pending status as a skip
      // reason — the loop below would do the same but doing it here makes
      // the live status show the reason immediately.
      for (const c of planned) {
        if (c.requiresBrowser) {
          ar.liveStatus.set(c.id, {
            status: 'skip',
            result: {
              id: c.id, name: c.name, phase: c.phase, severity: c.severity, description: c.description,
              status: 'skip',
              skippedReason: launch.error,
              ranAt: new Date().toISOString(),
            },
          });
        }
      }
    }
  }

  // Fail-fast gate: when ANY critical preflight check fails (e.g., simulator
  // busy, system unreachable, testcase not found), there's no point firing
  // the trigger — it'll just 409 / 404 / time out, eating ~40s of wall clock
  // per cascade. We tag the cascade reason and skip everything downstream
  // of preflight cleanly. This applies only when transitioning OUT of the
  // preflight phase (so all preflight checks still run for full diagnostics).
  let preflightCriticalFailed = false;
  let cascadeReason: string | undefined;

  for (const c of planned) {
    if (ar.canceled) {
      ar.liveStatus.set(c.id, { status: 'skip' });
      results.push({
        id: c.id, name: c.name, phase: c.phase, severity: c.severity, description: c.description,
        status: 'skip', skippedReason: 'run aborted', ranAt: new Date().toISOString(),
      });
      continue;
    }
    // Pre-skipped (e.g. browser launch failed earlier).
    const pre = ar.liveStatus.get(c.id);
    if (pre?.status === 'skip' && pre.result) {
      results.push(pre.result);
      continue;
    }
    // Cascade-skip everything past preflight when a critical preflight failed.
    if (preflightCriticalFailed && c.phase !== 'preflight') {
      const skipResult: CheckResult = {
        id: c.id, name: c.name, phase: c.phase, severity: c.severity, description: c.description,
        status: 'skip',
        skippedReason: `preflight critical check failed — ${cascadeReason ?? 'system not ready for this run'}`,
        ranAt: new Date().toISOString(),
      };
      ar.liveStatus.set(c.id, { status: 'skip', result: skipResult });
      results.push(skipResult);
      continue;
    }

    ar.liveStatus.set(c.id, { status: 'running' });
    try {
      const r = await c.run(ar.ctx);
      ar.liveStatus.set(c.id, { status: r.status, result: r });
      results.push(r);
      // Latch the cascade flag the moment a critical preflight check fails.
      if (c.phase === 'preflight' && c.severity === 'critical' && r.status === 'fail') {
        preflightCriticalFailed = true;
        if (!cascadeReason) cascadeReason = r.detail ?? `${c.id} failed`;
      }
    } catch (e: any) {
      const fail: CheckResult = {
        id: c.id, name: c.name, phase: c.phase, severity: c.severity, description: c.description,
        status: 'fail',
        detail: `check threw: ${e?.message ?? e}`,
        ranAt: new Date().toISOString(),
      };
      ar.liveStatus.set(c.id, { status: 'fail', result: fail });
      results.push(fail);
      if (c.phase === 'preflight' && c.severity === 'critical') {
        preflightCriticalFailed = true;
        if (!cascadeReason) cascadeReason = fail.detail;
      }
    }
  }

  // Close the browser if we launched one.
  if (ar.ctx.browser) {
    try { await ar.ctx.browser.close(); } catch { /* swallow */ }
    ar.ctx.browser = undefined;
  }

  // Verdict:
  //   • aborted             → ok=false ("aborted")
  //   • any critical FAIL   → ok=false ("N critical check(s) failed")
  //   • any critical SKIPPED (prerequisite missing, browser unavailable, etc.)
  //                          → ok=false ("N critical check(s) skipped — incomplete validation")
  //   • non-critical fails  → ok=true  but flagged ("N non-critical fail(s)")
  //   • zero passes at all  → ok=false ("nothing ran" — covers the onlyCheckIds=[] edge)
  //   • otherwise           → ok=true ("M of N checks passed")
  const passed         = results.filter((r) => r.status === 'pass').length;
  const failed         = results.filter((r) => r.status === 'fail').length;
  const skipped        = results.filter((r) => r.status === 'skip').length;
  const criticalFailed = results.some((r) => r.status === 'fail' && r.severity === 'critical');
  const criticalSkipped = results.filter((r) => r.status === 'skip' && r.severity === 'critical');

  ar.finishedAt = new Date().toISOString();
  if (ar.canceled) {
    ar.ok = false;
    ar.finalDetail = 'aborted';
  } else if (criticalFailed) {
    const n = results.filter((r) => r.status === 'fail' && r.severity === 'critical').length;
    ar.ok = false;
    ar.finalDetail = `${n} critical check(s) failed`;
  } else if (criticalSkipped.length > 0 && passed === 0) {
    ar.ok = false;
    ar.finalDetail = `${criticalSkipped.length} critical check(s) skipped — validation incomplete (${criticalSkipped[0].skippedReason ?? 'no detail'})`;
  } else if (passed === 0 && failed === 0 && skipped > 0) {
    // Everything skipped, no failures. Common when onlyCheckIds points at
    // checks whose preflight prerequisites passed but the targeted check
    // wasn't reachable for some reason — treat as inconclusive.
    ar.ok = false;
    ar.finalDetail = `nothing ran successfully — ${skipped} skipped`;
  } else if (failed > 0) {
    ar.ok = true;  // non-critical fails don't fail the overall verdict
    ar.finalDetail = `${passed} passed · ${failed} non-critical fail(s) · ${skipped} skipped`;
  } else {
    ar.ok = true;
    ar.finalDetail = skipped > 0
      ? `${passed} passed, ${skipped} skipped`
      : `all ${passed} check(s) passed`;
  }

  // Persist the report. The active-runs map gets cleared on the next
  // status call after a 30s grace period so the page has a chance to see
  // the finished state before it disappears.
  ar.ctx.testcaseName = ar.testcaseName = ar.ctx.testcaseName ?? ar.testcaseId;
  saveReport(ar, results);

  // Garbage-collect this run after a delay so listRuns/loadRun can take over.
  setTimeout(() => { activeRuns.delete(ar.runId); }, 60_000);
}

function saveReport(ar: ActiveRun, results?: CheckResult[]): void {
  const all = results ?? Array.from(ar.liveStatus.values())
    .map((s) => s.result)
    .filter((r): r is CheckResult => !!r);
  const observedSec = (ar.ctx.triggeredAt && ar.ctx.finishedAt) ? (ar.ctx.finishedAt - ar.ctx.triggeredAt) / 1000 : undefined;
  const passed  = all.filter((r) => r.status === 'pass').length;
  const failed  = all.filter((r) => r.status === 'fail').length;
  const skipped = all.filter((r) => r.status === 'skip').length;
  const report: FinalReport = {
    runId: ar.runId,
    systemId: ar.systemId,
    systemHost: ar.systemHost,
    systemName: ar.systemName,
    testcaseId: ar.testcaseId,
    testcaseName: ar.testcaseName ?? ar.ctx.testcaseName,
    executionId: ar.ctx.executionId,
    startedAt: ar.startedAt,
    finishedAt: ar.finishedAt ?? new Date().toISOString(),
    ok: ar.ok ?? false,
    finalDetail: ar.finalDetail,
    configuredDurationSec: ar.ctx.configuredDurationSec,
    observedDurationSec: observedSec,
    options: ar.options,
    counts: { total: all.length, passed, failed, skipped },
    results: all,
  };
  try {
    fs.writeFileSync(path.join(ar.ctx.evidenceDir, 'report.json'), JSON.stringify(report, null, 2));
  } catch (e: any) {
    console.error('[end-to-end] could not save report:', e?.message ?? e);
  }
}

function snapshotOf(r: ActiveRun): RunStatusSnapshot {
  const checks = r.catalog.map((meta) => {
    const live = r.liveStatus.get(meta.id);
    if (!live || live.status === 'pending' || live.status === 'running') {
      return { id: meta.id, name: meta.name, phase: meta.phase, severity: meta.severity, description: meta.description, status: live?.status ?? 'pending' };
    }
    if (live.result) return live.result;
    // status is pass/fail/skip but no result object — synthesise
    return {
      id: meta.id, name: meta.name, phase: meta.phase, severity: meta.severity, description: meta.description,
      status: live.status, ranAt: new Date().toISOString(),
    };
  });
  const passed  = checks.filter((c) => c.status === 'pass').length;
  const failed  = checks.filter((c) => c.status === 'fail').length;
  const skipped = checks.filter((c) => c.status === 'skip').length;
  const pending = checks.filter((c) => c.status === 'pending' || c.status === 'running').length;
  const phase = checks.find((c) => c.status === 'running')?.phase
            ?? checks.find((c) => c.status === 'pending')?.phase
            ?? 'post';
  return {
    running: !r.finishedAt,
    runId: r.runId,
    systemId: r.systemId,
    systemHost: r.systemHost,
    testcaseId: r.testcaseId,
    executionId: r.ctx.executionId,
    startedAt: r.startedAt,
    phase,
    checks,
    counts: { total: checks.length, passed, failed, skipped, pending },
    ok: r.ok,
    finishedAt: r.finishedAt,
    finalDetail: r.finalDetail,
  };
}

// ───────────── Internals ─────────────

function newRunId(): string {
  const now = new Date();
  const stamp = [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0'),
  ].join('') + '-' + [
    String(now.getUTCHours()).padStart(2, '0'),
    String(now.getUTCMinutes()).padStart(2, '0'),
    String(now.getUTCSeconds()).padStart(2, '0'),
  ].join('');
  const rand = Math.random().toString(36).slice(2, 8);
  return `run-${stamp}-${rand}`;
}

/** Checks that EVERY other check depends on. They populate ctx.token and
 *  ctx.testcaseMetadata which the rest of the catalogue reads. When the
 *  user picks onlyCheckIds for a re-run, we still need to run these or
 *  every subsequent check fails with "no token". */
const FOUNDATIONAL_PREFLIGHT_IDS = new Set([
  'preflight-login',
  'preflight-testcase-exists',
]);

function filterChecks(catalogue: CheckDef[], options: RunOptions, onlyIds?: string[]): CheckDef[] {
  let list = catalogue.slice();
  if (!options.apiChecks) list = list.filter((c) => c.requiresBrowser);
  if (!options.uiChecks)  list = list.filter((c) => !c.requiresBrowser);
  if (onlyIds && onlyIds.length > 0) {
    // Foundational preflight always runs (login + testcase-fetch), so a
    // re-run-failures from the page doesn't end up with every check
    // skipping for missing token / metadata. We also keep these visible
    // in the UI so the user sees they ran.
    const want = new Set([...onlyIds, ...FOUNDATIONAL_PREFLIGHT_IDS]);
    list = list.filter((c) => want.has(c.id));
  }
  return list;
}

async function findLastExecutedTestcase(target: ReturnType<typeof uesimApiOptsForSystem>): Promise<string> {
  if (!target) throw new Error('no target');
  // Login first.
  const lr = await fetch(`http://${target.host}/v2/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: target.username, password: target.password }),
  });
  if (!lr.ok) throw new Error(`login: ${lr.status}`);
  const lj = await lr.json();
  const token = lj.access_token ?? lj.token;
  // Search ordered by most-recently-executed. The API supports POST /v2/testcases/search.
  const sr = await fetch(`http://${target.host}/v2/testcases/search`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ offset: 0, limit: 50 }),
  });
  if (!sr.ok) throw new Error(`search: ${sr.status}`);
  const sj = await sr.json();
  const items: any[] = sj.items ?? sj.data ?? [];
  // Pick the most recently executed one.
  let best: { id: string; ts: string } | undefined;
  for (const it of items) {
    const ts = it.metadata?.lastExecution?.executedOn;
    if (typeof ts === 'string' && (!best || ts > best.ts)) {
      best = { id: it.id, ts };
    }
  }
  if (!best) throw new Error('no testcase has a lastExecution');
  return best.id;
}

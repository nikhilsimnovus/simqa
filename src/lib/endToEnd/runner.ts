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
import { API_CHECKS, type CheckDef } from './checks';
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

const activeRuns = new Map<string, ActiveRun>();

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
  const planned = filterChecks(API_CHECKS, options, req.onlyCheckIds);
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

  for (const c of planned) {
    if (ar.canceled) {
      ar.liveStatus.set(c.id, { status: 'skip' });
      results.push({
        id: c.id, name: c.name, phase: c.phase, severity: c.severity, description: c.description,
        status: 'skip', skippedReason: 'run aborted', ranAt: new Date().toISOString(),
      });
      continue;
    }
    ar.liveStatus.set(c.id, { status: 'running' });
    try {
      const r = await c.run(ar.ctx);
      ar.liveStatus.set(c.id, { status: r.status, result: r });
      results.push(r);
    } catch (e: any) {
      const fail: CheckResult = {
        id: c.id, name: c.name, phase: c.phase, severity: c.severity, description: c.description,
        status: 'fail',
        detail: `check threw: ${e?.message ?? e}`,
        ranAt: new Date().toISOString(),
      };
      ar.liveStatus.set(c.id, { status: 'fail', result: fail });
      results.push(fail);
    }
  }

  // Verdict: critical fails → overall fail. Otherwise pass.
  const criticalFailed = results.some((r) => r.status === 'fail' && r.severity === 'critical');
  ar.ok = !criticalFailed && !ar.canceled;
  ar.finishedAt = new Date().toISOString();
  const passed  = results.filter((r) => r.status === 'pass').length;
  const failed  = results.filter((r) => r.status === 'fail').length;
  const skipped = results.filter((r) => r.status === 'skip').length;
  ar.finalDetail = ar.canceled ? 'aborted' :
    criticalFailed ? `${results.filter((r) => r.status === 'fail' && r.severity === 'critical').length} critical check(s) failed` :
    failed > 0     ? `${failed} non-critical check(s) failed` :
                     `all ${passed} checks passed`;

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

function filterChecks(catalogue: CheckDef[], options: RunOptions, onlyIds?: string[]): CheckDef[] {
  let list = catalogue.slice();
  if (!options.apiChecks) list = list.filter((c) => c.requiresBrowser);
  if (!options.uiChecks)  list = list.filter((c) => !c.requiresBrowser);
  if (onlyIds && onlyIds.length > 0) {
    const want = new Set(onlyIds);
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

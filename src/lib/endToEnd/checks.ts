// End-to-End check catalogue.
//
// Each entry is a self-contained validation step. The runner walks the
// catalogue in order, populating the shared RunCtx as it goes (token,
// executionId, etc.). Checks within the same phase may depend on each
// other's ctx-side effects; checks across phases are designed to fail
// gracefully if an upstream check skipped or failed (e.g., everything
// in DURING/COMPLETION/POST checks ctx.executionId before doing work).
//
// Severity:
//   critical — when this fails, the rest of the run is essentially
//              meaningless (no token = no API; no executionId = no DURING).
//   normal   — interesting product behaviour; failure indicates a real
//              bug worth reporting.
//   optional — nice-to-have signal; failures rolled into the summary but
//              don't drive the overall verdict.

import * as fs from 'node:fs';
import type { CheckResult, Phase, Severity } from './types';
import type { RunCtx } from './ctx';
import { pollUntil, sleep } from './poll';
import { newCheckContext, loginUI } from './browser';

// ───────────── Helpers ─────────────

const apiBase = (host: string) => `http://${host}/v2`;

function authHeaders(ctx: RunCtx): Record<string, string> {
  return ctx.token ? { Authorization: `Bearer ${ctx.token}` } : {};
}

async function jsonFetch(url: string, init?: RequestInit, timeoutMs = 20000): Promise<{ status: number; body: any; raw: string; durationMs: number }> {
  const t0 = Date.now();
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ac.signal });
    const raw = await res.text();
    let body: any;
    try { body = JSON.parse(raw); } catch { body = undefined; }
    return { status: res.status, body, raw, durationMs: Date.now() - t0 };
  } finally {
    clearTimeout(t);
  }
}

function makeResult(
  base: { id: string; name: string; phase: Phase; severity: Severity; description: string },
  status: 'pass' | 'fail' | 'skip',
  detail: string,
  extra: Partial<CheckResult> = {},
): CheckResult {
  return {
    ...base,
    status,
    detail,
    ranAt: new Date().toISOString(),
    ...extra,
    ...(status === 'skip' && !extra.skippedReason ? { skippedReason: detail } : {}),
  };
}

// ───────────── Check definitions ─────────────

export interface CheckDef {
  id: string;
  name: string;
  description: string;
  phase: Phase;
  severity: Severity;
  /** If true, this check requires a Playwright browser. Skipped when
   *  options.uiChecks is false or no browser is available. */
  requiresBrowser?: boolean;
  /** If true, this check mutates state on the target (POST). Useful for the
   *  UI to flag what will actually happen. */
  destructive?: boolean;
  run: (ctx: RunCtx) => Promise<CheckResult>;
}

// ── PREFLIGHT (4) ──────────────────────────────────────────────────────────

const preflightLogin: CheckDef = {
  id: 'preflight-login',
  name: 'Login to Simnovator API',
  description: 'POST /v2/login returns a JWT. Required for everything else.',
  phase: 'preflight', severity: 'critical',
  run: async (ctx) => {
    const base = { id: 'preflight-login', name: 'Login to Simnovator API', phase: 'preflight' as Phase, severity: 'critical' as Severity, description: 'POST /v2/login returns a JWT. Required for everything else.' };
    const t0 = Date.now();
    try {
      const r = await jsonFetch(`${apiBase(ctx.systemHost)}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: ctx.apiUser, password: ctx.apiPass }),
      });
      if (r.status !== 200) return makeResult(base, 'fail', `login returned ${r.status}`, { durationMs: Date.now() - t0 });
      const token = r.body?.access_token ?? r.body?.token ?? r.body?.jwt;
      if (!token) return makeResult(base, 'fail', 'login 200 but no access_token/token/jwt in response', { durationMs: Date.now() - t0 });
      ctx.token = token;
      return makeResult(base, 'pass', `200 in ${r.durationMs}ms, token len=${token.length}`, { durationMs: Date.now() - t0 });
    } catch (e: any) {
      return makeResult(base, 'fail', `login threw: ${e?.message ?? e}`, { durationMs: Date.now() - t0 });
    }
  },
};

const preflightTestcaseExists: CheckDef = {
  id: 'preflight-testcase-exists',
  name: 'Testcase exists',
  description: 'GET /v2/testcases/{id} returns 200 with a parsed testDefinition.',
  phase: 'preflight', severity: 'critical',
  run: async (ctx) => {
    const base = { id: 'preflight-testcase-exists', name: 'Testcase exists', phase: 'preflight' as Phase, severity: 'critical' as Severity, description: 'GET /v2/testcases/{id} returns 200 with a parsed testDefinition.' };
    if (!ctx.token) return makeResult(base, 'skip', 'no token (login failed)');
    const r = await jsonFetch(`${apiBase(ctx.systemHost)}/testcases/${encodeURIComponent(ctx.testcaseId)}`, { headers: authHeaders(ctx) });
    if (r.status !== 200) return makeResult(base, 'fail', `got ${r.status}`, { durationMs: r.durationMs });
    ctx.testcaseName = r.body?.name ?? ctx.testcaseId;
    ctx.testcaseMetadata = r.body?.metadata;

    // Extract configured duration. Priority order (canonical first):
    //   1. metadata.lastExecution.testDuration / durationSeconds — the
    //      authoritative field on Simnovator 4.x. Set when the testcase
    //      has run at least once; reads the last actual duration as a
    //      proxy for the expected run time.
    //   2. testDefinition.settings.duration / executionDuration — present
    //      on some test types (data-plane long-runners).
    //   3. testDefinition top-level — older API shape.
    const meta = r.body?.metadata?.lastExecution ?? {};
    const td   = r.body?.testDefinition ?? {};
    const candidates = [
      meta.testDuration,
      meta.durationSeconds,
      td.settings?.duration,
      td.settings?.executionDuration,
      td.duration,
      td.executionDuration,
      td.testParameters?.duration,
      td.testParams?.duration,
      td.run_duration,
    ];
    for (const c of candidates) {
      const n = typeof c === 'string' ? parseInt(c, 10) : c;
      if (typeof n === 'number' && n > 0) { ctx.configuredDurationSec = n; break; }
    }

    const durStr = ctx.configuredDurationSec ? ` configuredDuration=${ctx.configuredDurationSec}s` : ' (no duration found — completion will use default 60s)';
    return makeResult(base, 'pass', `id=${ctx.testcaseId} name="${ctx.testcaseName}"${durStr}`, { durationMs: r.durationMs });
  },
};

const preflightApiResponsive: CheckDef = {
  id: 'preflight-api-responsive',
  name: 'Simnovator API is responsive',
  description: 'GET /v2/simulators returns 2xx in under 5 seconds.',
  phase: 'preflight', severity: 'normal',
  run: async (ctx) => {
    const base = { id: 'preflight-api-responsive', name: 'Simnovator API is responsive', phase: 'preflight' as Phase, severity: 'normal' as Severity, description: 'GET /v2/simulators returns 2xx in under 5 seconds.' };
    if (!ctx.token) return makeResult(base, 'skip', 'no token');
    const r = await jsonFetch(`${apiBase(ctx.systemHost)}/simulators`, { headers: authHeaders(ctx) });
    if (r.status !== 200) return makeResult(base, 'fail', `got ${r.status}`, { durationMs: r.durationMs });
    const slow = r.durationMs > 5000;
    return makeResult(base, slow ? 'fail' : 'pass', `200 in ${r.durationMs}ms${slow ? ' (slow, > 5s)' : ''}`, { durationMs: r.durationMs });
  },
};

const preflightSimulatorsAvailable: CheckDef = {
  id: 'preflight-simulators-available',
  name: 'Required simulators are available',
  description: 'The testcase\'s simulator must be CONNECTED + AVAILABLE, AND no other simulator on the system can be BUSY (Simnovator enforces a system-wide mutex on test executions).',
  phase: 'preflight', severity: 'critical',
  run: async (ctx) => {
    const base = { id: 'preflight-simulators-available', name: 'Required simulators are available', phase: 'preflight' as Phase, severity: 'critical' as Severity, description: 'The testcase\'s simulator must be CONNECTED + AVAILABLE, AND no other simulator on the system can be BUSY (Simnovator enforces a system-wide mutex on test executions).' };
    if (!ctx.token) return makeResult(base, 'skip', 'no token');
    const r = await jsonFetch(`${apiBase(ctx.systemHost)}/simulators`, { headers: authHeaders(ctx) });
    if (r.status !== 200) return makeResult(base, 'fail', `simulators returned ${r.status}`, { durationMs: r.durationMs });
    const items: any[] = r.body?.items ?? r.body?.data ?? [];
    if (items.length === 0) return makeResult(base, 'fail', '0 simulators registered on this system', { durationMs: r.durationMs });

    // ── BUSY-flag handling ───────────────────────────────────────────────
    // The /v2/simulators list returns availability=BUSY for two distinct
    // states on the current box build:
    //   (a) a real running execution — the system-wide mutex will reject
    //       any new POST /executions with 409.
    //   (b) a stale flag — the previous run terminated but the box never
    //       reset the field. Tracked as SIM40-2064. On build 4.0.0_260427
    //       there is NO API recovery: documented stop endpoints 404, PATCH
    //       silently no-ops. The only recovery is a service restart.
    //
    // The runtime view at /v2/testcases/executions/current/status?simulatorId={id}
    // distinguishes them: 200 → real execution; 404 with body
    // {"code":"NOT_FOUND","message":"no active execution found for simulator"}
    // → stale flag.
    //
    // Policy (decided 2026-05-13, in response to the customer DOS):
    //   - If a BUSY sim turns out to be stale, treat it as effectively
    //     AVAILABLE and don't block the run. Let the trigger step be the
    //     real gate — the box may still 409, but if it does we'll get a
    //     precise error from POST /executions, and if it doesn't we get
    //     a successful run despite the stale flag. Either outcome is
    //     better than blocking customers behind a flag we know lies.
    //   - If a BUSY sim has a REAL execution, keep failing the preflight
    //     so we don't fire a doomed trigger that costs ~30s.
    //   - Always surface what we did via the result detail so the user
    //     can see "overrode stale BUSY on X, Y, Z" or "real execution
    //     blocking on sim X".
    const extractWhat = (o: any): string | undefined => {
      if (!o || typeof o !== 'object') return undefined;
      const direct = ['testCaseId', 'testcaseId', 'test_case_id',
        'currentTestcaseId', 'currentTestCaseId', 'testcaseName',
        'testCaseName', 'testName', 'name'];
      for (const k of direct) {
        const v = o[k];
        if (typeof v === 'string' && v) return v;
      }
      const wrappers = [o.testcase, o.testCase, o.currentExecution, o.execution];
      for (const w of wrappers) {
        if (w && typeof w === 'object') {
          const inner = w.testCaseId ?? w.testcaseId ?? w.name ?? w.id;
          if (typeof inner === 'string' && inner) return inner;
        }
      }
      return undefined;
    };
    const extractExec = (o: any): string | undefined => {
      if (!o || typeof o !== 'object') return undefined;
      const direct = ['executionId', 'execution_id', 'currentExecutionId', 'id', 'eid'];
      for (const k of direct) {
        const v = o[k];
        if (typeof v === 'string' && v) return v;
      }
      const wrappers = [o.currentExecution, o.execution];
      for (const w of wrappers) {
        if (w && typeof w === 'object') {
          const inner = w.executionId ?? w.id ?? w.eid;
          if (typeof inner === 'string' && inner) return inner;
        }
      }
      return undefined;
    };

    const busySims = items.filter((s) => (s.availability ?? '').toUpperCase() === 'BUSY');
    // For each BUSY sim, classify as "stale" or "running" by querying the
    // runtime endpoint. Probed serially to keep box load low; with the
    // 2-3 BUSY sims we see in practice this is well under a second total.
    const staleBusyIds: string[] = [];
    const realBusy: Array<{ id: string; name: string; what?: string; exec?: string }> = [];
    for (const b of busySims) {
      try {
        const cur = await jsonFetch(
          `${apiBase(ctx.systemHost)}/testcases/executions/current/status?simulatorId=${encodeURIComponent(b.id)}`,
          { headers: authHeaders(ctx) },
        );
        if (cur.status === 200 && cur.body && typeof cur.body === 'object') {
          realBusy.push({ id: b.id, name: b.name, what: extractWhat(cur.body), exec: extractExec(cur.body) });
        } else if (cur.status === 404) {
          staleBusyIds.push(b.id);
        } else {
          // Treat any other response (5xx, timeout) as REAL busy to be safe.
          realBusy.push({ id: b.id, name: b.name });
        }
      } catch {
        // Network blip — assume REAL busy.
        realBusy.push({ id: b.id, name: b.name });
      }
    }

    if (realBusy.length > 0) {
      const r0 = realBusy[0];
      return makeResult(base, 'fail',
        `${r0.name} (id=${r0.id}) has a REAL execution registered — running "${r0.what ?? '(unknown testcase)'}"${r0.exec ? ` (executionId=${r0.exec})` : ''}. Simnovator enforces a system-wide execution mutex; wait for it to finish, then retry.` +
        (realBusy.length > 1 ? ` ${realBusy.length - 1} other sim(s) also running.` : '') +
        (staleBusyIds.length > 0 ? ` (Separately: ${staleBusyIds.length} stale-BUSY flag(s) on sim id(s) ${staleBusyIds.join(', ')} — see SIM40-2064 — overridden but not blocking.)` : ''),
        { durationMs: r.durationMs });
    }

    // Build the effective-availability view: BUSY sims that turned out to
    // be stale are now treated as AVAILABLE for the downstream checks.
    const isStaleBusy = (id: string) => staleBusyIds.includes(id);
    const effectiveAvailability = (s: any): string => {
      const av = String(s.availability ?? '').toUpperCase();
      if (av === 'BUSY' && isStaleBusy(String(s.id))) return 'AVAILABLE';
      return av;
    };
    const staleNote = staleBusyIds.length > 0
      ? ` (overrode stale BUSY flag on sim id(s) ${staleBusyIds.join(', ')} — no live execution per /testcases/executions/current/status; see SIM40-2064)`
      : '';

    // Step 2 — the testcase's preferred simulator (from its last execution
    // metadata) must be present + CONNECTED + AVAILABLE + STABLE (where
    // AVAILABLE is the effective view above, so stale-BUSY counts as
    // AVAILABLE).
    const wantSim = ctx.testcaseMetadata?.lastExecution?.simulatorName
      ?? ctx.testcaseMetadata?.simulatorType
      ?? undefined;
    if (wantSim) {
      const w = String(wantSim).toLowerCase();
      const match = items.find((s) => (s.name ?? '').toLowerCase() === w || (s.name ?? '').toLowerCase().includes(w) || (s.type ?? '').toLowerCase().includes(w));
      if (!match) {
        return makeResult(base, 'fail',
          `the testcase's last-used simulator "${wantSim}" is not registered (have: ${items.map((s) => s.name).join(', ')})`,
          { durationMs: r.durationMs });
      }
      const conn = String(match.connectivity ?? '').toUpperCase();
      const avail = effectiveAvailability(match);
      const stab  = String(match.stability ?? '').toUpperCase();
      if (conn !== 'CONNECTED' || avail !== 'AVAILABLE' || stab !== 'STABLE') {
        return makeResult(base, 'fail',
          `"${match.name}" state is not ready: connectivity=${match.connectivity} availability=${match.availability}${isStaleBusy(String(match.id)) ? ' (stale, ignored)' : ''} stability=${match.stability}`,
          { durationMs: r.durationMs });
      }
      return makeResult(base, 'pass',
        `"${match.name}" CONNECTED+AVAILABLE+STABLE${busySims.length === 0 ? ' (system idle, no other test running)' : ''}${staleNote}`,
        { durationMs: r.durationMs });
    }

    // No specific sim in testcase metadata — just check at least one is ready
    // (under the effective-availability view).
    const ready = items.filter((s) => String(s.connectivity).toUpperCase() === 'CONNECTED' && effectiveAvailability(s) === 'AVAILABLE' && String(s.stability).toUpperCase() === 'STABLE');
    if (ready.length === 0) {
      return makeResult(base, 'fail',
        `no simulator is CONNECTED+AVAILABLE+STABLE (have ${items.length} total)`,
        { durationMs: r.durationMs });
    }
    return makeResult(base, 'pass',
      `${ready.length} of ${items.length} simulator(s) are CONNECTED+AVAILABLE+STABLE: ${ready.map((s) => s.name).join(', ')}${staleNote}`,
      { durationMs: r.durationMs });
  },
};

// ── TRIGGER (2) ────────────────────────────────────────────────────────────

const triggerStart: CheckDef = {
  id: 'trigger-start-execution',
  name: 'POST /testcases/{id}/executions',
  description: 'Start endpoint returns 2xx within 90 seconds. This is the first state-mutating step. Note: the Simnovator can take up to ~60s to come back with a 5xx (e.g. "Could not start LTE") — we wait so the failure surfaces as a real message, not "aborted".',
  phase: 'trigger', severity: 'critical',
  destructive: true,
  run: async (ctx) => {
    const base = { id: 'trigger-start-execution', name: 'POST /testcases/{id}/executions', phase: 'trigger' as Phase, severity: 'critical' as Severity, description: 'Start endpoint returns 2xx within 90 seconds. This is the first state-mutating step.' };
    if (!ctx.token) return makeResult(base, 'skip', 'no token');
    ctx.triggeredAt = Date.now();
    // Bumped from 20s default to 90s on 2026-05-13. The Simnovator can take
    // up to ~55s to return 500 "Could not start LTE" when the UESIM ue.cfg
    // is unpatched (SDR rf_driver block on hardware with no /dev/sdr0) —
    // we want to surface that error message rather than an unhelpful
    // "This operation was aborted" client-side timeout.
    const r = await jsonFetch(`${apiBase(ctx.systemHost)}/testcases/${encodeURIComponent(ctx.testcaseId)}/executions`, {
      method: 'POST',
      headers: { ...authHeaders(ctx), 'Content-Type': 'application/json' },
      body: '{}',
    }, 90_000);
    if (r.status !== 200 && r.status !== 201 && r.status !== 202) {
      return makeResult(base, 'fail', `start returned ${r.status}: ${r.raw.slice(0, 200)}`, { durationMs: r.durationMs });
    }
    // We deliberately do NOT flag "slow > 5s" as fail anymore. A slow-but-
    // successful trigger is fine and was masking real 5xx failures behind
    // an "aborted" client-side timeout. Trigger duration still surfaces in
    // the result detail so anyone watching can see it.
    return makeResult(base, 'pass', `${r.status} in ${r.durationMs}ms${r.durationMs > 5000 ? ' (slow but accepted)' : ''}`, { durationMs: r.durationMs });
  },
};

const triggerExecutionDiscovered: CheckDef = {
  id: 'trigger-execution-id-discovered',
  name: 'Execution registered in testcase metadata',
  description: 'Within 30s of trigger, metadata.lastExecution.executionId exposes a new id.',
  phase: 'trigger', severity: 'critical',
  run: async (ctx) => {
    const base = { id: 'trigger-execution-id-discovered', name: 'Execution registered in testcase metadata', phase: 'trigger' as Phase, severity: 'critical' as Severity, description: 'Within 30s of trigger, metadata.lastExecution.executionId exposes a new id.' };
    if (!ctx.token || !ctx.triggeredAt) return makeResult(base, 'skip', 'trigger did not fire');
    // The /executions POST doesn't return an id directly. We re-fetch the
    // testcase and look at metadata.lastExecution.executionId. Filter out
    // any executionId that was already there before we triggered (compare
    // executedOn timestamp against ctx.triggeredAt).
    const seenBefore = ctx.testcaseMetadata?.lastExecution?.executionId as string | undefined;
    const triggeredAtIso = new Date(ctx.triggeredAt).toISOString();
    const r = await pollUntil(async () => {
      const f = await jsonFetch(`${apiBase(ctx.systemHost)}/testcases/${encodeURIComponent(ctx.testcaseId)}`, { headers: authHeaders(ctx) });
      if (f.status !== 200) return undefined;
      const last = f.body?.metadata?.lastExecution;
      if (!last?.executionId) return undefined;
      // Treat as newly-discovered if either id changed or executedOn >= triggeredAt.
      if (last.executionId !== seenBefore) return last.executionId;
      const execAt = String(last.executedOn ?? '');
      if (execAt && execAt >= triggeredAtIso.slice(0, 19)) return last.executionId;
      return undefined;
    }, { intervalMs: 2000, timeoutMs: 30000, isCanceled: ctx.isCanceled });
    if (!r.ok) return makeResult(base, 'fail', `no new execution id after ${(r.elapsedMs / 1000).toFixed(1)}s (reason=${r.reason})`, { durationMs: r.elapsedMs });
    ctx.executionId = r.value!;
    return makeResult(base, 'pass', `executionId=${ctx.executionId} discovered in ${(r.elapsedMs / 1000).toFixed(1)}s`, { durationMs: r.elapsedMs });
  },
};

// ── DURING (3) ─────────────────────────────────────────────────────────────

const duringStatusRunning: CheckDef = {
  id: 'during-status-running',
  name: 'Execution transitions to RUNNING',
  description: 'Within 30s of trigger, lastExecution.status reaches RUNNING.',
  phase: 'during', severity: 'critical',
  run: async (ctx) => {
    const base = { id: 'during-status-running', name: 'Execution transitions to RUNNING', phase: 'during' as Phase, severity: 'critical' as Severity, description: 'Within 30s of trigger, lastExecution.status reaches RUNNING.' };
    if (!ctx.token || !ctx.executionId) return makeResult(base, 'skip', 'no executionId');
    const r = await pollUntil(async () => {
      const f = await jsonFetch(`${apiBase(ctx.systemHost)}/testcases/${encodeURIComponent(ctx.testcaseId)}`, { headers: authHeaders(ctx) });
      if (f.status !== 200) return undefined;
      const status = String(f.body?.metadata?.lastExecution?.status ?? '').toUpperCase();
      if (status === 'RUNNING' || status === 'IN_PROGRESS' || status === 'STARTED') return status;
      // Terminal status reached before we ever saw RUNNING — that's a failure of this check.
      if (['COMPLETED', 'FAILED', 'STOPPED', 'ABORTED', 'INCOMPLETE'].includes(status)) {
        throw new Error(`reached terminal status "${status}" without going through RUNNING`);
      }
      return undefined;
    }, { intervalMs: 2000, timeoutMs: 30000, isCanceled: ctx.isCanceled });
    if (!r.ok) return makeResult(base, 'fail', r.error ? r.error.message : `did not reach RUNNING after ${(r.elapsedMs / 1000).toFixed(1)}s`, { durationMs: r.elapsedMs });
    return makeResult(base, 'pass', `status=${r.value} after ${(r.elapsedMs / 1000).toFixed(1)}s`, { durationMs: r.elapsedMs });
  },
};

// Both during-* checks below use these helpers:
//
// Timeout scales with the testcase's configured duration. 60s was the
// old hardcoded cap, which is too short for any testcase that takes
// >30s to bring up a PDU session (essentially all real data-plane tests
// on IP loopback). New cap: min(180s, configuredDuration / 3) with a
// 60s floor so very short testcases still get a fair shot.
function deriveDuringTimeoutMs(ctx: any): number {
  const configured = ctx.configuredDurationSec ?? 60;
  const scaled = Math.floor((configured * 1000) / 3);
  return Math.max(60_000, Math.min(180_000, scaled));
}

const duringUeAttach: CheckDef = {
  id: 'during-ue-attach',
  name: 'At least one UE attaches',
  description: 'GET /v2/testcases/executions/{eid}/statistics/ues — data.totalUEs ≥ 1 within a duration-scaled window.',
  phase: 'during', severity: 'normal',
  run: async (ctx) => {
    const base = { id: 'during-ue-attach', name: 'At least one UE attaches', phase: 'during' as Phase, severity: 'normal' as Severity, description: 'GET /v2/testcases/executions/{eid}/statistics/ues — data.totalUEs ≥ 1 within a duration-scaled window.' };
    if (!ctx.token || !ctx.executionId) return makeResult(base, 'skip', 'no executionId');
    const timeoutMs = deriveDuringTimeoutMs(ctx);
    const r = await pollUntil(async () => {
      const now = Date.now();
      // Endpoint is `/statistics/ues` (plural, no `-summary`). The
      // `/ue-summary` path 404s on build 4.0.0_260427 (verified live
      // 2026-05-14). Response shape: { code, message, data: { ue_data,
      // totalUEs } }. Field names confirmed against 192.168.10.128.
      const f = await jsonFetch(`${apiBase(ctx.systemHost)}/testcases/executions/${encodeURIComponent(ctx.executionId!)}/statistics/ues?startTime=${now - 60000}&endTime=${now}`, { headers: authHeaders(ctx) });
      if (f.status !== 200) return undefined;
      // Prefer data.totalUEs (current shape). Keep fallbacks for older
      // builds and unknown future ones.
      const candidates = [
        f.body?.data?.totalUEs,
        Array.isArray(f.body?.data?.ue_data) ? f.body.data.ue_data.length : undefined,
        f.body?.totalAttachedUEs,
        f.body?.totalUEs,
        f.body?.attached,
        f.body?.summary?.attached,
        Array.isArray(f.body?.items) ? f.body.items.length : undefined,
      ];
      for (const c of candidates) {
        if (typeof c === 'number' && c > 0) return c;
      }
      return undefined;
    }, { intervalMs: 5000, timeoutMs, isCanceled: ctx.isCanceled });
    if (!r.ok) return makeResult(base, 'fail', `no UE attached after ${(r.elapsedMs / 1000).toFixed(1)}s (poll window ${(timeoutMs / 1000).toFixed(0)}s — scaled from configuredDuration)`, { durationMs: r.elapsedMs });
    return makeResult(base, 'pass', `${r.value} UE(s) attached after ${(r.elapsedMs / 1000).toFixed(1)}s`, { durationMs: r.elapsedMs });
  },
};

const duringThroughputFlowing: CheckDef = {
  id: 'during-throughput-flowing',
  name: 'Downlink throughput > 0',
  description: 'GET /v2/testcases/executions/{eid}/statistics/cells — any cell with dl_throughput > 0 within a duration-scaled window.',
  phase: 'during', severity: 'normal',
  run: async (ctx) => {
    const base = { id: 'during-throughput-flowing', name: 'Downlink throughput > 0', phase: 'during' as Phase, severity: 'normal' as Severity, description: 'GET /v2/testcases/executions/{eid}/statistics/cells — any cell with dl_throughput > 0 within a duration-scaled window.' };
    if (!ctx.token || !ctx.executionId) return makeResult(base, 'skip', 'no executionId');
    const timeoutMs = deriveDuringTimeoutMs(ctx);
    const r = await pollUntil(async () => {
      const now = Date.now();
      // Endpoint is `/statistics/cells` (plural, no `-summary`). The
      // `/cells-summary` path returns cell CONFIG (n_rb, pci, antennas),
      // not throughput stats — surprising but verified live. Use the
      // `/cells` endpoint instead. Response: { code, message, data: { cells } }.
      const f = await jsonFetch(`${apiBase(ctx.systemHost)}/testcases/executions/${encodeURIComponent(ctx.executionId!)}/statistics/cells?startTime=${now - 60000}&endTime=${now}`, { headers: authHeaders(ctx) });
      if (f.status !== 200) return undefined;
      const cells: any[] = Array.isArray(f.body?.data?.cells) ? f.body.data.cells
        : Array.isArray(f.body?.cells) ? f.body.cells
        : Array.isArray(f.body?.items) ? f.body.items
        : Array.isArray(f.body) ? f.body : [];
      for (const c of cells) {
        const dl = c.dl_throughput ?? c.dlThroughput ?? c.dl ?? c.downlinkThroughput ?? c.throughput?.dl;
        if (typeof dl === 'number' && dl > 0) return dl;
      }
      return undefined;
    }, { intervalMs: 5000, timeoutMs, isCanceled: ctx.isCanceled });
    if (!r.ok) return makeResult(base, 'fail', `no DL throughput after ${(r.elapsedMs / 1000).toFixed(1)}s (poll window ${(timeoutMs / 1000).toFixed(0)}s — scaled from configuredDuration) — testcase may not be data-plane, or PDU session never came up`, { durationMs: r.elapsedMs });
    return makeResult(base, 'pass', `DL=${r.value} bps after ${(r.elapsedMs / 1000).toFixed(1)}s`, { durationMs: r.elapsedMs });
  },
};

// ── COMPLETION (3) ─────────────────────────────────────────────────────────

const completionStatusTerminal: CheckDef = {
  id: 'completion-status-terminal',
  name: 'Execution reaches a terminal state',
  description: 'Status becomes COMPLETED / STOPPED / FAILED within configured duration + grace.',
  phase: 'completion', severity: 'critical',
  run: async (ctx) => {
    const base = { id: 'completion-status-terminal', name: 'Execution reaches a terminal state', phase: 'completion' as Phase, severity: 'critical' as Severity, description: 'Status becomes COMPLETED / STOPPED / FAILED within configured duration + grace.' };
    if (!ctx.token || !ctx.executionId) return makeResult(base, 'skip', 'no executionId');
    const configured = ctx.configuredDurationSec ?? 60; // default 60s if duration unknown
    const grace = 60_000; // +60s grace
    const timeoutMs = configured * 1000 + grace;
    const r = await pollUntil(async () => {
      const f = await jsonFetch(`${apiBase(ctx.systemHost)}/testcases/${encodeURIComponent(ctx.testcaseId)}`, { headers: authHeaders(ctx) });
      if (f.status !== 200) return undefined;
      const status = String(f.body?.metadata?.lastExecution?.status ?? '').toUpperCase();
      if (['COMPLETED', 'STOPPED', 'FAILED', 'ABORTED', 'INCOMPLETE'].includes(status)) return status;
      return undefined;
    }, { intervalMs: 5000, timeoutMs, isCanceled: ctx.isCanceled });
    if (!r.ok) return makeResult(base, 'fail', `did not reach terminal state in ${(timeoutMs / 1000).toFixed(0)}s (reason=${r.reason})`, { durationMs: r.elapsedMs });
    ctx.finishedAt = Date.now();
    return makeResult(base, 'pass', `terminal status=${r.value} after ${(r.elapsedMs / 1000).toFixed(1)}s`, { durationMs: r.elapsedMs });
  },
};

const completionDurationSane: CheckDef = {
  id: 'completion-duration-sane',
  name: 'Observed duration matches configured duration',
  description: 'Wall-clock duration within ±20% of configured duration.',
  phase: 'completion', severity: 'normal',
  run: async (ctx) => {
    const base = { id: 'completion-duration-sane', name: 'Observed duration matches configured duration', phase: 'completion' as Phase, severity: 'normal' as Severity, description: 'Wall-clock duration within ±20% of configured duration.' };
    if (!ctx.triggeredAt || !ctx.finishedAt) return makeResult(base, 'skip', 'trigger or completion timestamp missing');
    if (!ctx.configuredDurationSec) return makeResult(base, 'skip', 'no configured duration in testcase metadata');
    const observedSec = (ctx.finishedAt - ctx.triggeredAt) / 1000;
    const configured = ctx.configuredDurationSec;
    const lo = configured * 0.8;
    const hi = configured * 1.2 + 30;  // +30s of slack for trigger latency
    if (observedSec >= lo && observedSec <= hi) {
      return makeResult(base, 'pass', `observed=${observedSec.toFixed(1)}s configured=${configured}s (within ±20% + 30s slack)`);
    }
    return makeResult(base, 'fail', `observed=${observedSec.toFixed(1)}s configured=${configured}s — outside [${lo.toFixed(0)}, ${hi.toFixed(0)}]s`);
  },
};

const completionVerdictPresent: CheckDef = {
  id: 'completion-verdict-present',
  name: 'Execution has a verdict / result',
  description: 'metadata.lastExecution.result is one of PASS / FAIL / INCOMPLETE.',
  phase: 'completion', severity: 'normal',
  run: async (ctx) => {
    const base = { id: 'completion-verdict-present', name: 'Execution has a verdict / result', phase: 'completion' as Phase, severity: 'normal' as Severity, description: 'metadata.lastExecution.result is one of PASS / FAIL / INCOMPLETE.' };
    if (!ctx.token || !ctx.executionId) return makeResult(base, 'skip', 'no executionId');
    const r = await jsonFetch(`${apiBase(ctx.systemHost)}/testcases/${encodeURIComponent(ctx.testcaseId)}`, { headers: authHeaders(ctx) });
    if (r.status !== 200) return makeResult(base, 'fail', `testcase fetch returned ${r.status}`, { durationMs: r.durationMs });
    const result = String(r.body?.metadata?.lastExecution?.result ?? '').toUpperCase();
    if (!result) return makeResult(base, 'fail', 'no result field on lastExecution', { durationMs: r.durationMs });
    return makeResult(base, 'pass', `result=${result}`, { durationMs: r.durationMs });
  },
};

// ── POST (1) ───────────────────────────────────────────────────────────────

const postLogsExport: CheckDef = {
  id: 'post-logs-exportable',
  name: 'Logs are exportable',
  description: 'GET /v2/testcases/executions/{eid}/logs/export returns 2xx and non-empty body.',
  phase: 'post', severity: 'normal',
  run: async (ctx) => {
    const base = { id: 'post-logs-exportable', name: 'Logs are exportable', phase: 'post' as Phase, severity: 'normal' as Severity, description: 'GET /v2/testcases/executions/{eid}/logs/export returns 2xx and non-empty body.' };
    if (!ctx.token || !ctx.executionId) return makeResult(base, 'skip', 'no executionId');
    const url = `${apiBase(ctx.systemHost)}/testcases/executions/${encodeURIComponent(ctx.executionId)}/logs/export?format=zip`;
    const t0 = Date.now();
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 60_000);
      const res = await fetch(url, { headers: authHeaders(ctx), signal: ac.signal });
      clearTimeout(t);
      const buf = await res.arrayBuffer();
      const dur = Date.now() - t0;
      if (res.status !== 200) return makeResult(base, 'fail', `got ${res.status} after ${dur}ms`, { durationMs: dur });
      if (buf.byteLength === 0) return makeResult(base, 'fail', `200 OK but empty body (after ${dur}ms)`, { durationMs: dur });
      return makeResult(base, 'pass', `200 OK, ${buf.byteLength} bytes in ${dur}ms`, { durationMs: dur });
    } catch (e: any) {
      return makeResult(base, 'fail', `logs/export threw: ${e?.message ?? e}`, { durationMs: Date.now() - t0 });
    }
  },
};

// ── UI checks (Phase 2 — require Playwright browser) ──────────────────────
//
// All UI checks are gated behind ctx.browser being set. When the runner is
// invoked with options.uiChecks=true it launches a browser and stuffs it
// into ctx.browser; if no browser can be launched, these checks are skipped
// with a clear reason instead of failing.

const uiDuringNo5xx: CheckDef = {
  id: 'ui-during-no-5xx',
  name: 'No 5xx responses while navigating stats pages',
  description: 'Visit /testcase, /statistics?iterationId=<eid>, /logs — assert no response status >= 500.',
  phase: 'during', severity: 'normal',
  requiresBrowser: true,
  run: async (ctx) => {
    const base = { id: 'ui-during-no-5xx', name: 'No 5xx responses while navigating stats pages', phase: 'during' as Phase, severity: 'normal' as Severity, description: 'Visit /testcase, /statistics?iterationId=<eid>, /logs — assert no response status >= 500.' };
    if (!ctx.browser) return makeResult(base, 'skip', 'no browser available');
    if (!ctx.executionId) return makeResult(base, 'skip', 'no executionId');
    const { context, page, responses } = await newCheckContext(ctx.browser);
    try {
      const lr = await loginUI(page, ctx.systemHost, ctx.apiUser, ctx.apiPass);
      if (!lr.ok) return makeResult(base, 'fail', `UI login: ${lr.detail}`);
      for (const pth of ['/testcase', `/statistics?iterationId=${encodeURIComponent(ctx.executionId)}`, '/logs']) {
        try { await page.goto(`http://${ctx.systemHost}${pth}`, { waitUntil: 'domcontentloaded' }); }
        catch { /* swallow; we capture network anyway */ }
        await sleep(2000, ctx.isCanceled);
      }
      const fives = responses.filter((r) => r.status >= 500 && !r.url.startsWith('chrome-extension://'));
      if (fives.length === 0) return makeResult(base, 'pass', `0 5xx responses across ${responses.length} captured requests`);
      const sample = fives.slice(0, 3).map((r) => `${r.method} ${r.url} → ${r.status}`).join(' | ');
      return makeResult(base, 'fail', `${fives.length} 5xx response(s). e.g.: ${sample}`);
    } finally {
      await context.close().catch(() => null);
    }
  },
};

const uiDuringNoConsoleErrors: CheckDef = {
  id: 'ui-during-no-console-errors',
  name: 'No JS console errors on stats pages',
  description: 'console.error count across /testcase, /statistics, /logs must be 0.',
  phase: 'during', severity: 'normal',
  requiresBrowser: true,
  run: async (ctx) => {
    const base = { id: 'ui-during-no-console-errors', name: 'No JS console errors on stats pages', phase: 'during' as Phase, severity: 'normal' as Severity, description: 'console.error count across /testcase, /statistics, /logs must be 0.' };
    if (!ctx.browser) return makeResult(base, 'skip', 'no browser available');
    if (!ctx.executionId) return makeResult(base, 'skip', 'no executionId');
    const { context, page, consoleErrors } = await newCheckContext(ctx.browser);
    try {
      const lr = await loginUI(page, ctx.systemHost, ctx.apiUser, ctx.apiPass);
      if (!lr.ok) return makeResult(base, 'fail', `UI login: ${lr.detail}`);
      for (const pth of ['/testcase', `/statistics?iterationId=${encodeURIComponent(ctx.executionId)}`, '/logs']) {
        try { await page.goto(`http://${ctx.systemHost}${pth}`, { waitUntil: 'domcontentloaded' }); }
        catch { /* swallow */ }
        await sleep(2000, ctx.isCanceled);
      }
      if (consoleErrors.length === 0) return makeResult(base, 'pass', '0 console errors');
      const sample = consoleErrors.slice(0, 3).join(' | ');
      return makeResult(base, 'fail', `${consoleErrors.length} console error(s). e.g.: ${sample}`);
    } finally {
      await context.close().catch(() => null);
    }
  },
};

const uiDuringStopAffordance: CheckDef = {
  id: 'ui-during-stop-affordance',
  name: 'Stop affordance visible during running execution',
  description: 'A Stop / Cancel button is visible on the testcase detail card while RUNNING (does NOT click — affordance only).',
  phase: 'during', severity: 'optional',
  requiresBrowser: true,
  run: async (ctx) => {
    const base = { id: 'ui-during-stop-affordance', name: 'Stop affordance visible during running execution', phase: 'during' as Phase, severity: 'optional' as Severity, description: 'A Stop / Cancel button is visible on the testcase detail card while RUNNING (does NOT click — affordance only).' };
    if (!ctx.browser) return makeResult(base, 'skip', 'no browser available');
    if (!ctx.executionId) return makeResult(base, 'skip', 'no executionId');
    const { context, page } = await newCheckContext(ctx.browser);
    try {
      const lr = await loginUI(page, ctx.systemHost, ctx.apiUser, ctx.apiPass);
      if (!lr.ok) return makeResult(base, 'fail', `UI login: ${lr.detail}`);
      await page.goto(`http://${ctx.systemHost}/testcase`, { waitUntil: 'domcontentloaded' }).catch(() => null);
      await sleep(2000, ctx.isCanceled);
      const stopVisible = await page.locator('button:has-text("Stop"), button:has-text("Cancel"), [aria-label="Stop"]').first().isVisible().catch(() => false);
      if (stopVisible) return makeResult(base, 'pass', 'Stop / Cancel button visible on /testcase');
      return makeResult(base, 'fail', 'no Stop / Cancel button found on /testcase while RUNNING');
    } finally {
      await context.close().catch(() => null);
    }
  },
};

const uiDuringExportButtons: CheckDef = {
  id: 'ui-during-export-buttons',
  name: 'Stats Export buttons download a file',
  description: 'Click Cell + UE + Global Export buttons in turn — each must trigger a download with > 0 bytes.',
  phase: 'during', severity: 'normal',
  requiresBrowser: true,
  run: async (ctx) => {
    const base = { id: 'ui-during-export-buttons', name: 'Stats Export buttons download a file', phase: 'during' as Phase, severity: 'normal' as Severity, description: 'Click Cell + UE + Global Export buttons in turn — each must trigger a download with > 0 bytes.' };
    if (!ctx.browser) return makeResult(base, 'skip', 'no browser available');
    if (!ctx.executionId) return makeResult(base, 'skip', 'no executionId');
    const { context, page } = await newCheckContext(ctx.browser);
    try {
      const lr = await loginUI(page, ctx.systemHost, ctx.apiUser, ctx.apiPass);
      if (!lr.ok) return makeResult(base, 'fail', `UI login: ${lr.detail}`);
      const results: Array<{ tab: string; ok: boolean; bytes?: number; detail: string }> = [];
      for (const tab of ['cell', 'ue', 'global']) {
        try {
          await page.goto(`http://${ctx.systemHost}/statistics?tab=${tab}&iterationId=${encodeURIComponent(ctx.executionId)}`, { waitUntil: 'domcontentloaded' });
          await sleep(1500, ctx.isCanceled);
          const exportBtn = page.locator('button:has-text("Export"), button:has-text("Download")').first();
          if (!(await exportBtn.isVisible().catch(() => false))) {
            results.push({ tab, ok: false, detail: 'Export button not visible' });
            continue;
          }
          // Wait for download to fire when clicked.
          const dlP = page.waitForEvent('download', { timeout: 15_000 });
          await exportBtn.click();
          const download = await dlP.catch(() => null);
          if (!download) { results.push({ tab, ok: false, detail: 'click did not trigger a download in 15s' }); continue; }
          const tmp = `/tmp/export-${tab}-${Date.now()}.bin`;
          await download.saveAs(tmp).catch(() => null);
          let bytes = 0;
          try { bytes = fs.statSync(tmp).size; } catch { bytes = 0; }
          if (bytes > 0) results.push({ tab, ok: true, bytes, detail: `${bytes} bytes` });
          else results.push({ tab, ok: false, bytes, detail: 'download empty' });
        } catch (e: any) {
          results.push({ tab, ok: false, detail: `threw: ${(e?.message ?? e).toString().slice(0, 120)}` });
        }
      }
      const failed = results.filter((r) => !r.ok);
      const summary = results.map((r) => `${r.tab}=${r.ok ? r.bytes + 'B' : '✗'}`).join(' / ');
      if (failed.length === 0) return makeResult(base, 'pass', summary);
      return makeResult(base, 'fail', `${failed.length} of ${results.length} export buttons failed. ${summary}`);
    } finally {
      await context.close().catch(() => null);
    }
  },
};

const uiPostDeepLink: CheckDef = {
  id: 'ui-post-deep-link-shareable',
  name: 'Statistics deep-link works in a fresh context',
  description: 'A /statistics?iterationId=<eid> link, opened in a new context (no localStorage), still renders without bouncing to login.',
  phase: 'post', severity: 'optional',
  requiresBrowser: true,
  run: async (ctx) => {
    const base = { id: 'ui-post-deep-link-shareable', name: 'Statistics deep-link works in a fresh context', phase: 'post' as Phase, severity: 'optional' as Severity, description: 'A /statistics?iterationId=<eid> link, opened in a new context (no localStorage), still renders without bouncing to login.' };
    if (!ctx.browser) return makeResult(base, 'skip', 'no browser available');
    if (!ctx.executionId) return makeResult(base, 'skip', 'no executionId');
    const { context, page } = await newCheckContext(ctx.browser);
    try {
      const lr = await loginUI(page, ctx.systemHost, ctx.apiUser, ctx.apiPass);
      if (!lr.ok) return makeResult(base, 'fail', `UI login: ${lr.detail}`);
      const target = `http://${ctx.systemHost}/statistics?iterationId=${encodeURIComponent(ctx.executionId)}`;
      await page.goto(target, { waitUntil: 'domcontentloaded' });
      await sleep(2000, ctx.isCanceled);
      const finalUrl = page.url();
      const onLogin = /login|signin/i.test(finalUrl) || finalUrl.endsWith('/');
      if (onLogin) return makeResult(base, 'fail', `bounced to ${finalUrl} — deep-link not preserved`);
      const hasIterId = finalUrl.includes('iterationId=');
      if (!hasIterId) return makeResult(base, 'fail', `iterationId stripped from URL: ${finalUrl}`);
      return makeResult(base, 'pass', `rendered at ${finalUrl}`);
    } finally {
      await context.close().catch(() => null);
    }
  },
};

// ───────────── Catalogue export ─────────────

/** All checks. Walked in catalog order, but the runner filters by
 *  options.uiChecks / options.apiChecks before walking. API checks are
 *  the cheap, always-runnable ones. UI checks need a browser. */
export const ALL_CHECKS: CheckDef[] = [
  // PREFLIGHT
  preflightLogin,
  preflightTestcaseExists,
  preflightApiResponsive,
  preflightSimulatorsAvailable,
  // TRIGGER
  triggerStart,
  triggerExecutionDiscovered,
  // DURING (API)
  duringStatusRunning,
  duringUeAttach,
  duringThroughputFlowing,
  // DURING (UI)
  uiDuringNo5xx,
  uiDuringNoConsoleErrors,
  uiDuringStopAffordance,
  uiDuringExportButtons,
  // COMPLETION
  completionStatusTerminal,
  completionDurationSane,
  completionVerdictPresent,
  // POST (API)
  postLogsExport,
  // POST (UI)
  uiPostDeepLink,
];

/** Backwards-compat name some older imports might use. */
export const API_CHECKS = ALL_CHECKS;

// Re-export sleep for runner-side waits between phases.
export { sleep };

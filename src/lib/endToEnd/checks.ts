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
import * as net from 'node:net';
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

/** Resolve the simulatorId used for start + runtime-status queries: the
 *  testcase's last-used simulator when present, else the first registered
 *  one. Build 4.0.0_260609 requires an explicit simulatorId both to start
 *  an execution (empty body → 500 "No default simulator found") and to
 *  query /testcases/executions/current/status. */
async function resolveSimulatorId(ctx: RunCtx): Promise<string | undefined> {
  const lastSim = ctx.testcaseMetadata?.lastExecution?.simulatorId;
  if (lastSim !== undefined && lastSim !== null && String(lastSim) !== '') return String(lastSim);
  const sims = await jsonFetch(`${apiBase(ctx.systemHost)}/simulators`, { headers: authHeaders(ctx) });
  const arr: any[] = sims.body?.items ?? sims.body?.data ?? [];
  if (arr[0]?.id !== undefined && arr[0]?.id !== null) return String(arr[0].id);
  return undefined;
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
    ctx.testDefinition = r.body?.testDefinition;

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

// ── PREFLIGHT — security posture ───────────────────────────────────────────

/** Outcome of the anonymous-FTP login probe. */
type FtpProbeOutcome =
  | { kind: 'logged-in'; detail: string }   // 230 — anonymous accepted (BAD)
  | { kind: 'rejected'; detail: string }    // 3xx/530/5xx — anonymous locked (GOOD)
  | { kind: 'refused'; detail: string }     // ECONNREFUSED — port closed (GOOD)
  | { kind: 'timeout'; detail: string }     // no reply — can't judge
  | { kind: 'no-ftp'; detail: string };     // not an FTP service — can't judge

/** Raw FTP conversation: read banner, "USER anonymous", "PASS guest@", judge
 *  the final reply code. Plain node:net — no FTP library, no shell-out. Every
 *  path destroys the socket exactly once (settled flag); listeners stay
 *  attached so a late 'error' after resolve can never crash the process. */
function probeAnonymousFtp(host: string, port = 21, timeoutMs = 5000): Promise<FtpProbeOutcome> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let buf = '';
    let stage: 'banner' | 'user' | 'pass' = 'banner';
    let settled = false;
    let lastLine = '';
    let hardCap: ReturnType<typeof setTimeout> | undefined;
    const finish = (o: FtpProbeOutcome) => {
      if (settled) return;
      settled = true;
      if (hardCap) clearTimeout(hardCap);
      try { socket.destroy(); } catch { /* already gone */ }
      resolve(o);
    };
    // Hard cap across all stages — the per-stage idle timeout resets on every
    // chunk, so a slow-drip server could otherwise hold us for minutes.
    hardCap = setTimeout(() => finish({ kind: 'timeout', detail: `probe exceeded ${timeoutMs * 3}ms overall (stage=${stage})` }), timeoutMs * 3);
    socket.setTimeout(timeoutMs);
    socket.on('timeout', () => finish({ kind: 'timeout', detail: `no FTP reply within ${timeoutMs}ms (stage=${stage})` }));
    socket.on('error', (e: any) => {
      if (e?.code === 'ECONNREFUSED') finish({ kind: 'refused', detail: `connection refused on ${host}:${port} — FTP port closed` });
      else finish({ kind: 'no-ftp', detail: `socket error: ${e?.code ?? e?.message ?? e}` });
    });
    socket.on('close', () => finish({ kind: 'no-ftp', detail: `connection closed at stage=${stage}${lastLine ? ` (last reply: ${lastLine})` : ''}` }));
    socket.on('data', (chunk: Buffer) => {
      if (settled) return;
      buf += chunk.toString('latin1');
      // An FTP reply is complete when a line starts "NNN " (multiline replies
      // use "NNN-" continuations) — keep buffering until we see one.
      let code: number | undefined;
      for (const l of buf.split(/\r?\n/)) {
        const m = l.match(/^(\d{3}) /);
        if (m) { code = parseInt(m[1], 10); lastLine = l.slice(0, 120); }
      }
      if (code === undefined) return;
      buf = '';
      if (stage === 'banner') {
        if (code !== 220) { finish({ kind: 'no-ftp', detail: `unexpected banner: ${lastLine}` }); return; }
        stage = 'user';
        socket.write('USER anonymous\r\n');
      } else if (stage === 'user') {
        if (code === 230) { finish({ kind: 'logged-in', detail: `anonymous accepted WITHOUT password: ${lastLine}` }); return; }
        if (code === 331 || code === 332) { stage = 'pass'; socket.write('PASS guest@\r\n'); return; }
        if (code >= 400) { finish({ kind: 'rejected', detail: `USER anonymous rejected (${code}): ${lastLine}` }); return; }
        finish({ kind: 'no-ftp', detail: `unexpected USER reply: ${lastLine}` });
      } else { // stage === 'pass' — this is the final, decisive reply
        if (code >= 200 && code < 300) { finish({ kind: 'logged-in', detail: `anonymous/guest@ logged in (${code}): ${lastLine}` }); return; }
        // 3xx after PASS (e.g. "need account") means anonymous was NOT
        // granted a session — that's the locked-down outcome we want, same
        // as an outright 5xx rejection.
        if (code >= 300 && code < 400) { finish({ kind: 'rejected', detail: `anonymous login not granted (${code}): ${lastLine}` }); return; }
        if (code >= 400) { finish({ kind: 'rejected', detail: `anonymous login rejected (${code}): ${lastLine}` }); return; }
        finish({ kind: 'no-ftp', detail: `unexpected PASS reply: ${lastLine}` });
      }
    });
    socket.connect(port, host);
  });
}

// Symlink the caller's picked cfg files into place on the callbox and bring
// the radio stack back up — the same bring-up Automation Suite already does,
// extracted to src/lib/labCfgLink.ts so this and that share one
// implementation. Only does anything when the run was started with a
// cfgSelection (src/app/testcases/[id]'s "Run Configuration" picker); a plain
// REST-only validation run skips this cleanly, the same way
// preflightApiResponsive skips when there's no token.
const preflightCfgBringUp: CheckDef = {
  id: 'preflight-cfg-bring-up',
  name: 'Callbox cfg bring-up',
  description: 'Symlink the selected enb/mme/ims cfg files into place on the callbox and restart lte, so the run actually exercises the chosen configuration rather than whatever was already linked.',
  phase: 'preflight', severity: 'critical',
  destructive: true,
  run: async (ctx) => {
    const base = {
      id: 'preflight-cfg-bring-up', name: 'Callbox cfg bring-up', phase: 'preflight' as Phase, severity: 'critical' as Severity,
      description: 'Symlink the selected enb/mme/ims cfg files into place on the callbox and restart lte, so the run actually exercises the chosen configuration rather than whatever was already linked.',
    };
    const sel = ctx.cfgSelection;
    if (!sel || (!sel.enb && !sel.mme && !sel.ims)) {
      return makeResult(base, 'skip', 'no cfg files selected for this run');
    }
    if (!ctx.callbox) {
      return makeResult(base, 'fail', 'no callbox bound to this Simnovator in Systems Management → Topology Setup — cannot link the selected files');
    }
    const t0 = Date.now();
    const { linkAndRestart } = await import('../labCfgLink');
    const r = await linkAndRestart(ctx.callbox, sel);
    const detail = r.steps.map((s) => `${s.step}${s.ok ? '' : ' FAILED'}: ${s.detail}`).join('; ');
    return makeResult(base, r.ok ? 'pass' : 'fail', detail, { durationMs: Date.now() - t0 });
  },
};

// SIM40-2227: the box ships an FTP service that grants anonymous login,
// exposing run artifacts/configs to anyone on the management network. This
// probe is read-only in effect (a login attempt, no STOR/DELE/RETR ever sent).
const preflightFtpAnonLocked: CheckDef = {
  id: 'preflight-ftp-anon-locked',
  name: 'FTP rejects anonymous login',
  description: 'Port 21 on the target must not grant anonymous/guest@ FTP access (final reply 230). PASS on 530/connection-refused; SKIP when no FTP service answers.',
  phase: 'preflight', severity: 'normal',
  run: async (ctx) => {
    const base = { id: 'preflight-ftp-anon-locked', name: 'FTP rejects anonymous login', phase: 'preflight' as Phase, severity: 'normal' as Severity, description: 'Port 21 on the target must not grant anonymous/guest@ FTP access (final reply 230). PASS on 530/connection-refused; SKIP when no FTP service answers.' };
    // systemHost may carry an HTTP port (host:port) — FTP always probes :21.
    const host = ctx.systemHost.split(':')[0];
    const t0 = Date.now();
    try {
      const o = await probeAnonymousFtp(host);
      const dur = Date.now() - t0;
      switch (o.kind) {
        case 'logged-in':
          return makeResult(base, 'fail', `anonymous FTP login SUCCEEDED on ${host}:21 — ${o.detail} (SIM40-2227)`, { durationMs: dur });
        case 'rejected':
        case 'refused':
          return makeResult(base, 'pass', o.detail, { durationMs: dur });
        case 'timeout':
        case 'no-ftp':
          return makeResult(base, 'skip', `no usable FTP service on ${host}:21 — ${o.detail}`, { durationMs: dur });
      }
    } catch (e: any) {
      return makeResult(base, 'skip', `FTP probe threw: ${e?.message ?? e}`, { durationMs: Date.now() - t0 });
    }
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
    // Build 4.0.0_260609 dropped the default-simulator behaviour: an empty
    // start body now returns 500 "No default simulator found". Resolve a
    // simulatorId — the testcase's last-used simulator, else the first
    // registered one.
    const simulatorId = await resolveSimulatorId(ctx);
    const r = await jsonFetch(`${apiBase(ctx.systemHost)}/testcases/${encodeURIComponent(ctx.testcaseId)}/executions`, {
      method: 'POST',
      headers: { ...authHeaders(ctx), 'Content-Type': 'application/json' },
      body: JSON.stringify(simulatorId ? { simulatorId } : {}),
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

// Cell bring-up + subscriber registration on real hardware is a mostly
// FIXED cost — it doesn't shrink just because a testcase's configured
// (traffic) duration is short. Observed live: a 131s-configured run took
// 227.3s wall-clock end to end, ~96s of which was attach/settle overhead
// unrelated to the configured traffic window. duringZombieExecution's own
// grace period independently arrived at the same ~120s figure for "how
// long attach legitimately takes" — reused here as one named constant
// instead of three separately-guessed numbers.
const ATTACH_SETTLE_MS = 120_000;

// Both during-* checks below use these helpers:
//
// Timeout for "does X eventually happen" during-checks (UE attach,
// throughput ramp-up, per-cell traffic). Previously scaled as
// configuredDuration / 3 with a 60s floor — for a 131s-configured
// testcase that's a 60s window, well under the ~120s attach/settle cost
// above, so checks gave up before the fleet had a real chance to finish
// attaching (61/64 UEs at 63s, then reported FAIL, even though all 64
// went on to attach later in the same run). Track the full configured
// duration instead of a fraction of it, floored at the settle cost.
function deriveDuringTimeoutMs(ctx: any): number {
  const configured = ctx.configuredDurationSec ?? 60;
  return Math.max(ATTACH_SETTLE_MS, Math.min(240_000, configured * 1000));
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
      // Endpoint is `/statistics/ues` (plural, no `-summary`). The
      // `/ue-summary` path 404s on build 4.0.0_260427 (verified live
      // 2026-05-14). Response: { code, message, data: { ue_data, totalUEs } }.
      // Time window MUST be in SECONDS (see statsWindowSec) and totalUEs is
      // unreliable — count attached ue_data rows.
      const n = await fetchTotalUes(ctx);
      return typeof n === 'number' && n > 0 ? n : undefined;
    }, { intervalMs: 5000, timeoutMs, isCanceled: ctx.isCanceled });
    if (!r.ok) return makeResult(base, 'fail', `no UE attached after ${(r.elapsedMs / 1000).toFixed(1)}s (poll window ${(timeoutMs / 1000).toFixed(0)}s — scaled from configuredDuration)`, { durationMs: r.elapsedMs });
    return makeResult(base, 'pass', `${r.value} UE(s) attached after ${(r.elapsedMs / 1000).toFixed(1)}s`, { durationMs: r.elapsedMs });
  },
};

// Minimum throughput a run must reach to count as PASS. Below "nonzero" —
// dl_bitrate ticking up from ramp-up noise (a few kbps) used to satisfy the
// old ">0" bar and reported PASS on traffic that never really got going.
// These are absolute floors, not the testcase's own configured target
// (userPlaneConfig.profiles[].dataBitrate) — a real QA gate rather than
// "the box did anything at all".
const DL_MIN_KBPS = 1500;
const UL_MIN_KBPS = 200;

const duringThroughputFlowing: CheckDef = {
  id: 'during-throughput-flowing',
  name: `Downlink throughput ≥ ${DL_MIN_KBPS} kbps`,
  description: `GET /v2/testcases/executions/{eid}/statistics/cells — some cell's dl_bitrate must reach ${DL_MIN_KBPS} kbps within a duration-scaled window.`,
  phase: 'during', severity: 'normal',
  run: async (ctx) => {
    const base = { id: 'during-throughput-flowing', name: `Downlink throughput ≥ ${DL_MIN_KBPS} kbps`, phase: 'during' as Phase, severity: 'normal' as Severity, description: `GET /v2/testcases/executions/{eid}/statistics/cells — some cell's dl_bitrate must reach ${DL_MIN_KBPS} kbps within a duration-scaled window.` };
    if (!ctx.token || !ctx.executionId) return makeResult(base, 'skip', 'no executionId');
    const dirs = configuredDirections(ctx.testDefinition);
    if (!dirs.dl) return makeResult(base, 'skip', 'no DL traffic configured');
    const timeoutMs = deriveDuringTimeoutMs(ctx);
    const thresholdBps = DL_MIN_KBPS * 1000;
    let peak = 0;
    const r = await pollUntil(async () => {
      // Endpoint is `/statistics/cells` (plural, no `-summary`). The
      // `/cells-summary` path returns cell CONFIG (n_rb, pci, antennas),
      // not throughput stats — verified live. Throughput field is
      // `dl_bitrate` (bps). Time window MUST be in SECONDS (see fetchCells).
      const cells = await fetchCells(ctx);
      for (const c of cells) {
        const dl = cellDl(c);
        if (typeof dl !== 'number') continue;
        if (dl > peak) peak = dl;
        if (dl >= thresholdBps) return dl;
      }
      return undefined;
    }, { intervalMs: 5000, timeoutMs, isCanceled: ctx.isCanceled });
    if (!r.ok) return makeResult(base, 'fail', `DL peaked at ${(peak / 1000).toFixed(1)} kbps after ${(r.elapsedMs / 1000).toFixed(1)}s — never reached ${DL_MIN_KBPS} kbps (poll window ${(timeoutMs / 1000).toFixed(0)}s — scaled from configuredDuration)`, { durationMs: r.elapsedMs });
    return makeResult(base, 'pass', `DL=${((r.value as number) / 1000).toFixed(1)} kbps after ${(r.elapsedMs / 1000).toFixed(1)}s (≥ ${DL_MIN_KBPS} kbps)`, { durationMs: r.elapsedMs });
  },
};

const duringUlThroughputFlowing: CheckDef = {
  id: 'during-ul-throughput-flowing',
  name: `Uplink throughput ≥ ${UL_MIN_KBPS} kbps`,
  description: `GET /v2/testcases/executions/{eid}/statistics/cells — some cell's ul_bitrate must reach ${UL_MIN_KBPS} kbps within a duration-scaled window.`,
  phase: 'during', severity: 'normal',
  run: async (ctx) => {
    const base = { id: 'during-ul-throughput-flowing', name: `Uplink throughput ≥ ${UL_MIN_KBPS} kbps`, phase: 'during' as Phase, severity: 'normal' as Severity, description: `GET /v2/testcases/executions/{eid}/statistics/cells — some cell's ul_bitrate must reach ${UL_MIN_KBPS} kbps within a duration-scaled window.` };
    if (!ctx.token || !ctx.executionId) return makeResult(base, 'skip', 'no executionId');
    const dirs = configuredDirections(ctx.testDefinition);
    if (!dirs.ul) return makeResult(base, 'skip', 'no UL traffic configured');
    const timeoutMs = deriveDuringTimeoutMs(ctx);
    const thresholdBps = UL_MIN_KBPS * 1000;
    let peak = 0;
    const r = await pollUntil(async () => {
      const cells = await fetchCells(ctx);
      for (const c of cells) {
        const ul = cellUl(c);
        if (typeof ul !== 'number') continue;
        if (ul > peak) peak = ul;
        if (ul >= thresholdBps) return ul;
      }
      return undefined;
    }, { intervalMs: 5000, timeoutMs, isCanceled: ctx.isCanceled });
    if (!r.ok) return makeResult(base, 'fail', `UL peaked at ${(peak / 1000).toFixed(1)} kbps after ${(r.elapsedMs / 1000).toFixed(1)}s — never reached ${UL_MIN_KBPS} kbps (poll window ${(timeoutMs / 1000).toFixed(0)}s — scaled from configuredDuration)`, { durationMs: r.elapsedMs });
    return makeResult(base, 'pass', `UL=${((r.value as number) / 1000).toFixed(1)} kbps after ${(r.elapsedMs / 1000).toFixed(1)}s (≥ ${UL_MIN_KBPS} kbps)`, { durationMs: r.elapsedMs });
  },
};

/** Per-cell block error rate, as /statistics/cells reports it (field: `bler`,
 *  observed live as a plain 0-based number, not a "0.0X" fraction — e.g. a
 *  reading of 0.18 means 0.18%, not 18%). */
const cellBler = (c: any) => rowNum(c, ['bler', 'BLER', 'dl_bler', 'blerDl', 'avg_dl_bler']);

/** Same ≤5% BLER tolerance the box's own PASS verdict uses. Originally this
 *  check failed on ANY nonzero sample, deliberately stricter than the box —
 *  but real RF (and the box's own simulated channel) naturally produces
 *  occasional small nonzero blips even on a healthy link, e.g. 0.18% on one
 *  sample out of dozens. That's not a quality regression, just normal
 *  measurement noise, and demanding literal zero across a whole run window
 *  just produced false failures on runs the Simnovator itself reports as
 *  fine. 5% is also the standard 3GPP link-adaptation target BLER, not a
 *  loose number picked to make failures go away. */
const BLER_MAX_PERCENT = 5;

const duringBlerZero: CheckDef = {
  id: 'during-bler-zero',
  name: `BLER stays within ${BLER_MAX_PERCENT}%`,
  description: `Samples per-cell BLER via /statistics/cells across the run window. Fails if any sample exceeds ${BLER_MAX_PERCENT}% on any cell.`,
  phase: 'during', severity: 'normal',
  run: async (ctx) => {
    const base = { id: 'during-bler-zero', name: `BLER stays within ${BLER_MAX_PERCENT}%`, phase: 'during' as Phase, severity: 'normal' as Severity, description: `Samples per-cell BLER via /statistics/cells across the run window. Fails if any sample exceeds ${BLER_MAX_PERCENT}% on any cell.` };
    if (!ctx.token || !ctx.executionId) return makeResult(base, 'skip', 'no executionId');
    const dirs = configuredDirections(ctx.testDefinition);
    if (!dirs.dl && !dirs.ul) return makeResult(base, 'skip', 'no traffic configured');
    const deadline = Math.min(duringDeadline(ctx), Date.now() + 120_000);
    const t0 = Date.now();
    let samples = 0;
    let maxBler = 0;
    let worstCell: string | undefined;
    while (Date.now() < deadline && !ctx.isCanceled()) {
      const rows = await fetchCells(ctx);
      for (const c of latestPerCell(rows)) {
        const b = cellBler(c);
        if (typeof b !== 'number') continue;
        samples++;
        if (b > maxBler) { maxBler = b; worstCell = String(c.cell ?? c.cell_id ?? c.cellId ?? '?'); }
      }
      await sleep(5000, ctx.isCanceled);
    }
    const dur = Date.now() - t0;
    if (samples === 0) return makeResult(base, 'skip', 'no BLER samples observed in window', { durationMs: dur });
    if (maxBler > BLER_MAX_PERCENT) return makeResult(base, 'fail', `BLER reached ${maxBler}% on cell ${worstCell} across ${samples} sample(s) — must stay within ${BLER_MAX_PERCENT}%`, { durationMs: dur });
    return makeResult(base, 'pass', `BLER peaked at ${maxBler}% across ${samples} sample(s) (within ${BLER_MAX_PERCENT}%)`, { durationMs: dur });
  },
};

// ── DURING — expectation-driven checks ─────────────────────────────────────
//
// These derive their thresholds from the testcase definition instead of
// hard-coding "≥ 1". Added 2026-06-11 after a QA sweep found real product
// bugs the catalogue was blind to: partial/mid-run UE deregistration at
// scale, oscillating or collapsing throughput, a dead per-cell direction
// (NSA LTE leg carrying no UL), and per-UE statistics corruption (frozen
// position, constant bogus SNR, missing VoNR KPIs).

/** Sum of configured UEs across subscriber groups. 0 = unknown. */
function expectedUeCount(td: any): number {
  const subs: any[] = td?.subsConfig?.subs ?? [];
  let total = 0;
  for (const s of subs) {
    const n = typeof s?.ueCount === 'string' ? parseInt(s.ueCount, 10) : s?.ueCount;
    if (typeof n === 'number' && n > 0) total += n;
  }
  return total;
}

/** Which traffic directions the user plane configures. */
function configuredDirections(td: any): { dl: boolean; ul: boolean } {
  const profiles: any[] = td?.userPlaneConfig?.profiles ?? [];
  let dl = false, ul = false;
  for (const p of profiles) {
    const dir = String(p?.dataDirection ?? '').toLowerCase();
    const type = String(p?.dataType ?? '').toLowerCase();
    if (!type || type === 'no data' || type === 'nodata') continue;
    if (dir === 'both' || dir === 'downlink' || !dir) dl = true;
    if (dir === 'both' || dir === 'uplink') ul = true;
    // Voice is inherently bidirectional regardless of dataDirection.
    if (/vonr|vinr|volte|vilte|voice/.test(type)) { dl = true; ul = true; }
  }
  return { dl, ul };
}

/** True when any user-plane profile is a voice (VoNR/ViNR/VoLTE) type. */
function isVoiceTest(td: any): boolean {
  const profiles: any[] = td?.userPlaneConfig?.profiles ?? [];
  return profiles.some((p) => /vonr|vinr|volte|vilte|voice/i.test(String(p?.dataType ?? '')));
}

/** Indicator that the testcase INTENTIONALLY power-cycles / detaches UEs
 *  (subscriber behaviour profiles with power-cycle, detach, or attach-detach
 *  semantics). Such tests legitimately pass through zero-UE windows, so
 *  zero-UE heuristics (zombie detection) must not judge them. Scans the
 *  subscriber config and any behaviour-profile-shaped subtrees defensively —
 *  the exact schema has moved between builds — and returns a short
 *  description of the first matching indicator, or undefined when none. */
function intentionalUeChurnIndicator(td: any): string | undefined {
  const re = /power[\s_-]?cycl|attach[\s_-]?detach|detach/i;
  const disabledRe = /^(false|0|no|none|off|disabled?)$/i;
  const scopes: Array<[string, any]> = [
    ['subsConfig', td?.subsConfig],
    ['behaviourConfig', td?.behaviourConfig],
    ['behaviorConfig', td?.behaviorConfig],
    ['ueBehaviourConfig', td?.ueBehaviourConfig],
    ['ueBehaviorConfig', td?.ueBehaviorConfig],
  ];
  const seen = new Set<any>();
  const walk = (node: any, path: string, depth: number): string | undefined => {
    if (!node || typeof node !== 'object' || depth > 6 || seen.has(node)) return undefined;
    seen.add(node);
    const entries = Array.isArray(node) ? node.map((v, i) => [String(i), v] as const) : Object.entries(node);
    for (const [k, v] of entries) {
      if (typeof v === 'string' && re.test(v)) return `${path}${k}="${v.slice(0, 60)}"`;
      if (re.test(k)) {
        const enabled = v === true
          || (typeof v === 'number' && v > 0)
          || (typeof v === 'string' && v.trim() !== '' && !disabledRe.test(v.trim()))
          || (v !== null && typeof v === 'object');
        if (enabled) return `${path}${k}`;
      }
      if (v && typeof v === 'object') {
        const hit = walk(v, `${path}${k}.`, depth + 1);
        if (hit) return hit;
      }
    }
    return undefined;
  };
  for (const [name, scope] of scopes) {
    const hit = walk(scope, `${name}.`, 0);
    if (hit) return hit;
  }
  return undefined;
}

/** True when the testcase configures actual UE movement (not stationary). */
function hasMobility(td: any): boolean {
  const profiles: any[] = td?.mobilityConfig?.profiles ?? [];
  return profiles.some((p) => {
    const trip = String(p?.tripType ?? '').toLowerCase();
    const speed = typeof p?.speed === 'string' ? parseFloat(p.speed) : p?.speed;
    return (trip && trip !== 'stationary' && trip !== 'none') || (typeof speed === 'number' && speed > 0);
  });
}

/** First numeric field among candidate names on a stats row. */
function rowNum(row: any, names: string[]): number | undefined {
  for (const n of names) {
    const v = row?.[n];
    const num = typeof v === 'string' ? parseFloat(v) : v;
    if (typeof num === 'number' && Number.isFinite(num)) return num;
  }
  return undefined;
}

/** Pull the per-UE rows out of /statistics/ues regardless of envelope shape. */
function ueRowsOf(body: any): any[] {
  const d = body?.data ?? body;
  if (Array.isArray(d?.ue_data)) return d.ue_data;
  if (Array.isArray(d?.ues)) return d.ues;
  if (Array.isArray(d?.items)) return d.items;
  if (Array.isArray(d)) return d;
  if (d && typeof d === 'object') {
    for (const v of Object.values(d)) if (Array.isArray(v) && v.length && typeof v[0] === 'object') return v as any[];
  }
  return [];
}

/** Sortable timestamp of a stats row. Accepts epoch numbers (seconds or
 *  millis — only relative ordering matters), numeric strings, or ISO dates. */
function rowUtc(row: any): number {
  const v = row?.utc ?? row?.timestamp ?? row?.time;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    if (/^\d+(\.\d+)?$/.test(v.trim())) return parseFloat(v);
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  return 0;
}

/** Collapse the /statistics/ues TIME SERIES to the newest row per UE.
 *
 *  ue_data carries one row PER UE PER SAMPLE (verified live on 4.0.0_260609:
 *  64 UEs × 16 samples = 1024 rows). Counting raw rows therefore over-counts
 *  by the sample factor the moment UEs attach — 1024 ≥ expected 64 passes
 *  trivially and MASKS partial attach, mid-run drops, and stuck teardown.
 *  Every consumer that reasons about "current UE state" must go through this
 *  dedupe first. Ties / missing utc keep the later row (rows arrive in
 *  chronological order). Rows with no UE identity at all are kept verbatim
 *  rather than collapsed into one bogus bucket. */
function latestPerUe(rows: any[]): any[] {
  const byUe = new Map<string, any>();
  const keyless: any[] = [];
  for (const r of rows) {
    const rawKey = r?.ue_id ?? r?.ueId ?? r?.imsi ?? r?.id;
    if (rawKey === undefined || rawKey === null || rawKey === '') { keyless.push(r); continue; }
    const key = String(rawKey);
    const prev = byUe.get(key);
    if (!prev || rowUtc(r) >= rowUtc(prev)) byUe.set(key, r);
  }
  return [...byUe.values(), ...keyless];
}

/** Like latestPerUe, but prefers each UE's newest row WHILE ATTACHED over its
 *  absolute newest row. A window that runs even a few seconds into teardown
 *  otherwise makes "newest row" the disconnected one for every UE, which
 *  reads as "nothing was ever attached" regardless of how the test actually
 *  went. Falls back to the newest row overall for a UE that was never seen
 *  attached, so it still shows up (correctly, as unattached) rather than
 *  vanishing from the set. Requires ueAttached (defined above). */
function latestAttachedPerUe(rows: any[]): any[] {
  const byUeAttached = new Map<string, any>();
  const byUeAny = new Map<string, any>();
  const keyless: any[] = [];
  for (const r of rows) {
    const rawKey = r?.ue_id ?? r?.ueId ?? r?.imsi ?? r?.id;
    if (rawKey === undefined || rawKey === null || rawKey === '') { keyless.push(r); continue; }
    const key = String(rawKey);
    const prevAny = byUeAny.get(key);
    if (!prevAny || rowUtc(r) >= rowUtc(prevAny)) byUeAny.set(key, r);
    if (ueAttached(r)) {
      const prevAttached = byUeAttached.get(key);
      if (!prevAttached || rowUtc(r) >= rowUtc(prevAttached)) byUeAttached.set(key, r);
    }
  }
  const out: any[] = [];
  for (const key of byUeAny.keys()) out.push(byUeAttached.get(key) ?? byUeAny.get(key));
  return [...out, ...keyless];
}

/** Statistics time window, in SECONDS. The box's statistics endpoints expect
 *  epoch *seconds* for startTime/endTime — passing milliseconds (Date.now())
 *  lands the window ~50,000 years in the future, so every query silently
 *  returns empty (ue_data:null, totalUEs:0). Verified live on 4.0.0_260609:
 *  the same eid returns 64 UE rows + 9 cells with a seconds window and null
 *  with a millis one. lookbackSec controls how far back the window reaches. */
function statsWindowSec(lookbackSec = 120): { start: number; end: number } {
  const end = Math.floor(Date.now() / 1000);
  return { start: end - lookbackSec, end };
}

/** A UE row is "attached" when it is registered/connected (not torn down).
 *  Note "disconnected" contains the substring "connect", so test for
 *  "disconnect" first. Falls back to row presence when no state fields exist. */
function ueAttached(row: any): boolean {
  const rrc = String(row?.rrc_state ?? '').toLowerCase();
  const emm = String(row?.emm_state ?? '').toLowerCase();
  if (rrc) return rrc.includes('connect') && !rrc.includes('disconnect');
  if (emm) return (emm.includes('regist') && !emm.includes('dereg')) || emm.includes('power on');
  return true;
}

/** Count of attached UEs right now. The `totalUEs` scalar is unreliable
 *  (reads 0 even when ue_data carries 64 real rows — verified live), so we
 *  count attached UEs from ue_data instead — deduped to the newest row per
 *  ue_id FIRST, because ue_data is a time series (one row per UE per sample;
 *  counting raw rows would over-count by the sample factor and trivially
 *  satisfy any "all N UEs attached" threshold — see latestPerUe). */
async function fetchTotalUes(ctx: RunCtx): Promise<number | undefined> {
  const { start, end } = statsWindowSec(120);
  const f = await jsonFetch(`${apiBase(ctx.systemHost)}/testcases/executions/${encodeURIComponent(ctx.executionId!)}/statistics/ues?startTime=${start}&endTime=${end}`, { headers: authHeaders(ctx) });
  if (f.status !== 200) return undefined;
  const rows = ueRowsOf(f.body);
  if (!rows.length) return undefined;
  return latestPerUe(rows).filter(ueAttached).length;
}

async function fetchCells(ctx: RunCtx): Promise<any[]> {
  const { start, end } = statsWindowSec(120);
  const f = await jsonFetch(`${apiBase(ctx.systemHost)}/testcases/executions/${encodeURIComponent(ctx.executionId!)}/statistics/cells?startTime=${start}&endTime=${end}`, { headers: authHeaders(ctx) });
  if (f.status !== 200) return [];
  return Array.isArray(f.body?.data?.cells) ? f.body.data.cells
    : Array.isArray(f.body?.cells) ? f.body.cells
    : Array.isArray(f.body?.items) ? f.body.items
    : Array.isArray(f.body) ? f.body : [];
}

const cellDl = (c: any) => rowNum(c, ['dl_throughput', 'dlThroughput', 'dl_bitrate', 'dl', 'downlinkThroughput']) ?? 0;
const cellUl = (c: any) => rowNum(c, ['ul_throughput', 'ulThroughput', 'ul_bitrate', 'ul', 'uplinkThroughput']) ?? 0;

/** Collapse the /statistics/cells TIME SERIES to the newest row per cell.
 *
 *  /statistics/cells — exactly like /statistics/ues — returns one row PER
 *  CELL PER SAMPLE (one per second). Any consumer reasoning about the
 *  "current" per-cell state must dedupe to the newest row per cell first
 *  (key: row.cell, keep max utc), mirroring latestPerUe. Ties / missing utc
 *  keep the later row (rows arrive in chronological order); rows with no
 *  cell identity are kept verbatim rather than collapsed into one bucket. */
function latestPerCell(rows: any[]): any[] {
  const byCell = new Map<string, any>();
  const keyless: any[] = [];
  for (const r of rows) {
    const rawKey = r?.cell ?? r?.cell_id ?? r?.cellId;
    if (rawKey === undefined || rawKey === null || rawKey === '') { keyless.push(r); continue; }
    const key = String(rawKey);
    const prev = byCell.get(key);
    if (!prev || rowUtc(r) >= rowUtc(prev)) byCell.set(key, r);
  }
  return [...byCell.values(), ...keyless];
}

/** AUTHORITATIVE attach counts: /statistics/global → data.ue_state_summary
 *  { globalNas:{registered,...,deregistered}, globalRrc:{connected,idle,...},
 *  perCell:{...} }. Verified live on 4.0.0_260609. Window in SECONDS. */
async function fetchUeStateSummary(ctx: RunCtx): Promise<any | undefined> {
  const { start, end } = statsWindowSec(120);
  const f = await jsonFetch(`${apiBase(ctx.systemHost)}/testcases/executions/${encodeURIComponent(ctx.executionId!)}/statistics/global?startTime=${start}&endTime=${end}`, { headers: authHeaders(ctx) });
  if (f.status !== 200) return undefined;
  const sum = f.body?.data?.ue_state_summary ?? f.body?.ue_state_summary;
  return sum && typeof sum === 'object' ? sum : undefined;
}

/** Parse executionTimeCompleted-style values defensively: plain numbers,
 *  numeric strings, or "HH:MM:SS"/"MM:SS" clocks. Only relative ordering
 *  matters (we ask "is it advancing?"), so unit ambiguity is harmless. */
function parseDurationish(v: any): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const hms = v.trim().match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
    if (hms) {
      const a = parseInt(hms[1], 10), b = parseInt(hms[2], 10);
      return hms[3] ? a * 3600 + b * 60 + parseInt(hms[3], 10) : a * 60 + b;
    }
    const n = parseFloat(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** End of the safe DURING sampling window (avoid colliding with teardown). */
function duringDeadline(ctx: RunCtx): number {
  if (ctx.triggeredAt && ctx.configuredDurationSec) return ctx.triggeredAt + ctx.configuredDurationSec * 1000 * 0.85;
  return Date.now() + 90_000;
}

const duringAllUesAttach: CheckDef = {
  id: 'during-all-ues-attach',
  name: 'ALL configured UEs attach',
  description: 'totalUEs reaches the ueCount configured in the testcase (not just ≥ 1). Catches partial attach at scale.',
  phase: 'during', severity: 'normal',
  run: async (ctx) => {
    const base = { id: 'during-all-ues-attach', name: 'ALL configured UEs attach', phase: 'during' as Phase, severity: 'normal' as Severity, description: 'totalUEs reaches the ueCount configured in the testcase (not just ≥ 1). Catches partial attach at scale.' };
    if (!ctx.token || !ctx.executionId) return makeResult(base, 'skip', 'no executionId');
    const expected = expectedUeCount(ctx.testDefinition);
    if (!expected) return makeResult(base, 'skip', 'ueCount not derivable from testDefinition');
    const timeoutMs = deriveDuringTimeoutMs(ctx);
    let maxSeen = 0;
    const r = await pollUntil(async () => {
      const n = await fetchTotalUes(ctx);
      if (typeof n === 'number') { maxSeen = Math.max(maxSeen, n); if (n >= expected) return n; }
      return undefined;
    }, { intervalMs: 5000, timeoutMs, isCanceled: ctx.isCanceled });
    if (!r.ok) return makeResult(base, 'fail', `only ${maxSeen}/${expected} UEs attached after ${(r.elapsedMs / 1000).toFixed(0)}s — partial attach`, { durationMs: r.elapsedMs });
    return makeResult(base, 'pass', `${r.value}/${expected} UEs attached after ${(r.elapsedMs / 1000).toFixed(1)}s`, { durationMs: r.elapsedMs });
  },
};

const duringUeStability: CheckDef = {
  id: 'during-ue-count-stable',
  name: 'No UEs drop out mid-run',
  description: 'Samples totalUEs through the run window; the count must never fall below its peak (silent mid-run deregistration).',
  phase: 'during', severity: 'normal',
  run: async (ctx) => {
    const base = { id: 'during-ue-count-stable', name: 'No UEs drop out mid-run', phase: 'during' as Phase, severity: 'normal' as Severity, description: 'Samples totalUEs through the run window; the count must never fall below its peak (silent mid-run deregistration).' };
    if (!ctx.token || !ctx.executionId) return makeResult(base, 'skip', 'no executionId');
    const deadline = Math.min(duringDeadline(ctx), Date.now() + 120_000);
    if (deadline - Date.now() < 15_000) return makeResult(base, 'skip', 'run too short to sample UE-count stability');
    const t0 = Date.now();
    let peak = 0; let minAfterPeak = Infinity; let samples = 0;
    while (Date.now() < deadline && !ctx.isCanceled()) {
      const n = await fetchTotalUes(ctx);
      if (typeof n === 'number') {
        samples++;
        if (n > peak) peak = n;
        else if (peak > 0 && n < peak) minAfterPeak = Math.min(minAfterPeak, n);
      }
      await sleep(8000, ctx.isCanceled);
    }
    const dur = Date.now() - t0;
    if (samples < 2 || peak === 0) return makeResult(base, 'skip', `not enough UE-count samples (${samples}) to judge stability`, { durationMs: dur });
    if (minAfterPeak < peak) {
      return makeResult(base, 'fail', `UE count dropped from peak ${peak} to ${minAfterPeak} mid-run (${peak - minAfterPeak} UE(s) silently deregistered)`, { durationMs: dur });
    }
    return makeResult(base, 'pass', `UE count held at peak ${peak} across ${samples} samples (${(dur / 1000).toFixed(0)}s window)`, { durationMs: dur });
  },
};

const duringThroughputStability: CheckDef = {
  id: 'during-throughput-stability',
  name: 'DL throughput is stable (not just nonzero)',
  description: 'Samples total DL throughput; after ramp-up, the minimum must stay ≥ 40% of the established mean and variation must be bounded. Catches oscillation and mid-run collapse.',
  phase: 'during', severity: 'normal',
  run: async (ctx) => {
    const base = { id: 'during-throughput-stability', name: 'DL throughput is stable (not just nonzero)', phase: 'during' as Phase, severity: 'normal' as Severity, description: 'Samples total DL throughput; after ramp-up, the minimum must stay ≥ 40% of the established mean and variation must be bounded. Catches oscillation and mid-run collapse.' };
    if (!ctx.token || !ctx.executionId) return makeResult(base, 'skip', 'no executionId');
    const dirs = configuredDirections(ctx.testDefinition);
    if (!dirs.dl) return makeResult(base, 'skip', 'no DL traffic configured');
    const deadline = Math.min(duringDeadline(ctx), Date.now() + 120_000);
    const t0 = Date.now();
    const series: number[] = [];
    while (Date.now() < deadline && !ctx.isCanceled()) {
      // /statistics/cells is a time series: summing every row in the 120s
      // window would inflate the sample with the row count (cells × seconds
      // of history). Each poll's sample is the sum of dl over the LATEST
      // row per cell — the actual instantaneous aggregate.
      const rows = await fetchCells(ctx);
      if (rows.length) series.push(latestPerCell(rows).reduce((a, c) => a + cellDl(c), 0));
      await sleep(5000, ctx.isCanceled);
    }
    const dur = Date.now() - t0;
    const max = Math.max(0, ...series);
    if (max <= 0) return makeResult(base, 'skip', `no DL throughput observed in window (${series.length} samples) — covered by during-throughput-flowing`, { durationMs: dur });
    // Drop the ramp: established = samples from the first one ≥ 50% of max.
    const startIdx = series.findIndex((v) => v >= max * 0.5);
    const est = series.slice(startIdx);
    if (est.length < 5) return makeResult(base, 'skip', `window too short after ramp-up (${est.length} established samples)`, { durationMs: dur });
    const mean = est.reduce((a, b) => a + b, 0) / est.length;
    const min = Math.min(...est);
    const sd = Math.sqrt(est.reduce((a, b) => a + (b - mean) ** 2, 0) / est.length);
    const cv = mean > 0 ? sd / mean : 0;
    const fmt = (v: number) => v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(0)}k` : v.toFixed(0);
    const summary = `mean=${fmt(mean)} min=${fmt(min)} (${((min / mean) * 100).toFixed(0)}% of mean) cv=${cv.toFixed(2)} over ${est.length} samples`;
    if (min < mean * 0.4 || cv > 0.4) {
      return makeResult(base, 'fail', `DL throughput unstable: ${summary} — drops/oscillation beyond tolerance`, { durationMs: dur });
    }
    return makeResult(base, 'pass', `DL stable: ${summary}`, { durationMs: dur });
  },
};

const duringPerCellTraffic: CheckDef = {
  id: 'during-per-cell-traffic',
  name: 'Every cell carries the configured traffic directions',
  description: 'Each cell must show nonzero throughput in every configured direction, and no cell may sit below 2% of the busiest cell. Catches a dead per-cell direction (e.g. an NSA LTE leg with no UL).',
  phase: 'during', severity: 'normal',
  run: async (ctx) => {
    const base = { id: 'during-per-cell-traffic', name: 'Every cell carries the configured traffic directions', phase: 'during' as Phase, severity: 'normal' as Severity, description: 'Each cell must show nonzero throughput in every configured direction, and no cell may sit below 2% of the busiest cell. Catches a dead per-cell direction (e.g. an NSA LTE leg with no UL).' };
    if (!ctx.token || !ctx.executionId) return makeResult(base, 'skip', 'no executionId');
    const dirs = configuredDirections(ctx.testDefinition);
    if (!dirs.dl && !dirs.ul) return makeResult(base, 'skip', 'no traffic configured');
    const timeoutMs = deriveDuringTimeoutMs(ctx);
    // Wait until traffic is established somewhere, then judge the per-cell split.
    const r = await pollUntil(async () => {
      // /statistics/cells is a TIME SERIES (one row per cell per second) —
      // judge the LATEST snapshot per cell, not every historical row, or
      // ramp-up zeros in the window flag perfectly healthy cells.
      const rows = await fetchCells(ctx);
      if (!rows.length) return undefined;
      const latest = latestPerCell(rows);
      const anyTraffic = latest.some((c) => (dirs.dl && cellDl(c) > 0) || (dirs.ul && cellUl(c) > 0));
      return anyTraffic ? latest : undefined;
    }, { intervalMs: 5000, timeoutMs, isCanceled: ctx.isCanceled });
    if (!r.ok) return makeResult(base, 'skip', 'no traffic observed on any cell in window — covered by during-throughput-flowing', { durationMs: r.elapsedMs });
    const cells = r.value as any[];
    const problems: string[] = [];
    for (const [label, want, get] of [['DL', dirs.dl, cellDl], ['UL', dirs.ul, cellUl]] as const) {
      if (!want) continue;
      const vals = cells.map((c, i) => ({ i, v: get(c) }));
      const busiest = Math.max(...vals.map((x) => x.v));
      if (busiest <= 0) { problems.push(`${label}: zero on ALL ${cells.length} cell(s) despite being configured`); continue; }
      for (const { i, v } of vals) {
        if (v <= 0) problems.push(`${label}: cell ${i} carries none (busiest cell at ${busiest.toFixed(0)})`);
        else if (v < busiest * 0.02) problems.push(`${label}: cell ${i} at ${((v / busiest) * 100).toFixed(1)}% of busiest — effectively dead`);
      }
    }
    const dirStr = [dirs.dl ? 'DL' : '', dirs.ul ? 'UL' : ''].filter(Boolean).join('+');
    if (problems.length) return makeResult(base, 'fail', `${problems.length} per-cell traffic problem(s) [${dirStr} configured]: ${problems.slice(0, 4).join('; ')}`, { durationMs: r.elapsedMs });
    return makeResult(base, 'pass', `all ${cells.length} cell(s) carry ${dirStr} within tolerance`, { durationMs: r.elapsedMs });
  },
};

// SIM40-2303 / SIM40-2309 / SIM40-2310 / SIM40-2305: the box's three stats
// surfaces (global NAS summary, global RRC summary, per-cell throughput) can
// drift into mutually impossible states — NAS reporting deregistrations while
// RRC still shows the full configured fleet connected, or RRC claiming
// connected UEs while no cell carries a single bit of configured traffic.
const duringStatsConsistency: CheckDef = {
  id: 'during-stats-consistency',
  name: 'Global UE-state summary is self-consistent',
  description: 'Samples /statistics/global ue_state_summary through the run window: NAS deregistrations must not coexist with a full RRC-connected fleet, and connected UEs with traffic configured must show nonzero cell throughput.',
  phase: 'during', severity: 'normal',
  run: async (ctx) => {
    const base = { id: 'during-stats-consistency', name: 'Global UE-state summary is self-consistent', phase: 'during' as Phase, severity: 'normal' as Severity, description: 'Samples /statistics/global ue_state_summary through the run window: NAS deregistrations must not coexist with a full RRC-connected fleet, and connected UEs with traffic configured must show nonzero cell throughput.' };
    if (!ctx.token || !ctx.executionId) return makeResult(base, 'skip', 'no executionId');
    // No upfront "is there enough time" estimate — a short testcase still gets
    // whatever samples fit in whatever window remains, down to a single one.
    // The only real skip condition is having gathered literally zero samples
    // (checked after the loop), not a guess made before trying.
    const deadline = Math.min(duringDeadline(ctx), Date.now() + 120_000);
    const expected = expectedUeCount(ctx.testDefinition);
    const dirs = configuredDirections(ctx.testDefinition);
    const trafficConfigured = dirs.dl || dirs.ul;
    const t0 = Date.now();
    let samples = 0;
    let cellSamples = 0;
    let maxConnected = 0;
    let sawCellTraffic = false;
    let contradiction: string | undefined;
    // Streak of CONSECUTIVE contradictory samples (mirrors the
    // during-zombie-execution streak). A single dereg>0-while-
    // connected==expected sample can be a legitimate transient — e.g. a UE
    // deregistering and re-attaching between the two counters' sample
    // points — so only ≥2 consecutive contradictory samples fail.
    let contradictionStreak = 0;
    while (Date.now() < deadline && !ctx.isCanceled()) {
      const sum = await fetchUeStateSummary(ctx);
      if (sum) {
        samples++;
        const dereg = rowNum(sum.globalNas ?? {}, ['deregistered']) ?? 0;
        const connected = rowNum(sum.globalRrc ?? {}, ['connected']) ?? 0;
        maxConnected = Math.max(maxConnected, connected);
        // (a) NAS says UEs left while RRC still equals the configured fleet —
        //     both cannot be true at once (SIM40-2303/2309/2310).
        if (expected > 0 && dereg > 0 && connected === expected) {
          contradictionStreak++;
          if (contradictionStreak >= 2) {
            contradiction = `globalNas.deregistered=${dereg} while globalRrc.connected=${connected} still equals configured ueCount=${expected} (${contradictionStreak} consecutive samples)`;
            break;
          }
        } else {
          contradictionStreak = 0;
        }
      }
      if (trafficConfigured) {
        const cells = await fetchCells(ctx);
        if (cells.length) {
          cellSamples++;
          if (cells.some((c) => cellDl(c) + cellUl(c) > 0)) sawCellTraffic = true;
        }
      }
      // Never sleep past the deadline — a short window still gets exactly the
      // samples it has room for instead of the loop overshooting into a check
      // that was supposed to stay bounded.
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(10_000, remaining), ctx.isCanceled);
    }
    const dur = Date.now() - t0;
    if (contradiction) return makeResult(base, 'fail', `state-summary contradiction: ${contradiction}`, { durationMs: dur });
    // (b) UEs RRC-connected, traffic configured, yet EVERY cell sample in the
    //     window carried 0 dl+ul — connected fleet with no data path
    //     (SIM40-2305). Require ≥2 cell samples so one unlucky read can't fail.
    if (trafficConfigured && maxConnected > 0 && cellSamples >= 2 && !sawCellTraffic) {
      return makeResult(base, 'fail', `globalRrc.connected reached ${maxConnected} but all ${cellSamples} /statistics/cells samples showed 0 dl_bitrate+ul_bitrate with traffic configured — UEs connected but no data path`, { durationMs: dur });
    }
    if (samples === 0) return makeResult(base, 'skip', 'no ue_state_summary samples available in window', { durationMs: dur });
    return makeResult(base, 'pass', `${samples} ue_state_summary sample(s) self-consistent (peak connected=${maxConnected}${trafficConfigured ? `, cell traffic ${sawCellTraffic ? 'seen' : 'not seen'} across ${cellSamples} sample(s)` : ''})`, { durationMs: dur });
  },
};

// SIM40-1122 / SIM40-2218-class: "zombie" executions — current/status keeps
// reporting IN_PROGRESS with the progress clock advancing while the UE fleet
// is GONE (registered=0 AND connected=0). This is exactly the 2026-06-11 lab
// outage signature: a dead service under a live progress bar, runs that then
// auto-PASS empty ("No success criteria configured - auto pass").
const duringZombieExecution: CheckDef = {
  id: 'during-zombie-execution',
  name: 'Progress only advances while UEs exist',
  description: 'After a 120s attach grace, executions/current/status must not keep advancing executionTimeCompleted while ue_state_summary shows registered=0 and connected=0 for 4+ consecutive ~10s samples.',
  phase: 'during', severity: 'normal',
  run: async (ctx) => {
    const base = { id: 'during-zombie-execution', name: 'Progress only advances while UEs exist', phase: 'during' as Phase, severity: 'normal' as Severity, description: 'After a 120s attach grace, executions/current/status must not keep advancing executionTimeCompleted while ue_state_summary shows registered=0 and connected=0 for 4+ consecutive ~10s samples.' };
    if (!ctx.token || !ctx.executionId) return makeResult(base, 'skip', 'no executionId');
    // Tests that intentionally power-cycle / detach UEs pass through
    // legitimate zero-UE windows mid-run — the zombie signature
    // (IN_PROGRESS + advancing clock + zero UEs) is expected there, not a
    // dead service.
    const churn = intentionalUeChurnIndicator(ctx.testDefinition);
    if (churn) return makeResult(base, 'skip', `testcase configures intentional UE power-cycling/detach (${churn}) — zero-UE windows are expected, zombie heuristic not applicable`);
    const simulatorId = await resolveSimulatorId(ctx);
    if (!simulatorId) return makeResult(base, 'skip', 'no simulatorId resolvable — cannot query current/status');
    // Grace: UEs legitimately take a while to attach after trigger. Only
    // samples taken ≥ATTACH_SETTLE_MS after the trigger count toward the
    // zombie verdict. No upfront "is there room for 4 samples" estimate —
    // try, and take however many actually fit. A testcase shorter than the
    // grace period will legitimately end before any sample is possible;
    // that surfaces honestly below as "execution already finished" / "no
    // usable samples", not as a guess made before attempting anything.
    const graceEnd = (ctx.triggeredAt ?? Date.now()) + ATTACH_SETTLE_MS;
    const deadline = Math.min(duringDeadline(ctx), Date.now() + 180_000);
    const t0 = Date.now();
    // Never sleep past the deadline chasing a grace period the run won't live
    // to see — clamp so a short test fails fast into the loop's own verdict
    // instead of blocking for up to 120s for nothing.
    const graceSleep = Math.min(graceEnd, deadline) - Date.now();
    if (graceSleep > 0) await sleep(graceSleep, ctx.isCanceled);
    let samples = 0;
    let executionEnded = false;
    // Streak of consecutive zero-UE samples, with the progress clock at each.
    let streak: number[] = [];
    while (Date.now() < deadline && !ctx.isCanceled()) {
      const cur = await jsonFetch(`${apiBase(ctx.systemHost)}/testcases/executions/current/status?simulatorId=${encodeURIComponent(simulatorId)}`, { headers: authHeaders(ctx) });
      if (cur.status === 404) { executionEnded = true; break; } // idle — run finished, not a zombie
      const status = String(cur.body?.status ?? '').toUpperCase();
      const completed = parseDurationish(cur.body?.executionTimeCompleted);
      if (cur.status === 200 && status === 'IN_PROGRESS' && completed !== undefined) {
        const sum = await fetchUeStateSummary(ctx);
        if (sum) {
          samples++;
          const registered = rowNum(sum.globalNas ?? {}, ['registered']) ?? 0;
          const connected = rowNum(sum.globalRrc ?? {}, ['connected']) ?? 0;
          if (registered === 0 && connected === 0) {
            streak.push(completed);
            if (streak.length >= 4 && streak[streak.length - 1] > streak[0]) {
              return makeResult(base, 'fail',
                `execution advancing with zero UEs — service likely dead under a live progress bar: ${streak.length} consecutive samples with registered=0/connected=0 while status stayed IN_PROGRESS and executionTimeCompleted advanced ${streak[0]} → ${streak[streak.length - 1]}`,
                { durationMs: Date.now() - t0 });
            }
          } else {
            streak = [];
          }
        }
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(10_000, remaining), ctx.isCanceled);
    }
    const dur = Date.now() - t0;
    if (samples === 0) {
      return makeResult(base, 'skip', executionEnded ? 'execution already finished before any post-grace sample' : 'no usable status+summary samples in window', { durationMs: dur });
    }
    return makeResult(base, 'pass', `no zombie signature across ${samples} post-grace sample(s)${executionEnded ? ' (execution ended during sampling)' : ''}`, { durationMs: dur });
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
    // configuredDurationSec is the TRAFFIC window, not the full wall-clock
    // run — cell bring-up + subscriber registration adds a mostly-fixed
    // ~120s (ATTACH_SETTLE_MS) on top before traffic even starts, which a
    // flat 30s of slack didn't cover (live: 131s configured measured
    // 227.3s observed, a legitimate run flagged as a false failure). That
    // fixed cost is a much bigger fraction of a short test than a long
    // one, hence additive slack rather than a bigger multiplier.
    const hi = configured * 1.2 + ATTACH_SETTLE_MS / 1000;
    if (observedSec >= lo && observedSec <= hi) {
      return makeResult(base, 'pass', `observed=${observedSec.toFixed(1)}s configured=${configured}s (within ±20% + ${(ATTACH_SETTLE_MS / 1000).toFixed(0)}s slack)`);
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

// SIM40-1585: teardown leaves UEs behind — the run reaches a terminal status
// but the newest per-UE sample still shows RRC-connected / registered UEs
// instead of everyone powered off. Polls with a 30s grace so a teardown
// sample that simply hasn't landed yet doesn't false-fail.
const postAllUesPowerOff: CheckDef = {
  id: 'post-all-ues-power-off',
  name: 'All UEs powered off after the run',
  description: 'After terminal status, the latest /statistics/ues sample per UE (last ~60s of the run, 30s grace) must show every UE powered off / not RRC-connected.',
  phase: 'post', severity: 'normal',
  run: async (ctx) => {
    const base = { id: 'post-all-ues-power-off', name: 'All UEs powered off after the run', phase: 'post' as Phase, severity: 'normal' as Severity, description: 'After terminal status, the latest /statistics/ues sample per UE (last ~60s of the run, 30s grace) must show every UE powered off / not RRC-connected.' };
    if (!ctx.token || !ctx.executionId) return makeResult(base, 'skip', 'no executionId');
    // A UE is "still up" only when its state fields say so. Rows with no
    // state fields at all don't count — we never claim a leak we can't see.
    const stillUp = (row: any): boolean => {
      const rrc = String(row?.rrc_state ?? '').toLowerCase();
      const emm = String(row?.emm_state ?? '').toLowerCase();
      if (rrc) return rrc.includes('connect') && !rrc.includes('disconnect');
      if (emm) return emm.includes('regist') && !emm.includes('dereg') && !emm.includes('power off');
      return false;
    };
    let sawRows = false;
    let sawPostTerminal = false;
    let lastUp: any[] = [];
    let lastTotal = 0;
    // Freshest sample seen regardless of the post-terminal guard, so a run
    // that never produces one can still be judged instead of skipped — see
    // below. On a short testcase the box can stop writing UE stats within a
    // couple of seconds of the run ending, before our own terminal-status
    // poll (5s cadence) even notices; requiring a sample strictly AFTER that
    // detection was skipping runs that had perfectly good teardown evidence.
    let bestUtc = -Infinity;
    let bestUp: any[] = [];
    let bestTotal = 0;
    // Normalize a row timestamp to epoch SECONDS — rowUtc may yield epoch
    // seconds, epoch millis, or Date.parse millis depending on field shape.
    const rowUtcSec = (row: any): number => {
      const v = rowUtc(row);
      return v >= 1e11 ? v / 1000 : v;
    };
    const finishedSec = (ctx.finishedAt ?? Date.now()) / 1000;
    // Window in SECONDS: from ~60s before the run finished up to "now", so it
    // always contains the final teardown samples. Re-polled for up to 30s of
    // grace in case the powered-off sample lags the terminal status.
    const r = await pollUntil(async () => {
      const startSec = Math.floor((ctx.finishedAt ?? Date.now()) / 1000) - 60;
      const endSec = Math.floor(Date.now() / 1000);
      const f = await jsonFetch(`${apiBase(ctx.systemHost)}/testcases/executions/${encodeURIComponent(ctx.executionId!)}/statistics/ues?startTime=${startSec}&endTime=${endSec}`, { headers: authHeaders(ctx) }, 30_000);
      if (f.status !== 200) return undefined;
      const rows = ueRowsOf(f.body);
      if (!rows.length) return undefined;
      sawRows = true;
      const maxUtc = Math.max(...rows.map(rowUtcSec));
      const latest = latestPerUe(rows); // time series → newest row per UE
      const up = latest.filter(stillUp);
      if (maxUtc > bestUtc) { bestUtc = maxUtc; bestUp = up; bestTotal = latest.length; }
      // Prefer a sample strictly at/after the terminal status when one shows
      // up (5s tolerance) — cleanest evidence. Keep polling for it briefly,
      // but the freshest-seen fallback above means a timeout is never a dead
      // end.
      if (maxUtc < finishedSec - 5) return undefined;
      sawPostTerminal = true;
      lastTotal = latest.length;
      lastUp = up;
      return lastUp.length === 0 ? latest.length : undefined;
    }, { intervalMs: 5000, timeoutMs: 30_000, isCanceled: ctx.isCanceled });
    if (r.ok) return makeResult(base, 'pass', `all ${r.value} UE(s) powered off / disconnected after ${(r.elapsedMs / 1000).toFixed(1)}s`, { durationMs: r.elapsedMs });
    if (!sawRows) return makeResult(base, 'skip', 'no per-UE rows in the final window — nothing to judge', { durationMs: r.elapsedMs });
    if (sawPostTerminal) {
      const ids = lastUp.slice(0, 8).map((u) => String(u?.ue_id ?? u?.imsi ?? '?'));
      return makeResult(base, 'fail', `${lastUp.length} of ${lastTotal} UE(s) still connected/registered ${(r.elapsedMs / 1000).toFixed(0)}s after terminal status (ue_id: ${ids.join(', ')}${lastUp.length > ids.length ? ', …' : ''}) — teardown did not power them off`, { durationMs: r.elapsedMs });
    }
    // No sample ever landed strictly post-terminal — judge the freshest one we
    // DID get rather than skip. Per-UE power state does not spontaneously
    // flip back to connected, so a reading a few seconds stale is still real
    // evidence either way.
    const staleness = (finishedSec - bestUtc).toFixed(1);
    if (bestTotal === 0) return makeResult(base, 'skip', 'no per-UE rows in the final window — nothing to judge', { durationMs: r.elapsedMs });
    if (bestUp.length === 0) {
      return makeResult(base, 'pass', `all ${bestTotal} UE(s) powered off / disconnected (freshest sample ${staleness}s before terminal status — box stopped writing stats around teardown)`, { durationMs: r.elapsedMs });
    }
    const ids = bestUp.slice(0, 8).map((u) => String(u?.ue_id ?? u?.imsi ?? '?'));
    return makeResult(base, 'fail', `${bestUp.length} of ${bestTotal} UE(s) still connected/registered in the freshest available sample (${staleness}s before terminal status; no fresher sample was ever written) — teardown did not power them off (ue_id: ${ids.join(', ')}${bestUp.length > ids.length ? ', …' : ''})`, { durationMs: r.elapsedMs });
  },
};

const postPerUeStatsSane: CheckDef = {
  id: 'post-per-ue-stats-sane',
  name: 'Per-UE statistics are plausible',
  description: 'After completion, the per-UE stats must not be visibly corrupted: traffic-carrying UEs report nonzero bitrate, SNR is not one constant implausible value, positions move when mobility is configured, and voice tests expose MOS for (nearly) all UEs.',
  phase: 'post', severity: 'normal',
  run: async (ctx) => {
    const base = { id: 'post-per-ue-stats-sane', name: 'Per-UE statistics are plausible', phase: 'post' as Phase, severity: 'normal' as Severity, description: 'After completion, the per-UE stats must not be visibly corrupted: traffic-carrying UEs report nonzero bitrate, SNR is not one constant implausible value, positions move when mobility is configured, and voice tests expose MOS for (nearly) all UEs.' };
    if (!ctx.token || !ctx.executionId) return makeResult(base, 'skip', 'no executionId');
    // Window in SECONDS (the box ignores millisecond epochs — see
    // statsWindowSec). Wide and generous on both ends — from just before
    // trigger through a bit past the detected finish — rather than trying to
    // guess a cutoff that lands before teardown starts. A fixed "-8s" cutoff
    // fought the several-second lag in our OWN terminal-status detection (5s
    // poll cadence): on a short testcase, "finish - 8s" could already be
    // inside the disconnect window, leaving nothing but teardown rows no
    // matter how the test actually went. The window can safely span past
    // teardown now because latestAttachedPerUe (below) picks each UE's
    // ATTACHED row over its merely-newest one.
    const endSec = ctx.finishedAt ? Math.floor(ctx.finishedAt / 1000) + 15 : Math.floor(Date.now() / 1000);
    const startSec = ctx.triggeredAt ? Math.floor(ctx.triggeredAt / 1000) - 5 : endSec - 3600;
    const f = await jsonFetch(`${apiBase(ctx.systemHost)}/testcases/executions/${encodeURIComponent(ctx.executionId)}/statistics/ues?startTime=${startSec}&endTime=${endSec}`, { headers: authHeaders(ctx) }, 30_000);
    if (f.status !== 200) return makeResult(base, 'fail', `statistics/ues returned ${f.status}`, { durationMs: f.durationMs });
    // Dedupe to ONE row per UE BEFORE judging: every fraction-based threshold
    // below ("60% of UEs report bitrate", "90% of UEs have MOS") is about UEs,
    // not about time-series rows. Without the dedupe, 64 UEs × 16 samples =
    // 1024 rows silently rescale all the percentages. Prefer each UE's
    // attached row over its newest row — see latestAttachedPerUe.
    const rows = latestAttachedPerUe(ueRowsOf(f.body));
    if (rows.length < 2) return makeResult(base, 'skip', `only ${rows.length} per-UE row(s) — not enough to judge`, { durationMs: f.durationMs });
    // Skip only when NO UE was ever seen attached anywhere in the window —
    // genuinely nothing to sanity-check, as opposed to the old cutoff-based
    // guard which could trigger even when the run attached fine.
    if (rows.filter(ueAttached).length === 0) return makeResult(base, 'skip', `no UE was ever attached in the window — nothing to judge`, { durationMs: f.durationMs });
    const td = ctx.testDefinition;
    const dirs = configuredDirections(td);
    const problems: string[] = [];

    // 1. Traffic configured → most UEs must report nonzero bitrate. A run
    //    where traffic flowed globally but per-UE rows are all zeros is the
    //    stats pipeline failing, not the radio.
    if (dirs.dl || dirs.ul) {
      const withTraffic = rows.filter((r) =>
        (rowNum(r, ['dl_bitrate', 'dlBitrate', 'dl_throughput']) ?? 0) > 0 ||
        (rowNum(r, ['ul_bitrate', 'ulBitrate', 'ul_throughput']) ?? 0) > 0).length;
      const frac = withTraffic / rows.length;
      if (frac < 0.6) problems.push(`only ${withTraffic}/${rows.length} UEs report any bitrate despite traffic being configured`);
    }

    // 2. Constant implausible SNR across the fleet (e.g. every UE = 88.9 dB)
    //    is a known corruption signature, not physics.
    const snrs = rows.map((r) => rowNum(r, ['snr', 'sinr', 'SNR'])).filter((v): v is number => typeof v === 'number');
    if (snrs.length >= 8) {
      const distinct = new Set(snrs.map((v) => v.toFixed(1)));
      if (distinct.size === 1 && Math.abs(snrs[0]) > 60) {
        problems.push(`all ${snrs.length} UEs report the identical SNR ${snrs[0].toFixed(1)} dB — implausible constant`);
      }
    }

    // 3. Mobility configured → positions must not be frozen at one coordinate.
    if (hasMobility(td)) {
      const pos = rows.map((r) => {
        const p = r?.position ?? {};
        const x = rowNum(p, ['x']) ?? rowNum(r, ['position_x', 'x']);
        const y = rowNum(p, ['y']) ?? rowNum(r, ['position_y', 'y']);
        return x !== undefined || y !== undefined ? `${x ?? 0},${y ?? 0}` : undefined;
      }).filter(Boolean);
      if (pos.length >= 4 && new Set(pos).size === 1) {
        problems.push(`mobility is configured but all ${pos.length} UE positions are frozen at (${pos[0]})`);
      }
    }

    // 4. Voice test → voice KPIs must be exposed and populated.
    //    SIM40-2306 / SIM40-1416 / SIM40-2305: VoNR runs whose per-UE stats
    //    carry no MOS/RTP/jitter fields at all (KPIs silently dropped), or
    //    where most of the fleet is missing a MOS score. Keys are scanned on
    //    EVERY latest-per-UE row, not just rows[0] — the box has shipped
    //    builds where only a subset of UEs carry the voice columns.
    if (isVoiceTest(td)) {
      const voiceKeyRe = /mos|rtp|jitter/i;
      const voiceKeys = new Set<string>();
      for (const r of rows) for (const k of Object.keys(r ?? {})) if (voiceKeyRe.test(k)) voiceKeys.add(k);
      if (voiceKeys.size === 0) {
        problems.push('voice test but no MOS/RTP/jitter-named field exists on any per-UE row — voice KPIs absent entirely');
      } else {
        const mosKeys = [...voiceKeys].filter((k) => /mos/i.test(k));
        const withMos = rows.filter((r) => mosKeys.some((k) => { const v = typeof r[k] === 'string' ? parseFloat(r[k]) : r[k]; return typeof v === 'number' && Number.isFinite(v) && v > 0; })).length;
        const frac = withMos / rows.length;
        if (frac < 0.9) problems.push(`only ${withMos}/${rows.length} UEs report a parseable positive MOS (need ≥90%; voice keys present: ${[...voiceKeys].slice(0, 5).join(', ')})`);
      }
    }

    if (problems.length) return makeResult(base, 'fail', `${problems.length} per-UE stats problem(s): ${problems.join('; ')}`, { durationMs: f.durationMs });
    return makeResult(base, 'pass', `${rows.length} per-UE rows look plausible (traffic/SNR/position/voice checks)`, { durationMs: f.durationMs });
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

// SIM40-2218: the UI's notification widget announces "Completed"/"Success"
// for a testcase whose execution the API still reports IN_PROGRESS — the
// notifications and the runtime status disagree about reality.
const uiDuringNotificationConsistency: CheckDef = {
  id: 'ui-during-notification-consistency',
  name: 'Notifications do not claim completion mid-run',
  description: 'While /v2 executions/current/status reports IN_PROGRESS, the notification bell must not show a Completed/Success row for the running testcase.',
  phase: 'during', severity: 'normal',
  requiresBrowser: true,
  run: async (ctx) => {
    const base = { id: 'ui-during-notification-consistency', name: 'Notifications do not claim completion mid-run', phase: 'during' as Phase, severity: 'normal' as Severity, description: 'While /v2 executions/current/status reports IN_PROGRESS, the notification bell must not show a Completed/Success row for the running testcase.' };
    if (!ctx.browser) return makeResult(base, 'skip', 'no browser available');
    if (!ctx.token || !ctx.executionId) return makeResult(base, 'skip', 'no executionId');
    const tcName = ctx.testcaseName ?? ctx.testcaseId;
    // The whole point is a cross-check against the API's runtime view — only
    // meaningful while the box itself says the run is IN_PROGRESS.
    const inProgress = async (): Promise<boolean> => {
      const simulatorId = await resolveSimulatorId(ctx);
      if (!simulatorId) return false;
      const cur = await jsonFetch(`${apiBase(ctx.systemHost)}/testcases/executions/current/status?simulatorId=${encodeURIComponent(simulatorId)}`, { headers: authHeaders(ctx) });
      return cur.status === 200 && String(cur.body?.status ?? '').toUpperCase() === 'IN_PROGRESS';
    };
    if (!(await inProgress())) return makeResult(base, 'skip', 'execution not IN_PROGRESS (per current/status) — nothing to cross-check');
    const { context, page } = await newCheckContext(ctx.browser);
    try {
      const lr = await loginUI(page, ctx.systemHost, ctx.apiUser, ctx.apiPass);
      if (!lr.ok) return makeResult(base, 'fail', `UI login: ${lr.detail}`);
      await page.goto(`http://${ctx.systemHost}/testcase`, { waitUntil: 'domcontentloaded' }).catch(() => null);
      await sleep(2000, ctx.isCanceled);
      // Find the notification bell defensively — by aria/role first, class
      // names last. The widget has moved between builds; skip if absent.
      const bellSelectors = [
        '[aria-label*="notification" i]',
        'button[title*="notification" i]',
        '[data-testid*="notification" i]',
        '[role="button"][aria-label*="bell" i]',
        'button:has(svg[class*="bell" i])',
        '[class*="notification-bell" i]',
        '[class*="bell" i]',
      ];
      let opened = false;
      for (const sel of bellSelectors) {
        const loc = page.locator(sel).first();
        if (await loc.isVisible().catch(() => false)) {
          const clicked = await loc.click({ timeout: 5000 }).then(() => true).catch(() => false);
          if (clicked) { opened = true; break; }
        }
      }
      if (!opened) return makeResult(base, 'skip', 'notification bell/widget not found in the UI — cannot cross-check');
      await sleep(1500, ctx.isCanceled);
      // Scrape visible text from likely notification containers.
      const containers = page.locator('[role="dialog"], [role="menu"], [role="listbox"], [class*="notif" i], [class*="dropdown" i], [class*="popover" i]');
      const texts: string[] = [];
      const n = await containers.count().catch(() => 0);
      for (let i = 0; i < Math.min(n, 8); i++) {
        const el = containers.nth(i);
        if (!(await el.isVisible().catch(() => false))) continue;
        const t = await el.innerText().catch(() => '');
        if (t.trim()) texts.push(t);
      }
      if (!texts.length) return makeResult(base, 'skip', 'notification widget opened but exposed no readable content');
      // A notification "row" for our testcase: a line containing the current
      // testcase name; Completed/Success may sit on the same or an adjacent
      // line depending on the row layout.
      const lines = texts.join('\n').split('\n').map((l) => l.trim()).filter(Boolean);
      // When NO scanned line mentions the testcase name at all, passing would
      // be a false pass — we verified nothing about this run. A generic
      // Completed/Success row only counts as a failure candidate when the
      // widget clearly ties it to the running execution (its id); otherwise
      // skip: the rows simply don't reference the running testcase.
      if (!lines.some((l) => l.includes(tcName))) {
        const genericForThisRun = lines.filter((l) =>
          /completed|success/i.test(l) && !!ctx.executionId && l.includes(ctx.executionId));
        if (genericForThisRun.length > 0) {
          // Race guard, same as below: the run may have finished while we scraped.
          if (!(await inProgress())) return makeResult(base, 'skip', 'execution finished while scraping notifications — cannot distinguish a premature toast from a real one');
          return makeResult(base, 'fail', `notification claims completion for the running execution (matched by executionId) while current/status is IN_PROGRESS: "${genericForThisRun[0].slice(0, 160)}"${genericForThisRun.length > 1 ? ` (+${genericForThisRun.length - 1} more)` : ''}`);
        }
        return makeResult(base, 'skip', 'notification rows do not reference the running testcase');
      }
      const offending: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].includes(tcName)) continue;
        const neighbourhood = lines.slice(i, i + 3).join(' ');
        if (/\b(completed|success(ful|fully)?)\b/i.test(neighbourhood)) offending.push(neighbourhood.slice(0, 160));
      }
      if (offending.length === 0) {
        return makeResult(base, 'pass', `no Completed/Success notification for "${tcName}" while IN_PROGRESS (${lines.length} notification line(s) scanned)`);
      }
      // Race guard: the run may have legitimately finished while we scraped —
      // re-check before claiming the UI lied (SIM40-2218 vs. an honest toast).
      if (!(await inProgress())) return makeResult(base, 'skip', 'execution finished while scraping notifications — cannot distinguish a premature toast from a real one');
      return makeResult(base, 'fail', `notification claims completion while current/status is IN_PROGRESS: "${offending[0]}"${offending.length > 1 ? ` (+${offending.length - 1} more)` : ''}`);
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
  preflightCfgBringUp,
  preflightFtpAnonLocked,
  // TRIGGER
  triggerStart,
  triggerExecutionDiscovered,
  // DURING (API)
  duringStatusRunning,
  duringUeAttach,
  duringAllUesAttach,
  duringUeStability,
  duringThroughputFlowing,
  duringUlThroughputFlowing,
  duringBlerZero,
  duringThroughputStability,
  duringPerCellTraffic,
  duringStatsConsistency,
  duringZombieExecution,
  // DURING (UI)
  uiDuringNo5xx,
  uiDuringNoConsoleErrors,
  uiDuringNotificationConsistency, // early among UI checks — needs the run still IN_PROGRESS
  uiDuringStopAffordance,
  uiDuringExportButtons,
  // COMPLETION
  completionStatusTerminal,
  completionDurationSane,
  completionVerdictPresent,
  // POST (API)
  postLogsExport,
  postAllUesPowerOff,
  postPerUeStatsSane,
  // POST (UI)
  uiPostDeepLink,
];

/** Backwards-compat name some older imports might use. */
export const API_CHECKS = ALL_CHECKS;

// Re-export sleep for runner-side waits between phases.
export { sleep };

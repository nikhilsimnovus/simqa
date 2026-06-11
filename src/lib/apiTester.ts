// Comprehensive API tester for the Simnovator REST surface (v2). Tests are
// grouped by category so the UI can run a slice. Each test returns a
// structured result with the HTTP status and a one-line detail.
//
// Safety:
//   - Default category set is read-only.
//   - Mutating tests are gated behind `includeDestructive` and use throwaway
//     resources (e.g. a simqa-tester-<ts> user we create + delete in the
//     same run).
//   - Negative tests intentionally provoke 401/404/400 to verify error paths.

import { ensureToken } from './uesimClient';
import type { Inventory } from './inventory';
import { uesimApiOptsFromInventory, uesimApiOptsForSystem } from './inventory';

export type ApiTestCategory =
  | 'auth' | 'version' | 'users' | 'admin-users' | 'simulators'
  | 'system' | 'tools' | 'testcases' | 'test-creator' | 'executions' | 'statistics'
  | 'logs' | 'jobs' | 'negative' | 'mutating' | 'fuzz'
  // Sample-test matrix categories — generated from src/lib/sampleTests/matrix.ts.
  // RAT-based grouping (matches the box's actually-shipped sample tests; see
  // dist/overnight/bug-report.md → C2 for why we use RAT instead of the
  // wiki's narrative grouping).
  | 'sample-sa' | 'sample-lte' | 'sample-nsa' | 'sample-nbiot';

export type ApiTestSeverity = 'critical' | 'normal' | 'optional';

export interface ApiRequestEvidence {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface ApiResponseEvidence {
  status: number;
  statusText?: string;
  headers: Record<string, string>;
  body?: string;
  bodyTruncated?: boolean;
  contentType?: string;
  durationMs: number;
}

export interface ApiTestResult {
  id: string;
  name: string;
  category: ApiTestCategory;
  method: string;
  endpoint: string;
  severity: ApiTestSeverity;
  destructive: boolean;
  ok: boolean;
  status?: number;
  detail?: string;
  durationMs?: number;
  /** True if the test was skipped (e.g. requires execution context not available). */
  skipped?: boolean;
  skippedReason?: string;
  /** Full request as sent. Authorization is redacted for safe sharing. */
  request?: ApiRequestEvidence;
  /** Response received, with body capped at 8 KB. */
  response?: ApiResponseEvidence;
  /** ISO timestamp when this test ran. */
  ranAt?: string;
  /** Engineering guidance: what the API SHOULD have returned. Populated on failures. */
  expected?: string;
}

export interface ApiTesterRequest {
  /** Categories to run. If omitted, runs the default safe set. */
  categories?: ApiTestCategory[];
  /** Allow tests that change state. Off by default. */
  includeDestructive?: boolean;
  /** Allow tests that take >10s. Off by default. */
  includeLongRunning?: boolean;
  /** Include negative tests (401/404/400 verification). Default true. */
  includeNegative?: boolean;
  /** Inventory system id to test against. If omitted, the first UESIM-capable
   *  system is used (legacy behaviour). Lets two teammates target different
   *  boxes from the same simqa install. */
  targetSystemId?: string;
}

export interface ApiTesterResponse {
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  counts: { total: number; passed: number; failed: number; skipped: number };
  results: ApiTestResult[];
  /** Convenience: pass/fail count grouped by category. */
  byCategory: Record<string, { passed: number; failed: number; skipped: number }>;
}

const DEFAULT_CATEGORIES: ApiTestCategory[] = [
  'auth', 'version', 'users', 'admin-users', 'simulators',
  'system', 'tools', 'testcases', 'test-creator', 'executions', 'statistics', 'logs', 'jobs',
  'negative', 'fuzz',
];

interface RunCtx {
  host: string;
  username: string;
  password: string;
  token: string;
  /** Most recent execution id discovered from /testcases scan (for stats/logs tests). */
  recentExecutionId?: string;
  recentSimulatorId?: string;
  /** First testcase id from /testcases list. */
  someTestcaseId?: string;
  /** First job id discovered from GET /api/jobs (for jobs/{id} test). */
  someJobId?: string;
  includeDestructive: boolean;
  includeLongRunning: boolean;
  /** Full testcase catalogue (id + name), lazily loaded once and reused by
   *  every sample-matrix test so we don't re-search the box 200+ times in
   *  one sweep. Populated by `ensureTestcaseCatalog(c)`. */
  testcaseCatalog?: Array<{ id: string; name: string }>;
}

function tBase(host: string) { return `http://${host}/v2`; }

const MAX_BODY_BYTES = 8 * 1024;

function redactHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (k.toLowerCase() === 'authorization') {
      out[k] = v.replace(/Bearer\s+\S+/i, 'Bearer <REDACTED>');
    } else {
      out[k] = v;
    }
  }
  return out;
}

function headersToObject(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => { out[k] = v; });
  return out;
}

function truncate(s: string): { body: string; truncated: boolean } {
  if (s.length <= MAX_BODY_BYTES) return { body: s, truncated: false };
  return { body: s.slice(0, MAX_BODY_BYTES) + '\n... [truncated]', truncated: true };
}

interface RawCallResult {
  status: number;
  ms: number;
  bodyText?: string;
  bodyJson?: any;
  error?: string;
  request: ApiRequestEvidence;
  response?: ApiResponseEvidence;
}

async function rawCall(
  ctx: RunCtx | null,
  method: string,
  url: string,
  init: RequestInit & { auth?: 'none' | 'bearer' | 'wrong' } = {},
): Promise<RawCallResult> {
  const headers: Record<string, string> = { ...(init.headers as any) };
  const auth = init.auth ?? 'bearer';
  if (auth === 'bearer') {
    if (ctx?.token) headers['Authorization'] = `Bearer ${ctx.token}`;
  } else if (auth === 'wrong') {
    headers['Authorization'] = 'Bearer not-a-real-token';
  }
  const reqBody = typeof init.body === 'string' ? init.body : (init.body ? String(init.body) : undefined);
  const request: ApiRequestEvidence = {
    method, url,
    headers: redactHeaders(headers),
    ...(reqBody !== undefined ? { body: truncate(reqBody).body } : {}),
  };
  const t0 = Date.now();
  try {
    const res = await fetch(url, { ...init, method, headers });
    const ms = Date.now() - t0;
    const ct = res.headers.get('content-type') ?? '';
    const respHeaders = headersToObject(res.headers);
    if (ct.includes('application/json')) {
      const raw = await res.text().catch(() => '');
      let bodyJson: any;
      try { bodyJson = raw ? JSON.parse(raw) : undefined; } catch { bodyJson = undefined; }
      const { body: bodyOut, truncated } = truncate(raw);
      return {
        status: res.status, ms, bodyJson,
        request,
        response: { status: res.status, statusText: res.statusText, headers: respHeaders, body: bodyOut, bodyTruncated: truncated, contentType: ct, durationMs: ms },
      };
    }
    const bodyText = await res.text().catch(() => '');
    const { body: bodyOut, truncated } = truncate(bodyText);
    return {
      status: res.status, ms, bodyText,
      request,
      response: { status: res.status, statusText: res.statusText, headers: respHeaders, body: bodyOut, bodyTruncated: truncated, contentType: ct, durationMs: ms },
    };
  } catch (e: any) {
    return {
      status: 0, ms: Date.now() - t0, error: e?.message ?? String(e),
      request,
    };
  }
}

type EvidenceCarrier = { request?: ApiRequestEvidence; response?: ApiResponseEvidence; error?: string };

function ok(name: string, base: { id: string; category: ApiTestCategory; method: string; endpoint: string; severity: ApiTestSeverity; destructive?: boolean }, r: { status: number; ms: number } & EvidenceCarrier, detail: string): ApiTestResult {
  return { ...base, name, ok: true, status: r.status, durationMs: r.ms, detail, destructive: !!base.destructive, request: r.request, response: r.response, ranAt: new Date().toISOString() };
}
function bad(name: string, base: { id: string; category: ApiTestCategory; method: string; endpoint: string; severity: ApiTestSeverity; destructive?: boolean }, r: { status: number; ms: number; error?: string } & EvidenceCarrier, detail: string, expected?: string): ApiTestResult {
  return { ...base, name, ok: false, status: r.status, durationMs: r.ms, detail: r.error ? `${detail} (${r.error})` : detail, destructive: !!base.destructive, request: r.request, response: r.response, ranAt: new Date().toISOString(), expected };
}
function skip(name: string, base: { id: string; category: ApiTestCategory; method: string; endpoint: string; severity: ApiTestSeverity; destructive?: boolean }, reason: string): ApiTestResult {
  return { ...base, name, ok: true, skipped: true, skippedReason: reason, destructive: !!base.destructive, ranAt: new Date().toISOString() };
}

// ---------- Test-creator request bodies ----------
// Known-good payloads for the /tests/* config-builder family. Derived from the
// OpenAPI examples and CORRECTED against the live UE-sim box, where the spec
// examples are wrong:
//   • cellConfig.master.product MUST be "UE-SIM" on a UE-sim box.
//   • cellConfig.cells[].bandwidth is a STRING ("20"), not a number.
//   • subscriber startingIMSI is a NUMBER (uint64), not a quoted string.
//   • subscriber opc must match ^[0-9a-fA-F]{32}$ — omit it when op is supplied
//     (the spec's opc:"" is rejected).
// Section creation is ORDER-DEPENDENT: each section is gated on the previous
// one (cells → subscribers → user-plane → power-cycle → mobility → settings),
// and settings is the finaliser that LOCKS the case.
const TC_CELLS_LTE = {
  cellConfig: {
    master: { product: 'UE-SIM', carrierAggregation: false, channelSim: false, pdcchDecodeOpt: true, pdcchDecodeOptThreshold: 0.1, ratType: 'smartphone', turboIteration: 14 },
    cells: [{
      cellType: '4g', syncId: 0, duplexMode: 'FDD', band: '1', EARFCN: { dl: 300, ul: 18300 },
      bandwidth: '20', prach: 0, antennas: { dl: 1, ul: 1 }, rfCard: 0, rxToTxLatency: 4,
      txGain: [70], rxGain: [0], globalTimingAdvance: -1,
      mobility: { antennaType: 'isotropic', position: [4, 3], referencePower: -25, ulAttenuation: 60 },
    }],
  },
};
const TC_SUBS_LTE = {
  subsConfig: {
    subs: [{
      ueCount: 2, servingCell: 0, startingIMSI: 1010123456789, preferredPLMN: ['011-01', '544-780'],
      nextIMSI: 1, algorithm: 'milenage', sharedKey: '00112233445566778899aabbccddeeff',
      op: '000102030405060708090A0B0C0D0E0F', resLength: 8, securityContext: true, asRelease: 13,
      redCap: false, ueCategoryType: 'combined', ueCategory: '6', imeisv: '4085780000000102',
      powerControl: false, powerMin: 0, powerMax: 0, attachType: 'normal', ueInitiatedEvents: 'tau',
      eventsInLoop: true, triggerTime: [10], pdnType: 'ipv4', defaultApn: '',
      cipherAlgorithm: ['eea0', 'eea1', 'eea2'], integrityAlgorithm: ['eia0', 'eia1', 'eia2'],
      cqi: 'auto', ri: 'auto', pmi: 'auto', preambleIndex: 0,
    }],
  },
};
const TC_UPLANE = { userPlaneConfig: { profiles: [{ subscriberGroup: [0], dataType: 'no_data', pdnType: 'ipv4', apnName: '' }] } };
const TC_PCYCLE = { powerCycleConfig: { profiles: [{ subscriberGroup: [0], loopProfile: 'disable', attachType: 'bursty', attachRate: 1, attachDelay: 0, powerOnTime: 2000, powerOffTime: 10 }] } };
const TC_MOBILITY = { mobilityConfig: { profiles: [{ subscriberGroup: [0], tripType: 'roundTrip', loopProfile: 'time', startDelay: 5, duration: 380, waitTime: 0, uePosition: [0, 0], speed: 1, direction: 0, distance: 50, fadingProfile: { fadingType: 'awgn', frequencyDoppler: 70, mimoCorrelation: 'low' }, noiseSpectralDensity: -174 }] } };
// settings is the finaliser. 4.0.0_260602 tightened validation so a
// non-existent successCriteriaName now 400s with the explicit message:
//   "successCriteriaName 'X' does not exist".
// No public endpoint enumerates valid names (see P1 in the overnight bug
// report), so we self-discover by reading settings.successCriteriaName +
// .loggingProfileName off any existing testcase right before the call.
// Falls back to the historical defaults if the catalogue is empty.
async function tcSettingsBody(c: RunCtx, testCaseName?: string): Promise<any> {
  const fallback = { loggingProfileName: 'debug', successCriteriaName: 'abcd' };
  try {
    const list = await rawCall(c, 'POST', `${tBase(c.host)}/testcases/search`, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ offset: 0, limit: 25 }),
    });
    const items: any[] = list.bodyJson?.items ?? list.bodyJson?.data ?? [];
    for (const it of items) {
      const tc = await rawCall(c, 'GET', `${tBase(c.host)}/testcases/${encodeURIComponent(it.id)}`);
      const s = tc.bodyJson?.testDefinition?.settings;
      if (s?.successCriteriaName && s?.loggingProfileName) {
        return { settings: { ...s, ...(testCaseName ? { testCaseName, test_name: testCaseName } : {}) } };
      }
    }
  } catch { /* fall through to historical defaults */ }
  return { settings: { ...fallback, ...(testCaseName ? { testCaseName, test_name: testCaseName } : {}) } };
}

// ---------- Test definitions ----------

type RunFn = (ctx: RunCtx) => Promise<ApiTestResult>;

interface TestDef {
  id: string;
  name: string;
  category: ApiTestCategory;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  endpoint: string;
  severity: ApiTestSeverity;
  destructive?: boolean;
  longRunning?: boolean;
  run: RunFn;
}

function defs(): TestDef[] {
  const list: TestDef[] = [];

  // ---------- AUTH ----------
  list.push({
    id: 'auth-login', name: 'POST /login (admin/admin)', category: 'auth',
    method: 'POST', endpoint: '/v2/login', severity: 'critical',
    run: async (c) => {
      const base = { id: 'auth-login', category: 'auth' as const, method: 'POST', endpoint: '/v2/login', severity: 'critical' as const };
      const r = await rawCall(null, 'POST', `${tBase(c.host)}/login`, {
        auth: 'none', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: c.username, password: c.password }),
      });
      if (r.status === 200 && r.bodyJson?.access_token) return ok(base.id, base, r, 'token issued');
      return bad(base.id, base, r, `expected 200 with access_token, got ${r.status}`);
    },
  });
  list.push({
    id: 'auth-logout', name: 'POST /logout (uses a fresh token)', category: 'auth',
    method: 'POST', endpoint: '/v2/logout', severity: 'normal',
    run: async (c) => {
      const base = { id: 'auth-logout', category: 'auth' as const, method: 'POST', endpoint: '/v2/logout', severity: 'normal' as const };
      // Use a fresh token so we don't invalidate the shared token mid-run.
      const loginR = await fetch(`${tBase(c.host)}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: c.username, password: c.password }) });
      const body = await loginR.json().catch(() => undefined);
      if (!loginR.ok || !body?.access_token) {
        return bad(base.id, base, { status: loginR.status, ms: 0, request: { method: 'POST', url: `${tBase(c.host)}/login`, headers: { 'Content-Type': 'application/json' }, body: '{...}' } }, 'fresh login failed');
      }
      const url = `${tBase(c.host)}/logout`;
      const reqHeaders = { Authorization: `Bearer ${body.access_token}` };
      const t0 = Date.now();
      const res = await fetch(url, { method: 'POST', headers: reqHeaders });
      const ms = Date.now() - t0;
      const respText = await res.text().catch(() => '');
      const carrier = {
        status: res.status, ms,
        request: { method: 'POST', url, headers: redactHeaders(reqHeaders) },
        response: { status: res.status, statusText: res.statusText, headers: headersToObject(res.headers), body: truncate(respText).body, bodyTruncated: truncate(respText).truncated, contentType: res.headers.get('content-type') ?? undefined, durationMs: ms },
      };
      if (res.status === 204 || res.status === 200) return ok(base.id, base, carrier, `revoked fresh token`);
      return bad(base.id, base, carrier, `expected 204/200, got ${res.status}`);
    },
  });

  // ---------- VERSION ----------
  list.push({
    id: 'version-get', name: 'GET /version', category: 'version',
    method: 'GET', endpoint: '/v2/version', severity: 'normal',
    run: async (c) => {
      const base = { id: 'version-get', category: 'version' as const, method: 'GET', endpoint: '/v2/version', severity: 'normal' as const };
      const r = await rawCall(c, 'GET', `${tBase(c.host)}/version`);
      if (r.status === 200) return ok(base.id, base, r, JSON.stringify(r.bodyJson?.simnovator ?? r.bodyJson).slice(0, 120));
      // The box has a known issue where /version returns 401 even with a valid admin token.
      if (r.status === 401) return bad(base.id, base, r, 'returned 401 for admin token (spec mismatch)',
        '200 with body { simnovator: { version, build }, simulators: [...] } per the OpenAPI spec at lines 14-59. The endpoint is documented as bearer-protected and admin tokens should pass.');
      return bad(base.id, base, r, `unexpected ${r.status}`, '200 with version info per spec');
    },
  });

  // ---------- USERS ----------
  list.push({
    id: 'users-me', name: 'GET /users/me', category: 'users',
    method: 'GET', endpoint: '/v2/users/me', severity: 'critical',
    run: async (c) => {
      const base = { id: 'users-me', category: 'users' as const, method: 'GET', endpoint: '/v2/users/me', severity: 'critical' as const };
      const r = await rawCall(c, 'GET', `${tBase(c.host)}/users/me`);
      if (r.status === 200 && r.bodyJson?.username) return ok(base.id, base, r, `user=${r.bodyJson.username} roles=${(r.bodyJson.roles ?? []).join(',')}`);
      return bad(base.id, base, r, `expected 200 + username, got ${r.status}`);
    },
  });

  // ---------- ADMIN USERS ----------
  list.push({
    id: 'admin-users-list', name: 'GET /admin/users', category: 'admin-users',
    method: 'GET', endpoint: '/v2/admin/users', severity: 'normal',
    run: async (c) => {
      const base = { id: 'admin-users-list', category: 'admin-users' as const, method: 'GET', endpoint: '/v2/admin/users', severity: 'normal' as const };
      const r = await rawCall(c, 'GET', `${tBase(c.host)}/admin/users`);
      if (r.status === 200) return ok(base.id, base, r, `users=${r.bodyJson?.users?.length ?? r.bodyJson?.total ?? '?'}`);
      return bad(base.id, base, r, `expected 200, got ${r.status}`);
    },
  });

  list.push({
    id: 'admin-users-full-lifecycle', name: 'admin users + profile patch + sim assign/revoke (throwaway)', category: 'mutating',
    method: 'POST', endpoint: '/v2/admin/users (combo)', severity: 'normal', destructive: true,
    run: async (c) => {
      const base = { id: 'admin-users-full-lifecycle', category: 'mutating' as const, method: 'POST', endpoint: '/v2/admin/users (combo)', severity: 'normal' as const, destructive: true };
      const username = `simqa-tester-${Date.now().toString(36)}`;
      const traces: string[] = [];
      const trace = (label: string, r: { status: number }) => traces.push(`${label}=${r.status}`);

      // 1. POST /admin/users
      const create = await rawCall(c, 'POST', `${tBase(c.host)}/admin/users`, {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, first_name: 'simqa', last_name: 'tester', email: `${username}@example.invalid`, role: 'user' }),
      });
      trace('create', create);
      if (create.status !== 201 && create.status !== 200) return bad(base.id, base, create, `create returned ${create.status}`);

      // 2. POST /admin/users/{name}/reset-password
      const reset = await rawCall(c, 'POST', `${tBase(c.host)}/admin/users/${encodeURIComponent(username)}/reset-password`, {
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ new_password: 'TmpSimqa123!' }),
      });
      trace('reset', reset);

      // 3. PUT /admin/users/{name}/role
      const role = await rawCall(c, 'PUT', `${tBase(c.host)}/admin/users/${encodeURIComponent(username)}/role`, {
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'user' }),
      });
      trace('role', role);

      // 4. PATCH /users/{name}: update first_name on the throwaway.
      const patch = await rawCall(c, 'PATCH', `${tBase(c.host)}/users/${encodeURIComponent(username)}`, {
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ first_name: 'simqa-renamed' }),
      });
      trace('patch', patch);

      // 5. POST /simulators/{id}/users/{name}: assign throwaway to a known simulator.
      // 6. DELETE /simulators/{id}/users/{name}: revoke. Both gated on having a sim id.
      let assignTrace = 'assign=skipped';
      let revokeTrace = 'revoke=skipped';
      if (c.recentSimulatorId) {
        const assign = await rawCall(c, 'POST', `${tBase(c.host)}/simulators/${encodeURIComponent(c.recentSimulatorId)}/users/${encodeURIComponent(username)}`);
        assignTrace = `assign=${assign.status}`;
        traces.push(assignTrace);
        const revoke = await rawCall(c, 'DELETE', `${tBase(c.host)}/simulators/${encodeURIComponent(c.recentSimulatorId)}/users/${encodeURIComponent(username)}`);
        revokeTrace = `revoke=${revoke.status}`;
        traces.push(revokeTrace);
      } else {
        traces.push(assignTrace, revokeTrace);
      }

      // 7. DELETE /admin/users/{name}: cleanup.
      const del = await rawCall(c, 'DELETE', `${tBase(c.host)}/admin/users/${encodeURIComponent(username)}`);
      trace('delete', del);
      if (del.status !== 204 && del.status !== 200) return bad(base.id, base, del, `delete returned ${del.status} for ${username}`);
      return ok(base.id, base, create, `${username}: ${traces.join(' ')}`);
    },
  });

  // ---------- SIMULATORS ----------
  list.push({
    id: 'simulators-list', name: 'GET /simulators', category: 'simulators',
    method: 'GET', endpoint: '/v2/simulators', severity: 'critical',
    run: async (c) => {
      const base = { id: 'simulators-list', category: 'simulators' as const, method: 'GET', endpoint: '/v2/simulators', severity: 'critical' as const };
      const r = await rawCall(c, 'GET', `${tBase(c.host)}/simulators`);
      if (r.status === 200 && Array.isArray(r.bodyJson?.items)) {
        if (r.bodyJson.items.length > 0) c.recentSimulatorId = r.bodyJson.items[0].id;
        return ok(base.id, base, r, `${r.bodyJson.items.length} registered`);
      }
      return bad(base.id, base, r, `expected 200 with items[], got ${r.status}`);
    },
  });
  list.push({
    id: 'simulators-status', name: 'GET /simulators/{id}/status', category: 'simulators',
    method: 'GET', endpoint: '/v2/simulators/{id}/status', severity: 'normal',
    run: async (c) => {
      const base = { id: 'simulators-status', category: 'simulators' as const, method: 'GET', endpoint: '/v2/simulators/{id}/status', severity: 'normal' as const };
      if (!c.recentSimulatorId) return skip(base.id, base, 'no simulator id available (run simulators-list first)');
      const r = await rawCall(c, 'GET', `${tBase(c.host)}/simulators/${encodeURIComponent(c.recentSimulatorId)}/status`);
      if (r.status === 200) return ok(base.id, base, r, JSON.stringify(r.bodyJson).slice(0, 120));
      return bad(base.id, base, r, `got ${r.status}`);
    },
  });
  // Cross-check: the runtime-side view of a simulator's current execution.
  // Used by the end-to-end preflight to distinguish a real running testcase
  // from a stale BUSY flag (SIM40-2064). Two valid responses:
  //   200 → simulator has a live execution; body carries testcase + eid.
  //   404 with code=NOT_FOUND, message="no active execution found for
  //        simulator" → simulator currently idle.
  // Either response counts as a pass; the catalogue check is "does the
  // endpoint exist and answer coherently". When SIM40-2064 ships its fix,
  // a 404 here MUST coincide with availability=AVAILABLE in /simulators —
  // that cross-endpoint invariant is verified by the end-to-end preflight,
  // not by this catalogue check.
  list.push({
    id: 'executions-current-status', name: 'GET /testcases/executions/current/status?simulatorId={id}', category: 'simulators',
    method: 'GET', endpoint: '/v2/testcases/executions/current/status', severity: 'normal',
    run: async (c) => {
      const base = { id: 'executions-current-status', category: 'simulators' as const, method: 'GET' as const, endpoint: '/v2/testcases/executions/current/status', severity: 'normal' as const };
      if (!c.recentSimulatorId) return skip(base.id, base, 'no simulator id available (run simulators-list first)');
      const r = await rawCall(c, 'GET', `${tBase(c.host)}/testcases/executions/current/status?simulatorId=${encodeURIComponent(c.recentSimulatorId)}`);
      if (r.status === 200) return ok(base.id, base, r, 'simulator currently running an execution');
      // Box returns application/json content type even on 404, so the
      // diagnostic message lands in r.bodyJson.message (not r.bodyText —
      // bodyText is only populated by the non-JSON branch of rawCall).
      const msg = (r.bodyJson?.message as string | undefined) ?? r.bodyText ?? '';
      if (r.status === 404 && /no active execution found/i.test(msg)) {
        return ok(base.id, base, r, 'simulator idle (404 NOT_FOUND with expected NOT_FOUND body, contract-compliant)');
      }
      if (r.status === 400) return bad(base.id, base, r, `400 BAD_REQUEST — simulatorId rejected (likely a build that doesn't expose this endpoint)`);
      return bad(base.id, base, r, `unexpected status ${r.status}${msg ? ` (message: ${msg.slice(0, 120)})` : ''}`);
    },
  });

  // ---------- SYSTEM ----------
  list.push({
    id: 'system-log-settings', name: 'GET /system/log-settings', category: 'system',
    method: 'GET', endpoint: '/v2/system/log-settings', severity: 'optional',
    run: async (c) => {
      const base = { id: 'system-log-settings', category: 'system' as const, method: 'GET', endpoint: '/v2/system/log-settings', severity: 'optional' as const };
      const r = await rawCall(c, 'GET', `${tBase(c.host)}/system/log-settings`);
      if (r.status === 200) return ok(base.id, base, r, `${(r.bodyJson?.items ?? r.bodyJson?.logSettings ?? []).length ?? '?'} setting(s)`);
      return bad(base.id, base, r, `got ${r.status}`);
    },
  });

  // ---------- TOOLS ----------
  list.push({
    id: 'tools-bandinfo-nr', name: 'POST /band-info (NR)', category: 'tools',
    method: 'POST', endpoint: '/v2/band-info', severity: 'normal',
    run: async (c) => {
      const base = { id: 'tools-bandinfo-nr', category: 'tools' as const, method: 'POST', endpoint: '/v2/band-info', severity: 'normal' as const };
      const r = await rawCall(c, 'POST', `${tBase(c.host)}/band-info`, {
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rat: 'NR' }),
      });
      if (r.status === 200 && Array.isArray(r.bodyJson?.data)) return ok(base.id, base, r, `${r.bodyJson.data.length} bands`);
      return bad(base.id, base, r, `got ${r.status}`);
    },
  });
  list.push({
    id: 'tools-bandinfo-lte', name: 'POST /band-info (LTE)', category: 'tools',
    method: 'POST', endpoint: '/v2/band-info', severity: 'normal',
    run: async (c) => {
      const base = { id: 'tools-bandinfo-lte', category: 'tools' as const, method: 'POST', endpoint: '/v2/band-info', severity: 'normal' as const };
      const r = await rawCall(c, 'POST', `${tBase(c.host)}/band-info`, {
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rat: 'LTE' }),
      });
      if (r.status === 200 && Array.isArray(r.bodyJson?.data)) return ok(base.id, base, r, `${r.bodyJson.data.length} bands`);
      return bad(base.id, base, r, `got ${r.status}`);
    },
  });
  list.push({
    id: 'tools-satellite-tracker', name: 'POST /tools/satellite-tracker/metrics', category: 'tools',
    method: 'POST', endpoint: '/v2/tools/satellite-tracker/metrics', severity: 'optional',
    run: async (c) => {
      const base = { id: 'tools-satellite-tracker', category: 'tools' as const, method: 'POST', endpoint: '/v2/tools/satellite-tracker/metrics', severity: 'optional' as const };
      const r = await rawCall(c, 'POST', `${tBase(c.host)}/tools/satellite-tracker/metrics`, {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sLat: 0, sLon: 0, sAlt: 35786, sVel: 3.07, gLat: 0, gLon: 0 }),
      });
      if (r.status === 200) return ok(base.id, base, r, JSON.stringify(r.bodyJson).slice(0, 100));
      return bad(base.id, base, r, `got ${r.status}`);
    },
  });

  // ---------- TESTCASES ----------
  list.push({
    id: 'testcases-list', name: 'GET /testcases', category: 'testcases',
    method: 'GET', endpoint: '/v2/testcases', severity: 'critical',
    run: async (c) => {
      const base = { id: 'testcases-list', category: 'testcases' as const, method: 'GET', endpoint: '/v2/testcases', severity: 'critical' as const };
      const r = await rawCall(c, 'GET', `${tBase(c.host)}/testcases?limit=50&offset=0`);
      if (r.status === 200 && Array.isArray(r.bodyJson?.items)) {
        const items = r.bodyJson.items;
        if (items.length > 0) {
          c.someTestcaseId = items[0].id;
          // Pull a recent execution id from the metadata if available.
          // The metadata field can carry a stale id (execution since GC'd or
          // from a different DB state) — every stats/logs check would then
          // hit a guaranteed 404 and FAIL even though the endpoints work.
          // We validate the discovered id ONCE here by hitting a cheap stats
          // endpoint; if it 404s, drop it so downstream checks SKIP cleanly
          // instead of stacking up false-positive failures.
          let candidate: string | undefined;
          for (const it of items) {
            const last = it.metadata?.lastExecution;
            if (last?.executionId) { candidate = last.executionId; break; }
          }
          if (candidate) {
            // Probe the eid with the /logs endpoint, not /statistics/global.
            // Empirical: /statistics/global is permissive (returns 200 with
            // empty data even when the execution has been GC'd) so it
            // false-passes stale eids. /logs is strict — 404 if the
            // execution doesn't exist. /v2/testcases/executions/{eid}/logs
            // is the same code path the stats/ue-summary endpoint uses for
            // its existence check, so its verdict matches what the other
            // stats endpoints will do.
            try {
              const probe = await rawCall(c, 'GET', `${tBase(c.host)}/testcases/executions/${encodeURIComponent(candidate)}/logs?limit=1`);
              if (probe.status === 200 || probe.status === 202) {
                c.recentExecutionId = candidate;
              }
              // Anything else (404, 500, etc.) → keep recentExecutionId
              // undefined so stats/logs checks SKIP with "no execution id
              // available — this system has no recent execution to validate
              // stats against".
            } catch {
              // Network blip — same fallback as 404.
            }
          }
        }
        return ok(base.id, base, r, `total=${r.bodyJson.total ?? items.length}${c.recentExecutionId ? ` · recentExecutionId=${c.recentExecutionId.slice(0,8)}…` : ' · no live execution available for stats/logs validation'}`);
      }
      return bad(base.id, base, r, `got ${r.status}`);
    },
  });
  list.push({
    id: 'testcases-get-one', name: 'GET /testcases/{id}', category: 'testcases',
    method: 'GET', endpoint: '/v2/testcases/{id}', severity: 'critical',
    run: async (c) => {
      const base = { id: 'testcases-get-one', category: 'testcases' as const, method: 'GET', endpoint: '/v2/testcases/{id}', severity: 'critical' as const };
      if (!c.someTestcaseId) return skip(base.id, base, 'no testcase id (run testcases-list first)');
      const r = await rawCall(c, 'GET', `${tBase(c.host)}/testcases/${encodeURIComponent(c.someTestcaseId)}`);
      if (r.status === 200 && r.bodyJson?.testDefinition) return ok(base.id, base, r, `id=${r.bodyJson.id} has testDefinition`);
      return bad(base.id, base, r, `got ${r.status}`);
    },
  });
  list.push({
    id: 'testcases-search', name: 'POST /testcases/search', category: 'testcases',
    method: 'POST', endpoint: '/v2/testcases/search', severity: 'normal',
    run: async (c) => {
      const base = { id: 'testcases-search', category: 'testcases' as const, method: 'POST', endpoint: '/v2/testcases/search', severity: 'normal' as const };
      const r = await rawCall(c, 'POST', `${tBase(c.host)}/testcases/search`, {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pageNumber: 1, pageSize: 10, sortOrder: 'DESC' }),
      });
      if (r.status === 200 && Array.isArray(r.bodyJson?.items)) return ok(base.id, base, r, `items=${r.bodyJson.items.length}`);
      return bad(base.id, base, r, `got ${r.status}`);
    },
  });
  list.push({
    id: 'testcases-export', name: 'POST /testcases/export', category: 'testcases',
    method: 'POST', endpoint: '/v2/testcases/export', severity: 'optional', longRunning: true,
    run: async (c) => {
      const base = { id: 'testcases-export', category: 'testcases' as const, method: 'POST', endpoint: '/v2/testcases/export', severity: 'optional' as const };
      if (!c.includeLongRunning) return skip(base.id, base, 'long-running (binary export); enable Long-running in opts');
      if (!c.someTestcaseId) return skip(base.id, base, 'no testcase id');
      const r = await rawCall(c, 'POST', `${tBase(c.host)}/testcases/export`, {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ testCaseIds: [c.someTestcaseId], output: { type: 'json' } }),
      });
      if (r.status === 200 || r.status === 202) return ok(base.id, base, r, `status ${r.status}`);
      return bad(base.id, base, r, `got ${r.status}`);
    },
  });

  // Integrity test: when N testcases are requested, exactly N must come back.
  // Discovered: server silently drops most of them — requesting 1048 returns ~77.
  // Counts as a critical data-loss bug (any backup/migration flow is unreliable).
  list.push({
    id: 'testcases-export-count-integrity',
    name: 'POST /testcases/export returns every requested testcase (count integrity)',
    category: 'testcases',
    method: 'POST', endpoint: '/v2/testcases/export', severity: 'critical',
    longRunning: true,
    run: async (c) => {
      const base = { id: 'testcases-export-count-integrity', category: 'testcases' as const, method: 'POST' as const, endpoint: '/v2/testcases/export', severity: 'critical' as const };
      if (!c.includeLongRunning) return skip(base.id, base, 'long-running (full export); enable Long-running in opts');

      // Fetch a batch of ids to exercise the endpoint with realistic load.
      const list = await rawCall(c, 'GET', `${tBase(c.host)}/testcases?limit=200&offset=0`);
      if (list.status !== 200) return bad(base.id, base, list, `pre-step list returned ${list.status}`);
      const ids: string[] = (list.bodyJson?.items ?? []).map((it: any) => it.id).filter(Boolean);
      if (ids.length === 0) return skip(base.id, base, 'no testcases on the box');

      // Pick a sample size that's both meaningful AND not so big that the test
      // runs forever in CI: min(50, all available). The bug reproduces at any N >= 3.
      const sample = ids.slice(0, Math.min(50, ids.length));
      const r = await rawCall(c, 'POST', `${tBase(c.host)}/testcases/export`, {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ testCaseIds: sample, output: { type: 'json' } }),
      });

      if (r.status !== 200) return bad(base.id, base, r, `export returned ${r.status} — expected 200`,
        '200 OK with the documented response body containing one entry per requested testcase id');

      // Parse and count. Documented shape: { test_case_details: [...] } per
      // observed responses; spec at lines 1111-1170 doesn't pin a name, so we
      // accept either `test_case_details`, `testCases`, or a top-level array.
      const body: any = r.bodyJson;
      const arr: any[] =
        Array.isArray(body) ? body :
        Array.isArray(body?.test_case_details) ? body.test_case_details :
        Array.isArray(body?.testCases) ? body.testCases :
        [];

      const got = arr.length;
      const want = sample.length;
      const exportedIds = new Set(arr.map((x) => x.Test_Id ?? x.id ?? x.testCaseId).filter(Boolean));
      const missing = sample.filter((id) => !exportedIds.has(id));

      if (got === want) {
        return ok(base.id, base, r, `exported ${got}/${want} testcases`);
      }
      const sampleMissing = missing.slice(0, 5).join(', ');
      return bad(base.id, base, r, `export integrity FAILED: requested ${want}, server returned ${got} (${missing.length} missing, e.g. ${sampleMissing})`,
        `200 with a body containing exactly ${want} entries — one per requested id. Server currently drops ${missing.length} of ${want} silently with no error indication, no partial-success metadata, and no warning header. Reproducible at any batch size >= 3 with output.type=json AND output.type=zip.`);
    },
  });

  // ---------- STATISTICS ----------
  // Note: OpenAPI spec puts these under `/v2/api/testcases/...` but the box
  // actually serves them at `/v2/testcases/...` (no /api/ prefix). Verified
  // by probing both forms: A returns 404, B returns 200. Using B.
  list.push({
    id: 'stats-global', name: 'GET /testcases/executions/{eid}/statistics/global', category: 'statistics',
    method: 'GET', endpoint: '/v2/testcases/executions/{eid}/statistics/global', severity: 'normal',
    run: async (c) => {
      const base = { id: 'stats-global', category: 'statistics' as const, method: 'GET', endpoint: '/v2/testcases/executions/{eid}/statistics/global', severity: 'normal' as const };
      if (!c.recentExecutionId) return skip(base.id, base, 'no execution id available');
      const end = Math.floor(Date.now() / 1000);
      const start = end - 24 * 3600;
      const r = await rawCall(c, 'GET', `${tBase(c.host)}/testcases/executions/${encodeURIComponent(c.recentExecutionId)}/statistics/global?startTime=${start}&endTime=${end}`);
      if (r.status === 200) return ok(base.id, base, r, JSON.stringify(r.bodyJson).slice(0, 100));
      if (r.status === 404) return skip(base.id, base, 'execution not found on this system (eid stale — no recent execution to validate against). Run a test and re-try.');
      return bad(base.id, base, r, `got ${r.status}`);
    },
  });
  list.push({
    id: 'stats-cells-summary', name: 'GET /testcases/executions/{eid}/statistics/cells-summary', category: 'statistics',
    method: 'GET', endpoint: '/v2/testcases/executions/{eid}/statistics/cells-summary', severity: 'normal',
    run: async (c) => {
      const base = { id: 'stats-cells-summary', category: 'statistics' as const, method: 'GET', endpoint: '/v2/testcases/executions/{eid}/statistics/cells-summary', severity: 'normal' as const };
      if (!c.recentExecutionId) return skip(base.id, base, 'no execution id available');
      const end = Math.floor(Date.now() / 1000);
      const start = end - 24 * 3600;
      const r = await rawCall(c, 'GET', `${tBase(c.host)}/testcases/executions/${encodeURIComponent(c.recentExecutionId)}/statistics/cells-summary?startTime=${start}&endTime=${end}`);
      if (r.status === 200) return ok(base.id, base, r, JSON.stringify(r.bodyJson).slice(0, 100));
      if (r.status === 404) return skip(base.id, base, 'execution not found on this system (eid stale — no recent execution to validate against). Run a test and re-try.');
      return bad(base.id, base, r, `got ${r.status}`);
    },
  });

  // Three more statistics endpoints from the spec — same path-fix (no /api/ prefix).
  for (const slug of ['cells', 'ues', 'ue-summary']) {
    list.push({
      id: `stats-${slug}`, name: `GET /testcases/executions/{eid}/statistics/${slug}`, category: 'statistics',
      method: 'GET', endpoint: `/v2/testcases/executions/{eid}/statistics/${slug}`, severity: 'normal',
      run: async (c) => {
        const base = { id: `stats-${slug}`, category: 'statistics' as const, method: 'GET' as const, endpoint: `/v2/testcases/executions/{eid}/statistics/${slug}`, severity: 'normal' as const };
        if (!c.recentExecutionId) return skip(base.id, base, 'no execution id available');
        const end = Math.floor(Date.now() / 1000);
        const start = end - 24 * 3600;
        const r = await rawCall(c, 'GET', `${tBase(c.host)}/testcases/executions/${encodeURIComponent(c.recentExecutionId)}/statistics/${slug}?startTime=${start}&endTime=${end}`);
        if (r.status === 200) return ok(base.id, base, r, JSON.stringify(r.bodyJson).slice(0, 100));
        if (r.status === 404) return skip(base.id, base, 'execution not found on this system (eid stale — no recent execution to validate against). Run a test and re-try.');
        return bad(base.id, base, r, `got ${r.status}`);
      },
    });
  }

  // Statistics + log exports (binary, long-running by default).
  for (const slug of ['cells', 'ues']) {
    list.push({
      id: `stats-${slug}-export`, name: `GET /testcases/executions/{eid}/statistics/${slug}/export`, category: 'statistics',
      method: 'GET', endpoint: `/v2/testcases/executions/{eid}/statistics/${slug}/export`, severity: 'optional', longRunning: true,
      run: async (c) => {
        const base = { id: `stats-${slug}-export`, category: 'statistics' as const, method: 'GET' as const, endpoint: `/v2/testcases/executions/{eid}/statistics/${slug}/export`, severity: 'optional' as const };
        if (!c.recentExecutionId) return skip(base.id, base, 'no execution id available');
        const r = await rawCall(c, 'GET', `${tBase(c.host)}/testcases/executions/${encodeURIComponent(c.recentExecutionId)}/statistics/${slug}/export?format=zip`);
        if (r.status === 200 || r.status === 202) return ok(base.id, base, r, `status ${r.status}`);
        if (r.status === 404) return skip(base.id, base, 'execution not found on this system (eid stale — no recent execution to validate against). Run a test and re-try.');
        return bad(base.id, base, r, `got ${r.status}`);
      },
    });
  }

  // ---------- LOGS ----------
  list.push({
    id: 'logs-fetch', name: 'GET /testcases/executions/{eid}/logs', category: 'logs',
    method: 'GET', endpoint: '/v2/testcases/executions/{eid}/logs', severity: 'normal',
    run: async (c) => {
      const base = { id: 'logs-fetch', category: 'logs' as const, method: 'GET', endpoint: '/v2/testcases/executions/{eid}/logs', severity: 'normal' as const };
      if (!c.recentExecutionId) return skip(base.id, base, 'no execution id available');
      const r = await rawCall(c, 'GET', `${tBase(c.host)}/testcases/executions/${encodeURIComponent(c.recentExecutionId)}/logs?limit=10`);
      if (r.status === 200) return ok(base.id, base, r, JSON.stringify(r.bodyJson).slice(0, 100));
      if (r.status === 404) return skip(base.id, base, 'execution not found on this system (eid stale — no recent execution to validate against). Run a test and re-try.');
      return bad(base.id, base, r, `got ${r.status}`);
    },
  });
  list.push({
    id: 'logs-export', name: 'GET /testcases/executions/{eid}/logs/export', category: 'logs',
    method: 'GET', endpoint: '/v2/testcases/executions/{eid}/logs/export', severity: 'optional', longRunning: true,
    run: async (c) => {
      const base = { id: 'logs-export', category: 'logs' as const, method: 'GET' as const, endpoint: '/v2/testcases/executions/{eid}/logs/export', severity: 'optional' as const };
      if (!c.recentExecutionId) return skip(base.id, base, 'no execution id available');
      const r = await rawCall(c, 'GET', `${tBase(c.host)}/testcases/executions/${encodeURIComponent(c.recentExecutionId)}/logs/export?format=zip`);
      if (r.status === 200 || r.status === 202) return ok(base.id, base, r, `status ${r.status}`);
      if (r.status === 404) return skip(base.id, base, 'execution not found on this system (eid stale — no recent execution to validate against). Run a test and re-try.');
      return bad(base.id, base, r, `got ${r.status}`);
    },
  });

  // ---------- NEGATIVE ----------
  list.push({
    id: 'neg-login-wrong', name: 'POST /login wrong password -> 401', category: 'negative',
    method: 'POST', endpoint: '/v2/login', severity: 'normal',
    run: async (c) => {
      const base = { id: 'neg-login-wrong', category: 'negative' as const, method: 'POST', endpoint: '/v2/login', severity: 'normal' as const };
      const r = await rawCall(null, 'POST', `${tBase(c.host)}/login`, {
        auth: 'none', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: c.username, password: 'definitely-wrong-' + Date.now() }),
      });
      if (r.status === 401) return ok(base.id, base, r, 'rejected wrong password as expected');
      return bad(base.id, base, r, `expected 401, got ${r.status}`);
    },
  });
  list.push({
    id: 'neg-no-token', name: 'GET /testcases without token -> 401', category: 'negative',
    method: 'GET', endpoint: '/v2/testcases', severity: 'normal',
    run: async (c) => {
      const base = { id: 'neg-no-token', category: 'negative' as const, method: 'GET', endpoint: '/v2/testcases', severity: 'normal' as const };
      const r = await rawCall(null, 'GET', `${tBase(c.host)}/testcases`, { auth: 'none' });
      if (r.status === 401) return ok(base.id, base, r, 'rejected unauthenticated as expected');
      return bad(base.id, base, r, `expected 401, got ${r.status}`);
    },
  });
  list.push({
    id: 'neg-bad-token', name: 'GET /testcases with bogus token -> 401', category: 'negative',
    method: 'GET', endpoint: '/v2/testcases', severity: 'normal',
    run: async (c) => {
      const base = { id: 'neg-bad-token', category: 'negative' as const, method: 'GET', endpoint: '/v2/testcases', severity: 'normal' as const };
      const r = await rawCall(c, 'GET', `${tBase(c.host)}/testcases`, { auth: 'wrong' });
      if (r.status === 401) return ok(base.id, base, r, 'rejected bogus token as expected');
      return bad(base.id, base, r, `expected 401, got ${r.status}`);
    },
  });
  list.push({
    id: 'neg-testcase-404', name: 'GET /testcases/<garbage> -> 404', category: 'negative',
    method: 'GET', endpoint: '/v2/testcases/{id}', severity: 'normal',
    run: async (c) => {
      const base = { id: 'neg-testcase-404', category: 'negative' as const, method: 'GET', endpoint: '/v2/testcases/{id}', severity: 'normal' as const };
      const r = await rawCall(c, 'GET', `${tBase(c.host)}/testcases/_simqa_does_not_exist_`);
      if (r.status === 404) return ok(base.id, base, r, '404 as expected');
      return bad(base.id, base, r, `expected 404, got ${r.status}`);
    },
  });
  list.push({
    id: 'neg-bandinfo-bad-rat', name: 'POST /band-info (rat=BOGUS) -> 400', category: 'negative',
    method: 'POST', endpoint: '/v2/band-info', severity: 'normal',
    run: async (c) => {
      const base = { id: 'neg-bandinfo-bad-rat', category: 'negative' as const, method: 'POST', endpoint: '/v2/band-info', severity: 'normal' as const };
      const r = await rawCall(c, 'POST', `${tBase(c.host)}/band-info`, {
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rat: 'BOGUS' }),
      });
      if (r.status === 400) return ok(base.id, base, r, '400 as expected');
      return bad(base.id, base, r, `expected 400, got ${r.status}`);
    },
  });

  // ---------- EXECUTIONS (live, opt-in destructive + long-running) ----------
  // Triggers a real test run on hardware. Gated on BOTH includeDestructive
  // and includeLongRunning so it never fires by accident.
  list.push({
    id: 'exec-start-stop', name: 'POST /testcases/{id}/executions then POST .stop', category: 'executions',
    method: 'POST', endpoint: '/v2/testcases/{id}/executions', severity: 'optional',
    destructive: true, longRunning: true,
    run: async (c) => {
      const base = { id: 'exec-start-stop', category: 'executions' as const, method: 'POST' as const, endpoint: '/v2/testcases/{id}/executions', severity: 'optional' as const, destructive: true };
      if (!c.someTestcaseId) return skip(base.id, base, 'no testcase id available');
      const start = await rawCall(c, 'POST', `${tBase(c.host)}/testcases/${encodeURIComponent(c.someTestcaseId)}/executions`, {
        headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      if (start.status !== 200 && start.status !== 201) return bad(base.id, base, start, `start returned ${start.status}`);
      // Give the box a beat then issue stop with executionId="current" + simulatorId.
      await new Promise((r) => setTimeout(r, 2000));
      const stop = await rawCall(c, 'POST', `${tBase(c.host)}/testcases/executions/current/stop${c.recentSimulatorId ? `?simulatorId=${encodeURIComponent(c.recentSimulatorId)}` : ''}`, {
        headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      if (stop.status !== 200) return bad(base.id, base, stop, `stop returned ${stop.status} (started=${start.status})`);
      return ok(base.id, base, start, `start=${start.status} stop=${stop.status}`);
    },
  });
  list.push({
    id: 'exec-restart', name: 'POST /testcases/executions/{eid}/restart', category: 'executions',
    method: 'POST', endpoint: '/v2/testcases/executions/{eid}/restart', severity: 'optional',
    destructive: true, longRunning: true,
    run: async (c) => {
      const base = { id: 'exec-restart', category: 'executions' as const, method: 'POST' as const, endpoint: '/v2/testcases/executions/{eid}/restart', severity: 'optional' as const, destructive: true };
      if (!c.recentExecutionId) return skip(base.id, base, 'no execution id available');
      const r = await rawCall(c, 'POST', `${tBase(c.host)}/testcases/executions/${encodeURIComponent(c.recentExecutionId)}/restart`, {
        headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      if (r.status === 200 || r.status === 202) return ok(base.id, base, r, `restart=${r.status}`);
      return bad(base.id, base, r, `expected 200/202, got ${r.status}`);
    },
  });

  // Stop-by-explicit-eid path (Dell's integration uses this form). The
  // exec-start-stop check above already validates the `current` alias which
  // shares the same server-side handler, but customers like Dell wire their
  // automation to the {executionId} variant — so we exercise that codepath
  // too. Starts a fresh execution, polls the testcase metadata briefly to
  // pick up the new executionId, then stops via the explicit id.
  list.push({
    id: 'exec-stop-by-eid', name: 'POST /testcases/{id}/executions then POST /executions/{eid}/stop',
    category: 'executions',
    method: 'POST', endpoint: '/v2/testcases/executions/{eid}/stop', severity: 'optional',
    destructive: true, longRunning: true,
    run: async (c) => {
      const base = { id: 'exec-stop-by-eid', category: 'executions' as const, method: 'POST' as const, endpoint: '/v2/testcases/executions/{eid}/stop', severity: 'optional' as const, destructive: true };
      if (!c.someTestcaseId) return skip(base.id, base, 'no testcase id available');

      // 1. Start a fresh execution.
      const start = await rawCall(c, 'POST', `${tBase(c.host)}/testcases/${encodeURIComponent(c.someTestcaseId)}/executions`, {
        headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      if (start.status !== 200 && start.status !== 201) {
        return bad(base.id, base, start, `start returned ${start.status} (system likely busy)`);
      }

      // 2. Poll the testcase metadata briefly to discover the new eid.
      let eid: string | undefined;
      for (let i = 0; i < 8 && !eid; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        const f = await rawCall(c, 'GET', `${tBase(c.host)}/testcases/${encodeURIComponent(c.someTestcaseId)}`);
        const last = f.bodyJson?.metadata?.lastExecution;
        // Treat as newly-discovered when the id differs from anything we
        // had before this check, OR when its status looks running/pending.
        if (last?.executionId && last.executionId !== c.recentExecutionId) eid = last.executionId;
        else if (last?.executionId && /running|in_progress|pending|started/i.test(last.status ?? '')) eid = last.executionId;
      }
      if (!eid) {
        // Cleanup attempt via "current" so we don't leak a live execution.
        await rawCall(c, 'POST', `${tBase(c.host)}/testcases/executions/current/stop${c.recentSimulatorId ? `?simulatorId=${encodeURIComponent(c.recentSimulatorId)}` : ''}`, {
          headers: { 'Content-Type': 'application/json' }, body: '{}',
        }).catch(() => null);
        return bad(base.id, base, start, 'could not discover new executionId within 12s of trigger');
      }

      // 3. Stop using the explicit eid path.
      const stop = await rawCall(c, 'POST', `${tBase(c.host)}/testcases/executions/${encodeURIComponent(eid)}/stop${c.recentSimulatorId ? `?simulatorId=${encodeURIComponent(c.recentSimulatorId)}` : ''}`, {
        headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      if (stop.status !== 200) return bad(base.id, base, stop, `stop-by-eid returned ${stop.status} (started ok=${start.status}, eid=${eid.slice(0,8)}…)`);
      return ok(base.id, base, stop, `start=${start.status} eid=${eid.slice(0,8)}… stop=${stop.status}`);
    },
  });

  // ---------- INTENTIONALLY-SKIPPED ENDPOINTS (documented in the audit) ----------
  // We surface these as test rows so coverage is visible — but they always
  // skip because executing them safely needs context we don't have:
  //
  //   POST /users/update-password    rotates the admin password; cannot revert.
  //   POST /testcases/import         requires a pre-built binary pack.
  //   POST /simulators (create) /
  //   PATCH /simulators/{id}         no DELETE endpoint -> can't tear down.
  //   PUT /simulators/{id}/log-settings  needs an existing log-setting id.
  const skipDef = (id: string, name: string, ep: string, method: 'POST'|'PUT'|'PATCH'|'GET'|'DELETE', reason: string, category: ApiTestCategory = 'mutating'): TestDef => ({
    id, name, category, method, endpoint: ep, severity: 'optional', destructive: true,
    run: async () => ({
      id, name, category, method, endpoint: ep, severity: 'optional',
      destructive: true, ok: true, skipped: true, skippedReason: reason,
    }),
  });
  list.push(skipDef('skip-update-password',     'POST /users/update-password',    '/v2/users/update-password',                  'POST', 'rotates admin password; no safe rollback'));
  list.push(skipDef('skip-sim-log-settings',    'PUT /simulators/{id}/log-settings', '/v2/simulators/{id}/log-settings',         'PUT', 'needs an existing log-setting id; trigger via /system/log-settings flow'));

  // Simulator full lifecycle: POST + GET status + PATCH + DELETE.
  // (Spec doesn't document DELETE /v2/simulators/{id} but the box implements it.)
  list.push({
    id: 'simulators-full-lifecycle', name: 'POST /simulators + PATCH + DELETE (throwaway)', category: 'mutating',
    method: 'POST', endpoint: '/v2/simulators (combo)', severity: 'normal', destructive: true,
    run: async (c) => {
      const base = { id: 'simulators-full-lifecycle', category: 'mutating' as const, method: 'POST' as const, endpoint: '/v2/simulators (combo)', severity: 'normal' as const, destructive: true };
      const simName = `simqa-tester-${Date.now().toString(36)}`;
      const traces: string[] = [];

      // 1. POST /v2/simulators
      const create = await rawCall(c, 'POST', `${tBase(c.host)}/simulators`, {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ simulatorName: simName, ipAddress: '10.255.255.254', type: 'UE' }),
      });
      traces.push(`create=${create.status}`);
      if (create.status !== 201 && create.status !== 200) return bad(base.id, base, create, `create returned ${create.status}`);

      // Extract the new id (response shape: { success, data: { id, ... } } per spec)
      const newId = create.bodyJson?.data?.id ?? create.bodyJson?.id;
      if (!newId) return bad(base.id, base, create, 'create succeeded but no id in response');

      // 2. GET /v2/simulators/{id}/status to confirm it exists
      const status = await rawCall(c, 'GET', `${tBase(c.host)}/simulators/${encodeURIComponent(newId)}/status`);
      traces.push(`status=${status.status}`);

      // 3. PATCH /v2/simulators/{id} - rename
      const patch = await rawCall(c, 'PATCH', `${tBase(c.host)}/simulators/${encodeURIComponent(newId)}`, {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ simulatorName: simName + '-renamed' }),
      });
      traces.push(`patch=${patch.status}`);

      // 4. DELETE /v2/simulators/{id} - cleanup. Always attempt regardless of upstream failures.
      const del = await rawCall(c, 'DELETE', `${tBase(c.host)}/simulators/${encodeURIComponent(newId)}`);
      traces.push(`delete=${del.status}`);
      if (del.status !== 204 && del.status !== 200) return bad(base.id, base, del, `delete returned ${del.status} for id=${newId}; ${traces.join(' ')}`,
        '204 NO CONTENT (resource removed) or 200 with confirmation. The DELETE endpoint should be implemented per REST conventions; the box currently 404s. Without DELETE, every POST /simulators leaks an inventory entry that has no API to remove it.');

      return ok(base.id, base, create, `id=${newId} ${traces.join(' ')}`);
    },
  });

  // ---------- SIM40-2048: block duplicate-IP simulator on create + update ----------
  // The fix: POST /v2/simulators and PATCH /v2/simulators/{id} must both
  // reject an IP that's already in use by another simulator, with 4xx
  // (suggested 409 CONFLICT). Previously: silent success → duplicate rows.
  list.push({
    id: 'sim40-2048-block-duplicate-simulator-ip',
    name: 'SIM40-2048: POST /simulators with duplicate ipAddress is rejected with 4xx',
    category: 'mutating', method: 'POST', endpoint: '/v2/simulators (duplicate-ip)', severity: 'normal', destructive: true,
    run: async (c) => {
      const base = { id: 'sim40-2048-block-duplicate-simulator-ip', category: 'mutating' as const, method: 'POST' as const, endpoint: '/v2/simulators (duplicate-ip)', severity: 'normal' as const, destructive: true };
      const sharedIp = '10.255.255.253';
      const name1 = `simqa-dup-a-${Date.now().toString(36)}`;
      const name2 = `simqa-dup-b-${Date.now().toString(36)}`;
      const create1 = await rawCall(c, 'POST', `${tBase(c.host)}/simulators`, {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ simulatorName: name1, ipAddress: sharedIp, type: 'UE' }),
      });
      if (create1.status !== 200 && create1.status !== 201) return bad(base.id, base, create1, `seed create returned ${create1.status} — cannot test duplicate-IP rejection without a baseline sim`);
      const id1 = create1.bodyJson?.data?.id ?? create1.bodyJson?.id;
      // Now attempt a second create with the SAME IP — must be rejected.
      const create2 = await rawCall(c, 'POST', `${tBase(c.host)}/simulators`, {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ simulatorName: name2, ipAddress: sharedIp, type: 'UE' }),
      });
      // Cleanup the second one if it landed (unexpected), and the first.
      const id2Maybe = create2.bodyJson?.data?.id ?? create2.bodyJson?.id;
      if (id2Maybe) await rawCall(c, 'DELETE', `${tBase(c.host)}/simulators/${encodeURIComponent(id2Maybe)}`);
      if (id1) await rawCall(c, 'DELETE', `${tBase(c.host)}/simulators/${encodeURIComponent(id1)}`);
      const status = create2.status;
      const isReject = status >= 400 && status < 500;
      const detailMsg = `first-create=${create1.status} dup-create=${status} (${isReject ? 'rejected, as required' : 'ACCEPTED — duplicate-IP block missing'})`;
      if (isReject) return ok(base.id, base, create2, detailMsg);
      return bad(base.id, base, create2, detailMsg, 'a second POST with an already-used ipAddress must be rejected with 4xx (409 CONFLICT preferred).');
    },
  });

  // ---------- SIM40-2049: DELETE /v2/simulators/{id} is the canonical endpoint ----------
  // The fix: the simulator-delete API is now exclusively under /v2 (the
  // /v1 path is gone). Verify that /v2 delete returns 200/204 on a real
  // sim, and that calling /v1 returns 404 (i.e. the legacy route is gone).
  list.push({
    id: 'sim40-2049-delete-v2-simulators-canonical',
    name: 'SIM40-2049: DELETE /v2/simulators/{id} works AND legacy /v1 path is gone',
    category: 'mutating', method: 'DELETE', endpoint: '/v2/simulators/{id} (v1 vs v2)', severity: 'normal', destructive: true,
    run: async (c) => {
      const base = { id: 'sim40-2049-delete-v2-simulators-canonical', category: 'mutating' as const, method: 'DELETE' as const, endpoint: '/v2/simulators/{id} (v1 vs v2)', severity: 'normal' as const, destructive: true };
      const name = `simqa-v2del-${Date.now().toString(36)}`;
      const create = await rawCall(c, 'POST', `${tBase(c.host)}/simulators`, {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ simulatorName: name, ipAddress: '10.255.255.252', type: 'UE' }),
      });
      if (create.status !== 200 && create.status !== 201) return bad(base.id, base, create, `seed create returned ${create.status}`);
      const id = create.bodyJson?.data?.id ?? create.bodyJson?.id;
      if (!id) return bad(base.id, base, create, 'seed create succeeded but no id in response');

      // 1) DELETE /v2/simulators/{id} should work.
      const delV2 = await rawCall(c, 'DELETE', `${tBase(c.host)}/simulators/${encodeURIComponent(id)}`);
      const v2Ok = delV2.status === 200 || delV2.status === 204;

      // 2) Probe /v1/simulators/{id} — should be 404 (route removed).
      // Recreate a temp sim for the v1 probe so we have a target id.
      const create2 = await rawCall(c, 'POST', `${tBase(c.host)}/simulators`, {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ simulatorName: name + '-v1probe', ipAddress: '10.255.255.251', type: 'UE' }),
      });
      const id2 = create2.bodyJson?.data?.id ?? create2.bodyJson?.id;
      let v1Status: number | undefined;
      if (id2) {
        // Replace `/v2/` with `/v1/` in the base URL.
        const v1Url = `${tBase(c.host).replace('/v2', '/v1')}/simulators/${encodeURIComponent(id2)}`;
        const delV1 = await rawCall(c, 'DELETE', v1Url);
        v1Status = delV1.status;
        // Cleanup id2 via v2.
        await rawCall(c, 'DELETE', `${tBase(c.host)}/simulators/${encodeURIComponent(id2)}`);
      }
      const v1Gone = v1Status === undefined || v1Status === 404 || v1Status === 405;
      const summary = `v2-delete=${delV2.status} v1-probe=${v1Status ?? 'skipped'} (${v2Ok && v1Gone ? 'v2 canonical, v1 gone' : 'unexpected'})`;
      if (v2Ok && v1Gone) return ok(base.id, base, delV2, summary);
      return bad(base.id, base, delV2, summary, 'DELETE /v2/simulators/{id} must return 2xx; /v1/simulators/{id} must be removed (404/405).');
    },
  });

  // ---------- TESTCASE IMPORT / ROUND-TRIP / VALIDATION ----------
  //
  // The /testcases/import wire format (confirmed by /testcases/export) is:
  //
  //   { test_case_details: [{
  //       Test_Id, Test_Name, Log_Settings_Id, Creator_Id, Modifier_Id, State,
  //       Test_Config_Intermediate_Object, Config_File: { config }, Type, ...
  //   }] }
  //
  // GET /testcases/{id} returns a different shape ({ id, name, testDefinition })
  // and is NOT a valid import payload. So a round-trip must use export -> import.
  //
  // Shared helpers used by the tests below.

  /** Pull a real testcase via /testcases/export to use as the seed pack. */
  async function fetchSeedExport(c: RunCtx): Promise<{ pack?: any; seedId?: string; seedName?: string; err?: string; status?: number }> {
    let seed = c.someTestcaseId;
    if (!seed) {
      const lst = await rawCall(c, 'GET', `${tBase(c.host)}/testcases?limit=1&offset=0`);
      seed = lst.bodyJson?.items?.[0]?.id;
      if (!seed) return { err: 'no testcases on the box to seed from' };
      c.someTestcaseId = seed;
    }
    const exp = await rawCall(c, 'POST', `${tBase(c.host)}/testcases/export`, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ testCaseIds: [seed], output: { type: 'json' } }),
    });
    const detail = exp.bodyJson?.test_case_details?.[0];
    if (exp.status !== 200 || !detail) return { err: `seed export returned ${exp.status}`, status: exp.status };
    return { pack: exp.bodyJson, seedId: seed, seedName: detail.Test_Name };
  }

  /** Clone an export pack and apply Test_Id / Test_Name overrides (or deletes). */
  function makePack(seed: any, overrides: Record<string, any> = {}, deletes: string[] = []): any {
    const cloned = JSON.parse(JSON.stringify(seed));
    const detail = cloned.test_case_details[0];
    delete detail.Created_Date;
    delete detail.Modified_Date;
    delete detail.Deleted_Date;
    for (const [k, v] of Object.entries(overrides)) detail[k] = v;
    for (const k of deletes) delete detail[k];
    return cloned;
  }

  /** POST /testcases/import as multipart/form-data. Returns evidence + parsed body. */
  async function postImport(host: string, token: string, pack: any, packLabel: string): Promise<{ status: number; ms: number; bodyJson: any; bodyText: string; landedIds: string[]; request: ApiRequestEvidence; response: ApiResponseEvidence }> {
    const blob = new Blob([JSON.stringify(pack)], { type: 'application/json' });
    const form = new FormData();
    form.append('file', blob, 'pack.json');
    const url = `${tBase(host)}/testcases/import`;
    const t0 = Date.now();
    const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
    const ms = Date.now() - t0;
    const bodyText = await res.text().catch(() => '');
    let bodyJson: any;
    try { bodyJson = bodyText ? JSON.parse(bodyText) : undefined; } catch { /* keep text */ }
    const arr: any[] = bodyJson?.testCases ?? bodyJson?.imported ?? bodyJson?.test_case_details ?? [];
    const landedIds: string[] = arr.map((x: any) => x?.id ?? x?.Test_Id ?? x?.testCaseId).filter(Boolean);
    const truncResp = truncate(bodyText);
    return {
      status: res.status, ms, bodyJson, bodyText, landedIds,
      request: { method: 'POST', url, headers: { Authorization: 'Bearer <REDACTED>', 'Content-Type': 'multipart/form-data; boundary=...' }, body: `<JSON pack: ${packLabel}>` },
      response: { status: res.status, statusText: res.statusText, headers: headersToObject(res.headers), body: truncResp.body, bodyTruncated: truncResp.truncated, contentType: res.headers.get('content-type') ?? undefined, durationMs: ms },
    };
  }

  /** Deep diff helper for round-trip equality. */
  function deepDiff(a: any, b: any, p = ''): string[] {
    const d: string[] = [];
    if (a === b) return d;
    if (typeof a !== typeof b) { d.push(`${p}: type ${typeof a}->${typeof b}`); return d; }
    if (a === null || b === null || typeof a !== 'object') { if (a !== b) d.push(`${p}: ${JSON.stringify(a)?.slice(0, 60)} -> ${JSON.stringify(b)?.slice(0, 60)}`); return d; }
    if (Array.isArray(a) !== Array.isArray(b)) { d.push(`${p}: array<->object`); return d; }
    if (Array.isArray(a)) {
      if (a.length !== b.length) d.push(`${p}: array len ${a.length}->${b.length}`);
      for (let i = 0; i < Math.max(a.length, b.length); i++) d.push(...deepDiff(a[i], b[i], `${p}[${i}]`));
      return d;
    }
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      if (!(k in a)) { d.push(`${p}.${k}: <missing> -> ${JSON.stringify(b[k]).slice(0, 60)}`); continue; }
      if (!(k in b)) { d.push(`${p}.${k}: ${JSON.stringify(a[k]).slice(0, 60)} -> <missing>`); continue; }
      d.push(...deepDiff(a[k], b[k], `${p}.${k}`));
    }
    return d;
  }

  // ---------- testcases-import-delete (fixed wire format) ----------
  // Imports a tweaked-id copy of a real testcase using the export-shape wire
  // format, then attempts DELETE. Currently fails on DELETE (SIM40-2016) and
  // leaks an inventory entry every run.
  list.push({
    id: 'testcases-import-delete', name: 'POST /testcases/import + DELETE (throwaway copy)', category: 'mutating',
    method: 'POST', endpoint: '/v2/testcases/import (combo)', severity: 'normal', destructive: true, longRunning: true,
    run: async (c) => {
      const base = { id: 'testcases-import-delete', category: 'mutating' as const, method: 'POST' as const, endpoint: '/v2/testcases/import (combo)', severity: 'normal' as const, destructive: true };
      const traces: string[] = [];

      const seedR = await fetchSeedExport(c);
      if (!seedR.pack) return seedR.err === 'no testcases on the box to seed from'
        ? skip(base.id, base, seedR.err)
        : bad(base.id, base, { status: seedR.status ?? 0, ms: 0, request: { method: 'POST', url: `${tBase(c.host)}/testcases/export`, headers: {} } }, seedR.err ?? 'seed export failed');
      traces.push(`seed-export=200`);

      const newId = `simqa-import-${Date.now().toString(36)}`;
      const pack = makePack(seedR.pack, { Test_Id: newId, Test_Name: newId });
      const imp = await postImport(c.host, c.token, pack, `Test_Id=${newId}`);
      traces.push(`import=${imp.status}`);
      if (imp.status < 200 || imp.status >= 300) return bad(base.id, base, imp, `import returned ${imp.status}: ${imp.bodyText.slice(0, 200)}`,
        '200 with importedCount and a testCases array reflecting the imported records');

      const landedId = imp.landedIds[0] ?? newId;

      const verify = await rawCall(c, 'GET', `${tBase(c.host)}/testcases/${encodeURIComponent(landedId)}`);
      traces.push(`verify=${verify.status}`);

      const del = await rawCall(c, 'DELETE', `${tBase(c.host)}/testcases/${encodeURIComponent(landedId)}`);
      traces.push(`delete=${del.status}`);
      if (del.status !== 204 && del.status !== 200) {
        return bad(base.id, base, del, `delete returned ${del.status} for id=${landedId}; ${traces.join(' ')}`,
          '204 NO CONTENT (resource removed) per REST conventions. The DELETE endpoint is currently not implemented (SIM40-2016) — every import leaks a testcase row.');
      }
      return ok(base.id, base, imp, `${landedId}: ${traces.join(' ')}`);
    },
  });

  // ---------- testcases-roundtrip-rename ----------
  // Full round-trip: export a real testcase, change Test_Id/Test_Name, import,
  // GET, re-export, deep-equal Test_Config_Intermediate_Object. Catches any
  // silent mutation of the testDefinition payload.
  list.push({
    id: 'testcases-roundtrip-rename', name: 'export -> rename -> import -> GET -> re-export -> deep-equal', category: 'mutating',
    method: 'POST', endpoint: '/v2/testcases/import (round-trip)', severity: 'critical', destructive: true, longRunning: true,
    run: async (c) => {
      const base = { id: 'testcases-roundtrip-rename', category: 'mutating' as const, method: 'POST' as const, endpoint: '/v2/testcases/import (round-trip)', severity: 'critical' as const, destructive: true };
      const traces: string[] = [];

      const seedR = await fetchSeedExport(c);
      if (!seedR.pack) return seedR.err === 'no testcases on the box to seed from'
        ? skip(base.id, base, seedR.err)
        : bad(base.id, base, { status: seedR.status ?? 0, ms: 0, request: { method: 'POST', url: `${tBase(c.host)}/testcases/export`, headers: {} } }, seedR.err ?? 'seed export failed');
      traces.push(`seed-export=200`);

      const newId = `simqa-rt-${Date.now().toString(36)}`;
      const newName = `${newId}_renamed`;
      const pack = makePack(seedR.pack, { Test_Id: newId, Test_Name: newName });
      const imp = await postImport(c.host, c.token, pack, `Test_Id=${newId}`);
      traces.push(`import=${imp.status}`);
      if (imp.status < 200 || imp.status >= 300) return bad(base.id, base, imp, `import returned ${imp.status}: ${imp.bodyText.slice(0, 200)}`,
        '200 with importedCount and the renamed testcase in testCases[]');

      const landedId = imp.landedIds[0] ?? newId;

      const get = await rawCall(c, 'GET', `${tBase(c.host)}/testcases/${encodeURIComponent(landedId)}`);
      traces.push(`get=${get.status}`);
      if (get.status !== 200) return bad(base.id, base, get, `GET returned ${get.status} for ${landedId}; ${traces.join(' ')}`,
        '200 (imported testcase retrievable by reported id). 404 here means the import response lied about success — see SIM40-2021.');

      if (get.bodyJson?.name !== newName) return bad(base.id, base, get, `name mismatch: sent "${newName}" got "${get.bodyJson?.name}"; ${traces.join(' ')}`,
        `the GET response .name field must equal the Test_Name we sent on import ("${newName}")`);

      const expBack = await rawCall(c, 'POST', `${tBase(c.host)}/testcases/export`, {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ testCaseIds: [landedId], output: { type: 'json' } }),
      });
      traces.push(`re-export=${expBack.status}`);
      const detailBack = expBack.bodyJson?.test_case_details?.[0];
      if (!detailBack) return bad(base.id, base, expBack, `re-export found no detail for ${landedId}; ${traces.join(' ')}`,
        'export must return the testcase we just imported (one entry in test_case_details)');

      const detailSent = (pack as any).test_case_details[0];
      const tdDiffs = deepDiff(detailSent.Test_Config_Intermediate_Object, detailBack.Test_Config_Intermediate_Object, 'Test_Config_Intermediate_Object');
      if (tdDiffs.length > 0) return bad(base.id, base, expBack, `Test_Config_Intermediate_Object diverged across round-trip: ${tdDiffs.slice(0, 3).join(' | ')}`,
        'every field of Test_Config_Intermediate_Object that we uploaded comes back byte-identical when re-exported');

      return ok(base.id, base, imp, `${landedId}: ${traces.join(' ')}, deep-equal OK`);
    },
  });

  // ---------- testcases-delete-frees-name (SIM40-2293) ----------
  // Soft-delete keeps the name reserved: create -> delete -> recreate the SAME
  // name must store the exact name again, not auto-suffix "_copy". Customers
  // automate create/delete/recreate cycles and then look the case up by name.
  list.push({
    id: 'testcases-delete-frees-name', name: 'DELETE frees the testcase name for reuse (create -> delete -> recreate)', category: 'mutating',
    method: 'POST', endpoint: '/v2/testcases/import (delete/recreate)', severity: 'normal', destructive: true, longRunning: true,
    run: async (c) => {
      const base = { id: 'testcases-delete-frees-name', category: 'mutating' as const, method: 'POST' as const, endpoint: '/v2/testcases/import (delete/recreate)', severity: 'normal' as const, destructive: true };
      const traces: string[] = [];
      const seedR = await fetchSeedExport(c);
      if (!seedR.pack) return skip(base.id, base, seedR.err ?? 'no seed');

      const name = `simqa-delfree-${Date.now().toString(36)}`;
      const expected = `after DELETE, re-importing the same name stores it verbatim ("${name}"), not an auto-suffixed "_copy". Soft-deleted rows must not reserve names (SIM40-2293).`;

      // 1. create
      const imp1 = await postImport(c.host, c.token, makePack(seedR.pack, { Test_Id: name, Test_Name: name }), `Test_Name=${name}`);
      traces.push(`create=${imp1.status}`);
      if (imp1.status < 200 || imp1.status >= 300) return bad(base.id, base, imp1, `initial import returned ${imp1.status}`, expected);
      const id1 = imp1.landedIds[0] ?? name;

      // 2. delete
      const del1 = await rawCall(c, 'DELETE', `${tBase(c.host)}/testcases/${encodeURIComponent(id1)}`);
      traces.push(`delete=${del1.status}`);
      if (del1.status !== 200 && del1.status !== 204) return bad(base.id, base, del1, `DELETE returned ${del1.status}; ${traces.join(' ')}`, expected);

      // 3. recreate same name + verify the stored name
      const imp2 = await postImport(c.host, c.token, makePack(seedR.pack, { Test_Id: name, Test_Name: name }), `Test_Name=${name} (recreate)`);
      traces.push(`recreate=${imp2.status}`);
      const id2 = imp2.landedIds[0];
      let storedName: string | undefined;
      if (id2) {
        const g = await rawCall(c, 'GET', `${tBase(c.host)}/testcases/${encodeURIComponent(id2)}`);
        storedName = g.bodyJson?.name;
        traces.push(`get=${g.status} name="${storedName}"`);
        // best-effort cleanup of the recreate (the original is already deleted)
        await rawCall(c, 'DELETE', `${tBase(c.host)}/testcases/${encodeURIComponent(id2)}`).catch(() => null);
      }
      if (imp2.status < 200 || imp2.status >= 300) return bad(base.id, base, imp2, `recreate import returned ${imp2.status}; ${traces.join(' ')}`, expected);
      if (storedName !== name) return bad(base.id, base, imp2, `name NOT freed by delete: recreate stored as "${storedName}" instead of "${name}" (soft-deleted row still reserves it); ${traces.join(' ')}`, expected);
      return ok(base.id, base, imp2, `${traces.join(' ')} — name reused verbatim`);
    },
  });

  // ---------- testcases-nbiot-definition-completeness (SIM40-2311/2312) ----------
  // NB-IoT definitions must carry the fields the UE config generator needs:
  // a ueCategory (nb1/nb2) per subscriber group and a deployment/operation
  // mode (standalone / in-band / guard-band). The GUI currently loses the
  // deployment mode entirely (SIM40-2312), which downstream produces
  // unbootable NB-IoT configs (SIM40-2311).
  list.push({
    id: 'testcases-nbiot-definition-completeness', name: 'NB-IoT testcase definitions carry ueCategory + deployment mode', category: 'testcases',
    method: 'GET', endpoint: '/v2/testcases/{id} (nbiot)', severity: 'normal', longRunning: true,
    run: async (c) => {
      const base = { id: 'testcases-nbiot-definition-completeness', category: 'testcases' as const, method: 'GET' as const, endpoint: '/v2/testcases/{id} (nbiot)', severity: 'normal' as const };
      const listR = await rawCall(c, 'GET', `${tBase(c.host)}/testcases?limit=1000`);
      if (listR.status !== 200) return bad(base.id, base, listR, `testcase list returned ${listR.status}`);
      const items: any[] = listR.bodyJson?.items ?? [];
      // Prefer name-matched candidates; fall back to probing a few definitions.
      const byName = items.filter((x) => /nb-?iot|nbiot|nb[12]\b/i.test(String(x?.name ?? '')));
      const probeList = (byName.length ? byName : items).slice(0, byName.length ? 5 : 12);
      const nbiot: Array<{ name: string; td: any }> = [];
      for (const it of probeList) {
        const g = await rawCall(c, 'GET', `${tBase(c.host)}/testcases/${encodeURIComponent(it.id)}`);
        const td = g.bodyJson?.testDefinition;
        if (String(td?.cellConfig?.master?.ratType ?? '').toLowerCase() === 'nbiot') nbiot.push({ name: it.name, td });
        if (nbiot.length >= 3) break;
      }
      if (!nbiot.length) return skip(base.id, base, 'no NB-IoT testcase on the box to inspect');
      const expected = 'every NB-IoT definition carries subsConfig.subs[].ueCategory (nb1/nb2) and a cell deployment/operation mode (standalone / in-band / guard-band). Missing mode = SIM40-2312; it downstream yields unbootable UE configs (SIM40-2311).';
      const problems: string[] = [];
      for (const { name, td } of nbiot) {
        const subs: any[] = td?.subsConfig?.subs ?? [];
        const missingCat = subs.length === 0 || subs.some((s) => !/nb/i.test(String(s?.ueCategory ?? '')));
        if (missingCat) problems.push(`"${name}": ueCategory missing/non-NB on at least one subscriber group`);
        const cells: any[] = td?.cellConfig?.cells ?? [];
        const master = td?.cellConfig?.master ?? {};
        const hasMode = [master, ...cells].some((o) => Object.entries(o ?? {}).some(([k, v]) =>
          (/operation|deployment/i.test(k) && v) ||
          (/^cellType$/i.test(k) && /standalone|in.?band|guard/i.test(String(v)))));
        if (!hasMode) problems.push(`"${name}": no deployment/operation mode field (standalone/in-band/guard-band) anywhere in the definition`);
      }
      if (problems.length) return bad(base.id, base, listR, `${problems.length} NB-IoT definition gap(s): ${problems.slice(0, 4).join('; ')}`, expected);
      return ok(base.id, base, listR, `${nbiot.length} NB-IoT definition(s) carry ueCategory + deployment mode`);
    },
  });

  // Distinguish a validation 400 ("Test_Name is required") from a collision
  // 400 ("name already exists") for the validation tests below. A collision
  // 400 means the bad name was previously accepted on this box - which itself
  // is evidence the validation rule is missing - so it should not be treated
  // as a pass.
  function isCollisionMessage(msg: any): boolean {
    return typeof msg === 'string' && msg.toLowerCase().includes('already exists');
  }

  // ---------- testcases-import-empty-name (SIM40-2021) ----------
  // The validator should reject Test_Name="". Currently returns 200, then GET
  // 404s - the record becomes a ghost.
  list.push({
    id: 'testcases-import-empty-name', name: 'POST /testcases/import with Test_Name="" must be rejected (SIM40-2021)', category: 'mutating',
    method: 'POST', endpoint: '/v2/testcases/import (validation)', severity: 'critical', destructive: true,
    run: async (c) => {
      const base = { id: 'testcases-import-empty-name', category: 'mutating' as const, method: 'POST' as const, endpoint: '/v2/testcases/import (validation)', severity: 'critical' as const, destructive: true };
      const seedR = await fetchSeedExport(c);
      if (!seedR.pack) return skip(base.id, base, seedR.err ?? 'no seed');
      const newId = `simqa-empty-name-${Date.now().toString(36)}`;
      const pack = makePack(seedR.pack, { Test_Id: newId, Test_Name: '' });
      const imp = await postImport(c.host, c.token, pack, `Test_Id=${newId} Test_Name=""`);
      const expected = '400 BAD_REQUEST {"code":"INVALID_REQUEST","message":"Test_Name is required and must be non-empty after trimming"}. Currently returns 200 + ghost record (SIM40-2021).';
      if (imp.status >= 200 && imp.status < 300) return bad(base.id, base, imp, `200 - empty Test_Name accepted (validation gap, ghost record on box)`, expected);
      if (imp.status >= 500) return bad(base.id, base, imp, `5xx - server crashed on empty Test_Name`, expected);
      if (imp.status === 400 && isCollisionMessage(imp.bodyJson?.message)) return bad(base.id, base, imp, `400 but reason is "already exists" - proves a prior import did accept Test_Name="". Validation gap still real (SIM40-2021).`, expected);
      if (imp.status >= 400 && imp.status < 500) return ok(base.id, base, imp, `rejected with ${imp.status}: ${imp.bodyJson?.message ?? ''}`);
      return bad(base.id, base, imp, `unexpected ${imp.status}`, expected);
    },
  });

  // ---------- testcases-import-empty-id (SIM40-2021) ----------
  list.push({
    id: 'testcases-import-empty-id', name: 'POST /testcases/import with Test_Id="" must be rejected (SIM40-2021)', category: 'mutating',
    method: 'POST', endpoint: '/v2/testcases/import (validation)', severity: 'critical', destructive: true,
    run: async (c) => {
      const base = { id: 'testcases-import-empty-id', category: 'mutating' as const, method: 'POST' as const, endpoint: '/v2/testcases/import (validation)', severity: 'critical' as const, destructive: true };
      const seedR = await fetchSeedExport(c);
      if (!seedR.pack) return skip(base.id, base, seedR.err ?? 'no seed');
      const pack = makePack(seedR.pack, { Test_Id: '', Test_Name: `simqa-empty-id-${Date.now().toString(36)}` });
      const imp = await postImport(c.host, c.token, pack, `Test_Id="" Test_Name=...`);
      const expected = '400 BAD_REQUEST {"code":"INVALID_REQUEST","message":"Test_Id is required and must be non-empty after trimming"}. Currently returns 200 with a record stored under id="" - collisions and unaddressable rows ahead (SIM40-2021).';
      if (imp.status >= 200 && imp.status < 300) return bad(base.id, base, imp, `200 - empty Test_Id accepted (validation gap)`, expected);
      if (imp.status >= 500) return bad(base.id, base, imp, `5xx - server crashed on empty Test_Id`, expected);
      if (imp.status === 400 && isCollisionMessage(imp.bodyJson?.message)) return bad(base.id, base, imp, `400 but reason is "already exists" - the empty-id row from a prior accepted import is what's blocking this. Validation gap still real (SIM40-2021).`, expected);
      if (imp.status >= 400 && imp.status < 500) return ok(base.id, base, imp, `rejected with ${imp.status}: ${imp.bodyJson?.message ?? ''}`);
      return bad(base.id, base, imp, `unexpected ${imp.status}`, expected);
    },
  });

  // ---------- testcases-import-whitespace-name (SIM40-2021) ----------
  list.push({
    id: 'testcases-import-whitespace-name', name: 'POST /testcases/import with Test_Name="   " must be rejected (SIM40-2021)', category: 'mutating',
    method: 'POST', endpoint: '/v2/testcases/import (validation)', severity: 'normal', destructive: true,
    run: async (c) => {
      const base = { id: 'testcases-import-whitespace-name', category: 'mutating' as const, method: 'POST' as const, endpoint: '/v2/testcases/import (validation)', severity: 'normal' as const, destructive: true };
      const seedR = await fetchSeedExport(c);
      if (!seedR.pack) return skip(base.id, base, seedR.err ?? 'no seed');
      const newId = `simqa-ws-name-${Date.now().toString(36)}`;
      const pack = makePack(seedR.pack, { Test_Id: newId, Test_Name: '   ' });
      const imp = await postImport(c.host, c.token, pack, `Test_Id=${newId} Test_Name="   "`);
      const expected = '400 BAD_REQUEST: Test_Name must be non-empty after trimming whitespace. Currently returns 200; log_filename ends up as "/tmp/   .log" (SIM40-2021).';
      if (imp.status >= 200 && imp.status < 300) return bad(base.id, base, imp, `200 - whitespace-only Test_Name accepted`, expected);
      if (imp.status === 400 && isCollisionMessage(imp.bodyJson?.message)) return bad(base.id, base, imp, `400 but reason is "already exists" - prior import accepted Test_Name="   ". Validation gap still real (SIM40-2021).`, expected);
      if (imp.status >= 400 && imp.status < 500) return ok(base.id, base, imp, `rejected with ${imp.status}: ${imp.bodyJson?.message ?? ''}`);
      return bad(base.id, base, imp, `unexpected ${imp.status}`, expected);
    },
  });

  // ---------- testcases-import-xss-name (SIM40-2020) ----------
  // The Test_Name field accepts arbitrary HTML/script and stores it verbatim;
  // a UI rendering the name without escaping is XSS-vulnerable. Test passes
  // when the API rejects unsafe characters with 400 (and not because of a
  // prior collision).
  list.push({
    id: 'testcases-import-xss-name', name: 'POST /testcases/import with <script> in Test_Name must be rejected (SIM40-2020)', category: 'mutating',
    method: 'POST', endpoint: '/v2/testcases/import (security)', severity: 'critical', destructive: true,
    run: async (c) => {
      const base = { id: 'testcases-import-xss-name', category: 'mutating' as const, method: 'POST' as const, endpoint: '/v2/testcases/import (security)', severity: 'critical' as const, destructive: true };
      const seedR = await fetchSeedExport(c);
      if (!seedR.pack) return skip(base.id, base, seedR.err ?? 'no seed');
      const newId = `simqa-xss-${Date.now().toString(36)}`;
      const xssName = '../../etc/passwd<script>alert(1)</script>';
      const pack = makePack(seedR.pack, { Test_Id: newId, Test_Name: xssName });
      const imp = await postImport(c.host, c.token, pack, `Test_Id=${newId} Test_Name=<XSS>`);
      const expected = '400 BAD_REQUEST: Test_Name contains illegal characters. Currently 200 - the script tag is stored verbatim and returned unescaped on GET, exposing any web UI rendering the name to stored XSS (SIM40-2020).';
      if (imp.status >= 200 && imp.status < 300) return bad(base.id, base, imp, `200 - <script> in Test_Name accepted (stored XSS vector)`, expected);
      if (imp.status === 400 && isCollisionMessage(imp.bodyJson?.message)) return bad(base.id, base, imp, `400 but reason is "already exists" - the script-tag name is already in the database, meaning a prior import accepted it. Stored XSS confirmed (SIM40-2020).`, expected);
      if (imp.status >= 400 && imp.status < 500) return ok(base.id, base, imp, `rejected with ${imp.status} (good): ${imp.bodyJson?.message ?? ''}`);
      return bad(base.id, base, imp, `unexpected ${imp.status}`, expected);
    },
  });

  // ---------- testcases-import-missing-name-error (SIM40-2022) ----------
  // When Test_Name is omitted the server returns 400 but with the wrong error
  // message ("Test case already exists"). Test passes when the message names
  // the actual problem (a missing field).
  list.push({
    id: 'testcases-import-missing-name-error', name: 'POST /testcases/import without Test_Name must return a "field required" error (SIM40-2022)', category: 'mutating',
    method: 'POST', endpoint: '/v2/testcases/import (diagnostics)', severity: 'normal', destructive: true,
    run: async (c) => {
      const base = { id: 'testcases-import-missing-name-error', category: 'mutating' as const, method: 'POST' as const, endpoint: '/v2/testcases/import (diagnostics)', severity: 'normal' as const, destructive: true };
      const seedR = await fetchSeedExport(c);
      if (!seedR.pack) return skip(base.id, base, seedR.err ?? 'no seed');
      const newId = `simqa-no-name-${Date.now().toString(36)}`;
      const pack = makePack(seedR.pack, { Test_Id: newId }, ['Test_Name']);
      const imp = await postImport(c.host, c.token, pack, `Test_Id=${newId} Test_Name=<omitted>`);
      const expected = '400 with code=INVALID_REQUEST and a message naming Test_Name as the missing field. Must NOT contain "already exists" — that message is misleading (SIM40-2022).';
      if (imp.status !== 400) return bad(base.id, base, imp, `expected 400, got ${imp.status}`, expected);
      const msg = String(imp.bodyJson?.message ?? '').toLowerCase();
      if (msg.includes('already exists')) return bad(base.id, base, imp, `400 but message claims the testcase "already exists" — the real problem is the missing Test_Name field`, expected);
      if (!msg.includes('test_name') && !msg.includes('name is required') && !msg.includes('name must')) return bad(base.id, base, imp, `400 but message does not mention Test_Name; got: ${imp.bodyJson?.message}`, expected);
      return ok(base.id, base, imp, `400 with helpful message: ${imp.bodyJson?.message}`);
    },
  });

  // ---------- testcases-import-collision-status (SIM40-2022) ----------
  // Importing with a Test_Id that already exists should return 409 CONFLICT,
  // not 400. Currently 400.
  list.push({
    id: 'testcases-import-collision-status', name: 'POST /testcases/import with existing Test_Id must return 409 CONFLICT (SIM40-2022)', category: 'mutating',
    method: 'POST', endpoint: '/v2/testcases/import (http-semantics)', severity: 'optional', destructive: true,
    run: async (c) => {
      const base = { id: 'testcases-import-collision-status', category: 'mutating' as const, method: 'POST' as const, endpoint: '/v2/testcases/import (http-semantics)', severity: 'optional' as const, destructive: true };
      const seedR = await fetchSeedExport(c);
      if (!seedR.pack || !seedR.seedId) return skip(base.id, base, seedR.err ?? 'no seed');
      const pack = makePack(seedR.pack, { Test_Id: seedR.seedId, Test_Name: `simqa-collide-${Date.now().toString(36)}` });
      const imp = await postImport(c.host, c.token, pack, `Test_Id=${seedR.seedId} (collision)`);
      const expected = '409 CONFLICT — REST convention for "request well-formed but resource state prevents it". Currently returns 400 (SIM40-2022).';
      if (imp.status === 409) return ok(base.id, base, imp, `409 CONFLICT (good)`);
      if (imp.status === 400) return bad(base.id, base, imp, `400 — should be 409 for resource collision`, expected);
      if (imp.status >= 200 && imp.status < 300) return bad(base.id, base, imp, `${imp.status} — collision should not succeed; check seed wasn't overwritten`, expected);
      return bad(base.id, base, imp, `unexpected ${imp.status}`, expected);
    },
  });

  // ---------- TEST-CREATOR (/tests/* config builder) ----------
  // How a test case is actually authored: POST /tests/cells initialises a case
  // and returns its testCaseId, then each section is bound in dependency order.
  // These read-only checks GET the sections of an existing case; the full
  // create → configure → delete flow is `tc-create-lifecycle` below.
  list.push({
    id: 'tc-cells-get', name: 'GET /tests/{id}/cells', category: 'test-creator',
    method: 'GET', endpoint: '/v2/tests/{id}/cells', severity: 'normal',
    run: async (c) => {
      const base = { id: 'tc-cells-get', category: 'test-creator' as const, method: 'GET' as const, endpoint: '/v2/tests/{id}/cells', severity: 'normal' as const };
      if (!c.someTestcaseId) return skip(base.id, base, 'no testcase id (run testcases-list first)');
      const r = await rawCall(c, 'GET', `${tBase(c.host)}/tests/${encodeURIComponent(c.someTestcaseId)}/cells`);
      if (r.status === 200 && r.bodyJson?.cellConfig) return ok(base.id, base, r, `cellConfig present (${r.bodyJson.cellConfig?.cells?.length ?? '?'} cell(s))`);
      return bad(base.id, base, r, `expected 200 with cellConfig, got ${r.status}`);
    },
  });
  for (const slug of ['subscribers', 'user-plane', 'power-cycle', 'mobility', 'settings']) {
    list.push({
      id: `tc-${slug}-get`, name: `GET /tests/{id}/${slug}`, category: 'test-creator',
      method: 'GET', endpoint: `/v2/tests/{id}/${slug}`, severity: 'optional',
      run: async (c) => {
        const base = { id: `tc-${slug}-get`, category: 'test-creator' as const, method: 'GET' as const, endpoint: `/v2/tests/{id}/${slug}`, severity: 'optional' as const };
        if (!c.someTestcaseId) return skip(base.id, base, 'no testcase id (run testcases-list first)');
        const r = await rawCall(c, 'GET', `${tBase(c.host)}/tests/${encodeURIComponent(c.someTestcaseId)}/${slug}`);
        if (r.status === 200) return ok(base.id, base, r, JSON.stringify(r.bodyJson).slice(0, 100));
        // A case created without this optional section returns 404 "section not
        // found" — expected, not a failure.
        if (r.status === 404) return skip(base.id, base, `this test case has no '${slug}' section`);
        return bad(base.id, base, r, `expected 200 or 404, got ${r.status}`);
      },
    });
  }

  // Full create → configure → finalise → tag → purge-history → delete.
  // Validated end-to-end against the live UE-sim box. Section order is
  // mandatory and settings is the finaliser that LOCKS the case; mobility
  // intentionally gets no PUT (the server rejects it with "section
  // 'mobilityConfig' cannot be updated"). Cleans up after itself via DELETE.
  list.push({
    id: 'tc-create-lifecycle',
    name: 'POST /tests/cells → subscribers → user-plane → power-cycle → mobility → settings (full create), PUT tags, purge history, DELETE',
    category: 'test-creator',
    method: 'POST', endpoint: '/v2/tests/cells (full lifecycle)', severity: 'critical',
    destructive: true, longRunning: true,
    run: async (c) => {
      const base = { id: 'tc-create-lifecycle', category: 'test-creator' as const, method: 'POST' as const, endpoint: '/v2/tests/cells (full lifecycle)', severity: 'critical' as const, destructive: true };
      const J = { 'Content-Type': 'application/json' };
      const traces: string[] = [];

      // 1. Initialise the case via cells → returns testCaseId.
      const cells = await rawCall(c, 'POST', `${tBase(c.host)}/tests/cells`, { headers: J, body: JSON.stringify(TC_CELLS_LTE) });
      traces.push(`cells=${cells.status}`);
      const id: string | undefined = cells.bodyJson?.testCaseId;
      if (cells.status !== 200 || !id) return bad(base.id, base, cells, `create cells returned ${cells.status}`, '200 with { success, testCaseId, testCaseName } per createCellConfig (master.product must be "UE-SIM", cells[].bandwidth must be a string)');

      const cleanup = async () => { try { await rawCall(c, 'DELETE', `${tBase(c.host)}/testcases/${encodeURIComponent(id)}`); } catch { /* best effort */ } };
      try {
        // 2–5. Sections in dependency order; each is gated on the previous one.
        const order: Array<[string, any]> = [['subscribers', TC_SUBS_LTE], ['user-plane', TC_UPLANE], ['power-cycle', TC_PCYCLE], ['mobility', TC_MOBILITY]];
        for (const [slug, body] of order) {
          const r = await rawCall(c, 'POST', `${tBase(c.host)}/tests/${encodeURIComponent(id)}/${slug}`, { headers: J, body: JSON.stringify(body) });
          traces.push(`${slug}=${r.status}`);
          if (r.status !== 200) { await cleanup(); return bad(base.id, base, r, `POST ${slug} returned ${r.status}: ${JSON.stringify(r.bodyJson)?.slice(0, 140)}; ${traces.join(' ')}`, '200; section creation is order-dependent (cells→subscribers→user-plane→power-cycle→mobility→settings)'); }
        }
        // 6. Update an existing section (cells supports PUT; mobility does not).
        const putCells = await rawCall(c, 'PUT', `${tBase(c.host)}/tests/${encodeURIComponent(id)}/cells`, { headers: J, body: JSON.stringify(TC_CELLS_LTE) });
        traces.push(`put-cells=${putCells.status}`);
        // 7. Finalise — settings locks the case and sets the final name.
        // Self-discovers valid loggingProfileName + successCriteriaName on
        // each run (4.0.0_260602+ now validates these against an internal
        // list; the names that worked on older builds may not exist on
        // every install).
        const settingsBody = await tcSettingsBody(c, `simqa-create-lifecycle-${Date.now().toString(36)}`);
        const settings = await rawCall(c, 'POST', `${tBase(c.host)}/tests/${encodeURIComponent(id)}/settings`, { headers: J, body: JSON.stringify(settingsBody) });
        traces.push(`settings=${settings.status}`);
        if (settings.status !== 200) { await cleanup(); return bad(base.id, base, settings, `settings (finalise) returned ${settings.status}: ${JSON.stringify(settings.bodyJson)?.slice(0, 160)}; ${traces.join(' ')}`, '200 "testcase creation completed". On 4.0.0_260602 settings now validates loggingProfileName and successCriteriaName against the box catalogue — the simqa test self-discovers these from an existing testcase.'); }
        // 8. Tag it (PUT /testcases/{id}).
        const tags = await rawCall(c, 'PUT', `${tBase(c.host)}/testcases/${encodeURIComponent(id)}`, { headers: J, body: JSON.stringify({ user_tags: ['simqa', 'smoke'] }) });
        traces.push(`tags=${tags.status}`);
        // 9. Purge history (async job) and 10. track it via /api/jobs/{id}.
        const purge = await rawCall(c, 'DELETE', `${tBase(c.host)}/testcases/${encodeURIComponent(id)}/history`);
        traces.push(`purge=${purge.status}`);
        const jobId: string | undefined = purge.bodyJson?.jobId;
        if (jobId) { const job = await rawCall(c, 'GET', `${tBase(c.host)}/api/jobs/${encodeURIComponent(jobId)}`); traces.push(`job=${job.status}`); }
        // 11. Confirm retrievable, then 12. delete + 13. confirm gone.
        const verify = await rawCall(c, 'GET', `${tBase(c.host)}/testcases/${encodeURIComponent(id)}`);
        traces.push(`verify=${verify.status}`);
        const del = await rawCall(c, 'DELETE', `${tBase(c.host)}/testcases/${encodeURIComponent(id)}`);
        traces.push(`delete=${del.status}`);
        if (del.status !== 200 && del.status !== 204) return bad(base.id, base, del, `DELETE testcase returned ${del.status} (leaked ${id}); ${traces.join(' ')}`, '200/204 — the case must be removable so a create smoke-test does not leak inventory');
        return ok(base.id, base, cells, `${id}: ${traces.join(' ')}`);
      } catch (e: any) {
        await cleanup();
        return bad(base.id, base, { status: 0, ms: 0, error: e?.message ?? String(e), request: { method: 'POST', url: `${tBase(c.host)}/tests/cells`, headers: {} } }, `lifecycle threw: ${e?.message ?? e}; ${traces.join(' ')}`);
      }
    },
  });

  // ---------- JOBS (async job tracking) ----------
  list.push({
    id: 'jobs-list', name: 'GET /api/jobs', category: 'jobs',
    method: 'GET', endpoint: '/v2/api/jobs', severity: 'normal',
    run: async (c) => {
      const base = { id: 'jobs-list', category: 'jobs' as const, method: 'GET' as const, endpoint: '/v2/api/jobs', severity: 'normal' as const };
      const r = await rawCall(c, 'GET', `${tBase(c.host)}/api/jobs`);
      if (r.status === 200) {
        const arr = Array.isArray(r.bodyJson) ? r.bodyJson : (r.bodyJson?.items ?? r.bodyJson?.jobs ?? []);
        if (Array.isArray(arr) && arr.length > 0) c.someJobId = arr[0]?.id ?? arr[0]?.jobId;
        return ok(base.id, base, r, `${Array.isArray(arr) ? arr.length : '?'} job(s)`);
      }
      return bad(base.id, base, r, `expected 200, got ${r.status}`);
    },
  });
  list.push({
    id: 'jobs-get-one', name: 'GET /api/jobs/{id}', category: 'jobs',
    method: 'GET', endpoint: '/v2/api/jobs/{id}', severity: 'normal',
    run: async (c) => {
      const base = { id: 'jobs-get-one', category: 'jobs' as const, method: 'GET' as const, endpoint: '/v2/api/jobs/{id}', severity: 'normal' as const };
      if (!c.someJobId) return skip(base.id, base, 'no job id available (run jobs-list first; box may have no jobs)');
      const r = await rawCall(c, 'GET', `${tBase(c.host)}/api/jobs/${encodeURIComponent(c.someJobId)}`);
      if (r.status === 200) return ok(base.id, base, r, JSON.stringify(r.bodyJson).slice(0, 100));
      return bad(base.id, base, r, `expected 200, got ${r.status}`);
    },
  });

  // ---------- USERS SEARCH ----------
  // Spec documents POST /users/search. On the lab box the /users* routes exist
  // but reject the master-realm admin token with 403 (search role not mapped),
  // while /admin/users* 404s — so 403 here means "route present, authz
  // enforced", which we accept as covered; 404 means the route is missing.
  list.push({
    id: 'users-search', name: 'POST /users/search', category: 'admin-users',
    method: 'POST', endpoint: '/v2/users/search', severity: 'optional',
    run: async (c) => {
      const base = { id: 'users-search', category: 'admin-users' as const, method: 'POST' as const, endpoint: '/v2/users/search', severity: 'optional' as const };
      const r = await rawCall(c, 'POST', `${tBase(c.host)}/users/search`, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pageNumber: 1, pageSize: 10 }) });
      if (r.status === 200) return ok(base.id, base, r, `items=${r.bodyJson?.items?.length ?? r.bodyJson?.users?.length ?? '?'}`);
      if (r.status === 403) return ok(base.id, base, r, 'route present; admin token forbidden (403) — search role not mapped for this deployment');
      return bad(base.id, base, r, `expected 200 (or 403 if authz-gated), got ${r.status}`, '200 with a paged user list per spec; 404 means the /users/search route is not deployed');
    },
  });

  // ---------- FUZZ ----------
  // Schema fuzzing: send malformed payloads and assert the API rejects with
  // 4xx (not 5xx, not 200). The point is to surface input validation gaps.
  // Each test passes if the response is a 4xx; a 200 means the server didn't
  // validate, a 5xx means it crashed.
  const fuzz = (id: string, name: string, ep: string, method: 'POST'|'PUT'|'PATCH'|'GET'|'DELETE', urlSuffix: string, body: any, opts: { headers?: Record<string,string>; auth?: 'bearer'|'none'; expected?: string } = {}): TestDef => ({
    id, name, category: 'fuzz', method, endpoint: ep, severity: 'optional',
    run: async (c) => {
      const base = { id, category: 'fuzz' as const, method, endpoint: ep, severity: 'optional' as const };
      const init: any = {
        auth: opts.auth ?? 'bearer',
        headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
      };
      if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
      const r = await rawCall(c, method, `${tBase(c.host)}${urlSuffix}`, init);
      const defaultExpected = opts.expected ?? '4xx with a JSON error envelope { code, message }; never 5xx (crash) or 2xx (silent acceptance of invalid input)';
      if (r.status >= 400 && r.status < 500) return ok(base.id, base, r, `rejected with ${r.status} (good)`);
      if (r.status >= 500)                   return bad(base.id, base, r, `5xx — server crashed on bad input`, defaultExpected);
      if (r.status >= 200 && r.status < 300) return bad(base.id, base, r, `200 — input validation gap`, defaultExpected);
      return bad(base.id, base, r, `unexpected ${r.status}`, defaultExpected);
    },
  });

  list.push(fuzz('fuzz-login-no-body',          'POST /login no body',                          '/v2/login',     'POST', '/login',     undefined,                       { auth: 'none', expected: '400 BAD_REQUEST {"code":"INVALID_REQUEST","message":"username and password are required"}' }));
  list.push(fuzz('fuzz-login-empty-obj',        'POST /login empty {}',                         '/v2/login',     'POST', '/login',     {},                              { auth: 'none', expected: '400 BAD_REQUEST with a message naming the missing fields' }));
  list.push(fuzz('fuzz-login-wrong-types',      'POST /login wrong types (numbers)',            '/v2/login',     'POST', '/login',     { username: 123, password: true }, { auth: 'none', expected: '400 BAD_REQUEST: username/password must be strings' }));
  list.push(fuzz('fuzz-login-malformed-json',   'POST /login malformed JSON',                   '/v2/login',     'POST', '/login',     '{"username":"admin", "password":', { auth: 'none', expected: '400 BAD_REQUEST {"code":"INVALID_JSON","message":"could not parse request body"} - MUST NOT 5xx; an unauthenticated DoS is critical' }));
  list.push(fuzz('fuzz-login-oversize',         'POST /login 1MB username',                     '/v2/login',     'POST', '/login',     { username: 'a'.repeat(1024*1024), password: 'x' }, { auth: 'none', expected: '413 PAYLOAD_TOO_LARGE or 400 - reject before fully buffering. Cap request body at 64 KB.' }));
  list.push(fuzz('fuzz-bandinfo-missing-rat',   'POST /band-info missing rat',                  '/v2/band-info', 'POST', '/band-info', { search: 'n7' },                { expected: '400 BAD_REQUEST: rat is required and must be one of [NR, LTE]' }));
  list.push(fuzz('fuzz-bandinfo-array-rat',     'POST /band-info rat as array',                 '/v2/band-info', 'POST', '/band-info', { rat: ['NR'] },                  { expected: '400 BAD_REQUEST: rat must be a string, not an array' }));
  list.push(fuzz('fuzz-search-bad-pageNumber',  'POST /testcases/search pageNumber=-1',         '/v2/testcases/search', 'POST', '/testcases/search', { pageNumber: -1, pageSize: 10 }, { expected: '400 BAD_REQUEST: pageNumber must be >= 1' }));
  list.push(fuzz('fuzz-search-huge-pageSize',   'POST /testcases/search pageSize=1e9',          '/v2/testcases/search', 'POST', '/testcases/search', { pageNumber: 1, pageSize: 1_000_000_000 }, { expected: '400 BAD_REQUEST: pageSize must be <= 1000 (or whatever max). Server-side cap to prevent memory exhaustion / DoS.' }));
  list.push(fuzz('fuzz-tc-list-negative-limit', 'GET /testcases?limit=-5',                      '/v2/testcases', 'GET',  '/testcases?limit=-5&offset=0', undefined, { expected: '400 BAD_REQUEST: limit must be a positive integer' }));
  list.push(fuzz('fuzz-tc-list-string-limit',   'GET /testcases?limit=abc',                     '/v2/testcases', 'GET',  '/testcases?limit=abc',         undefined, { expected: '400 BAD_REQUEST: limit must be an integer' }));
  list.push(fuzz('fuzz-tc-id-traversal',        'GET /testcases/../../etc/passwd',              '/v2/testcases/{id}', 'GET', '/testcases/' + encodeURIComponent('../../etc/passwd'), undefined, { expected: '404 (id contains illegal characters) or 400. Validate testcase id pattern: ^[A-Za-z0-9_-]+$' }));
  list.push(fuzz('fuzz-admin-user-no-fields',   'POST /admin/users empty body',                 '/v2/admin/users', 'POST', '/admin/users', {}, { expected: '400 BAD_REQUEST: username and first_name are required' }));
  list.push(fuzz('fuzz-admin-user-bad-role',    'POST /admin/users role=superduper',            '/v2/admin/users', 'POST', '/admin/users', { username: 'simqa-fuzz-' + Date.now(), first_name: 'x', role: 'superduper' }, { expected: '400 BAD_REQUEST: role must be one of [admin, user]' }));
  list.push(fuzz('fuzz-satellite-out-of-range', 'POST /tools/satellite-tracker sLat=999',       '/v2/tools/satellite-tracker/metrics', 'POST', '/tools/satellite-tracker/metrics', { sLat: 999, sLon: 0, sAlt: 35786, sVel: 3.07, gLat: 0, gLon: 0 }, { expected: '400 BAD_REQUEST: sLat must be in range [-90, 90] per OpenAPI spec lines 1781-1801' }));
  list.push(fuzz('fuzz-content-type-text',      'POST /login Content-Type: text/plain',         '/v2/login',     'POST', '/login',     'username=admin&password=admin', { auth: 'none', headers: { 'Content-Type': 'text/plain' }, expected: '415 UNSUPPORTED_MEDIA_TYPE - reject before parsing. MUST NOT 5xx; another unauthenticated DoS vector.' }));

  // ---------- SAMPLE-MATRIX (per-sample × variation) ----------
  // Every variant produced by src/lib/sampleTests/matrix.ts becomes one
  // ApiTest entry. The test:
  //   1. Looks up the base testcase by name in the box catalogue (cached
  //      per-sweep so we don't re-search 200+ times).
  //   2. If absent on this build  → SKIP with "not yet authored on box".
  //   3. If present + the box currently has NO active execution → trigger
  //      `POST /v2/testcases/{id}/executions`, accept 200/201/202/204 as a
  //      PASS (we don't poll for verdict — that's the end-to-end runner's
  //      job; this catalog only validates the create-and-trigger contract).
  //   4. If present but box is busy → SKIP with "box busy — cannot trigger"
  //      so the matrix doesn't fight existing runs.
  for (const variant of buildSampleMatrixEntries()) {
    list.push(variant);
  }

  return list;
}

/** Lazy-load the testcase catalog once per sweep and cache on the ctx. */
async function ensureTestcaseCatalog(c: RunCtx): Promise<Array<{ id: string; name: string }>> {
  if (c.testcaseCatalog) return c.testcaseCatalog;
  // Pull both user testcases (via search) AND sample-tagged testcases (which
  // the box exposes via a separate `?tags=sample` filter — confirmed during
  // the Chrome QA walk). Otherwise sample-matrix variants always SKIP because
  // the catalog only sees user-authored entries.
  const seen = new Map<string, { id: string; name: string }>();
  const userR = await rawCall(c, 'POST', `${tBase(c.host)}/testcases/search`, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ offset: 0, limit: 5000 }),
  });
  const userItems: any[] = userR.bodyJson?.items ?? userR.bodyJson?.data ?? [];
  for (const x of userItems) {
    if (!x || typeof x !== 'object') continue;
    const id = String(x.id ?? ''); if (!id) continue;
    seen.set(id, { id, name: String(x.name ?? '') });
  }
  // Sample-tagged testcases (system_tags=["sample"]) — separate listing.
  const sampleR = await rawCall(c, 'GET', `${tBase(c.host)}/testcases?limit=1000&tags=sample`);
  const sampleItems: any[] = sampleR.bodyJson?.items ?? sampleR.bodyJson?.data ?? [];
  for (const x of sampleItems) {
    if (!x || typeof x !== 'object') continue;
    const id = String(x.id ?? ''); if (!id) continue;
    if (!seen.has(id)) seen.set(id, { id, name: String(x.name ?? '') });
  }
  c.testcaseCatalog = [...seen.values()];
  return c.testcaseCatalog;
}

/** Build one TestDef per matrix variant. Each variant maps to one of the
 *  three sample-* categories so the report dashboards group cleanly. */
function buildSampleMatrixEntries(): TestDef[] {
  // Imported lazily-here (inside the function) to keep the file's top-level
  // imports tidy and avoid a circular-import risk if the matrix module
  // grows to depend on apiTester types.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { generateMatrix } = require('./sampleTests/matrix') as typeof import('./sampleTests/matrix');
  const matrix = generateMatrix();
  const out: TestDef[] = [];
  for (const v of matrix) {
    const category: ApiTestCategory = v.category === 'sa'
      ? 'sample-sa'
      : v.category === 'lte'
      ? 'sample-lte'
      : v.category === 'nsa'
      ? 'sample-nsa'
      : 'sample-nbiot';
    out.push({
      id: v.id,
      name: v.name,
      category,
      method: 'POST',
      endpoint: '/v2/testcases/{id}/executions',
      severity: 'normal',
      destructive: true,
      longRunning: true,
      run: async (c) => {
        const base = { id: v.id, category, method: 'POST' as const, endpoint: '/v2/testcases/{id}/executions', severity: 'normal' as const, destructive: true };
        const catalog = await ensureTestcaseCatalog(c);
        // Match strictly by the catalog's on-box id first (post-Chrome-QA we
        // know each sample testcase's exact id ends in `_` per SIM40-2015).
        // Fall back to name match for older builds that don't yet expose the
        // canonical id.
        const wantId   = v.baseId.toLowerCase();
        const wantName = v.baseName.toLowerCase();
        const hit = catalog.find((t) =>
          (t.id   || '').toLowerCase() === wantId ||
          (t.name || '').toLowerCase() === wantName,
        );
        if (!hit) return skip(base.id, base, `base testcase "${v.baseName}" (id=${v.baseId}) not yet authored on box (owner: ${v.owner})`);

        // Don't fire if the box is already busy — leaves other people's runs alone.
        const sims = await rawCall(c, 'GET', `${tBase(c.host)}/simulators`);
        const anyBusy = (sims.bodyJson?.items ?? []).some((s: any) => String(s?.availability ?? '').toUpperCase() === 'BUSY');
        if (anyBusy) return skip(base.id, base, 'box has a BUSY simulator — declining to trigger ' + v.baseName + ' variant ' + shortLabelOf(v.params));

        const trig = await rawCall(c, 'POST', `${tBase(c.host)}/testcases/${encodeURIComponent(hit.id)}/executions`, {
          headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        if (trig.status >= 200 && trig.status < 300) {
          return ok(base.id, base, trig, `${v.baseName} [${shortLabelOf(v.params)}] trigger ${trig.status} on box id=${hit.id}`);
        }
        // 409 = busy. Treat as SKIP (correct system-wide-mutex behaviour, not a regression).
        if (trig.status === 409) return skip(base.id, base, `box returned 409 BUSY when triggering ${v.baseName}`);
        return bad(base.id, base, trig, `trigger ${trig.status} for ${hit.id}`, '200/201/202 accepting the execution start');
      },
    });
  }
  return out;
}

function shortLabelOf(p: any): string {
  const bits: string[] = [];
  if (p.band) bits.push(p.band);
  if (p.traffic) bits.push(p.traffic);
  if (p.direction) bits.push(p.direction);
  if (p.ueCount) bits.push(`${p.ueCount}ue`);
  if (p.mobility) bits.push(p.mobility);
  if (p.channel) bits.push(p.channel);
  if (p.powerCycle) bits.push(p.powerCycle);
  if (p.hoMode) bits.push(p.hoMode);
  return bits.join('-') || 'default';
}

// ---------- Driver ----------

export async function runApiTests(inv: Inventory, req: ApiTesterRequest): Promise<ApiTesterResponse> {
  const startedAt = new Date().toISOString();
  // Resolve the target system. If a specific id was passed, use it; otherwise
  // fall back to the first UESIM-capable system in inventory (legacy
  // behaviour). This lets the UI offer a target dropdown the same way
  // /ui-tests does, so two teammates can test different boxes in parallel.
  const apiOpts = req.targetSystemId
    ? uesimApiOptsForSystem(inv, req.targetSystemId)
    : uesimApiOptsFromInventory(inv);
  if (!apiOpts) {
    return {
      startedAt, finishedAt: new Date().toISOString(),
      ok: false,
      counts: { total: 0, passed: 0, failed: 0, skipped: 0 },
      results: [{
        id: 'preflight', name: 'inventory has UESIM', category: 'auth',
        method: '-', endpoint: '-', severity: 'critical', destructive: false, ok: false,
        detail: req.targetSystemId
          ? `system "${req.targetSystemId}" not found or not UESIM-capable in inventory.yaml`
          : 'no UESIM system in inventory.yaml',
      }],
      byCategory: {},
    };
  }

  const wanted = new Set<ApiTestCategory>(req.categories ?? DEFAULT_CATEGORIES);
  const includeNegative = req.includeNegative ?? true;
  if (req.includeDestructive) wanted.add('mutating');
  if (includeNegative)        wanted.add('negative');

  // Preflight: log in once.
  let token = '';
  try { token = await ensureToken(apiOpts.host, apiOpts.username, apiOpts.password); }
  catch (e: any) {
    return {
      startedAt, finishedAt: new Date().toISOString(),
      ok: false,
      counts: { total: 0, passed: 0, failed: 1, skipped: 0 },
      results: [{ id: 'preflight-login', name: 'preflight login', category: 'auth', method: 'POST', endpoint: '/v2/login', severity: 'critical', destructive: false, ok: false, detail: e?.message ?? String(e) }],
      byCategory: {},
    };
  }

  const ctx: RunCtx = {
    host: apiOpts.host,
    username: apiOpts.username,
    password: apiOpts.password,
    token,
    includeDestructive: !!req.includeDestructive,
    includeLongRunning: !!req.includeLongRunning,
  };

  const results: ApiTestResult[] = [];
  for (const def of defs()) {
    if (!wanted.has(def.category)) continue;
    if (def.destructive && !req.includeDestructive) {
      results.push({ id: def.id, name: def.name, category: def.category, method: def.method, endpoint: def.endpoint, severity: def.severity, destructive: true, ok: true, skipped: true, skippedReason: 'destructive (enable Include destructive tests)' });
      continue;
    }
    if (def.longRunning && !req.includeLongRunning) {
      results.push({ id: def.id, name: def.name, category: def.category, method: def.method, endpoint: def.endpoint, severity: def.severity, destructive: !!def.destructive, ok: true, skipped: true, skippedReason: 'long-running (enable Include long-running tests)' });
      continue;
    }
    try {
      results.push(await def.run(ctx));
    } catch (e: any) {
      results.push({ id: def.id, name: def.name, category: def.category, method: def.method, endpoint: def.endpoint, severity: def.severity, destructive: !!def.destructive, ok: false, detail: `threw: ${e?.message ?? String(e)}`, ranAt: new Date().toISOString() });
    }
  }

  const counts = {
    total:   results.length,
    passed:  results.filter((r) => r.ok && !r.skipped).length,
    failed:  results.filter((r) => !r.ok).length,
    skipped: results.filter((r) => r.skipped).length,
  };
  const byCategory: Record<string, { passed: number; failed: number; skipped: number }> = {};
  for (const r of results) {
    const k = r.category;
    if (!byCategory[k]) byCategory[k] = { passed: 0, failed: 0, skipped: 0 };
    if (r.skipped) byCategory[k].skipped++;
    else if (r.ok) byCategory[k].passed++;
    else           byCategory[k].failed++;
  }

  return {
    startedAt, finishedAt: new Date().toISOString(),
    ok: counts.failed === 0,
    counts, results, byCategory,
  };
}

export function listAllCategories(): ApiTestCategory[] {
  return ['auth', 'version', 'users', 'admin-users', 'simulators', 'system', 'tools', 'testcases', 'test-creator', 'executions', 'statistics', 'logs', 'jobs', 'negative', 'mutating', 'fuzz'];
}

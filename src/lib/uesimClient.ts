// Thin client for the UESIM REST API (Simnovator v2). Used by the QA runner
// to fetch testcase definitions, kick off executions, poll status, and pull
// stats / logs at the end.
//
// Auth: POST /v2/login returns a JWT. We cache it per (host, user) until it
// expires; the spec says default TTL is 10800s (3h), we treat anything <60s
// remaining as expired and re-login.

import type { UesimTestDefinition } from './cfgGenerator';
import { getSettings } from './settings';

interface AuthState {
  token: string;
  expiresAt: number; // epoch ms
}

const authCache = new Map<string, AuthState>();

/** In-flight logins, keyed like authCache. Two concurrent callers (e.g. the
 *  dashboard fetching testcases + simulators at once) must share one login
 *  rather than each opening its own socket to a box that may be down. */
const loginInflight = new Map<string, Promise<string>>();

/**
 * Hosts that just failed to connect, and when to stop short-circuiting.
 *
 * Without this, every page load re-attempts a box that is switched off and
 * pays the full connect timeout again. A dead lab box is dead for more than
 * a few seconds, so we remember briefly and fail fast instead.
 */
const unreachableUntil = new Map<string, number>();
const UNREACHABLE_TTL_MS = 30_000;

/**
 * Bound on the login round-trip.
 *
 * This matters more than the GET/POST caps below: those guard the *second*
 * request, but every call funnels through ensureToken() first. Leaving that
 * fetch unbounded meant one unreachable host stalled a page for ~21s — the
 * OS-level TCP connect timeout — no matter what the other caps said.
 */
const LOGIN_TIMEOUT_MS = 6_000;

function cacheKey(host: string, user: string): string {
  return `${host}::${user}`;
}

function isAlive(state: AuthState | undefined): state is AuthState {
  return !!state && state.expiresAt - 60_000 > Date.now();
}

/** True for "could not reach the box" as opposed to "box said no". */
function isConnectFailure(e: unknown): boolean {
  const name = (e as any)?.name;
  return name === 'AbortError' || name === 'TimeoutError' || e instanceof TypeError;
}

/** Note that `host` is currently unreachable so the next call fails fast. */
function markUnreachable(host: string): void {
  unreachableUntil.set(host, Date.now() + UNREACHABLE_TTL_MS);
}

/** Forget a previous failure — called as soon as a box answers again. */
export function clearUnreachable(host: string): void {
  unreachableUntil.delete(host);
}

/** How long until we retry `host`, or 0 if it is not currently blacklisted. */
export function unreachableFor(host: string): number {
  return Math.max(0, (unreachableUntil.get(host) ?? 0) - Date.now());
}

/** Login (or use cached token) and return a Bearer header value. */
export async function ensureToken(host: string, username: string, password: string): Promise<string> {
  const k = cacheKey(host, username);
  const cached = authCache.get(k);
  if (isAlive(cached)) return cached.token;

  // Recently unreachable — don't pay the connect timeout again.
  const cooldown = unreachableFor(host);
  if (cooldown > 0) {
    throw new Error(`UESIM ${host} unreachable (retrying in ${Math.ceil(cooldown / 1000)}s)`);
  }

  const pending = loginInflight.get(k);
  if (pending) return pending;

  const attempt = (async () => {
    try {
      // One retry on a connect-class failure before declaring the box dead.
      // Observed in the field: a single login timed out at the full 6s
      // against a box that answers curl in 0.5s, and that one blip then
      // poisoned the blacklist for 30s, cascading 502s across the app. A
      // transient stall must not be treated as proof of death; a genuinely
      // dead box just pays 2×6s on the first visit and is then blacklisted.
      let res: Response;
      for (let attemptNo = 1; ; attemptNo++) {
        try {
          res = await fetch(`http://${host}/v2/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password }),
            signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
          });
          break;
        } catch (e) {
          if (attemptNo >= 2 || !isConnectFailure(e)) throw e;
        }
      }
      if (!res.ok) throw new Error(`UESIM login failed: ${res.status} ${await res.text().catch(() => '')}`);
      const body = (await res.json()) as { access_token: string; expires_in?: number };
      if (!body.access_token) throw new Error('UESIM login: no access_token in response');
      const ttl = (body.expires_in ?? 10800) * 1000;
      authCache.set(k, { token: body.access_token, expiresAt: Date.now() + ttl });
      clearUnreachable(host);
      return body.access_token;
    } catch (e) {
      // Only a connect/timeout failure means "box is down" — and only after
      // the retry above has also failed. A 401 is the box answering
      // promptly, and must not blacklist it.
      if (isConnectFailure(e)) markUnreachable(host);
      throw e;
    } finally {
      loginInflight.delete(k);
    }
  })();

  loginInflight.set(k, attempt);
  return attempt;
}

/** Exported: executions.ts, jobTracker/executor.ts and duplicateTestcase.ts all
 *  take the same host+credentials shape, and re-declaring it in each would let
 *  the four copies drift. */
export interface ApiOpts {
  host: string;
  username: string;
  password: string;
}

// Bounded timeouts so no call can hang a long batch run. Execution start is
// legitimately slow on some builds, so POST gets a generous cap. Both are
// user-tunable on /settings; getSettings() is mtime-cached so consulting it
// per call costs a stat(), not a parse.
const GET_TIMEOUT_MS  = () => getSettings().uesimGetTimeoutMs;
const POST_TIMEOUT_MS = () => getSettings().uesimPostTimeoutMs;

async function apiGet<T>(opts: ApiOpts, path: string): Promise<T> {
  const token = await ensureToken(opts.host, opts.username, opts.password);
  let res: Response;
  try {
    res = await fetch(`http://${opts.host}/v2${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(GET_TIMEOUT_MS()),
    });
  } catch (e) {
    // Cached token but the box has since gone away — record it so the next
    // caller short-circuits instead of waiting out the timeout again.
    if (isConnectFailure(e)) markUnreachable(opts.host);
    throw e;
  }
  if (!res.ok) throw new Error(`UESIM GET ${path}: ${res.status} ${await res.text().catch(() => '')}`);
  return (await res.json()) as T;
}

async function apiPost<T>(opts: ApiOpts, path: string, body?: unknown): Promise<T> {
  const token = await ensureToken(opts.host, opts.username, opts.password);
  let res: Response;
  try {
    res = await fetch(`http://${opts.host}/v2${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(POST_TIMEOUT_MS()),
    });
  } catch (e) {
    // Connection refused/reset = box is gone, blacklist like apiGet does.
    // A timeout is NOT proof of death here: execution start legitimately
    // runs long (hence the 120s cap), so a slow box must not get 30s of
    // fast-fails on top of an already-slow run.
    if (e instanceof TypeError) markUnreachable(opts.host);
    throw e;
  }
  if (!res.ok) throw new Error(`UESIM POST ${path}: ${res.status} ${await res.text().catch(() => '')}`);
  return (await res.json()) as T;
}

// ---------- Public surface ----------

export interface TestcaseSummary {
  id: string;
  name: string;
  description?: string;
  metadata?: any;
}

export async function listTestcases(opts: ApiOpts, limit = 50, offset = 0): Promise<{ items: TestcaseSummary[]; total: number }> {
  return apiGet(opts, `/testcases?limit=${limit}&offset=${offset}`);
}

export async function getTestcase(opts: ApiOpts, id: string): Promise<TestcaseSummary & { testDefinition: UesimTestDefinition }> {
  return apiGet(opts, `/testcases/${encodeURIComponent(id)}`);
}

/**
 * Resolve a testcase NAME to the id /v2/testcases/export will accept.
 *
 * Needed because the box's in-progress endpoint
 * (secureAPI/v1.0/executor/latest_testcase_details) reports only
 * test_case_name — no id of any kind — so a passive watcher that sees an
 * execution start has a name and nothing else.
 *
 * This is the FALLBACK path. POST /v2/testcases/search does support filtering —
 * with { field, operator, value }, which is what the watcher now uses to find
 * running executions and their exportable ids in one call. What it does NOT do
 * is reject a filter shape it does not recognise: { testCaseName: … } returns
 * all 894 testcases with the wanted row often sorted first, which reads exactly
 * like a working filter. This name-paging path stays for builds whose search
 * cannot filter, and for the legacy in-progress endpoint, which reports a test
 * name and no id of any kind.
 *
 * The map is cached per host because a testcase list changes far more slowly than
 * executions start, and rebuilding it is nine round-trips.
 */
const nameIndex = new Map<string, { at: number; byName: Map<string, string> }>();
const NAME_INDEX_TTL_MS = 5 * 60_000;

export async function resolveTestcaseIdByName(opts: ApiOpts, name: string): Promise<string | undefined> {
  const want = name.trim();
  if (!want) return undefined;

  const cached = nameIndex.get(opts.host);
  if (cached && Date.now() - cached.at < NAME_INDEX_TTL_MS) {
    const hit = cached.byName.get(want);
    if (hit) return hit;
  }

  // offset is a PAGE INDEX on this endpoint, not a row offset.
  const byName = new Map<string, string>();
  const seen = new Set<string>();
  const pageSize = 100;
  for (let page = 0; page < 50; page++) {
    const r = await listTestcases(opts, pageSize, page);
    const items = r.items ?? [];
    if (!items.length) break;
    let fresh = 0;
    for (const t of items) {
      const id = String((t as any)?.id ?? '');
      const nm = String((t as any)?.name ?? '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      fresh += 1;
      // Some rows carry a NAME where the id should be, and the box then refuses
      // them with 400 "Invalid testCaseId format". Prefer a uuid-shaped id, and
      // never let one of those overwrite a good entry.
      const looksLikeId = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id);
      if (nm && (looksLikeId || !byName.has(nm))) byName.set(nm, id);
    }
    if (fresh === 0) break;              // re-reading a page we already have
    if (items.length < pageSize) break;
  }

  nameIndex.set(opts.host, { at: Date.now(), byName });
  return byName.get(want);
}

/**
 * The testcase EXPORT the Simnovator GUI's own download button produces.
 *
 * Not the same thing as getTestcase(). GET /testcases/{id} returns the record:
 * status ("ABORTED"), validationStatus, metadata.lastExecution and a whole
 * metadata.executionHistory. None of that is configuration — it is the result of
 * having run the thing — so a backup built on it stores a testcase mixed in with
 * whatever happened to it last.
 *
 * This is the call behind the per-row download in the GUI, found in the box's own
 * SPA bundle (there is no OpenAPI for this API; /assets/index-*.js is the spec):
 *
 *   const vt = { scope: 'single', testCaseIds: [test_id], output: { type: 'json', fileName: name } };
 *   bCe(vt)  // POST v2/testcases/export, responseType: 'blob'
 *
 * It answers with { test_case_details: [ { Test_Id, Test_Name, State, Type,
 * Config_File.config, Test_Config_Intermediate_Object } ] } — configuration only,
 * and in the shape POST /v2/testcases/import accepts back.
 *
 * Returns the RAW body rather than a parsed object, so what gets stored is
 * byte-for-byte what the GUI would have saved.
 *
 * NOTE the scope: this is the SINGLE-testcase form. The bulk form of the same
 * endpoint is the one that silently drops rows (SIM40-2010: 1048 requested, 77
 * returned), which is why this is called once per testcase rather than once per
 * box. See src/lib/testcaseBackup.ts for that history.
 */
export async function exportTestcaseConfig(opts: ApiOpts, id: string, fileName: string): Promise<string> {
  const token = await ensureToken(opts.host, opts.username, opts.password);
  const res = await fetch(`http://${opts.host}/v2/testcases/export`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      scope: 'single',
      testCaseIds: [id],
      output: { type: 'json', fileName },
    }),
    signal: AbortSignal.timeout(POST_TIMEOUT_MS()),
  });
  if (!res.ok) {
    throw new Error(`UESIM POST /testcases/export (${id}): ${res.status} ${await res.text().catch(() => '')}`.slice(0, 300));
  }
  const text = await res.text();
  // A 200 carrying no test_case_details means the box accepted the request and
  // exported nothing — the SIM40-2010 failure mode. Refuse it rather than store
  // an empty file over a good backup.
  if (!text.includes('test_case_details')) {
    throw new Error(`export of ${id} returned no test_case_details (${text.length} bytes)`);
  }
  return text;
}

export interface SimulatorEntry {
  id: string;
  name: string;
  type: string;
  connectivity?: string;
  stability?: string;
  availability?: string;
}

export async function listSimulators(opts: ApiOpts): Promise<{ items: SimulatorEntry[]; total?: number }> {
  return apiGet(opts, '/simulators');
}

export async function startExecution(opts: ApiOpts, testcaseId: string, body?: any): Promise<{ message?: string; status?: string }> {
  return apiPost(opts, `/testcases/${encodeURIComponent(testcaseId)}/executions`, body ?? {});
}

export async function stopExecution(opts: ApiOpts, executionId: string, simulatorId?: string): Promise<{ message?: string; status?: string }> {
  const q = simulatorId ? `?simulatorId=${encodeURIComponent(simulatorId)}` : '';
  return apiPost(opts, `/testcases/executions/${encodeURIComponent(executionId)}/stop${q}`, {});
}

export async function getSimulatorStatus(opts: ApiOpts, simulatorId: string): Promise<any> {
  return apiGet(opts, `/simulators/${encodeURIComponent(simulatorId)}/status`);
}

/**
 * Best-effort: pull the box's reported software version. The /version endpoint
 * is documented as bearer-protected but the box currently 401s for admin
 * tokens (known spec mismatch). We try both bearer + unauthenticated; if
 * neither works we return undefined so callers can store "unknown".
 */
export async function getBoxVersion(opts: ApiOpts): Promise<{ version?: string; build?: string; raw?: any } | undefined> {
  // The unauthenticated fallback below doesn't go through ensureToken, so
  // honour the blacklist here or a known-dead box pays the timeout anyway.
  if (unreachableFor(opts.host) > 0) return undefined;
  const tryFetch = async (auth: 'bearer' | 'none'): Promise<any | undefined> => {
    const headers: Record<string, string> = {};
    if (auth === 'bearer') {
      try {
        const tok = await ensureToken(opts.host, opts.username, opts.password);
        headers['Authorization'] = `Bearer ${tok}`;
      } catch { return undefined; }
    }
    // Bounded like every other call — this one used to be unbounded and could
    // stall a page on an unreachable box.
    let res: Response;
    try {
      res = await fetch(`http://${opts.host}/v2/version`, {
        headers,
        signal: AbortSignal.timeout(GET_TIMEOUT_MS()),
      });
    } catch (e) {
      // Best-effort contract: this function reports undefined, never throws.
      // The cached-token path skips ensureToken's reachability check, so a
      // box that died since login would otherwise leak the raw fetch error.
      if (isConnectFailure(e)) markUnreachable(opts.host);
      return undefined;
    }
    if (!res.ok) return undefined;
    return res.json().catch(() => undefined);
  };
  const data = (await tryFetch('bearer')) ?? (await tryFetch('none'));
  if (!data) return undefined;
  const sn = data?.simnovator ?? data?.simnovus ?? data;
  return { version: sn?.version, build: sn?.build, raw: data };
}

/**
 * Helper to read UESIM credentials from env. Project convention: callers pass
 * either the explicit triple or fall back to UESIM_HOST / UESIM_USER / UESIM_PASS.
 */
export function uesimEnvOpts(overrides?: Partial<ApiOpts>): ApiOpts {
  return {
    host:     overrides?.host     ?? process.env.UESIM_HOST     ?? '192.168.1.95',
    username: overrides?.username ?? process.env.UESIM_USER     ?? 'admin',
    password: overrides?.password ?? process.env.UESIM_PASS     ?? 'admin',
  };
}

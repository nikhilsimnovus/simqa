// Thin client for the UESIM REST API (Simnovator v2). Used by the QA runner
// to fetch testcase definitions, kick off executions, poll status, and pull
// stats / logs at the end.
//
// Auth: POST /v2/login returns a JWT. We cache it per (host, user) until it
// expires; the spec says default TTL is 10800s (3h), we treat anything <60s
// remaining as expired and re-login.

import type { UesimTestDefinition } from './cfgGenerator';

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
      const res = await fetch(`http://${host}/v2/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
        signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`UESIM login failed: ${res.status} ${await res.text().catch(() => '')}`);
      const body = (await res.json()) as { access_token: string; expires_in?: number };
      if (!body.access_token) throw new Error('UESIM login: no access_token in response');
      const ttl = (body.expires_in ?? 10800) * 1000;
      authCache.set(k, { token: body.access_token, expiresAt: Date.now() + ttl });
      clearUnreachable(host);
      return body.access_token;
    } catch (e) {
      // Only a connect/timeout failure means "box is down". A 401 is the box
      // answering promptly, and must not blacklist it.
      if (isConnectFailure(e)) markUnreachable(host);
      throw e;
    } finally {
      loginInflight.delete(k);
    }
  })();

  loginInflight.set(k, attempt);
  return attempt;
}

interface ApiOpts {
  host: string;
  username: string;
  password: string;
}

// Bounded timeouts so no call can hang a long batch run. Execution start is
// legitimately slow on some builds, so POST gets a generous cap.
const GET_TIMEOUT_MS = 20_000;
const POST_TIMEOUT_MS = 120_000;

async function apiGet<T>(opts: ApiOpts, path: string): Promise<T> {
  const token = await ensureToken(opts.host, opts.username, opts.password);
  let res: Response;
  try {
    res = await fetch(`http://${opts.host}/v2${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(GET_TIMEOUT_MS),
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
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
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
        signal: AbortSignal.timeout(GET_TIMEOUT_MS),
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

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

function cacheKey(host: string, user: string): string {
  return `${host}::${user}`;
}

function isAlive(state: AuthState | undefined): state is AuthState {
  return !!state && state.expiresAt - 60_000 > Date.now();
}

/** Login (or use cached token) and return a Bearer header value. */
export async function ensureToken(host: string, username: string, password: string): Promise<string> {
  const k = cacheKey(host, username);
  const cached = authCache.get(k);
  if (isAlive(cached)) return cached.token;

  const url = `http://${host}/v2/login`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(`UESIM login failed: ${res.status} ${await res.text().catch(() => '')}`);
  const body = (await res.json()) as { access_token: string; expires_in?: number };
  if (!body.access_token) throw new Error('UESIM login: no access_token in response');
  const ttl = (body.expires_in ?? 10800) * 1000;
  authCache.set(k, { token: body.access_token, expiresAt: Date.now() + ttl });
  return body.access_token;
}

interface ApiOpts {
  host: string;
  username: string;
  password: string;
}

async function apiGet<T>(opts: ApiOpts, path: string): Promise<T> {
  const token = await ensureToken(opts.host, opts.username, opts.password);
  const res = await fetch(`http://${opts.host}/v2${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`UESIM GET ${path}: ${res.status} ${await res.text().catch(() => '')}`);
  return (await res.json()) as T;
}

async function apiPost<T>(opts: ApiOpts, path: string, body?: unknown): Promise<T> {
  const token = await ensureToken(opts.host, opts.username, opts.password);
  const res = await fetch(`http://${opts.host}/v2${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
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
  const tryFetch = async (auth: 'bearer' | 'none'): Promise<any | undefined> => {
    const headers: Record<string, string> = {};
    if (auth === 'bearer') {
      try {
        const tok = await ensureToken(opts.host, opts.username, opts.password);
        headers['Authorization'] = `Bearer ${tok}`;
      } catch { return undefined; }
    }
    const res = await fetch(`http://${opts.host}/v2/version`, { headers });
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

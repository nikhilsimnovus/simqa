// Container health for a Simnovator station.
//
// A build is not "installed" just because the installer exited 0 — what
// matters is whether the containers it laid down actually came up. The box
// exposes exactly that:
//
//   GET /v2/api/container-health
//     -> { containers: [{ name, status, uptime, ... }],
//          volumeUsage, filesystemUsage }
//
// Note the path: `/v2/api/container-health`, not `/v2/container-health`. The
// extra `api` segment is real — it is what the box's own Container Health page
// calls (found in its shipped bundle, verified live 2026-08-27 returning 13
// containers). Guessing the tidier path returns 404.
//
// Used by the Job Tracker's build view to show, per job, which sub-services
// the installed build is running and whether any of them is down.

import { loadInventory } from '../inventory';

export interface ContainerState {
  name: string;
  /** Box vocabulary: healthy | unhealthy | missing | starting | … */
  status: string;
  uptime?: string;
  healthy: boolean;
}

export interface ContainerHealth {
  host: string;
  checkedAt: string;
  /** True when every container reports healthy. */
  ok: boolean;
  containers: ContainerState[];
  unhealthy: string[];
  volumeUsage?: unknown;
  filesystemUsage?: unknown;
  /** Set when the box could not be asked at all. */
  error?: string;
}

/** The box's own alerting treats these two as "down" — mirrored so SimQA and
 *  the Simnovator UI agree about what unhealthy means. */
const DOWN = new Set(['missing', 'unhealthy']);

export async function fetchContainerHealth(host: string): Promise<ContainerHealth> {
  const checkedAt = new Date().toISOString();
  const base: ContainerHealth = { host, checkedAt, ok: false, containers: [], unhealthy: [] };
  if (!host) return { ...base, error: 'no host' };

  const inv = loadInventory();
  const sys = inv.systems.find((s) => s.host === host);
  const username = sys?.uesim?.username ?? sys?.username ?? 'admin';
  const password = sys?.uesim?.password ?? sys?.password ?? 'admin';

  try {
    const login = await fetch(`http://${host}/v2/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }), signal: AbortSignal.timeout(10_000),
    });
    if (!login.ok) return { ...base, error: `login returned HTTP ${login.status}` };
    const token = (await login.json())?.access_token;
    if (!token) return { ...base, error: 'login returned no access_token' };

    const r = await fetch(`http://${host}/v2/api/container-health`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return { ...base, error: `container-health returned HTTP ${r.status}` };
    const j: any = await r.json();

    const containers: ContainerState[] = (j?.containers ?? []).map((c: any) => {
      const status = String(c?.status ?? 'unknown');
      return {
        name: String(c?.name ?? '?'),
        status,
        uptime: typeof c?.uptime === 'string' ? c.uptime.trim() : undefined,
        healthy: !DOWN.has(status.toLowerCase()),
      };
    });
    const unhealthy = containers.filter((c) => !c.healthy).map((c) => c.name);
    return {
      host, checkedAt,
      ok: containers.length > 0 && unhealthy.length === 0,
      containers, unhealthy,
      volumeUsage: j?.volumeUsage,
      filesystemUsage: j?.filesystemUsage,
      // A 200 carrying no containers is not health — it is an answer with no
      // information, and calling it OK would be the same vacuous green this
      // codebase keeps running into.
      error: containers.length === 0 ? 'container-health returned no containers' : undefined,
    };
  } catch (e: any) {
    return { ...base, error: e?.name === 'TimeoutError' ? 'container-health timed out' : (e?.message ?? String(e)) };
  }
}

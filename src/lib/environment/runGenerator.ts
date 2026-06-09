// Drives the environment auto-create: expand the matrix into variants,
// then POST each through the box's 6-step create-lifecycle.
//
// Mirrors the bulk-tests generator's POST loop (login → cells →
// subscribers → user-plane → power-cycle → mobility → settings → tag),
// but bodies come from the Environment generator (site values stamped,
// scenario flags applied). Resumable: skips variants whose name already
// exists on the box.

import type { Environment } from './types';
import {
  type AutoCreateMatrix, type EnvVariant,
  expandMatrix, buildCells, buildSubscribers, buildUserPlane, buildPowerCycle, buildMobility,
} from './generator';

export interface AutoCreateOpts {
  host: string;
  username: string;
  password: string;
}

export interface AutoCreateProgress {
  startedAt: string;
  finishedAt?: string;
  total: number;
  done: number;
  created: number;
  failed: number;
  skipped: number;
  currentName?: string;
  aborted?: boolean;
}

export interface AutoCreateResult {
  startedAt: string;
  finishedAt: string;
  environmentId: string;
  environmentName: string;
  targetHost: string;
  buildVersion?: string;
  total: number;
  created: Array<{ id: string; name: string; boxId: string; variant: EnvVariant }>;
  failures: Array<{ name: string; step: string; status: number; message: string }>;
  skips: Array<{ name: string; reason: string }>;
}

async function login(host: string, u: string, p: string): Promise<string> {
  const r = await fetch(`http://${host}/v2/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u, password: p }),
  });
  if (!r.ok) throw new Error(`login: ${r.status}`);
  const j: any = await r.json();
  return j.access_token ?? j.token;
}

async function buildVersionOf(host: string, token: string): Promise<string | undefined> {
  try {
    const r = await fetch(`http://${host}/v2/version`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
    if (!r.ok) return undefined;
    const j: any = await r.json();
    const v = j?.simnovator?.version, b = j?.simnovator?.build;
    return v && b ? `${v} (${b})` : (v ?? undefined);
  } catch { return undefined; }
}

/** Self-discover a valid logging + success-criteria pair from any existing
 *  testcase (4.0.0_260602+ validates these against an internal list). */
async function settingsBody(host: string, token: string, name: string, env: Environment): Promise<any> {
  const fallback = {
    loggingProfileName: env.defaults.loggingProfileName ?? 'debug',
    successCriteriaName: env.defaults.successCriteriaName ?? 'BLER Success',
  };
  try {
    const r = await fetch(`http://${host}/v2/testcases?limit=25`, { headers: { Authorization: `Bearer ${token}` } });
    if (r.ok) {
      const d: any = await r.json();
      for (const it of (d.items ?? [])) {
        const t = await fetch(`http://${host}/v2/testcases/${encodeURIComponent(it.id)}`, { headers: { Authorization: `Bearer ${token}` } });
        if (!t.ok) continue;
        const s = (await t.json())?.testDefinition?.settings;
        if (s?.successCriteriaName && s?.loggingProfileName) {
          return { settings: { ...s, testCaseName: name, test_name: name } };
        }
      }
    }
  } catch { /* fall through */ }
  return { settings: { ...fallback, testCaseName: name, test_name: name } };
}

export async function runAutoCreate(
  env: Environment,
  matrix: AutoCreateMatrix,
  opts: AutoCreateOpts,
  onProgress?: (p: AutoCreateProgress) => void,
  signal?: AbortSignal,
): Promise<AutoCreateResult> {
  const startedAt = new Date().toISOString();
  const token = await login(opts.host, opts.username, opts.password);
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const buildVersion = await buildVersionOf(opts.host, token);

  const { variants, skipped } = expandMatrix(env, matrix);

  // Pre-load existing names to skip duplicates (resumable).
  const existing = new Set<string>();
  try {
    const r = await fetch(`http://${opts.host}/v2/testcases?limit=1000`, { headers: { Authorization: H.Authorization } });
    if (r.ok) for (const it of ((await r.json()).items ?? [])) if (it?.name) existing.add(String(it.name).toLowerCase());
  } catch { /* keep going */ }

  const created: AutoCreateResult['created'] = [];
  const failures: AutoCreateResult['failures'] = [];
  const skips: AutoCreateResult['skips'] = skipped.map(s => ({ name: s.id, reason: s.reason }));
  const progress: AutoCreateProgress = { startedAt, total: variants.length, done: 0, created: 0, failed: 0, skipped: skips.length };

  const POST = (path: string, body: any) => fetch(`http://${opts.host}${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) });
  const PUT  = (path: string, body: any) => fetch(`http://${opts.host}${path}`, { method: 'PUT',  headers: H, body: JSON.stringify(body) });
  const DEL  = (path: string)            => fetch(`http://${opts.host}${path}`, { method: 'DELETE', headers: H });

  const ueCount = matrix.ueCount ?? env.defaults.ueCount ?? 1;

  for (const v of variants) {
    if (signal?.aborted) { progress.aborted = true; break; }
    progress.currentName = v.id;
    onProgress?.(progress);

    if (existing.has(v.id.toLowerCase())) {
      skips.push({ name: v.id, reason: 'already on box' });
      progress.skipped++; progress.done++;
      continue;
    }

    let boxId = '';
    try {
      const cellsR = await POST('/v2/tests/cells', buildCells(env, v));
      const cellsJ: any = await cellsR.json().catch(() => ({}));
      if (!cellsR.ok || !cellsJ.testCaseId) {
        failures.push({ name: v.id, step: 'cells', status: cellsR.status, message: JSON.stringify(cellsJ).slice(0, 200) });
        progress.failed++; progress.done++; continue;
      }
      boxId = cellsJ.testCaseId;

      const steps: Array<[string, () => Promise<Response>]> = [
        ['subscribers', () => POST(`/v2/tests/${encodeURIComponent(boxId)}/subscribers`, buildSubscribers(env, v, ueCount))],
        ['user-plane',  () => POST(`/v2/tests/${encodeURIComponent(boxId)}/user-plane`,  buildUserPlane(env, v, ueCount))],
        ['power-cycle', () => POST(`/v2/tests/${encodeURIComponent(boxId)}/power-cycle`, buildPowerCycle(env, v))],
      ];
      const mob = buildMobility(env, v);
      if (mob) steps.push(['mobility', () => POST(`/v2/tests/${encodeURIComponent(boxId)}/mobility`, mob)]);

      let failedStep: string | null = null, failedStatus = 0, failedMsg = '';
      for (const [step, fn] of steps) {
        if (signal?.aborted) { progress.aborted = true; break; }
        const sr = await fn();
        if (!sr.ok) { failedStep = step; failedStatus = sr.status; failedMsg = (await sr.text()).slice(0, 200); break; }
      }
      if (failedStep) {
        await DEL(`/v2/testcases/${encodeURIComponent(boxId)}`);
        failures.push({ name: v.id, step: failedStep, status: failedStatus, message: failedMsg });
        progress.failed++; progress.done++; continue;
      }

      const settR = await POST(`/v2/tests/${encodeURIComponent(boxId)}/settings`, await settingsBody(opts.host, token, v.id, env));
      if (!settR.ok) {
        const m = (await settR.text()).slice(0, 200);
        await DEL(`/v2/testcases/${encodeURIComponent(boxId)}`);
        // A name collision means the testcase already exists from a prior
        // run (the dedup pre-load only sees the first 1000 names, so on a
        // big box a collision can slip through). Treat as a SKIP, not a
        // failure — keeps re-runs idempotent.
        if (/already exists/i.test(m)) {
          skips.push({ name: v.id, reason: 'already on box (name collision past dedup window)' });
          progress.skipped++; progress.done++; continue;
        }
        failures.push({ name: v.id, step: 'settings', status: settR.status, message: m });
        progress.failed++; progress.done++; continue;
      }

      await PUT(`/v2/testcases/${encodeURIComponent(boxId)}`, { user_tags: ['env-autocreate', env.id] }).catch(() => {});
      created.push({ id: v.id, name: v.id, boxId, variant: v });
      existing.add(v.id.toLowerCase());
      progress.created++; progress.done++;
    } catch (e: any) {
      if (boxId) await DEL(`/v2/testcases/${encodeURIComponent(boxId)}`).catch(() => {});
      failures.push({ name: v.id, step: 'exception', status: 0, message: e?.message ?? String(e) });
      progress.failed++; progress.done++;
    }
    onProgress?.(progress);
  }

  const finishedAt = new Date().toISOString();
  progress.finishedAt = finishedAt;
  onProgress?.(progress);

  return {
    startedAt, finishedAt,
    environmentId: env.id, environmentName: env.name,
    targetHost: opts.host, buildVersion,
    total: variants.length,
    created, failures, skips,
  };
}

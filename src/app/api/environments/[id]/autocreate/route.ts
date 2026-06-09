// POST /api/environments/[id]/autocreate
//   body: { systemId: string, matrix: AutoCreateMatrix, preview?: boolean }
//
// preview=true → just expand the matrix + return the variant list +
//                skip reasons (no box writes). Lets the UI show the plan +
//                count before committing.
// preview=false → kick off the generator against the target system;
//                 caller polls /api/environments/autocreate-status.

import { NextResponse } from 'next/server';
import { loadInventory, uesimApiOptsForSystem } from '@/lib/inventory';
import { getEnvironment } from '@/lib/environment/store';
import { expandMatrix, type AutoCreateMatrix } from '@/lib/environment/generator';
import { runAutoCreate } from '@/lib/environment/runGenerator';
import { getAutoCreateState, setAutoCreateState, persistAutoCreateState } from '@/lib/environment/state';
import { appendHistoryEntry } from '@/lib/historyStore';

export const dynamic = 'force-dynamic';
export const maxDuration = 1800;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const env = getEnvironment(id);
  if (!env) return NextResponse.json({ ok: false, error: `no environment "${id}"` }, { status: 404 });

  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }
  const matrix = body.matrix as AutoCreateMatrix;
  if (!matrix || !Array.isArray(matrix.cellCounts)) {
    return NextResponse.json({ ok: false, error: 'matrix required (with cellCounts[])' }, { status: 400 });
  }

  // Preview — no box writes, just expand + return the plan.
  if (body.preview) {
    const { variants, skipped } = expandMatrix(env, matrix);
    return NextResponse.json({ ok: true, preview: true, count: variants.length, variants, skipped });
  }

  const systemId: string = body.systemId ?? 'lab-uesim';
  const apiOpts = uesimApiOptsForSystem(loadInventory(), systemId);
  if (!apiOpts) return NextResponse.json({ ok: false, error: `system "${systemId}" not testable` }, { status: 404 });

  const state = getAutoCreateState();
  if (state.abort && state.progress && !state.progress.finishedAt) {
    return NextResponse.json({ ok: false, error: 'an auto-create run is already in progress', progress: state.progress }, { status: 409 });
  }

  const abort = new AbortController();
  setAutoCreateState({
    abort, environmentId: id,
    progress: { startedAt: new Date().toISOString(), total: 0, done: 0, created: 0, failed: 0, skipped: 0 },
  });

  (async () => {
    try {
      const result = await runAutoCreate(
        env, matrix,
        { host: apiOpts.host, username: apiOpts.username, password: apiOpts.password },
        (p) => { getAutoCreateState().progress = p; persistAutoCreateState(); },
        abort.signal,
      );
      getAutoCreateState().result = result;
      persistAutoCreateState();
      try {
        appendHistoryEntry({
          surface: 'bulk-generate',
          label: `Env auto-create "${env.name}" · ${result.total} variants · ${result.created.length} created · ${result.failures.length} fail`,
          startedAt: result.startedAt,
          finishedAt: result.finishedAt,
          targetSystemId: systemId,
          targetHost: result.targetHost,
          buildVersion: result.buildVersion,
          total: result.total,
          passed: result.created.length,
          failed: result.failures.length,
          skipped: result.skips.length,
          meta: { environmentId: id, environmentName: env.name, kind: 'environment-autocreate' },
        });
      } catch { /* history side-channel */ }
    } catch (e: any) {
      getAutoCreateState().result = {
        startedAt: getAutoCreateState().progress?.startedAt ?? new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        environmentId: id, environmentName: env.name,
        targetHost: apiOpts.host,
        total: 0, created: [], failures: [{ name: 'pipeline', step: 'exception', status: 0, message: e?.message ?? String(e) }], skips: [],
      };
    } finally {
      const s = getAutoCreateState();
      if (s.progress) s.progress.finishedAt = new Date().toISOString();
      persistAutoCreateState();
    }
  })();

  return NextResponse.json({ ok: true, systemId, host: apiOpts.host, environmentId: id });
}

// POST /api/bulk-tests/generate
//   body: { systemId: string, limit?: number }
//
// Starts the bulk-testcase generator against the named UESIM system (sys-6
// in the standard lab inventory). Returns immediately with the planned
// total + a run handle id; the caller polls /api/bulk-tests/status to
// track progress.

import { NextResponse } from 'next/server';
import { loadInventory, uesimApiOptsForSystem } from '@/lib/inventory';
import { generateBulkTestcases } from '@/lib/bulkTests/generator';
import { getState, writeManifest } from '@/lib/bulkTests/state';
import type { UesimApiOpts } from '@/lib/bulkTests/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 1800;   // up to 30 min for ~500 creates

export async function POST(req: Request) {
  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }
  const systemId: string = body.systemId ?? 'sys-6';
  const limit: number | undefined = typeof body.limit === 'number' && body.limit > 0 ? body.limit : undefined;

  const inv = loadInventory();
  const apiOpts = uesimApiOptsForSystem(inv, systemId);
  if (!apiOpts) return NextResponse.json({ ok: false, error: `system "${systemId}" not testable (must be UESIM/SIMNOVATOR/CALLBOX type)` }, { status: 404 });

  const state = getState();
  if (state.generation.handle && state.generation.progress && !state.generation.progress.finishedAt) {
    return NextResponse.json({ ok: false, error: 'a generation run is already in progress', progress: state.generation.progress }, { status: 409 });
  }

  const opts: UesimApiOpts = {
    systemId: apiOpts.systemId,
    host: apiOpts.host,
    username: apiOpts.username,
    password: apiOpts.password,
  };

  const handle = { abort: new AbortController() };
  state.generation = { handle, progress: { startedAt: new Date().toISOString(), total: 0, done: 0, passed: 0, failed: 0, skipped: 0 } };

  // Fire and forget. The caller polls /api/bulk-tests/status.
  (async () => {
    try {
      const result = await generateBulkTestcases(
        opts,
        (p) => { state.generation.progress = p; },
        handle.abort.signal,
        limit,
      );
      state.generation.result = result;
      writeManifest(result);
    } catch (e: any) {
      const startedAt = state.generation.progress?.startedAt ?? new Date().toISOString();
      state.generation.result = {
        startedAt,
        finishedAt: new Date().toISOString(),
        targetHost: opts.host,
        total: 0, passed: 0, failed: 0, skipped: 0,
        created: [], failures: [{ id: 'pipeline', name: 'pipeline', step: 'exception', status: 0, message: e?.message ?? String(e) }],
        skips: [],
      };
    } finally {
      if (state.generation.progress) state.generation.progress.finishedAt = new Date().toISOString();
    }
  })();

  return NextResponse.json({ ok: true, systemId, host: opts.host, limit: limit ?? null });
}

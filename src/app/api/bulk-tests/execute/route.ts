// POST /api/bulk-tests/execute
//   body: { systemId?: string, uesimSystemId?: string, sampleSize?: number,
//           pollTimeoutMs?: number }
//
// Actually RUNS a sample of qa-bulk testcases on the box:
//   trigger execution → wait for ue.cfg to appear on the UE-sim → stop
//   execution → export testcase pack → on failure capture screen-log +
//   ots.log tail. Evidence is written under
//   dist/build-reports/<build-slug>/testcase-evidence/<name>/.
//
// Sequential because the box has a system-wide execution mutex. Caller
// almost always wants sampleSize set (full runs of >50 cases take hours).

import { NextResponse } from 'next/server';
import { loadInventory } from '@/lib/inventory';
import { executeBulkTestcases } from '@/lib/bulkTests/executor';
import { getState, readManifest } from '@/lib/bulkTests/state';
import { appendHistoryEntry } from '@/lib/historyStore';

export const dynamic = 'force-dynamic';
export const maxDuration = 3600;   // up to 60 min for ~30 sequential exec runs

export async function POST(req: Request) {
  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }
  const systemId: string = body.systemId ?? 'sys-6';
  const uesimSystemId: string = body.uesimSystemId ?? 'sys-7';
  const sampleSize: number | undefined = typeof body.sampleSize === 'number' && body.sampleSize > 0 ? body.sampleSize : undefined;
  const pollTimeoutMs: number | undefined = typeof body.pollTimeoutMs === 'number' && body.pollTimeoutMs > 0 ? body.pollTimeoutMs : undefined;

  const inv = loadInventory();

  const state = getState();
  if (state.execution?.handle && state.execution.progress && !state.execution.progress.finishedAt) {
    return NextResponse.json({ ok: false, error: 'an execution run is already in progress', progress: state.execution.progress }, { status: 409 });
  }

  const gen = state.generation.result ?? readManifest();
  if (!gen || gen.created.length === 0) {
    return NextResponse.json({ ok: false, error: 'no manifest — run /api/bulk-tests/generate first' }, { status: 400 });
  }

  const handle = { abort: new AbortController() };
  // Track execution in the same state as generation/validation so the
  // /bulk-tests page can poll it via /api/bulk-tests/status.
  state.execution = {
    handle,
    progress: { startedAt: new Date().toISOString(), total: Math.min(sampleSize ?? gen.created.length, gen.created.length), done: 0, passed: 0, failed: 0 },
  };

  // Fire-and-forget. The caller polls /api/bulk-tests/status.
  (async () => {
    try {
      const summary = await executeBulkTestcases(inv, {
        simnovatorSystemId: systemId,
        uesimSystemId,
        manifest: gen.created,
        sampleSize,
        buildVersion: gen.buildVersion,
        pollTimeoutMs,
        signal: handle.abort.signal,
        onProgress: (p) => { state.execution!.progress = p; },
      });
      state.execution!.result = summary;
      try {
        appendHistoryEntry({
          surface: 'bulk-execute',
          label: `Bulk execute · ${summary.total} sampled · ${summary.passed} pass / ${summary.failed} fail`,
          startedAt: summary.startedAt,
          finishedAt: summary.finishedAt,
          targetSystemId: systemId,
          targetHost: summary.targetHost,
          buildVersion: summary.buildVersion,
          total: summary.total,
          passed: summary.passed,
          failed: summary.failed,
          detailPath: summary.evidenceRoot,
          meta: { uesimSystemId, sampleSize: sampleSize ?? null },
        });
      } catch { /* history side-channel */ }
    } catch (e: any) {
      state.execution!.result = {
        startedAt: state.execution!.progress?.startedAt ?? new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        targetHost: systemId,
        buildVersion: gen.buildVersion,
        total: 0, passed: 0, failed: 0, results: [],
        evidenceRoot: '',
      };
    } finally {
      if (state.execution!.progress) state.execution!.progress.finishedAt = new Date().toISOString();
    }
  })();

  return NextResponse.json({
    ok: true,
    systemId, uesimSystemId,
    sampleSize: sampleSize ?? gen.created.length,
  });
}

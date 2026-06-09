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
import { executeBulkTestcases } from '@/lib/bulkTests/executor';
import { getState, writeManifest } from '@/lib/bulkTests/state';
import { appendHistoryEntry } from '@/lib/historyStore';
import type { UesimApiOpts } from '@/lib/bulkTests/types';
import type { SweepSize } from '@/lib/bulkTests/spec';

export const dynamic = 'force-dynamic';
export const maxDuration = 1800;   // up to 30 min for ~500 creates

export async function POST(req: Request) {
  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }
  const systemId: string = body.systemId ?? 'sys-6';
  const limit: number | undefined = typeof body.limit === 'number' && body.limit > 0 ? body.limit : undefined;
  const sweep: SweepSize = body.sweep === 'quick' || body.sweep === 'moderate' ? body.sweep : 'complete';
  // When true, after generation finishes we kick off the executor over
  // the just-created testcases (sample-bounded for safety).
  const alsoExecute: boolean = !!body.alsoExecute;
  const uesimSystemId: string = body.uesimSystemId ?? 'sys-7';
  const execSampleSize: number | undefined = typeof body.execSampleSize === 'number' && body.execSampleSize > 0 ? body.execSampleSize : undefined;

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
        sweep,
      );
      state.generation.result = result;
      writeManifest(result);
      try {
        appendHistoryEntry({
          surface: 'bulk-generate',
          label: `Bulk generate (${sweep}) · ${result.total} planned · ${result.passed} created · ${result.failed} fail · ${result.skipped} skip`,
          startedAt: result.startedAt,
          finishedAt: result.finishedAt,
          targetSystemId: systemId,
          targetHost: result.targetHost,
          buildVersion: result.buildVersion,
          total: result.total,
          passed: result.passed,
          failed: result.failed,
          skipped: result.skipped,
          detailPath: 'data/bulk-tests/manifest.json',
          meta: { sweep, limit: limit ?? null },
        });
      } catch { /* history is a side-channel */ }

      // If the caller asked for the combined generate+execute flow, kick
      // the executor off now over the just-created manifest. We always
      // sample to keep the run bounded — full executes of 500+ cases
      // would take many hours given the box's system-wide exec mutex.
      if (alsoExecute && result.created.length > 0) {
        const execHandle = { abort: new AbortController() };
        state.execution = {
          handle: execHandle,
          progress: { startedAt: new Date().toISOString(), total: Math.min(execSampleSize ?? result.created.length, result.created.length), done: 0, passed: 0, failed: 0 },
        };
        try {
          const execSummary = await executeBulkTestcases(inv, {
            simnovatorSystemId: systemId,
            uesimSystemId,
            manifest: result.created,
            sampleSize: execSampleSize,
            buildVersion: result.buildVersion,
            signal: execHandle.abort.signal,
            onProgress: (p) => { state.execution!.progress = p; },
          });
          state.execution!.result = execSummary;
          try {
            appendHistoryEntry({
              surface: 'bulk-execute',
              label: `Bulk execute · ${execSummary.total} sampled · ${execSummary.passed} pass / ${execSummary.failed} fail`,
              startedAt: execSummary.startedAt,
              finishedAt: execSummary.finishedAt,
              targetSystemId: systemId,
              targetHost: execSummary.targetHost,
              buildVersion: execSummary.buildVersion,
              total: execSummary.total,
              passed: execSummary.passed,
              failed: execSummary.failed,
              detailPath: execSummary.evidenceRoot,
              meta: { uesimSystemId, sampleSize: execSampleSize ?? null },
            });
          } catch { /* history side-channel */ }
        } finally {
          if (state.execution?.progress) state.execution.progress.finishedAt = new Date().toISOString();
        }
      }
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

  return NextResponse.json({ ok: true, systemId, host: opts.host, sweep, limit: limit ?? null, alsoExecute });
}

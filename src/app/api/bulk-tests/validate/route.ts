// POST /api/bulk-tests/validate
//   body: { systemId?: string }
//
// Runs the API validator over the manifest produced by the most recent
// /api/bulk-tests/generate call. Returns immediately; caller polls
// /api/bulk-tests/status for progress.

import { NextResponse } from 'next/server';
import { loadInventory, uesimApiOptsForSystem } from '@/lib/inventory';
import { validateBulkTestcases } from '@/lib/bulkTests/validator';
import { getState, readManifest, writeValidationSummary } from '@/lib/bulkTests/state';
import { writeBuildReport } from '@/lib/bulkTests/reportBuilder';
import { appendHistoryEntry } from '@/lib/historyStore';
import type { UesimApiOpts } from '@/lib/bulkTests/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 1800;

export async function POST(req: Request) {
  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }
  const systemId: string = body.systemId ?? 'sys-6';

  const inv = loadInventory();
  const apiOpts = uesimApiOptsForSystem(inv, systemId);
  if (!apiOpts) return NextResponse.json({ ok: false, error: `system "${systemId}" not testable` }, { status: 404 });

  const state = getState();
  if (state.validation.handle && state.validation.progress && !state.validation.progress.finishedAt) {
    return NextResponse.json({ ok: false, error: 'a validation run is already in progress', progress: state.validation.progress }, { status: 409 });
  }

  // Prefer in-memory generation result; fall back to on-disk manifest.
  const result = state.generation.result ?? readManifest();
  if (!result || result.created.length === 0) {
    return NextResponse.json({ ok: false, error: 'no manifest — run /api/bulk-tests/generate first' }, { status: 400 });
  }

  const opts: UesimApiOpts = {
    systemId: apiOpts.systemId,
    host: apiOpts.host,
    username: apiOpts.username,
    password: apiOpts.password,
  };

  const handle = { abort: new AbortController() };
  state.validation = {
    handle,
    progress: { startedAt: new Date().toISOString(), total: result.created.length, done: 0, passed: 0, failed: 0 },
  };

  (async () => {
    try {
      const summary = await validateBulkTestcases(
        opts,
        result.created.map(c => ({ id: c.id, name: c.name, boxId: c.boxId, category: c.category })),
        (p) => { state.validation.progress = p; },
        handle.abort.signal,
      );
      state.validation.result = summary;
      writeValidationSummary(summary);
      // Emit the per-build report (HTML + MD + JSON) so QA has a
      // shareable artifact for this Simnovator build. Joins the
      // generation manifest with the just-finished validation results.
      let detailPath: string | undefined;
      try {
        const paths = writeBuildReport({ generation: result, validation: summary });
        detailPath = paths.htmlPath ? `dist/build-reports/${paths.buildSlug}/report.html` : undefined;
      } catch (e) { /* don't fail the run if the report fails */ }
      // Append a unified-history row so /runs shows this bulk-validate
      // alongside everything else. Fail-closed: a write hiccup here
      // must not break the API response.
      try {
        appendHistoryEntry({
          surface: 'bulk-validate',
          label: `Bulk validate · ${summary.total} testcases · ${summary.passed} pass / ${summary.failed} fail`,
          startedAt: summary.startedAt,
          finishedAt: summary.finishedAt,
          targetSystemId: systemId,
          targetHost: summary.targetHost,
          buildVersion: result.buildVersion,
          total: summary.total,
          passed: summary.passed,
          failed: summary.failed,
          detailPath,
          meta: { manifestSize: result.created.length },
        });
      } catch { /* history is a side-channel */ }
    } catch (e: any) {
      state.validation.result = {
        startedAt: state.validation.progress?.startedAt ?? new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        targetHost: opts.host,
        total: 0, passed: 0, failed: 0, results: [],
      };
    } finally {
      if (state.validation.progress) state.validation.progress.finishedAt = new Date().toISOString();
    }
  })();

  return NextResponse.json({ ok: true, systemId, host: opts.host, total: result.created.length });
}

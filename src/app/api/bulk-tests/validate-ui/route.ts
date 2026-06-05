// POST /api/bulk-tests/validate-ui
//   body: { systemId?: string, sampleSize?: number }
//
// Drives Playwright through Chromium against the box's /testcase UI to
// assert each generated testcase (sampled) renders + is searchable.

import { NextResponse } from 'next/server';
import { loadInventory, uesimApiOptsForSystem } from '@/lib/inventory';
import { validateBulkTestcasesViaUI } from '@/lib/bulkTests/uiValidator';
import { getState, readManifest } from '@/lib/bulkTests/state';
import type { UesimApiOpts } from '@/lib/bulkTests/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 3600;

export async function POST(req: Request) {
  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }
  const systemId: string = body.systemId ?? 'sys-6';
  const sampleSize: number = typeof body.sampleSize === 'number' && body.sampleSize > 0 ? body.sampleSize : 50;

  const inv = loadInventory();
  const apiOpts = uesimApiOptsForSystem(inv, systemId);
  if (!apiOpts) return NextResponse.json({ ok: false, error: `system "${systemId}" not testable` }, { status: 404 });

  const state = getState();
  if (state.uiValidation.handle && state.uiValidation.progress && !state.uiValidation.progress.finishedAt) {
    return NextResponse.json({ ok: false, error: 'a UI validation is already in progress', progress: state.uiValidation.progress }, { status: 409 });
  }

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
  state.uiValidation = {
    handle,
    progress: { startedAt: new Date().toISOString(), total: Math.min(sampleSize, result.created.length), done: 0, passed: 0, failed: 0 },
  };

  (async () => {
    try {
      const summary = await validateBulkTestcasesViaUI(
        opts,
        result.created.map(c => ({ id: c.id, name: c.name, boxId: c.boxId, category: c.category })),
        sampleSize,
        (p) => { state.uiValidation.progress = p; },
        handle.abort.signal,
      );
      state.uiValidation.result = summary;
    } catch (e: any) {
      state.uiValidation.result = {
        startedAt: state.uiValidation.progress?.startedAt ?? new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        targetHost: opts.host,
        total: 0, sampleSize, passed: 0, failed: 0, results: [], runDir: '',
      };
    } finally {
      if (state.uiValidation.progress) state.uiValidation.progress.finishedAt = new Date().toISOString();
    }
  })();

  return NextResponse.json({ ok: true, systemId, host: opts.host, sampleSize });
}

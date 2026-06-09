import { NextResponse } from 'next/server';
import { runUiTests, type UiTesterRequest } from '@/lib/uiTester';
import { loadInventory } from '@/lib/inventory';
import { appendHistoryEntry } from '@/lib/historyStore';

export const dynamic = 'force-dynamic';
// UI runs can take many minutes (full 156-test runs hit ~25 min). The Next.js
// dev server doesn't enforce maxDuration but Vercel-hosted deployments would
// cap at 60s by default. Set to the max allowed.
export const maxDuration = 3600;

export async function POST(req: Request) {
  // Wrap the entire handler so any thrown error becomes a JSON envelope (the
  // page parses the response body as JSON; an HTML 500 page makes it choke
  // with "Unexpected end of JSON input").
  try {
    let body: UiTesterRequest = {};
    try { body = await req.json(); } catch { /* empty is fine */ }
    const inv = loadInventory();
    const r = await runUiTests(inv, body ?? {});
    try {
      const counts = r.counts ?? { total: 0, passed: 0, failed: 0, skipped: 0 };
      appendHistoryEntry({
        surface: 'ui-tests',
        label: `UI sweep · ${counts.total} tests · ${counts.passed} pass / ${counts.failed} fail${counts.skipped ? ` / ${counts.skipped} skip` : ''}`,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        targetSystemId: body?.targetSystemId,
        total: counts.total,
        passed: counts.passed,
        failed: counts.failed,
        skipped: counts.skipped,
        detailPath: r.runDir || undefined,
        meta: {
          browserType: body?.browserType,
          categories: body?.categories ?? null,
          severityFilter: body?.severityFilter ?? null,
        },
      });
    } catch { /* history side-channel */ }
    return NextResponse.json(r);
  } catch (e: any) {
    const msg = e?.stack ?? e?.message ?? String(e);
    return NextResponse.json({
      ok: false,
      error: 'run-failed',
      message: msg,
      counts: { total: 0, passed: 0, failed: 0, skipped: 0 },
      results: [],
      runDir: '',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    }, { status: 500 });
  }
}

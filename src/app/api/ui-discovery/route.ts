// POST /api/ui-discovery
//
// Discover the UI of the selected Simnovator and run the checks that come out
// of it. The body is a DiscoveryRequest; `mode` chooses between mapping the
// UI, running against the map already stored, or both (the default).
//
// Synchronous, like the built-in sweep: a crawl plus a run is minutes of
// browser work, and the page follows it through /api/ui-discovery/status.

import { NextResponse } from 'next/server';
import { runDiscovery, type DiscoveryRequest } from '@/lib/uiDiscovery/run';
import { loadInventory } from '@/lib/inventory';
import { userFromRequest } from '@/lib/identity';
import { appendHistoryEntry } from '@/lib/historyStore';

export const dynamic = 'force-dynamic';
export const maxDuration = 3600;

export async function POST(req: Request) {
  try {
    let body: DiscoveryRequest = {};
    try { body = (await req.json()) as DiscoveryRequest; } catch { /* defaults are fine */ }
    const r = await runDiscovery(loadInventory(), body ?? {});

    try {
      const c = r.counts;
      const pages = r.map?.nodes.length ?? 0;
      appendHistoryEntry({
        surface: 'ui-tests',
        user: userFromRequest(req) || undefined,
        label: body.mode === 'discover'
          ? `UI discovery · ${pages} page(s) found${r.diffSummary && r.diffSummary !== 'No UI changes since the last discovery.' ? ` · ${r.diffSummary}` : ''}`
          : `Dynamic UI run · ${pages} page(s) · ${c.total} checks · ${c.passed} pass / ${c.failed} fail${c.skipped ? ` / ${c.skipped} skip` : ''}`,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        targetSystemId: r.systemId,
        targetHost: r.host,
        buildVersion: r.build,
        total: c.total,
        passed: c.passed,
        failed: c.failed,
        skipped: c.skipped + c.notAvailable,
        detailPath: r.runDir || undefined,
        meta: { mode: body.mode ?? 'discover+run', boxUser: r.username, pages },
      });
    } catch { /* history is a side-channel */ }

    return NextResponse.json(r, { status: r.error ? 409 : 200 });
  } catch (e: any) {
    return NextResponse.json({
      ok: false,
      error: String(e?.stack ?? e?.message ?? e).slice(0, 800),
      counts: { total: 0, passed: 0, failed: 0, skipped: 0, notAvailable: 0, errors: 0 },
      outcomes: [], notes: [],
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      runDir: '', host: '',
    }, { status: 500 });
  }
}

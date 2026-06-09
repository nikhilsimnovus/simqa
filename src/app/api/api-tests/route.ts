import { NextResponse } from 'next/server';
import { runApiTests, type ApiTesterRequest } from '@/lib/apiTester';
import { loadInventory } from '@/lib/inventory';
import { appendHistoryEntry } from '@/lib/historyStore';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as ApiTesterRequest;
  const inv = loadInventory();
  const r = await runApiTests(inv, body ?? {});
  // Append a unified-history row so /runs picks this up. Wrapped because
  // a write hiccup in the side-channel must never break the API response.
  try {
    const counts = r.counts ?? { total: 0, passed: 0, failed: 0, skipped: 0 };
    appendHistoryEntry({
      surface: 'api-tests',
      label: `API sweep · ${counts.total} tests · ${counts.passed} pass / ${counts.failed} fail${counts.skipped ? ` / ${counts.skipped} skip` : ''}`,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      targetSystemId: body?.targetSystemId,
      total: counts.total,
      passed: counts.passed,
      failed: counts.failed,
      skipped: counts.skipped,
      meta: { categories: body?.categories ?? null },
    });
  } catch (e) { /* history is a side-channel */ }
  return NextResponse.json(r);
}

// GET /api/ui-tests/status[?targetHost=192.168.1.95]
// Returns either a single run status (if targetHost given) or the full list
// of currently-active runs across every target host.

import { NextResponse } from 'next/server';
import { getCurrentRunStatus, listActiveRuns } from '@/lib/uiTester';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const targetHost = url.searchParams.get('targetHost') ?? undefined;
  if (targetHost) {
    return NextResponse.json(getCurrentRunStatus(targetHost), { headers: { 'Cache-Control': 'no-store' } });
  }
  // No specific target requested: return both legacy single-run shape AND the
  // multi-run list. The page reads `runs[]` for the multi-target picker.
  return NextResponse.json(
    { ...getCurrentRunStatus(), runs: listActiveRuns() },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

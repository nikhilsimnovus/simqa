// GET /api/end-to-end/status?runId=<id>
// Live progress snapshot for the page's poll loop. Mirrors the shape
// /api/ui-tests/status returns so the UI can reuse the live-progress
// rendering pattern.

import { NextResponse } from 'next/server';
import { getRunStatus } from '@/lib/endToEnd/runner';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const runId = new URL(req.url).searchParams.get('runId') ?? undefined;
  return NextResponse.json(getRunStatus(runId), { headers: { 'Cache-Control': 'no-store' } });
}

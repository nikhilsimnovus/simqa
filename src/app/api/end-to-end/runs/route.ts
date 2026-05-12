// GET /api/end-to-end/runs — list past end-to-end validation reports
// (newest first). Each entry is a thin summary; fetch /runs/[id] for the
// full check-by-check breakdown.

import { NextResponse } from 'next/server';
import { listRuns } from '@/lib/endToEnd/runner';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ runs: listRuns() }, { headers: { 'Cache-Control': 'no-store' } });
}

// GET /api/api-validation/reports
//
// Recent runs, newest first, read from the results.json each one wrote. This
// survives a restart, unlike the in-memory registry the live progress uses.

import { NextResponse } from 'next/server';
import { listRuns } from '@/lib/apiValidation/store';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const asked = Number(new URL(req.url).searchParams.get('limit') ?? 25) || 25;
  return NextResponse.json({ runs: listRuns(Math.min(Math.max(asked, 1), 200)) });
}

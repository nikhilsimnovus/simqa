// GET /api/api-validation/runs/<id>?since=<n>
//
// Live progress: everything that happened after the entries the page already
// holds, so a long run streams in rather than arriving at the end.

import { NextResponse } from 'next/server';
import { getRun } from '@/lib/apiValidation/service';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = getRun(id);
  if (!run) return NextResponse.json({ error: 'unknown run' }, { status: 404 });
  const since = Number(new URL(req.url).searchParams.get('since') ?? 0) || 0;
  return NextResponse.json(run.progress(since));
}

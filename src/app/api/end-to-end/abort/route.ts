// POST /api/end-to-end/abort?runId=<id>
// Signals the runner to bail. Polling loops check ctx.isCanceled() between
// every iteration so this takes effect within ~200ms.

import { NextResponse } from 'next/server';
import { abortRun } from '@/lib/endToEnd/runner';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const runId = new URL(req.url).searchParams.get('runId');
  if (!runId) return NextResponse.json({ ok: false, error: 'runId required' }, { status: 400 });
  const ok = abortRun(runId);
  return NextResponse.json({ ok }, { status: ok ? 200 : 404 });
}

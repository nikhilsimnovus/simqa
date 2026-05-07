// POST /api/ui-tests/abort                     -> abort all active runs
// POST /api/ui-tests/abort?targetHost=...       -> abort the run on that host

import { NextResponse } from 'next/server';
import { abortCurrentRun } from '@/lib/uiTester';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const url = new URL(req.url);
  const targetHost = url.searchParams.get('targetHost') ?? undefined;
  let body: { targetHost?: string } = {};
  try { body = await req.json(); } catch { /* empty */ }
  const which = targetHost ?? body.targetHost;
  const aborted = abortCurrentRun(which);
  if (aborted) return NextResponse.json({ ok: true, message: which ? `abort signalled for ${which}` : 'all runs signalled' });
  return NextResponse.json({ ok: false, message: 'no active run to abort' }, { status: 404 });
}

// GET  /api/environments/autocreate-status  — poll the running job.
// POST /api/environments/autocreate-status/abort handled inline via ?abort=1

import { NextResponse } from 'next/server';
import { getAutoCreateState } from '@/lib/environment/state';

export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getAutoCreateState();
  return NextResponse.json({
    ok: true,
    progress: s.progress ?? null,
    result: s.result ?? null,
    environmentId: s.environmentId ?? null,
  }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST() {
  // Abort the in-flight run.
  const s = getAutoCreateState();
  if (s.abort && s.progress && !s.progress.finishedAt) {
    s.abort.abort();
    return NextResponse.json({ ok: true, aborted: true });
  }
  return NextResponse.json({ ok: false, error: 'no run in progress' }, { status: 404 });
}

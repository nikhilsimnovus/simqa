// POST /api/api-validation/document/rollback
//
// Make an earlier document active again. The current one is archived on the
// way out, so a rollback can itself be rolled back.

import { NextResponse } from 'next/server';
import { activeSpec } from '@/lib/apiValidation/store';
import { rollback, summary, history } from '@/lib/apiValidation/docs';
import { runInProgress } from '@/lib/apiValidation/service';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({} as any));
  if (runInProgress()) {
    return NextResponse.json({ error: 'a run is in progress; wait for it to finish' }, { status: 409 });
  }
  try {
    const spec = rollback(String(body.file ?? ''), activeSpec());
    return NextResponse.json({ ok: true, ...summary(spec), history: history() });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 400 });
  }
}

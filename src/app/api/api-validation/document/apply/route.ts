// POST /api/api-validation/document/apply
//
// Make the previewed document active. The current one is archived first, so
// nothing is ever lost, and applying is refused while a run is in progress —
// a run that changed documents half way through would report against two.

import { NextResponse } from 'next/server';
import { activeSpec } from '@/lib/apiValidation/store';
import { apply, summary, history } from '@/lib/apiValidation/docs';
import { runInProgress } from '@/lib/apiValidation/service';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({} as any));
  if (runInProgress()) {
    return NextResponse.json({ error: 'a run is in progress; wait for it to finish' }, { status: 409 });
  }
  try {
    const spec = apply(String(body.token ?? ''), activeSpec());
    return NextResponse.json({ ok: true, ...summary(spec), history: history() });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 400 });
  }
}

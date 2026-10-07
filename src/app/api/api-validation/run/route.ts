// POST /api/api-validation/run
//
// Start a run and return its id. The run outlives this response — it can take
// many minutes, and the Python tool used a background thread for exactly the
// same reason — so the page polls /runs/<id> for progress.

import { NextResponse } from 'next/server';
import { startRun } from '@/lib/apiValidation/service';
import { userFromRequest } from '@/lib/identity';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({} as any));
  // "Run As" is recorded in every report and in Recent runs. It defaults to
  // the signed-in SimQA user, who is in fact the person running it.
  if (!String(body.run_as ?? '').trim()) body.run_as = userFromRequest(req) || '';
  const r = startRun(body);
  return NextResponse.json(r, { status: r.ok ? 200 : 400 });
}

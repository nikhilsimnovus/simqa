// POST /api/jobs/resource-check  { setupHost }
//
// Station readiness for a station, with no job involved. The per-job variant
// (/api/jobs/<id>/resource-check) cannot serve the wizard any more: the wizard
// now holds an unsaved draft and there is no job to hang the check on until
// Submit. Same check function either way, so the two cannot drift.

import { NextResponse } from 'next/server';
import { runResourceCheck } from '@/lib/jobTracker/resourceCheck';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(req: Request) {
  let body: { setupHost?: string } = {};
  try { body = await req.json(); } catch { /* validated below */ }
  const setupHost = String(body?.setupHost ?? '').trim();
  if (!setupHost) return NextResponse.json({ ok: false, error: 'setupHost is required' }, { status: 400 });
  try {
    const check = await runResourceCheck(setupHost);
    return NextResponse.json({ ok: true, check });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
  }
}

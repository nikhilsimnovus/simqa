// GET /api/automation/campaigns/[id]/progress
//
// Live state of a campaign run — which test case is going, what each one came
// to so far. The same store a suite run reports into, keyed by the campaign
// id, so a refresh mid-run re-attaches exactly as it does for a suite.

import { NextResponse } from 'next/server';
import { getProgress } from '@/lib/automation/progress';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const p = getProgress(id);
  if (!p) return NextResponse.json({ ok: true, running: false });
  return NextResponse.json({ ok: true, running: !p.finished, interrupted: !!p.interrupted, progress: p });
}

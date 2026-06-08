// GET /api/automation/runs/[runId] — fetch one run record in full
//   (includes the per-step verdict array + diagnostics pointer).

import { NextResponse } from 'next/server';
import { getRun } from '@/lib/automation/runStore';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ runId: string }> }) {
  const { runId } = await ctx.params;
  const r = getRun(runId);
  if (!r) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true, run: r });
}

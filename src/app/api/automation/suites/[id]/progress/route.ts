// GET /api/automation/suites/[id]/progress
//
// Live state of an in-flight run: how many rows are done, which one is going,
// and each row's status so far. Cheap and in-memory — the run itself is a long
// synchronous POST that tells the client nothing until it finishes.
//
// Returns `running: false` when no run is in flight; the page then falls back to
// the last saved run for its status column.

import { NextResponse } from 'next/server';
import { getProgress } from '@/lib/automation/progress';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const p = getProgress(id);
  if (!p) return NextResponse.json({ ok: true, running: false });
  return NextResponse.json({ ok: true, running: !p.finished, progress: p });
}

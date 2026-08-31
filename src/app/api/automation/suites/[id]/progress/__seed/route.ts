// TEMPORARY test route — deleted right after use.
// Seeds the in-memory progress store so the page's "re-attach after refresh"
// behaviour can be checked without occupying the lab with a real run.
import { NextResponse } from 'next/server';
import { startProgress, markRunning } from '@/lib/automation/progress';
import { getSuite } from '@/lib/automation/store';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const s = getSuite(id);
  if (!s) return NextResponse.json({ ok: false, error: 'no suite' }, { status: 404 });
  const names = (s.items ?? []).map(i => i.name);
  startProgress(id, s.name, names.length, names);
  markRunning(id, 0, names[0]);
  return NextResponse.json({ ok: true, seeded: names });
}

import { NextResponse } from 'next/server';
import { loadRun, listRunFiles } from '@/lib/runStore';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const run = loadRun(id);
  if (!run) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const files = listRunFiles(id);
  return NextResponse.json({ ...run, evidenceFiles: files });
}

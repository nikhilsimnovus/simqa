import { NextResponse } from 'next/server';
import { getMatrixStatus } from '@/lib/configFidelity/runner';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const r = getMatrixStatus(id);
  if (!r) return NextResponse.json({ error: 'run not found' }, { status: 404 });
  return NextResponse.json(r);
}

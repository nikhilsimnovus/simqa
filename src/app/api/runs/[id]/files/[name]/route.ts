import { NextResponse } from 'next/server';
import { readRunFile } from '@/lib/runStore';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string; name: string }> }) {
  const { id, name } = await ctx.params;
  const text = readRunFile(id, name);
  if (text == null) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return new NextResponse(text, { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

import { NextResponse } from 'next/server';
import { getTestcase } from '@/lib/uesimClient';
import { uesimApiOptsFromInventory, loadInventory } from '@/lib/inventory';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const inv = loadInventory();
  const opts = uesimApiOptsFromInventory(inv);
  if (!opts) return NextResponse.json({ error: 'no UESIM in inventory' }, { status: 400 });
  try {
    const r = await getTestcase(opts, id);
    return NextResponse.json(r);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 502 });
  }
}

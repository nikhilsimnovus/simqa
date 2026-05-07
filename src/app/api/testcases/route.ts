import { NextResponse } from 'next/server';
import { listTestcases } from '@/lib/uesimClient';
import { uesimApiOptsFromInventory, loadInventory } from '@/lib/inventory';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const inv = loadInventory();
  const opts = uesimApiOptsFromInventory(inv);
  if (!opts) return NextResponse.json({ error: 'no UESIM in inventory' }, { status: 400 });
  const url = new URL(req.url);
  const limit  = Number(url.searchParams.get('limit')  ?? 200);
  const offset = Number(url.searchParams.get('offset') ?? 0);
  try {
    const r = await listTestcases(opts, limit, offset);
    return NextResponse.json(r);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 502 });
  }
}

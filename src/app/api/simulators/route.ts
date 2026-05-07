import { NextResponse } from 'next/server';
import { listSimulators } from '@/lib/uesimClient';
import { uesimApiOptsFromInventory, loadInventory } from '@/lib/inventory';

export const dynamic = 'force-dynamic';

export async function GET() {
  const inv = loadInventory();
  const opts = uesimApiOptsFromInventory(inv);
  if (!opts) return NextResponse.json({ error: 'no UESIM in inventory' }, { status: 400 });
  try {
    const r = await listSimulators(opts);
    return NextResponse.json(r);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 502 });
  }
}

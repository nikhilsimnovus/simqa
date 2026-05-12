// GET /api/tools/uesim-patcher/status?systemId=<id>
// Returns the patcher status for a UESIM box.

import { NextResponse } from 'next/server';
import { loadInventory, getSystem } from '@/lib/inventory';
import { getStatus } from '@/lib/labTools';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const systemId = url.searchParams.get('systemId');
  if (!systemId) return NextResponse.json({ error: 'systemId required' }, { status: 400 });
  const inv = loadInventory();
  const sys = getSystem(inv, systemId);
  if (!sys) return NextResponse.json({ error: `system "${systemId}" not in inventory` }, { status: 404 });
  const status = await getStatus(sys);
  return NextResponse.json(status, { headers: { 'Cache-Control': 'no-store' } });
}

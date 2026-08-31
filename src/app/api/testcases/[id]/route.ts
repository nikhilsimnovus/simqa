// GET /api/testcases/<id>?systemId — must accept the same systemId as the
// list route, or a testcase opened from box B gets looked up on box A.

import { NextResponse } from 'next/server';
import { getTestcase } from '@/lib/uesimClient';
import { uesimApiOptsForSystem, loadInventory } from '@/lib/inventory';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const systemId = new URL(req.url).searchParams.get('systemId') ?? undefined;
  const inv = loadInventory();
  const opts = uesimApiOptsForSystem(inv, systemId);
  if (!opts) {
    return NextResponse.json(
      { error: systemId ? `system "${systemId}" is not a testable UESIM` : 'no UESIM in inventory' },
      { status: 400 },
    );
  }
  try {
    const r = await getTestcase(opts, id);
    return NextResponse.json({ ...r, systemId: opts.systemId, host: opts.host });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e), systemId: opts.systemId, host: opts.host }, { status: 502 });
  }
}

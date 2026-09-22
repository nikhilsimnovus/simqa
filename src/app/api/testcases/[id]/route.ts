// GET /api/testcases/<id>?systemId — must accept the same systemId as the
// list route, or a testcase opened from box B gets looked up on box A.

import { NextResponse } from 'next/server';
import { getTestcase } from '@/lib/uesimClient';
import { uesimApiOptsForSystem, loadInventory } from '@/lib/inventory';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const q = new URL(req.url).searchParams;
  const systemId = q.get('systemId') ?? undefined;
  // WHOSE testcase: an operator's token only sees their own, so sruthi's
  // testcase read through simuser's login is a 404. Opened from the
  // dashboard's user tiles with ?boxUserId=<that user>.
  const boxUserId = q.get('boxUserId') ?? undefined;
  const inv = loadInventory();
  const opts = uesimApiOptsForSystem(inv, systemId, boxUserId);
  if (!opts) {
    return NextResponse.json(
      { error: systemId ? `system "${systemId}" is not a testable UESIM` : 'no UESIM in inventory' },
      { status: 400 },
    );
  }
  try {
    const r = await getTestcase(opts, id);
    // boxUser: the login this was read through. An operator can only see —
    // and so only run — their own testcases, so it is also whose runs these are.
    return NextResponse.json({ ...r, systemId: opts.systemId, host: opts.host, boxUser: opts.boxUser });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e), systemId: opts.systemId, host: opts.host }, { status: 502 });
  }
}

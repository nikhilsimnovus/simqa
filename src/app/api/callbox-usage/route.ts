// GET /api/callbox-usage?systemId=<simnovator>&boxUserId=<login>
//
// Before a run applies a config: is anyone ELSE executing on the callbox this
// Simnovator shares, and what config is linked on it right now? The testcase
// page asks this when Run is clicked, so the operator can choose to wait or to
// run on the current config instead of restarting LTE under someone's test.
// The run re-checks on the server (preflight-cfg-bring-up) — this is for the
// prompt, not the protection.
//
// Read-only. Returns names and filenames only — never credentials.

import { NextResponse } from 'next/server';
import { loadInventory, callboxForSimnovator, uesimApiOptsForSystem } from '@/lib/inventory';
import { callboxUsage } from '@/lib/callboxUsage';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const systemId = (q.get('systemId') ?? '').trim();
  if (!systemId) return NextResponse.json({ ok: false, error: 'systemId required' }, { status: 400 });

  const inv = loadInventory();
  const callbox = callboxForSimnovator(inv, systemId);
  if (!callbox) {
    // No callbox bound: a run links nothing and restarts nothing, so there is
    // nobody to protect. Say so rather than erroring the Run button.
    return NextResponse.json({ ok: true, callbox: null, others: [], current: {} });
  }
  const me = uesimApiOptsForSystem(inv, systemId, q.get('boxUserId') ?? undefined)?.boxUser;
  try {
    const { others, current } = await callboxUsage(inv, callbox, { me });
    return NextResponse.json({ ok: true, callbox: { id: callbox.id, host: callbox.host }, me, others, current });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 502 });
  }
}

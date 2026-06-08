// GET /api/automation/uesim-testcases?systemId=sys-6
//
// Pulls the catalogue of testcases from a Simnovator/UESIM by hitting
// GET /v2/testcases?limit=1000 (the only endpoint on this build that
// returns more than 50 rows reliably — see overnight bug-report P5/P8).
// Used by the Automation Suite wizard's testcase multi-select.

import { NextResponse } from 'next/server';
import { loadInventory, uesimApiOptsForSystem } from '@/lib/inventory';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const systemId = url.searchParams.get('systemId');
  if (!systemId) return NextResponse.json({ ok: false, error: 'systemId required' }, { status: 400 });
  const inv = loadInventory();
  const opts = uesimApiOptsForSystem(inv, systemId);
  if (!opts) return NextResponse.json({ ok: false, error: `system "${systemId}" not testable` }, { status: 404 });

  try {
    // Login → cache the JWT for this one call.
    const loginR = await fetch(`http://${opts.host}/v2/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: opts.username, password: opts.password }),
    });
    if (!loginR.ok) {
      return NextResponse.json({ ok: false, error: `login: ${loginR.status}` }, { status: 502 });
    }
    const loginD: any = await loginR.json();
    const token: string = loginD.access_token ?? loginD.token;

    const r = await fetch(`http://${opts.host}/v2/testcases?limit=1000`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return NextResponse.json({ ok: false, error: `box returned ${r.status}` }, { status: 502 });
    const d: any = await r.json();
    const items: any[] = d.items ?? d.data ?? [];
    // Trim to the fields the UI multi-select needs.
    const out = items.map(t => ({
      id: t.id,
      name: t.name,
      description: (t.description ?? '').slice(0, 140),
      lastResult: t?.metadata?.lastExecution?.result ?? null,
      lastStatus: t?.metadata?.lastExecution?.status ?? null,
    }));
    return NextResponse.json({ ok: true, testcases: out, total: out.length, host: opts.host });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
  }
}

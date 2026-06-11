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

    // Page through the catalogue. The box caps a single response at 1000 rows
    // and (verified on 4.0.0_260609) offsets at/near 1000 return EMPTY while
    // total can exceed it — rows past 1000 are unreachable via this API. Page
    // in 500s to collect whatever the box will serve and surface serverTotal +
    // truncated so callers can tell the user what is missing.
    const items: any[] = [];
    let serverTotal = 0;
    for (let offset = 0, page = 0; page < 20; page++) {
      const r = await fetch(`http://${opts.host}/v2/testcases?limit=500&offset=${offset}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) {
        if (page === 0) return NextResponse.json({ ok: false, error: `box returned ${r.status}` }, { status: 502 });
        break;
      }
      const d: any = await r.json();
      const batch: any[] = d.items ?? d.data ?? [];
      serverTotal = d.total ?? serverTotal;
      if (batch.length === 0) break;
      items.push(...batch);
      offset += batch.length;
      if (serverTotal > 0 && items.length >= serverTotal) break;
    }
    const truncated = serverTotal > items.length;
    // Trim to the fields the UI multi-select needs, surface lastModifiedOn
    // so callers can show it and we can sort newest-first.
    const out = items.map(t => ({
      id: t.id,
      name: t.name,
      description: (t.description ?? '').slice(0, 140),
      lastResult: t?.metadata?.lastExecution?.result ?? null,
      lastStatus: t?.metadata?.lastExecution?.status ?? null,
      lastModifiedOn: t?.metadata?.lastModifiedOn ?? null,
      lastExecutedOn: t?.metadata?.lastExecutedOn ?? null,
      createdOn:      t?.metadata?.createdOn ?? null,
    }));
    // Sort newest first by lastModifiedOn → lastExecutedOn → createdOn.
    out.sort((a, b) => {
      const ax = a.lastModifiedOn || a.lastExecutedOn || a.createdOn || '';
      const bx = b.lastModifiedOn || b.lastExecutedOn || b.createdOn || '';
      return bx.localeCompare(ax);
    });
    return NextResponse.json({ ok: true, testcases: out, total: out.length, serverTotal, truncated, host: opts.host });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
  }
}

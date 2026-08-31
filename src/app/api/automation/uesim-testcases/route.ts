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

    // Page through the catalogue.
    //
    // `offset` is a PAGE INDEX on this API, not a row offset. This loop used to
    // advance it by batch.length, so after page 0 it asked for offset=500 —
    // page 500, which is far past the end and comes back empty. The loop then
    // stopped and reported "showing 500 of 886, the box cannot serve past
    // ~1000". That conclusion was wrong: verified live on .95, offset=1 returns
    // the remaining 386 rows. Nothing was unreachable; we were asking wrongly.
    //
    // The box also returns DUPLICATE ids within a single page (500 rows, 491
    // unique on .95), which surfaced as a React duplicate-key error in the
    // suite picker. Deduping here fixes it for every consumer rather than in
    // one component, and means `total` is a count of real testcases.
    const seen = new Set<string>();
    const items: any[] = [];
    let serverTotal = 0;
    let rowsRead = 0;
    for (let page = 0; page < 40; page++) {
      const r = await fetch(`http://${opts.host}/v2/testcases?limit=500&offset=${page}`, {
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
      rowsRead += batch.length;
      for (const t of batch) {
        const id = String(t?.id ?? '');
        if (!id || seen.has(id)) continue;
        seen.add(id);
        items.push(t);
      }
      // serverTotal counts the box's duplicates, so compare against rows READ,
      // not rows kept — otherwise a duplicate-heavy catalogue never terminates.
      if (batch.length < 500) break;
    }
    // Truncated only when the box has rows we never READ. items.length is
    // lower than serverTotal by design, because the box counts its duplicates.
    const truncated = serverTotal > 0 && rowsRead < serverTotal;
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

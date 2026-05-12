// GET /api/end-to-end/testcases?systemId=<id>&search=<q>
// Lists testcases on the given Simnovator system, ordered by most recently
// executed first. Used by the "Run & validate" tab's testcase picker.
//
// Note: deliberately uses /v2/testcases/search rather than /v2/testcases/list
// to inherit the sort (and to avoid SIM40-2013-style hidden-pagination
// silent caps). Returns a flat array — the page paginates client-side.

import { NextResponse } from 'next/server';
import { loadInventory, uesimApiOptsForSystem } from '@/lib/inventory';

export const dynamic = 'force-dynamic';

interface Item {
  id: string;
  name: string;
  description?: string;
  lastExecutedOn?: string;
  lastResult?: string;
  lastExecutionId?: string;
  simulatorName?: string;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const systemId = url.searchParams.get('systemId');
  const search   = (url.searchParams.get('search') ?? '').trim().toLowerCase();
  if (!systemId) return NextResponse.json({ error: 'systemId required' }, { status: 400 });
  const inv = loadInventory();
  const target = uesimApiOptsForSystem(inv, systemId);
  if (!target) return NextResponse.json({ error: `system "${systemId}" not UESIM-capable` }, { status: 404 });

  try {
    // Login
    const lr = await fetch(`http://${target.host}/v2/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: target.username, password: target.password }),
    });
    if (!lr.ok) return NextResponse.json({ error: `login: ${lr.status}` }, { status: 502 });
    const lj: any = await lr.json();
    const token = lj.access_token ?? lj.token;

    // Search — pull first 200 (UI rarely needs more for a picker).
    const sr = await fetch(`http://${target.host}/v2/testcases/search`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ offset: 0, limit: 200 }),
    });
    if (!sr.ok) return NextResponse.json({ error: `search: ${sr.status}` }, { status: 502 });
    const sj: any = await sr.json();
    let items: any[] = sj.items ?? sj.data ?? [];

    // Client-side search filter — if search term given, narrow.
    if (search) {
      items = items.filter((it) => {
        const hay = `${it.id ?? ''} ${it.name ?? ''} ${it.description ?? ''}`.toLowerCase();
        return hay.includes(search);
      });
    }

    // Project to slim type. Sort by most-recently-executed.
    const out: Item[] = items.map((it) => ({
      id: it.id,
      name: it.name,
      description: it.description,
      lastExecutedOn: it.metadata?.lastExecution?.executedOn,
      lastResult: it.metadata?.lastExecution?.result,
      lastExecutionId: it.metadata?.lastExecution?.executionId,
      simulatorName: it.metadata?.lastExecution?.simulatorName,
    }));
    out.sort((a, b) => (b.lastExecutedOn ?? '').localeCompare(a.lastExecutedOn ?? ''));

    return NextResponse.json({ items: out, total: sj.total ?? out.length });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 502 });
  }
}

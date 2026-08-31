// GET /api/jobs/playlists/verify?host=<simnovator>
//
// Which built-in playlist testcases actually exist on that station.
//
// Testcase catalogues differ per box — .95 has 866 testcases, .102 has ~214 —
// so a playlist that resolves on one may be half-missing on another. Finding
// that out at submit time means a job that runs nothing and reports failure;
// finding out here means the wizard can say so while the choice is still being
// made.

import { NextResponse } from 'next/server';
import { loadInventory } from '@/lib/inventory';
import { listTestcases } from '@/lib/uesimClient';
import { listPlaylists } from '@/lib/jobTracker/playlists';
import { getSetup } from '@/lib/jobTracker/setups';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function GET(req: Request) {
  const host = new URL(req.url).searchParams.get('host') ?? '';
  const inv = loadInventory();
  const setup = getSetup(host, inv);
  if (!setup) {
    return NextResponse.json({ ok: false, error: `No Simnovator "${host}" in inventory.` }, { status: 400 });
  }

  const sys = inv.systems.find((s) => s.id === setup.systemId);
  const opts = {
    host: setup.host,
    username: sys?.uesim?.username ?? sys?.username ?? 'admin',
    password: sys?.uesim?.password ?? sys?.password ?? 'admin',
  };

  // Paging note: the box's `offset` is a PAGE INDEX, not a row offset.
  const names = new Set<string>();
  try {
    for (let page = 0; page < 50; page++) {
      const r = await listTestcases(opts, 1000, page);
      const items = r.items ?? [];
      if (!items.length) break;
      for (const t of items) if (t?.name) names.add(t.name);
      if (items.length < 1000) break;
      if (typeof r.total === 'number' && (page + 1) * 1000 >= r.total) break;
    }
  } catch (e: any) {
    // Unreachable box: say so rather than reporting every testcase as missing,
    // which would look like a broken playlist instead of a broken connection.
    return NextResponse.json({
      ok: false,
      reachable: false,
      error: `${setup.host} did not answer: ${e?.message ?? e}`,
    }, { status: 502 });
  }

  const playlists = listPlaylists().map((p) => {
    const present = p.testcases.filter((t) => names.has(t));
    const missing = p.testcases.filter((t) => !names.has(t));
    return {
      id: p.id,
      runnable: missing.length === 0,
      present,
      missing,
    };
  });

  return NextResponse.json({ ok: true, reachable: true, host: setup.host, catalogue: names.size, playlists });
}

// GET /api/ui-discovery/map?systemId=…&boxUserId=…
//
// The UI structure already discovered for a setup, with the plan that comes
// out of it and what changed since the map taken on the previous build. Read
// only — no browser is launched, so opening the page is instant and the tree
// is there before anyone presses Run.

import { NextResponse } from 'next/server';
import { loadInventory, uesimApiOptsForSystem } from '@/lib/inventory';
import { readMap, listHistory, previousBuildMap, otherLoginMaps } from '@/lib/uiDiscovery/store';
import { checksFromMap, planSummary } from '@/lib/uiDiscovery/plan';
import { diffMaps, describeDiff } from '@/lib/uiDiscovery/diff';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const systemId = url.searchParams.get('systemId') ?? undefined;
  const boxUserId = url.searchParams.get('boxUserId') ?? undefined;
  const probeRequiredFields = url.searchParams.get('probeRequiredFields') === '1';
  const includeMutating = url.searchParams.get('includeMutating') === '1';

  const target = uesimApiOptsForSystem(loadInventory(), systemId, boxUserId);
  if (!target) {
    return NextResponse.json({ ok: false, error: `no system matched "${systemId ?? '(default)'}"` }, { status: 404 });
  }

  const map = readMap(target.host, target.username);
  if (!map) {
    return NextResponse.json({
      ok: true, host: target.host, username: target.username, systemId: target.systemId,
      map: null, checks: [], plan: null, diff: null,
      history: listHistory(target.host, target.username),
      message: `No UI has been discovered for ${target.host} as ${target.username} yet.`,
    });
  }

  const checks = checksFromMap(map, {
    probeRequiredFields, includeMutating,
    otherLogins: otherLoginMaps(target.host, target.username),
  });
  const previous = previousBuildMap(target.host, target.username, map.build);
  const diff = previous && previous.discoveredAt !== map.discoveredAt ? diffMaps(previous, map) : undefined;

  return NextResponse.json({
    ok: true,
    host: target.host, username: target.username, systemId: target.systemId,
    map,
    checks,
    plan: planSummary(checks),
    diff: diff ?? null,
    diffSummary: diff ? describeDiff(diff) : null,
    history: listHistory(target.host, target.username),
  });
}

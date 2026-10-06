// GET /api/ui-discovery/status?host=… — live progress of a discovery run.
//
// One browser per box, so there is at most one per host. The page polls this
// while a run is in flight to show the tree filling in and the checks ticking
// over, which matters when a full walk takes minutes.

import { NextResponse } from 'next/server';
import { discoveryStatus, listDiscoveries } from '@/lib/uiDiscovery/run';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const host = new URL(req.url).searchParams.get('host') ?? undefined;
  const current = discoveryStatus(host ?? undefined);
  return NextResponse.json({
    running: !!current,
    current: current ?? null,
    all: listDiscoveries(),
  });
}

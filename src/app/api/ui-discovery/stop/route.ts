// POST /api/ui-discovery/stop { host? } — stop a discovery or run.
//
// The crawler and the executor both check the signal between steps, so
// stopping lands at the next page boundary rather than killing the browser
// mid-click and leaving a dialog open on the box.

import { NextResponse } from 'next/server';
import { stopDiscovery } from '@/lib/uiDiscovery/run';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  let host: string | undefined;
  try { host = (await req.json())?.host; } catch { /* stop whatever is running */ }
  const stopped = stopDiscovery(host);
  return NextResponse.json({
    ok: stopped,
    message: stopped ? 'stopping at the next page boundary' : 'nothing is running',
  });
}

// GET /api/stations/problems
//
// Why each box that is not answering is not answering — the reason behind the
// word "unavailable", for any page that shows that word.
//
// Filled by the station monitor's own polling, so asking costs nothing and
// cannot itself hang on a box that is down. A box that answers has no entry:
// the reason is cleared the moment it comes back, so nothing here can show a
// stale excuse under a green badge.
//
// Hosts and reasons only. No credentials, no key material.

import { NextResponse } from 'next/server';
import { ensureStationMonitor, stationProblems } from '@/lib/stationMonitor';

export const dynamic = 'force-dynamic';

export async function GET() {
  // Same wake-up the dashboard does: after a server restart the monitor is
  // not running until something asks for it.
  ensureStationMonitor();
  return NextResponse.json({ ok: true, problems: stationProblems() });
}

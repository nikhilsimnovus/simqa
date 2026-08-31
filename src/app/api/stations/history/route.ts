// GET /api/stations/history?range=day|week|month|year[&station=<host>]
//
// Usage history for a station: how much of the range it was used, unused, or
// unavailable, bucketed for the graph — plus who last submitted work to it.
//
// The dashboard's history window polls this so the picture keeps updating
// without a full page reload.

import { NextResponse } from 'next/server';
import { allSeries, type Range } from '@/lib/stationHistory';
import { ensureStationMonitor, monitorStatus, tick } from '@/lib/stationMonitor';
import { listSystemUsage } from '@/lib/systemUsage';

export const dynamic = 'force-dynamic';

const RANGES = new Set<Range>(['day', 'week', 'month', 'year']);

export async function GET(req: Request) {
  const url = new URL(req.url);
  const raw = (url.searchParams.get('range') ?? 'day') as Range;
  const range: Range = RANGES.has(raw) ? raw : 'day';
  const station = url.searchParams.get('station') ?? '';

  // Background polling starts on first touch — see ensureStationMonitor.
  ensureStationMonitor();

  // A brand-new install has no history at all until the first tick lands.
  // Rather than showing an empty chart for up to a minute, take one reading
  // now. tick() joins the round already in progress if there is one, so this
  // can never race the timer into writing history out of order.
  if (!monitorStatus().lastTick) {
    try { await tick(); } catch { /* chart degrades to "no data" */ }
  }

  const usage = listSystemUsage();
  const withUsage = (s: ReturnType<typeof allSeries>[number]) => {
    const u = usage[s.systemId];
    return {
      ...s,
      // Who last submitted a job or testcase to this station, from the same
      // record the dashboard's "Last used by" line reads. Absent until someone
      // runs something while signed in.
      lastUsedBy: u?.by,
      lastUsedWhat: u?.what,
      lastUsedAt: u?.at,
    };
  };

  const all = allSeries(range).map(withUsage);

  // The station is the Simnovator. Its bound machines are returned separately
  // so the window can stay about the station without throwing their history
  // away — nothing else in the app exposes it.
  const forHost = station
    ? all.filter((s) => s.host === station || s.stationHost === station)
    : all;
  const primary = station
    ? forHost.find((s) => s.host === station)
    : forHost.find((s) => s.role === 'Simnovator');

  return NextResponse.json({
    ok: true,
    range,
    generatedAt: Date.now(),
    monitor: monitorStatus(),
    station: primary ?? null,
    members: forHost.filter((s) => s.systemId !== primary?.systemId),
    stations: forHost,
  });
}

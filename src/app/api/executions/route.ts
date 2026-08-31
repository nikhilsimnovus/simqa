// GET  /api/executions?systemId  -> what the box is currently running
// POST /api/executions?systemId  -> stop whatever it is running
//
// The box enforces a system-wide execution mutex: one testcase at a time per
// simulator. A simulator reports availability=BUSY plus currentExecutionId
// while a run is in flight, which is both how we warn "already running" before
// triggering and how we find the execution to stop.

import { NextResponse } from 'next/server';
import { stopExecution } from '@/lib/uesimClient';
import { findBusy } from '@/lib/executions';
import { uesimApiOptsForSystem, loadInventory } from '@/lib/inventory';

export const dynamic = 'force-dynamic';

function resolve(systemId: string | null) {
  const opts = uesimApiOptsForSystem(loadInventory(), systemId ?? undefined);
  if (!opts) throw new Error(systemId ? `system "${systemId}" is not a testable UESIM` : 'no UESIM in inventory');
  return opts;
}

export async function GET(req: Request) {
  const systemId = new URL(req.url).searchParams.get('systemId');
  try {
    const opts = resolve(systemId);
    const busy = await findBusy(opts);
    return NextResponse.json({ ok: true, host: opts.host, busy: !!busy, execution: busy });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 502 });
  }
}

export async function POST(req: Request) {
  const systemId = new URL(req.url).searchParams.get('systemId');
  try {
    const opts = resolve(systemId);
    const busy = await findBusy(opts);
    if (!busy) return NextResponse.json({ ok: false, error: `nothing is running on ${opts.host}` }, { status: 409 });
    if (!busy.executionId) {
      return NextResponse.json(
        { ok: false, error: `${opts.host} reports simulator ${busy.simulatorId} BUSY but gave no execution id to stop` },
        { status: 502 },
      );
    }
    const r = await stopExecution(opts, busy.executionId, busy.simulatorId);
    return NextResponse.json({ ok: true, host: opts.host, stopped: busy, response: r });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 502 });
  }
}

// GET  /api/executions?systemId&boxUserId  -> what THIS login is running
// POST /api/executions?systemId&boxUserId  -> stop what THIS login is running
//
// One testcase at a time per SIMULATOR, not per box: each operator on a
// multi-user Simnovator owns one, so three people run three testcases at once.
// The answers here are therefore scoped to the login — asking box-wide is what
// made one operator's run look like a reason to refuse another's, and would
// make Stop reach for hardware that is not theirs.

import { NextResponse } from 'next/server';
import { stopExecution } from '@/lib/uesimClient';
import { findBusy } from '@/lib/executions';
import { uesimApiOptsForSystem, loadInventory } from '@/lib/inventory';

export const dynamic = 'force-dynamic';

function resolve(systemId: string | null, boxUserId?: string | null) {
  const opts = uesimApiOptsForSystem(loadInventory(), systemId ?? undefined, boxUserId ?? undefined);
  if (!opts) throw new Error(systemId ? `system "${systemId}" is not a testable UESIM` : 'no UESIM in inventory');
  return opts;
}

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const systemId = q.get('systemId');
  try {
    const opts = resolve(systemId, q.get('boxUserId'));
    const busy = await findBusy(opts);
    return NextResponse.json({ ok: true, host: opts.host, boxUser: opts.boxUser, busy: !!busy, execution: busy });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 502 });
  }
}

export async function POST(req: Request) {
  const q = new URL(req.url).searchParams;
  const systemId = q.get('systemId');
  try {
    const opts = resolve(systemId, q.get('boxUserId'));
    const busy = await findBusy(opts);
    if (!busy) return NextResponse.json({ ok: false, error: `${opts.boxUser} is not running anything on ${opts.host}` }, { status: 409 });
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

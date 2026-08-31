// POST /api/automation/suites/[id]/stop
//
// Stop a suite run: end the execution the box is running AND cancel the rest of
// the suite. Doing only the former would just let the runner move on to the
// next row, which is not what "stop" means to anyone pressing it.
//
// Both halves are best-effort and reported separately — the box may be idle
// already (nothing to stop) while the suite still has rows queued, or the run
// may live in a different server process after a restart, in which case only
// the box-side stop is possible.

import { NextResponse } from 'next/server';
import { getSuite } from '@/lib/automation/store';
import { abortRun } from '@/lib/automation/progress';
import { findBusy } from '@/lib/executions';
import { stopExecution } from '@/lib/uesimClient';
import { uesimApiOptsForSystem, loadInventory } from '@/lib/inventory';

export const dynamic = 'force-dynamic';

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const suite = getSuite(id);
  if (!suite) return NextResponse.json({ ok: false, error: `no suite "${id}"` }, { status: 404 });

  const cancelled = abortRun(id);

  let stopped: string | null = null;
  let stopError: string | null = null;
  try {
    const opts = uesimApiOptsForSystem(loadInventory(), suite.uesimSystemId ?? undefined);
    if (opts) {
      const busy = await findBusy(opts);
      if (busy?.executionId) {
        await stopExecution(opts, busy.executionId, busy.simulatorId);
        stopped = busy.testCaseName ?? busy.testCaseId ?? busy.executionId;
      }
    }
  } catch (e: any) {
    stopError = e?.message ?? String(e);
  }

  return NextResponse.json({
    ok: true,
    cancelled,               // remaining rows will not run
    stopped,                 // testcase whose execution was stopped, if any
    stopError,
  });
}

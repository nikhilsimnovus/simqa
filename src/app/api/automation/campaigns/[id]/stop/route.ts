// POST /api/automation/campaigns/[id]/stop
//
// Stop a campaign run: end the execution the box is running AND cancel the
// rows still queued. Same two halves as stopping a suite, for the same reason
// — stopping only the box would just let the runner start the next test case.
//
// Which box to stop is not on the campaign, so it comes from the request: the
// page knows what it launched the run with.

import { NextResponse } from 'next/server';
import { getCampaign } from '@/lib/automation/campaignStore';
import { abortRun } from '@/lib/automation/progress';
import { findBusy } from '@/lib/executions';
import { stopExecution } from '@/lib/uesimClient';
import { uesimApiOptsForSystem, loadInventory } from '@/lib/inventory';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const campaign = getCampaign(id);
  if (!campaign) return NextResponse.json({ ok: false, error: `no campaign "${id}"` }, { status: 404 });

  let body: any = {};
  try { body = await req.json(); } catch { /* the queued rows can still be cancelled */ }

  const cancelled = abortRun(id);

  let stopped: string | null = null;
  let stopError: string | null = null;
  try {
    const sysId = String(body.uesimSystemId ?? campaign.lastUesimSystemId ?? '');
    const opts = sysId ? uesimApiOptsForSystem(loadInventory(), sysId, body.boxUserId ?? campaign.lastBoxUserId) : undefined;
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

  return NextResponse.json({ ok: true, cancelled, stopped, stopError });
}

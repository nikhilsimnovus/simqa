// POST /api/automation/suites/[id]/sync
//
// Write this suite's folders and files to the Automation Server now:
//
//   /root/automation_configs/<Suite Name>/<Test Case Name>/
//       test.json  enb.cfg  mme.cfg  ims.cfg  db  ots.cfg  ue.cfg
//
// Saving a suite does this in the background and a run does it again for the
// row it is about to execute, so this endpoint is for the cases neither
// covers: a suite that existed before the tree did, or a box that was down
// when it was saved and is back now.
//
// Reads the callbox and the UE over SSH and the testcase from the Simnovator,
// so it takes a few seconds per row.

import { NextResponse } from 'next/server';
import { getSuite } from '@/lib/automation/store';
import { loadInventory } from '@/lib/inventory';
import { syncSuiteToServer } from '@/lib/automation/syncServerConfigs';
import { automationRoot, rootIsCanonical } from '@/lib/automation/serverConfigs';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const suite = getSuite(id);
  if (!suite) return NextResponse.json({ ok: false, error: `no suite "${id}"` }, { status: 404 });

  try {
    const result = await syncSuiteToServer(loadInventory(), suite);
    return NextResponse.json({
      ok: true,
      ...result,                       // carries the root it actually wrote to
      // False when /root/automation_configs could not be written and the app
      // fell back to its own data directory — worth saying plainly, because
      // the whole point is that one path.
      canonical: rootIsCanonical(),
      root: automationRoot(),
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
  }
}

// POST /api/automation/suites/[id]/run
//
// Synchronous (small suites only — typical ≤ 30 testcases). Returns the
// SuiteRunResult JSON directly.
//
//   kind == 'uesim-only'    fires POST /v2/testcases/{id}/executions per
//                            testcaseId on the suite's UESIM.
//   kind == 'uesim+callbox' for each filename in testcaseIds:
//                            - if it's in suite.uploadedConfigs, scp
//                              the content to /root/enb/config/<file>
//                              on the callbox.
//                            - else: verify it's still present on the
//                              callbox (the user picked it earlier).
//                            (eNB restart is left to the operator.)

import { NextResponse } from 'next/server';
import { getSuite } from '@/lib/automation/store';
import { runSuite } from '@/lib/automation/runner';

export const dynamic = 'force-dynamic';
export const maxDuration = 900;

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const suite = getSuite(id);
  if (!suite) return NextResponse.json({ ok: false, error: `no suite "${id}"` }, { status: 404 });

  try {
    const result = await runSuite(suite);
    return NextResponse.json({ ok: true, result });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
  }
}

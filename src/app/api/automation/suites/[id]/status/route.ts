// GET /api/automation/suites/[id]/status
//
// Each testcase's MOST RECENT outcome, as { "<display name>": true|false }.
//
// The /runs listing deliberately returns summaries without steps, so the page
// cannot derive this from it. Walking the run records here keeps the response
// tiny (one boolean per row) instead of shipping every step to the browser.
//
// Newest run wins per row, not per run: executing a single testcase records
// only that one, and the other rows' earlier results are still the truth about
// them.

import { NextResponse } from 'next/server';
import { listRunsForSuite } from '@/lib/automation/runStore';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const runs = listRunsForSuite(id);          // newest first
    const statuses: Record<string, boolean> = {};
    const lastRunAt: Record<string, string> = {};
    for (const run of runs) {
      for (const st of run?.steps ?? []) {
        if (!st?.testcaseId || st.testcaseId in statuses) continue;
        statuses[st.testcaseId] = !!st.ok;
        if (run.finishedAt) lastRunAt[st.testcaseId] = run.finishedAt;
      }
    }
    return NextResponse.json({ ok: true, statuses, lastRunAt });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
  }
}

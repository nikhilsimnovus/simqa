// GET /api/automation/suites/[id]/runs — list past runs for one suite,
//   newest first. Each entry is a thin row (no per-step detail) so the
//   page can render the history without paying full JSON cost.

import { NextResponse } from 'next/server';
import { listRunsForSuite } from '@/lib/automation/runStore';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const runs = listRunsForSuite(id).map(r => ({
    runId: r.runId,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    kind: r.kind,
    total: r.total,
    passed: r.passed,
    failed: r.failed,
    buildVersion: r.buildVersion,
    diagnostics: r.diagnostics,
  }));
  return NextResponse.json({ ok: true, suiteId: id, runs });
}

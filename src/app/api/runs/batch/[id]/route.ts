import { NextResponse } from 'next/server';
import { listRunsInBatch } from '@/lib/runStore';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const runs = listRunsInBatch(id);
  const counts = {
    total:   runs.length,
    passed:  runs.filter((r) => r.status === 'passed').length,
    failed:  runs.filter((r) => r.status === 'failed').length,
    running: runs.filter((r) => r.status === 'running').length,
    queued:  runs.filter((r) => r.status === 'queued').length,
  };
  // Inferred batch status: passed if all done & all passed; failed if any
  // failed; running if any in progress; otherwise pending.
  let status: string;
  if (counts.running > 0 || counts.queued > 0) status = 'running';
  else if (counts.failed > 0)                  status = 'failed';
  else if (counts.passed > 0)                  status = 'passed';
  else                                         status = 'unknown';
  return NextResponse.json({ batchId: id, status, counts, runs: runs.map((r) => ({
    id: r.id,
    testcaseId: r.testcaseId,
    status: r.status,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    failedStep: r.steps.find((s) => !s.ok)?.name,
    summary: r.generatorSummary,
  })) });
}

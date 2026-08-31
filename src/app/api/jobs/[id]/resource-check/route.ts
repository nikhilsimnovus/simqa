// POST /api/jobs/<id>/resource-check → run the live resource check for Step 3.
//
// Probes the station, its Cockpit endpoint, and the UE/app machines bound to
// it, then records the result on the job so Review & Submit can show what was
// actually verified rather than re-asserting it.

import { NextResponse } from 'next/server';
import { getJob, updateJob, appendLogs } from '@/lib/jobTracker/store';
import { runResourceCheck } from '@/lib/jobTracker/resourceCheck';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const job = getJob(id);
  if (!job) return NextResponse.json({ ok: false, error: `no job "${id}"` }, { status: 404 });

  if (job.steps.build.status !== 'ok') {
    return NextResponse.json(
      { ok: false, error: 'Install the build first — resource check is locked until Step 1 succeeds.' },
      { status: 409 },
    );
  }

  let body: any = {};
  try { body = await req.json(); } catch { /* optional */ }
  // The user may point Step 3 at a different station than the one the build
  // went to; honour that, and record it, rather than silently checking the
  // build target.
  const host = String(body?.setupHost ?? '').trim() || job.setupHost;

  updateJob(job.key, (j) => {
    j.status = 'resource_checking';
    j.steps.resources = { status: 'running', startedAt: new Date().toISOString() };
  });

  const result = await runResourceCheck(host);

  appendLogs(job.key, [
    { phase: 'resources', level: 'step', line: `Resource check on ${host} — ${result.ok ? 'READY' : 'BLOCKED'}` },
    ...result.items.map((i) => ({
      phase: 'resources' as const,
      level: (i.status === 'failed' ? 'error' : 'info') as 'error' | 'info',
      line: `${i.status.toUpperCase().padEnd(8)} ${i.name}${i.detail ? ` — ${i.detail}` : ''}`,
    })),
  ]);

  const updated = updateJob(job.key, (j) => {
    j.resourceCheck = result;
    j.setupHost = host;
    j.status = result.ok ? 'ready' : 'resource_failed';
    j.steps.resources = {
      ...j.steps.resources,
      status: result.ok ? 'ok' : 'failed',
      finishedAt: new Date().toISOString(),
      detail: result.ok
        ? `${result.items.filter((i) => i.status === 'ready').length} checks passed`
        : result.items.filter((i) => i.blocking && i.status === 'failed').map((i) => i.name).join(', ') + ' failed',
    };
  });

  return NextResponse.json({ ok: true, result, job: updated });
}

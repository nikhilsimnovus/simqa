// POST /api/jobs/<id>/submit → create the job for real and start executing.
//
// Re-validates every gate server-side. The wizard already disables Next until
// each step passes, but a disabled button is a convenience, not a control — the
// checks that actually stop a half-configured job from touching lab hardware
// live here.

import { NextResponse } from 'next/server';
import { getJob, updateJob, appendLog } from '@/lib/jobTracker/store';
import { startJobExecution } from '@/lib/jobTracker/executor';
import { userFromRequest } from '@/lib/identity';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const job = getJob(id);
  if (!job) return NextResponse.json({ ok: false, error: `no job "${id}"` }, { status: 404 });

  if (job.submittedAt) {
    return NextResponse.json({ ok: false, error: `${job.id} has already been submitted.` }, { status: 409 });
  }
  if (job.steps.build.status !== 'ok') {
    return NextResponse.json({ ok: false, error: 'Build installation has not succeeded.' }, { status: 409 });
  }
  if (!job.playlistId || job.steps.playlist.status !== 'ok') {
    return NextResponse.json({ ok: false, error: 'No playlist selected.' }, { status: 409 });
  }
  if (job.steps.resources.status !== 'ok' || !job.resourceCheck?.ok) {
    return NextResponse.json({ ok: false, error: 'Resource check has not passed.' }, { status: 409 });
  }

  const submittedAt = new Date().toISOString();
  const updated = updateJob(job.key, (j) => {
    j.submittedAt = submittedAt;
    // Attribute to whoever pressed Submit; keep the original creator if the
    // submit request has no session (a background caller).
    j.user = userFromRequest(req) ?? j.user;
    j.status = 'in_progress';
  });
  appendLog(job.key, {
    phase: 'execution', level: 'step',
    line: `Job submitted by ${updated?.user ?? 'unknown user'}`,
  });

  // Long-running: kick off without awaiting so the browser gets its response
  // now. Progress is on the job record, which the history table polls.
  startJobExecution(job.key);

  return NextResponse.json({ ok: true, job: updated });
}

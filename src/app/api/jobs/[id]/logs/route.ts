// GET /api/jobs/<id>/logs?tail=<n>&phase=<build|playlist|resources|execution>
//
// The job's log, newest-last. `tail` caps the response — a 30-minute install
// emits tens of thousands of lines and shipping all of them would make the log
// view unusable.

import { NextResponse } from 'next/server';
import { getJob, readLog } from '@/lib/jobTracker/store';

export const dynamic = 'force-dynamic';

const PHASES = new Set(['build', 'playlist', 'resources', 'execution']);

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const job = getJob(id);
  if (!job) return NextResponse.json({ ok: false, error: `no job "${id}"` }, { status: 404 });

  const url = new URL(req.url);
  const tail = Math.min(20_000, Math.max(50, Number(url.searchParams.get('tail')) || 5000));
  const phase = url.searchParams.get('phase') ?? '';

  const { entries, total, truncated } = readLog(job.key, tail);
  const filtered = PHASES.has(phase) ? entries.filter((e) => e.phase === phase) : entries;

  return NextResponse.json({
    ok: true,
    job: {
      id: job.id, status: job.status, user: job.user,
      playlistName: job.playlistName, setupHost: job.setupHost,
      createdAt: job.createdAt, startedAt: job.startedAt, finishedAt: job.finishedAt,
      build: job.build, resourceCheck: job.resourceCheck, testcases: job.testcases, steps: job.steps,
    },
    entries: filtered,
    total,
    truncated,
  });
}

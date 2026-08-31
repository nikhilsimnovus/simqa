// GET   /api/jobs/<id>        → one job record (polled by the wizard + log view)
// PATCH /api/jobs/<id>        → save wizard progress (playlist choice)
// POST  /api/jobs/<id>/submit lives in ./submit

import { NextResponse } from 'next/server';
import { getJob, updateJob } from '@/lib/jobTracker/store';
import { getPlaylist } from '@/lib/jobTracker/playlists';
import type { TestcaseResult } from '@/lib/jobTracker/types';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const job = getJob(id);
  if (!job) return NextResponse.json({ ok: false, error: `no job "${id}"` }, { status: 404 });
  return NextResponse.json({ ok: true, job });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const job = getJob(id);
  if (!job) return NextResponse.json({ ok: false, error: `no job "${id}"` }, { status: 404 });

  let body: any = {};
  try { body = await req.json(); } catch { /* validated below */ }

  if (typeof body?.playlistId === 'string') {
    const pl = getPlaylist(body.playlistId);
    if (!pl) {
      return NextResponse.json({ ok: false, error: `no playlist "${body.playlistId}"` }, { status: 400 });
    }
    // The build must be in before a playlist can be attached — the whole point
    // of the gate is that nothing downstream runs against an uninstalled build.
    if (job.steps.build.status !== 'ok') {
      return NextResponse.json(
        { ok: false, error: 'Install the build first — the playlist step is locked until Step 1 succeeds.' },
        { status: 409 },
      );
    }
    // The caller may run a SUBSET of the playlist. Validate the selection
    // against the playlist rather than trusting it: an unknown name here would
    // become a testcase the executor could only ever skip, and the job record
    // would claim to have run something that was never in the playlist.
    const requested: string[] | undefined = Array.isArray(body?.selectedTestcases)
      ? body.selectedTestcases.filter((t: unknown) => typeof t === 'string')
      : undefined;
    const unknown = (requested ?? []).filter((t) => !pl.testcases.includes(t));
    if (unknown.length) {
      return NextResponse.json(
        { ok: false, error: `not in playlist "${pl.name}": ${unknown.join(', ')}` },
        { status: 400 },
      );
    }
    // Keep playlist order regardless of the order they were ticked in.
    const chosen = requested && requested.length
      ? pl.testcases.filter((t) => requested.includes(t))
      : pl.testcases;
    if (chosen.length === 0) {
      return NextResponse.json({ ok: false, error: 'select at least one testcase to run' }, { status: 400 });
    }

    const updated = updateJob(job.key, (j) => {
      j.playlistId = pl.id;
      j.playlistName = pl.name;
      j.playlistTestcases = pl.testcases;
      j.testcases = chosen.map((name): TestcaseResult => ({ name, status: 'queued' }));
      const subset = chosen.length !== pl.testcases.length;
      j.steps.playlist = {
        status: 'ok', finishedAt: new Date().toISOString(),
        detail: subset
          ? `${pl.name} · ${chosen.length} of ${pl.testcases.length} testcases selected`
          : `${pl.name} · ${chosen.length} testcases`,
      };
    });
    return NextResponse.json({ ok: true, job: updated });
  }

  return NextResponse.json({ ok: false, error: 'nothing to update' }, { status: 400 });
}

// POST /api/jobs/submit → validate a draft configuration, create the job, run it.
//
// This is the ONLY thing that creates a job. The wizard used to create one at
// Step 1 so the install had somewhere to log, which meant every abandoned
// wizard left a half-configured row in the Job Tracker and the tracker stopped
// meaning "jobs that were actually submitted". The whole configuration now
// lives in the browser as a draft and arrives here in one piece.
//
// Everything is re-validated here rather than trusted: the wizard's disabled
// buttons are a convenience, this is the control.

import { NextResponse } from 'next/server';
import { createJob, updateJob, appendLog } from '@/lib/jobTracker/store';
import { getSetup } from '@/lib/jobTracker/setups';
import { getPlaylist } from '@/lib/jobTracker/playlists';
import { runResourceCheck } from '@/lib/jobTracker/resourceCheck';
import { startJobExecution } from '@/lib/jobTracker/executor';
import { buildNameFromUrl, type TestcaseResult } from '@/lib/jobTracker/types';
import { userFromRequest } from '@/lib/identity';

export const dynamic = 'force-dynamic';
export const maxDuration = 3600;

export interface JobDraft {
  setupHost: string;
  skipBuild?: boolean;
  buildUrl?: string;
  /** Per-component file chosen out of the build, e.g. { ue: 'ue.cfg' }. */
  componentFiles?: Record<string, string>;
  /** 'playlist' runs a playlist (optionally a subset); 'testcase' runs a
   *  hand-picked set with no playlist involved. */
  mode?: 'playlist' | 'testcase';
  playlistId?: string;
  /** The testcases to run, in order. Required in both modes. */
  testcases?: string[];
}

export async function POST(req: Request) {
  let d: JobDraft = { setupHost: '' };
  try { d = (await req.json()) as JobDraft; } catch { /* validated below */ }

  const setupHost = String(d?.setupHost ?? '').trim();
  if (!setupHost) return NextResponse.json({ ok: false, error: 'Pick a resource set (Simnovator station).' }, { status: 400 });
  const setup = getSetup(setupHost);
  if (!setup) return NextResponse.json({ ok: false, error: `No Simnovator "${setupHost}" in inventory.` }, { status: 400 });

  const skipBuild = d?.skipBuild === true;
  const buildUrl = String(d?.buildUrl ?? '').trim();
  if (!skipBuild) {
    if (!buildUrl) return NextResponse.json({ ok: false, error: 'Add a build, or choose Skip Build.' }, { status: 400 });
    // Two shapes are valid, because Browse lists builds that are already on the
    // station: an http(s) URL to fetch, or an absolute path to one already
    // staged there (which needs no download at all).
    const isUrl = /^https?:\/\//i.test(buildUrl);
    const isStagedPath = buildUrl.startsWith('/');
    if (!isUrl && !isStagedPath) {
      return NextResponse.json({
        ok: false,
        error: 'The build must be an http(s) URL to download, or an absolute path to a build already on the station.',
      }, { status: 400 });
    }
    if (!setup.installable) {
      return NextResponse.json({ ok: false, error: setup.problem ?? 'This station cannot install a build.' }, { status: 400 });
    }
  }

  // Testcases. In playlist mode the selection must belong to the playlist; in
  // testcase mode it stands alone and no playlist is required.
  const mode: 'playlist' | 'testcase' = d?.mode === 'testcase' ? 'testcase' : 'playlist';
  const wanted = Array.isArray(d?.testcases) ? d!.testcases!.filter((t) => typeof t === 'string' && t.trim()) : [];
  if (wanted.length === 0) {
    return NextResponse.json({ ok: false, error: 'Select at least one test case to run.' }, { status: 400 });
  }

  let playlistId: string | undefined;
  let playlistName: string | undefined;
  let playlistTestcases: string[] | undefined;
  if (mode === 'playlist') {
    if (!d?.playlistId) return NextResponse.json({ ok: false, error: 'No playlist selected.' }, { status: 400 });
    const pl = getPlaylist(d.playlistId);
    if (!pl) return NextResponse.json({ ok: false, error: `No playlist "${d.playlistId}".` }, { status: 400 });
    const unknown = wanted.filter((t) => !pl.testcases.includes(t));
    if (unknown.length) {
      return NextResponse.json({ ok: false, error: `Not in playlist "${pl.name}": ${unknown.join(', ')}` }, { status: 400 });
    }
    playlistId = pl.id;
    playlistName = pl.name;
    playlistTestcases = pl.testcases;
  }
  // Playlist order for a playlist run; the user's own order for a standalone one.
  const ordered = mode === 'playlist' && playlistTestcases
    ? playlistTestcases.filter((t) => wanted.includes(t))
    : wanted;

  // Resource check runs HERE, at submit, against the station as it is right
  // now — a check the user ran five minutes ago is not evidence about the
  // station they are about to occupy.
  const check = await runResourceCheck(setupHost);
  if (!check.ok) {
    return NextResponse.json({
      ok: false, error: `This station cannot take the job: ${(check.blockers ?? []).join(', ') || 'a blocking check failed'}.`,
      check,
    }, { status: 409 });
  }

  const job = createJob({
    user: userFromRequest(req),
    setupHost: setup.host,
    setupSystemId: setup.systemId,
    setupName: setup.name,
    buildUrl: skipBuild ? '' : buildUrl,
    buildName: skipBuild ? undefined : buildNameFromUrl(buildUrl),
    skipBuild,
  });

  const submittedAt = new Date().toISOString();
  const updated = updateJob(job.key, (j) => {
    j.submittedAt = submittedAt;
    j.playlistId = playlistId;
    j.playlistName = playlistName ?? (mode === 'testcase' ? 'Individual test cases' : undefined);
    j.playlistTestcases = playlistTestcases;
    j.testcases = ordered.map((name): TestcaseResult => ({ name, status: 'queued' }));
    j.resourceCheck = check;
    j.componentFiles = d?.componentFiles && Object.keys(d.componentFiles).length ? d.componentFiles : undefined;
    if (!skipBuild) j.build.installPending = true;
    j.steps.playlist = {
      status: 'ok', finishedAt: submittedAt,
      detail: mode === 'playlist'
        ? `${playlistName} · ${ordered.length}${playlistTestcases && ordered.length !== playlistTestcases.length ? ` of ${playlistTestcases.length}` : ''} test case(s)`
        : `${ordered.length} individual test case(s)`,
    };
    j.steps.resources = { status: 'ok', finishedAt: submittedAt, detail: check.verdict };
    // Queued vs in-progress is a real distinction: the station may be busy with
    // someone else's run, and saying "in progress" then would be a lie.
    j.status = check.willQueue ? 'queued' : 'in_progress';
  });

  appendLog(job.key, { phase: 'execution', level: 'step', line: `Job submitted by ${updated?.user ?? 'unknown user'}` });
  appendLog(job.key, {
    phase: 'build', level: 'step',
    line: skipBuild
      ? `Build installation SKIPPED — running against the build already on ${setup.host}.`
      : `Build queued for install after submit: ${buildUrl}`,
  });
  if (check.willQueue) {
    appendLog(job.key, { phase: 'execution', level: 'info', line: 'Station is busy — this job will start once it is available.' });
  }

  startJobExecution(job.key);
  return NextResponse.json({ ok: true, job: updated ?? job });
}

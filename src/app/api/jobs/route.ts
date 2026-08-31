// GET  /api/jobs        → the job history table
// POST /api/jobs        → create a draft job (called when Step 1 starts)
//
// The job record is created as soon as a build install is about to run, not at
// Submit. Installing a build is a real change to lab hardware, so it belongs in
// the history whether or not the user ever finishes the wizard — and it gives
// the install logs somewhere to live from the first line.

import { NextResponse } from 'next/server';
import { listJobs, createJob, appendLog, updateJob } from '@/lib/jobTracker/store';
import { getSetup } from '@/lib/jobTracker/setups';
import { buildNameFromUrl } from '@/lib/jobTracker/types';
import { userFromRequest } from '@/lib/identity';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ ok: true, jobs: listJobs() });
}

export async function POST(req: Request) {
  let body: any = {};
  try { body = await req.json(); } catch { /* validated below */ }

  const buildUrl = String(body?.buildUrl ?? '').trim();
  const setupHost = String(body?.setupHost ?? '').trim();
  const skipBuild = body?.skipBuild === true;

  // A skipped install needs no URL — the point is to run against whatever is
  // already on the station. A non-skipped one must have a usable one.
  if (!skipBuild) {
    if (!buildUrl) {
      return NextResponse.json({ ok: false, error: 'Enter the build URL.' }, { status: 400 });
    }
    try {
      const u = new URL(buildUrl);
      if (!/^https?:$/.test(u.protocol)) throw new Error('protocol');
    } catch {
      return NextResponse.json({ ok: false, error: 'That is not a valid http(s) URL.' }, { status: 400 });
    }
  }
  if (!setupHost) {
    return NextResponse.json({ ok: false, error: 'Choose the Simnovator setup to install onto.' }, { status: 400 });
  }

  const setup = getSetup(setupHost);
  if (!setup) {
    return NextResponse.json({ ok: false, error: `No Simnovator "${setupHost}" in inventory.` }, { status: 400 });
  }
  // Refuse before creating anything: without --ue and --app the installer
  // cannot build a command, and a job that can never install is not worth a
  // history row. Irrelevant when the install is being skipped — that path never
  // builds a command.
  if (!skipBuild && !setup.installable) {
    return NextResponse.json({ ok: false, error: setup.problem ?? 'This setup is not installable.' }, { status: 400 });
  }

  // deferInstall: Step 1 records WHICH build to install and moves on; the
  // install itself runs on the server after Submit. Without this the job
  // could not leave Step 1 until an install had actually succeeded, which is
  // what tied a lab install to a browser tab staying open.
  const deferInstall = body?.deferInstall === true;

  const job = createJob({
    user: userFromRequest(req),
    setupHost: setup.host,
    setupSystemId: setup.systemId,
    setupName: setup.name,
    buildUrl,
    buildName: buildUrl ? buildNameFromUrl(buildUrl) : undefined,
    skipBuild,
  });
  if (skipBuild) {
    appendLog(job.key, {
      phase: 'build', level: 'step',
      line: `Build installation SKIPPED — this job runs against the build already on ${setup.host}.`,
    });
  } else if (deferInstall) {
    // Mark the build step satisfied FOR WIZARD PURPOSES so the playlist and
    // resource steps unlock, while recording plainly that nothing is installed
    // yet. The executor flips this when it actually performs the install.
    const updated = updateJob(job.key, (j) => {
      j.build.installPending = true;
      j.steps.build = {
        status: 'ok',
        finishedAt: new Date().toISOString(),
        detail: `Queued for install after submit — ${j.build.buildName ?? buildUrl}`,
      };
    });
    appendLog(job.key, {
      phase: 'build', level: 'step',
      line: `Build recorded for install after submit: ${buildUrl}`,
    });
    return NextResponse.json({ ok: true, job: updated ?? job });
  }

  return NextResponse.json({ ok: true, job });
}

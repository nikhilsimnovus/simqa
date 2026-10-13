// GET /api/automation/runs/[runId]/files?tc=<test case>[&file=<name>]
//
// The configs ONE RUN deployed for one of its test cases.
//
// Without the `file` parameter: what was kept, with sizes. With it: that
// file's contents.
//
// The point is the snapshot. /root/automation_configs holds what a row
// deploys TODAY — the next run rewrites it and operators edit it in between —
// so reading it to show a run from three weeks ago answers a different
// question than the one being asked. Each run now keeps its own copy, taken
// as it passed through the row.
//
// Runs recorded before that existed have no snapshot. Rather than show
// nothing, this falls back to the row's folder and says so with
// `live: true`, so the page can tell the operator these are the current files
// and not necessarily the ones that ran.

import { NextResponse } from 'next/server';
import { getRun, listRunConfigs, readRunConfig } from '@/lib/automation/runStore';
import { getSuite } from '@/lib/automation/store';
import { listTestCaseFiles, readTestCaseFile, testCaseDir } from '@/lib/automation/serverConfigs';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, ctx: { params: Promise<{ runId: string }> }) {
  const { runId } = await ctx.params;
  const q = new URL(req.url).searchParams;
  const tc = q.get('tc') ?? '';
  const file = q.get('file');

  const run = getRun(runId);
  if (!run) return NextResponse.json({ ok: false, error: `no run "${runId}"` }, { status: 404 });
  if (!tc) return NextResponse.json({ ok: false, error: 'tc is required' }, { status: 400 });

  const snapshot = listRunConfigs(runId, tc);
  const fromSnapshot = snapshot.length > 0;

  // The row, for the fallback — a run's steps name the row, and the suite
  // says which folder it keeps its configs in.
  const suite = getSuite(run.suiteId);
  const row = (suite?.items ?? []).find((r) => r.name === tc);
  const folder = row?.configSuite ?? suite?.name ?? run.suiteName;

  if (file) {
    const text = fromSnapshot
      ? readRunConfig(runId, tc, file)
      : readTestCaseFile(folder, tc, file);
    if (text === undefined) {
      return NextResponse.json({ ok: false, error: `${file} is not kept for this run` }, { status: 404 });
    }
    return NextResponse.json({
      ok: true, runId, testcase: tc, file, bytes: text.length, text,
      live: !fromSnapshot,
    });
  }

  const files = fromSnapshot
    ? snapshot
    : listTestCaseFiles(folder, tc);

  return NextResponse.json({
    ok: true, runId, testcase: tc, files,
    // Whether these are this run's own copies, or the folder as it stands.
    live: !fromSnapshot,
    dir: fromSnapshot ? `kept with this run` : testCaseDir(folder, tc),
  });
}

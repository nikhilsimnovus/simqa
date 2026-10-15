// GET    /api/api-validation/runs/<id>?since=<n>  — live progress
// DELETE /api/api-validation/runs/<id>            — remove a saved report
//
// The GET is what the page polls while a run is going: everything that
// happened after the entries it already holds, so a long run streams in
// rather than arriving all at once at the end.
//
// Both live here because Next routes by path, not by verb. Adding the DELETE
// as a new file at this path REPLACED the GET, and the page then polled a
// route that no longer existed — so a run showed "running · 0/86" until it was
// reloaded by hand, with the results already on the server. One file, both
// verbs.

import { NextResponse } from 'next/server';
import { getRun } from '@/lib/apiValidation/service';
import { deleteRun } from '@/lib/apiValidation/store';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = getRun(id);
  if (!run) return NextResponse.json({ error: 'unknown run' }, { status: 404 });
  const since = Number(new URL(req.url).searchParams.get('since') ?? 0) || 0;
  return NextResponse.json(run.progress(since));
}

/**
 * Delete a saved report: results.json, report.html and the directory holding
 * them. There is no undo, so the page asks first.
 *
 * The id is checked against [A-Za-z0-9._-] before it becomes a path (see
 * store.runDir), which is what keeps a crafted id from reaching outside the
 * reports directory.
 */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const gone = deleteRun(id);
    if (!gone) return NextResponse.json({ ok: false, error: `no report "${id}"` }, { status: 404 });
    return NextResponse.json({ ok: true, deleted: id });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 400 });
  }
}

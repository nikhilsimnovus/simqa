// DELETE /api/api-validation/runs/[id] — remove one saved report.
//
// Deletes the run's whole directory: results.json, report.html and anything
// else it wrote. There is no undo, so the UI asks first.
//
// The id is checked against [A-Za-z0-9._-] before it becomes a path (see
// store.runDir), which is what keeps a crafted id from reaching outside the
// reports directory.

import { NextResponse } from 'next/server';
import { deleteRun } from '@/lib/apiValidation/store';

export const dynamic = 'force-dynamic';

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

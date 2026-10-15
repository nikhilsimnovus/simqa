// GET /api/api-validation/runs/<id>/download/<html|json>
//
// The saved run, served from disk — so a run from last week downloads exactly
// as one from a minute ago, and a restart loses nothing.
//
// The HTML is RE-RENDERED from results.json rather than served as it was
// written. The results are the record; the report is a view of them, and
// pinning the view to the day it ran means every improvement to the report
// only ever reaches runs you have not done yet. The row colours and the
// expected → actual column landed that way: correct for new runs, invisible
// on every report already on the server.
//
// Falls back to the stored HTML when results.json cannot be read or rendered,
// so a run saved before this — or one whose results are damaged — still opens.

import { NextResponse } from 'next/server';
import { readRunFile } from '@/lib/apiValidation/store';
import { renderHtml } from '@/lib/apiValidation/report';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ id: string; kind: string }> }) {
  const { id, kind } = await params;
  const q = new URL(req.url).searchParams;
  const file = kind === 'html' ? 'report.html' : kind === 'json' ? 'results.json' : null;
  if (!file) return NextResponse.json({ error: 'report not found' }, { status: 404 });
  let text: string | null = null;
  try {
    text = readRunFile(id, file);
  } catch {
    text = null;
  }

  if (kind === 'html') {
    try {
      const raw = readRunFile(id, 'results.json');
      if (raw) {
        const fresh = renderHtml(JSON.parse(raw));
        if (fresh) text = fresh;
      }
    } catch {
      // Keep whatever was stored; a report that opens beats one that 500s.
    }
  }

  if (text === null) return NextResponse.json({ error: 'report not found' }, { status: 404 });

  // ?download=1 saves the file instead of opening it in the tab.
  //
  // The bytes are identical either way — the same rendered report, one file
  // with its styles and filtering inside it, so a saved copy works offline and
  // mails as a single attachment. Only the disposition differs.
  const save = ['1', 'true', 'yes'].includes((q.get('download') ?? '').toLowerCase());

  return new NextResponse(text, {
    headers: {
      'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/json',
      'Content-Disposition':
        `${save ? 'attachment' : 'inline'}; filename="simqa-api-report-${id}.${kind}"`,
      'Cache-Control': 'no-store',
    },
  });
}

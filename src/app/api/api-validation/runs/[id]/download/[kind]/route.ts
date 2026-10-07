// GET /api/api-validation/runs/<id>/download/<html|json>
//
// The saved report, served from disk — so a run from last week downloads
// exactly as one from a minute ago, and a restart loses nothing.

import { NextResponse } from 'next/server';
import { readRunFile } from '@/lib/apiValidation/store';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string; kind: string }> }) {
  const { id, kind } = await params;
  const file = kind === 'html' ? 'report.html' : kind === 'json' ? 'results.json' : null;
  if (!file) return NextResponse.json({ error: 'report not found' }, { status: 404 });
  let text: string | null = null;
  try {
    text = readRunFile(id, file);
  } catch {
    text = null;
  }
  if (text === null) return NextResponse.json({ error: 'report not found' }, { status: 404 });
  return new NextResponse(text, {
    headers: {
      'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/json',
      'Content-Disposition': `inline; filename="simqa-api-validation-${id}.${kind}"`,
      'Cache-Control': 'no-store',
    },
  });
}

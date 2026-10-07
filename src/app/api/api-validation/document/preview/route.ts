// POST /api/api-validation/document/preview
//
// Check an uploaded document and say what applying it would change: which
// sections and APIs appear or disappear, which status codes and schemas move,
// and whether the tool's own Simnovator wiring still fits. Nothing is applied
// here — a refused file changes nothing at all.

import { NextResponse } from 'next/server';
import { activeSpec } from '@/lib/apiValidation/store';
import { preview } from '@/lib/apiValidation/docs';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({} as any));
  const text = String(body.text ?? '');
  if (!text.trim()) return NextResponse.json({ error: 'no document was uploaded' }, { status: 400 });
  try {
    return NextResponse.json(preview(text, activeSpec()));
  } catch (e: any) {
    // The reason is written for a person: it says what is wrong with the file.
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 400 });
  }
}

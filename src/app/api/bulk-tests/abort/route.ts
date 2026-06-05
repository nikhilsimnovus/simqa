// POST /api/bulk-tests/abort?which=generation|validation
// Signals the current in-flight run to stop.

import { NextResponse } from 'next/server';
import { getState } from '@/lib/bulkTests/state';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const url = new URL(req.url);
  const which = url.searchParams.get('which') ?? 'generation';
  const s = getState();
  if (which === 'validation') {
    if (!s.validation.handle) return NextResponse.json({ ok: false, message: 'no validation run' }, { status: 404 });
    s.validation.handle.abort.abort();
    return NextResponse.json({ ok: true, message: 'validation abort signalled' });
  }
  if (!s.generation.handle) return NextResponse.json({ ok: false, message: 'no generation run' }, { status: 404 });
  s.generation.handle.abort.abort();
  return NextResponse.json({ ok: true, message: 'generation abort signalled' });
}

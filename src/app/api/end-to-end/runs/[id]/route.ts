// GET /api/end-to-end/runs/[id] — full report for one past run.

import { NextResponse } from 'next/server';
import { loadRun } from '@/lib/endToEnd/runner';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = loadRun(id);
  if (!r) return NextResponse.json({ ok: false, error: `run "${id}" not found` }, { status: 404 });
  return NextResponse.json(r, { headers: { 'Cache-Control': 'no-store' } });
}

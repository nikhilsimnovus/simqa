// GET    /api/automation/suites/[id]   — fetch one suite
// PUT    /api/automation/suites/[id]   — patch (body is partial AutomationSuite)
// DELETE /api/automation/suites/[id]   — remove

import { NextResponse } from 'next/server';
import { getSuite, updateSuite, deleteSuite } from '@/lib/automation/store';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const s = getSuite(id);
  if (!s) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true, suite: s });
}

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let patch: any = {};
  try { patch = await req.json(); } catch { /* empty patch */ }
  try {
    const s = updateSuite(id, patch);
    return NextResponse.json({ ok: true, suite: s });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 400 });
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ok = deleteSuite(id);
  if (!ok) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}

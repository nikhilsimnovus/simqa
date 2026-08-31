// GET    /api/e2e-testcases/<id>   one saved record
// POST   /api/e2e-testcases/<id>   replay it on a chosen system
// DELETE /api/e2e-testcases/<id>   remove it

import { NextResponse } from 'next/server';
import { loadInventory } from '@/lib/inventory';
import { loadE2ETestcase, deleteE2ETestcase, replayE2ETestcase } from '@/lib/e2eTestcases';

export const dynamic = 'force-dynamic';
// Replay pushes config files and walks the box's 6-step create lifecycle.
export const maxDuration = 600;

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const tc = loadE2ETestcase(id);
  if (!tc) return NextResponse.json({ ok: false, error: `no end-to-end test case "${id}"` }, { status: 404 });
  return NextResponse.json({ ok: true, testcase: tc });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: { simnovatorSystemId?: string; name?: string; pushConfigs?: boolean } = {};
  try { body = await req.json(); } catch { /* validated below */ }
  if (!body?.simnovatorSystemId) {
    return NextResponse.json({ ok: false, error: 'Pick the system to run this on.' }, { status: 400 });
  }
  try {
    const inv = loadInventory();
    const r = await replayE2ETestcase(inv, {
      id,
      simnovatorSystemId: body.simnovatorSystemId,
      name: body.name,
      pushConfigs: body.pushConfigs,
    });
    return NextResponse.json(r, { status: r.ok ? 200 : 400 });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.stack ?? e?.message ?? String(e) }, { status: 500 });
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return NextResponse.json({ ok: deleteE2ETestcase(id) });
}

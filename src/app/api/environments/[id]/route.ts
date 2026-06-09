// GET    /api/environments/[id]   — fetch one
// PATCH  /api/environments/[id]   — patch (name, defaults, site tweaks)
// DELETE /api/environments/[id]   — remove

import { NextResponse } from 'next/server';
import { getEnvironment, updateEnvironment, deleteEnvironment } from '@/lib/environment/store';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const env = getEnvironment(id);
  if (!env) return NextResponse.json({ ok: false, error: `no environment "${id}"` }, { status: 404 });
  return NextResponse.json({ ok: true, environment: env });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let patch: any = {};
  try { patch = await req.json(); } catch { /* empty */ }
  try {
    const env = updateEnvironment(id, patch);
    return NextResponse.json({ ok: true, environment: env });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 404 });
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ok = deleteEnvironment(id);
  if (!ok) return NextResponse.json({ ok: false, error: `no environment "${id}"` }, { status: 404 });
  return NextResponse.json({ ok: true });
}

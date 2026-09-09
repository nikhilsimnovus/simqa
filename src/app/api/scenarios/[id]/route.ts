// GET / PUT / DELETE a single scenario.
import { NextResponse } from 'next/server';
import { getScenario, updateScenario, deleteScenario } from '@/lib/scenarios';
import { userFromRequest } from '@/lib/identity';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const s = getScenario(id);
  if (!s) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true, scenario: s });
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'body is not valid JSON' }, { status: 400 }); }
  const s = updateScenario(id, body ?? {}, userFromRequest(req));
  if (!s) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true, scenario: s });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!deleteScenario(id)) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}

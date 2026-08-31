// GET/PUT the workspace settings edited on /settings.
import { NextResponse } from 'next/server';
import { getSettings, saveSettings } from '@/lib/settings';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(getSettings());
}

export async function PUT(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'body is not valid JSON' }, { status: 400 });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'expected a settings object' }, { status: 400 });
  }
  const saved = saveSettings(body);
  return NextResponse.json({ ok: true, settings: saved });
}

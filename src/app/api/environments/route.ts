// GET  /api/environments        — list all saved environments
// POST /api/environments        — create one from a parsed draft (the
//                                  upload endpoint returns the draft; the
//                                  page POSTs it here to persist).

import { NextResponse } from 'next/server';
import { listEnvironments, createEnvironment } from '@/lib/environment/store';
import type { Environment } from '@/lib/environment/types';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ ok: true, environments: listEnvironments() });
}

export async function POST(req: Request) {
  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }
  if (!body?.name || !body?.site) {
    return NextResponse.json({ ok: false, error: 'name + site required (upload first to get a draft)' }, { status: 400 });
  }
  try {
    const env = createEnvironment(body as Omit<Environment, 'id' | 'createdAt' | 'updatedAt'>);
    return NextResponse.json({ ok: true, environment: env });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
  }
}

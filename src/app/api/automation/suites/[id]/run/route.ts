// POST /api/automation/suites/[id]/run
//   body: { pushCallboxConfig?: boolean }
//
// Synchronous (small suites only — typical ≤ 30 testcases). Returns the
// SuiteRunResult JSON directly. For huge suites callers should split.

import { NextResponse } from 'next/server';
import { getSuite } from '@/lib/automation/store';
import { runSuite } from '@/lib/automation/runner';

export const dynamic = 'force-dynamic';
export const maxDuration = 900;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const suite = getSuite(id);
  if (!suite) return NextResponse.json({ ok: false, error: `no suite "${id}"` }, { status: 404 });

  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }
  try {
    const result = await runSuite(suite, { pushCallboxConfig: !!body.pushCallboxConfig });
    return NextResponse.json({ ok: true, result });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
  }
}

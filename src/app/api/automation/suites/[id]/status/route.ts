// GET /api/automation/suites/[id]/status
//
// Each testcase's most recent outcome — SimQA's pass/fail plus the box's own
// status and verdict. The logic lives in lib/automation/rowOutcomes.ts because
// campaigns need exactly the same answer about exactly the same run records.
//
// The /runs listing deliberately returns summaries without steps, so the page
// cannot derive this from it. Walking the run records here keeps the response
// tiny instead of shipping every step to the browser.

import { NextResponse } from 'next/server';
import { rowOutcomes } from '@/lib/automation/rowOutcomes';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    return NextResponse.json({ ok: true, ...rowOutcomes(id) });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
  }
}

// GET /api/automation/campaigns/[id]/status
//
// The campaign's rows, each with its most recent outcome: SimQA's pass/fail
// and the Simnovator's own status and verdict.
//
// A campaign executes as a throwaway suite whose id is the campaign's, so its
// runs are in the same store under the same key — the same function answers
// for both, and a campaign's Status column means what a suite's means.

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

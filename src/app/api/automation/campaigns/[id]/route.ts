// GET    /api/automation/campaigns/[id] — one campaign
// PUT    /api/automation/campaigns/[id] — rename, reorder, drop rows
// DELETE /api/automation/campaigns/[id] — remove it
//
// Deleting a campaign removes the running order and nothing else: the suites
// its test cases came from, and their saved configs, are untouched.

import { NextResponse } from 'next/server';
import { getCampaign, updateCampaign, deleteCampaign } from '@/lib/automation/campaignStore';
import { userFromRequest } from '@/lib/identity';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const campaign = getCampaign(id);
  if (!campaign) return NextResponse.json({ ok: false, error: `no campaign "${id}"` }, { status: 404 });
  return NextResponse.json({ ok: true, campaign });
}

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let patch: any = {};
  try { patch = await req.json(); } catch { /* empty patch */ }
  try {
    const by = userFromRequest(req);
    if (by) patch.updatedBy = by;
    delete patch.createdBy;
    return NextResponse.json({ ok: true, campaign: updateCampaign(id, patch) });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 400 });
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return NextResponse.json({ ok: deleteCampaign(id) });
}

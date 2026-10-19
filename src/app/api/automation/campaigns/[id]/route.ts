// GET    /api/automation/campaigns/[id] — one campaign
// PUT    /api/automation/campaigns/[id] — rename, reorder, drop rows
// DELETE /api/automation/campaigns/[id] — remove it
//
// Deleting a campaign removes the running order and nothing else: the suites
// its test cases came from, and their saved configs, are untouched.

import { NextResponse } from 'next/server';
import { getCampaign, updateCampaign, deleteCampaign, type CampaignItem } from '@/lib/automation/campaignStore';
import { getSuite } from '@/lib/automation/store';
import { userFromRequest } from '@/lib/identity';

export const dynamic = 'force-dynamic';

/**
 * Rows to append, given as { suiteId, itemId } pairs.
 *
 * The same rule the create route follows: the row is read out of the suite
 * rather than trusted from the client, so a campaign cannot come to hold a
 * test case that does not exist. Adding goes through here rather than the
 * page sending a whole `items` array, which would have meant the page
 * rebuilding each row's shape and the two drifting apart.
 */
function itemsFromPicks(picks: Array<{ suiteId: string; itemId: string }>): {
  items: CampaignItem[]; missing: string[];
} {
  const items: CampaignItem[] = [];
  const missing: string[] = [];
  for (const { suiteId, itemId } of picks) {
    const suite = getSuite(String(suiteId));
    const row = (suite?.items ?? []).find((i) => i.id === itemId);
    if (!suite || !row) { missing.push(`${suiteId}/${itemId}`); continue; }
    items.push({
      ...row,
      // A campaign's rows are its own — see the create route.
      id: `ci-${Math.random().toString(36).slice(2, 10)}`,
      sourceSuiteId: suite.id,
      sourceSuiteName: suite.name,
      configSuite: suite.name,
    });
  }
  return { items, missing };
}

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

    let skipped: string[] = [];

    // Append test cases picked from suites, resolved server-side.
    if (Array.isArray(patch.addPicks) && patch.addPicks.length > 0) {
      const current = getCampaign(id);
      if (!current) return NextResponse.json({ ok: false, error: `no campaign "${id}"` }, { status: 404 });
      const { items, missing } = itemsFromPicks(patch.addPicks);
      if (items.length === 0) {
        return NextResponse.json(
          { ok: false, error: `none of those test cases exist: ${missing.join(', ')}` }, { status: 400 });
      }
      patch.items = [...(current.items ?? []), ...items];
      skipped = missing;
    }
    delete patch.addPicks;

    // A new running order, given as the row ids in the order they should go.
    // Rows the list leaves out keep their place at the end rather than being
    // dropped: reordering must never be a way to lose a test case by
    // accident, and deleting one has its own call.
    if (Array.isArray(patch.order) && patch.order.length > 0) {
      const current = getCampaign(id);
      if (!current) return NextResponse.json({ ok: false, error: `no campaign "${id}"` }, { status: 404 });
      const byId = new Map((current.items ?? []).map((i) => [i.id, i]));
      const moved = (patch.order as unknown[])
        .map((rid) => byId.get(String(rid)))
        .filter((i): i is CampaignItem => !!i);
      const seen = new Set(moved.map((i) => i.id));
      patch.items = [...moved, ...(current.items ?? []).filter((i) => !seen.has(i.id))];
    }
    delete patch.order;

    return NextResponse.json({ ok: true, campaign: updateCampaign(id, patch), ...(skipped.length ? { skipped } : {}) });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 400 });
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return NextResponse.json({ ok: deleteCampaign(id) });
}

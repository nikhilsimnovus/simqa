// GET  /api/automation/campaigns  — every campaign, newest first
// POST /api/automation/campaigns  — create one from test cases picked out of
//                                   existing suites
//
// A campaign carries no systems and no login: it is a running order, and where
// it runs is chosen when Run is pressed. What it does carry, per test case, is
// the suite it came from — shown beside the row, and the folder under
// /root/automation_configs its configs are read from at execution time.
//
// Nothing here copies or edits a suite.

import { NextResponse } from 'next/server';
import { listCampaigns, createCampaign, type CampaignItem } from '@/lib/automation/campaignStore';
import { getSuite } from '@/lib/automation/store';
import { userFromRequest } from '@/lib/identity';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ ok: true, campaigns: listCampaigns() });
}

export async function POST(req: Request) {
  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }
  if (!body?.name || typeof body.name !== 'string') {
    return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
  }

  // Rows arrive as { suiteId, itemId } pairs — the campaign reads the real row
  // out of the suite rather than trusting whatever the client sent, so a
  // campaign cannot hold a test case that does not exist.
  const picks: Array<{ suiteId: string; itemId: string }> = Array.isArray(body.picks) ? body.picks : [];
  if (picks.length === 0) {
    return NextResponse.json({ ok: false, error: 'pick at least one test case' }, { status: 400 });
  }

  const items: CampaignItem[] = [];
  const missing: string[] = [];
  for (const { suiteId, itemId } of picks) {
    const suite = getSuite(String(suiteId));
    const row = (suite?.items ?? []).find(i => i.id === itemId);
    if (!suite || !row) { missing.push(`${suiteId}/${itemId}`); continue; }
    items.push({
      ...row,
      // A campaign's rows are its own: a new id keeps two suites' rows apart
      // when both happen to carry the same one.
      id: `ci-${Math.random().toString(36).slice(2, 10)}`,
      sourceSuiteId: suite.id,
      sourceSuiteName: suite.name,
      configSuite: suite.name,
    });
  }
  if (items.length === 0) {
    return NextResponse.json({ ok: false, error: `none of those test cases exist: ${missing.join(', ')}` }, { status: 400 });
  }

  try {
    const by = userFromRequest(req);
    const campaign = createCampaign({ name: body.name.trim(), createdBy: by, updatedBy: by, items });
    return NextResponse.json({ ok: true, campaign, skipped: missing });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 400 });
  }
}

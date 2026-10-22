// GET /api/post-process/report?suite=<suiteId>&row=<display name>
//
// The summary report behind one row's Result: which rules were checked, what
// each expected against what the log held, and every OTA message counted.
//
// It reads the RUN RECORD rather than the box. The report was produced when
// the execution finished and stored with the run, so this never depends on
// the Simnovator still being reachable — or on it still holding a log it has
// since pruned.
//
// Campaigns run as a throwaway suite whose id is the campaign's, so the same
// id works for both.
//
// Nothing here touches API Tests or API Validation.

import { NextResponse } from 'next/server';
import { listRunsForSuite } from '@/lib/automation/runStore';
import { pickPostReport } from '@/lib/postProcess/pickReport';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const suite = (url.searchParams.get('suite') ?? '').trim();
  const row = (url.searchParams.get('row') ?? '').trim();
  if (!suite || !row) {
    return NextResponse.json({ ok: false, error: 'suite and row are both required' }, { status: 400 });
  }
  try {
    const picked = pickPostReport(listRunsForSuite(suite), row);
    // Not an error: a row that has never been post-processed is an ordinary
    // state, and the page says so rather than showing a failure.
    if (!picked) return NextResponse.json({ ok: true, found: false, row });
    return NextResponse.json({ ok: true, found: true, ...picked });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
  }
}

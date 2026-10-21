// POST /api/jira-ui/run   — run a category, or chosen tickets
// GET  /api/jira-ui/run   — what is running now, and the recent runs
//
// The run is started and awaited here, the same way a suite run is: the page
// polls the run by its id while it goes, and every ticket's result is written
// as it finishes, so a browser that closes mid-run loses nothing.

import { NextResponse } from 'next/server';
import { runJiraTickets, liveJiraRuns } from '@/lib/jiraUi/execute';
import { listRuns, recordingAvailable } from '@/lib/jiraUi/store';
import { getSystem, uesimApiOptsForSystem, loadInventory } from '@/lib/inventory';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({
    ok: true,
    live: liveJiraRuns(),
    recent: listRuns(25).map((r) => ({
      runId: r.runId, category: r.category, host: r.host, boxUser: r.boxUser,
      startedAt: r.startedAt, finishedAt: r.finishedAt, live: r.live, stopped: r.stopped,
      total: r.requested.length, done: r.results.length,
      passed: r.results.filter((x) => x.status === 'PASS').length,
      failed: r.results.filter((x) => x.status === 'FAIL').length,
      blocked: r.results.filter((x) => x.status === 'BLOCKED').length,
    })),
    recordingAvailable: recordingAvailable(),
  });
}

export async function POST(req: Request) {
  let body: any = {};
  try { body = await req.json(); } catch { /* reported below */ }

  const systemId = String(body.systemId ?? '').trim();
  const category = String(body.category ?? '').trim();
  const keys: string[] = Array.isArray(body.keys) ? body.keys.map(String) : [];
  if (!systemId) {
    return NextResponse.json({ ok: false, error: 'choose the Simnovator to test against' }, { status: 400 });
  }
  if (!category && keys.length === 0) {
    return NextResponse.json({ ok: false, error: 'choose a category, or one or more tickets' }, { status: 400 });
  }

  // The login comes from the inventory, never from the request — the same
  // credential store System Management uses, so no password crosses the wire
  // and none is written into a run record.
  const inv = loadInventory();
  const sys = getSystem(inv, systemId);
  const opts = uesimApiOptsForSystem(inv, systemId, body.boxUserId ? String(body.boxUserId) : undefined);
  if (!sys || !opts) {
    return NextResponse.json({ ok: false, error: `system "${systemId}" is not a testable Simnovator` }, { status: 404 });
  }

  try {
    const run = await runJiraTickets({
      host: opts.host,
      username: opts.username,
      password: opts.password,
      category: category || '*',
      keys,
      runnableOnly: !!body.runnableOnly,
      headless: body.headless !== false,
      // A category of 297 tickets is hours of browser time, so a run is
      // bounded unless a number is asked for explicitly.
      max: Number.isFinite(Number(body.max)) && Number(body.max) > 0 ? Number(body.max) : 25,
    });
    return NextResponse.json({
      ok: true, runId: run.runId,
      total: run.requested.length, done: run.results.length,
      passed: run.results.filter((r) => r.status === 'PASS').length,
      failed: run.results.filter((r) => r.status === 'FAIL').length,
      blocked: run.results.filter((r) => r.status === 'BLOCKED').length,
      recordingAvailable: run.recordingAvailable,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
  }
}

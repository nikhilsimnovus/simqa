// GET /api/automation/runs/[runId]/execution?tc=<test case>&what=global|cells|ues|ue-summary|logs
//
// One test case's statistics or logs, from the Simnovator, for the execution
// THAT RUN produced.
//
// By execution id, which is the whole point. A suite row owns one test case on
// the box and runs it again and again, so asking the box about the test case
// gives whatever it did most recently — opening a run from three weeks ago
// would then show today's numbers under last month's heading. The id on the
// run record pins it.
//
// Live runs work for free: the box serves statistics and logs for an execution
// in flight, so the page can poll this while a row is running.
//
// Credentials are resolved here, from the inventory, exactly as every other
// caller does — the browser sends a run id and a test case name and never sees
// a password.

import { NextResponse } from 'next/server';
import { getRun } from '@/lib/automation/runStore';
import { getSuite } from '@/lib/automation/store';
import { loadInventory, uesimApiOptsForSystem } from '@/lib/inventory';
import { readStatistics, readLogs } from '@/lib/automation/executionReads';
import { STAT_KINDS, logLines, type StatKind } from '@/lib/automation/logShape';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, ctx: { params: Promise<{ runId: string }> }) {
  const { runId } = await ctx.params;
  const q = new URL(req.url).searchParams;
  const tc = q.get('tc') ?? '';
  const what = q.get('what') ?? 'global';

  const run = getRun(runId);
  if (!run) return NextResponse.json({ ok: false, error: `no run "${runId}"` }, { status: 404 });

  const step = (run.steps ?? []).find((s) => s.testcaseId === tc);
  if (!step) {
    return NextResponse.json({ ok: false, error: `"${tc}" is not a test case of this run` }, { status: 404 });
  }
  if (!step.executionId) {
    // Not an error: a row the box refused, or one the run never reached, has
    // no execution — and saying so is more use than an empty table.
    return NextResponse.json({
      ok: false, noExecution: true,
      error: 'this run produced no execution for this test case, so the Simnovator has no statistics or logs for it',
    }, { status: 404 });
  }

  // Where it ran. The suite says which system and login; the recorded host
  // wins when the suite has since been re-pointed or deleted.
  const inv = loadInventory();
  const suite = getSuite(run.suiteId);
  let systemId = suite?.uesimSystemId;
  if (run.uesimHost) {
    const current = systemId ? inv.systems.find((s) => s.id === systemId) : undefined;
    if (!current || current.host !== run.uesimHost) {
      systemId = inv.systems.find((s) => s.host === run.uesimHost)?.id ?? systemId;
    }
  }
  const opts = uesimApiOptsForSystem(inv, systemId, suite?.boxUserId);
  if (!opts) {
    return NextResponse.json({
      ok: false,
      error: `the Simnovator this ran on (${run.uesimHost ?? 'unknown'}) is not a registered system any more`,
    }, { status: 404 });
  }

  const when = { startedAt: run.startedAt, finishedAt: run.finishedAt };

  if (what === 'logs') {
    const limit = Number(q.get('limit') ?? 500);
    const r = await readLogs(opts, step.executionId, Number.isFinite(limit) ? limit : 500);
    if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: 502 });
    const lines = logLines(r.data);
    return NextResponse.json({
      ok: true, what: 'logs', testcase: tc, executionId: step.executionId,
      host: opts.host, boxUser: opts.boxUser,
      lines, total: lines.length,
    });
  }

  if (!(STAT_KINDS as readonly string[]).includes(what)) {
    return NextResponse.json(
      { ok: false, error: `"${what}" is not one of ${STAT_KINDS.join(', ')} or logs` }, { status: 400 });
  }

  const r = await readStatistics(opts, step.executionId, what as StatKind, when);
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: 502 });
  return NextResponse.json({
    ok: true, what, testcase: tc, executionId: step.executionId,
    host: opts.host, boxUser: opts.boxUser,
    data: r.data,
  });
}

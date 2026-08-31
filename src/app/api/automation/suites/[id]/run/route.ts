// POST /api/automation/suites/[id]/run
//
// Synchronous (small suites only — typical ≤ 30 testcases). Returns the
// SuiteRunResult JSON directly.
//
//   kind == 'uesim-only'    fires POST /v2/testcases/{id}/executions per
//                            testcaseId on the suite's UESIM.
//   kind == 'uesim+callbox' for each filename in testcaseIds:
//                            - if it's in suite.uploadedConfigs, scp
//                              the content to /root/enb/config/<file>
//                              on the callbox.
//                            - else: verify it's still present on the
//                              callbox (the user picked it earlier).
//                            (eNB restart is left to the operator.)

import { NextResponse } from 'next/server';
import { getSuite } from '@/lib/automation/store';
import { runSuite } from '@/lib/automation/runner';
import { startProgress, markRunning, markStep, finishProgress } from '@/lib/automation/progress';
import { userFromRequest } from '@/lib/identity';
import { recordSystemUse } from '@/lib/systemUsage';
import { loadInventory, getSystem } from '@/lib/inventory';

export const dynamic = 'force-dynamic';
export const maxDuration = 900;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const suite = getSuite(id);
  if (!suite) return NextResponse.json({ ok: false, error: `no suite "${id}"` }, { status: 404 });

  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }

  // `itemIds` runs just those rows — the per-testcase Run button in the suite
  // list. Order follows the suite, not the order the ids arrive in, so a subset
  // still executes in the sequence the suite defines.
  let target = suite;
  if (Array.isArray(body.itemIds) && body.itemIds.length > 0) {
    const wanted = new Set(body.itemIds.map(String));
    const picked = (suite.items ?? []).filter(it => wanted.has(it.id));
    if (picked.length === 0) {
      return NextResponse.json({ ok: false, error: 'none of the given itemIds are in this suite' }, { status: 400 });
    }
    target = { ...suite, items: picked, testcaseIds: picked.map(it => it.simnovatorTcId) };
  }

  const rows = target.items ?? [];
  // The controller is registered with the progress store so a Stop request can
  // reach this run: the runner checks the signal between rows, so stopping the
  // box's current execution also ends the suite instead of just letting the
  // next row start.
  const abort = new AbortController();
  startProgress(id, target.name, rows.length || target.testcaseIds.length, rows.map(r => r.name), abort);

  // Who submitted this job, and which lab systems it is about to use. Recorded
  // BEFORE the run rather than after, so a long run shows the box as in-use by
  // this person while it is still going — and a crashed run still leaves the
  // trail behind.
  const submittedBy = userFromRequest(req);
  const inv = loadInventory();
  const what = `automation suite "${target.name}"`;
  for (const sysId of [target.uesimSystemId, target.callboxSystemId]) {
    if (!sysId) continue;
    recordSystemUse({
      systemId: sysId,
      host: getSystem(inv, sysId)?.host,
      by: submittedBy,
      at: new Date().toISOString(),
      what,
    });
  }

  try {
    const result = await runSuite(target, {
      signal: abort.signal,
      submittedBy,
      collectDiagnostics: !!body.collectDiagnostics,
      perfQaUrl: typeof body.perfQaUrl === 'string' ? body.perfQaUrl : undefined,
      perfQaProfile: typeof body.perfQaProfile === 'string' ? body.perfQaProfile : undefined,
      onProgress: (done, _total, current) => markRunning(id, done, current),
      onStep: (step) => markStep(id, step.testcaseId, step.ok),
    });
    return NextResponse.json({ ok: true, result, runId: result.runId });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
  } finally {
    finishProgress(id);
  }
}

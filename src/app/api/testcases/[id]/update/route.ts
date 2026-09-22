// POST /api/testcases/<id>/update — save an edited testcase.json onto the SAME
// testcase on the Simnovator. The id does not change and nothing is deleted:
// only the sections that differ are written, with the box's own edit endpoint
// (PUT v2/tests/<id>/<section>). See updateTestcaseInPlace().
//
// This replaces /recreate, which deleted the testcase and built a new one.

import { NextResponse } from 'next/server';
import { updateTestcaseInPlace } from '@/lib/automation/duplicateTestcase';
import { normalizeToTestDefinition, EnvironmentParseError } from '@/lib/environment/parse';
import { uesimApiOptsForSystem, loadInventory } from '@/lib/inventory';
import { findBusy } from '@/lib/executions';
import { getTestcase } from '@/lib/uesimClient';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const systemId = body?.systemId as string | undefined;
  // WHOSE testcase. An operator's testcase is only visible — and so only
  // editable — through their own login; writing through the setup default
  // would 404, or edit through the wrong account.
  const boxUserId = body?.boxUserId as string | undefined;

  const inv = loadInventory();
  const opts = uesimApiOptsForSystem(inv, systemId, boxUserId);
  if (!opts) {
    return NextResponse.json(
      { error: systemId ? `system "${systemId}" is not a testable UESIM` : 'no UESIM in inventory' },
      { status: 400 },
    );
  }

  // Accepts the same shapes the environment importer trusts (the box's own
  // testcase.json download envelope, a bare testDefinition, or a raw GET
  // /v2/testcases/<id> response) — the page sends back whatever was edited.
  let testDefinition: any;
  try {
    const normalized = normalizeToTestDefinition(body?.testcaseJson);
    testDefinition = normalized.testDefinition;
    // The export names the testcase twice: the prominent top-level Test_Name
    // and a nested settings copy. Someone editing the file edits the one they
    // can see — carry it into settings so a rename actually takes.
    if (normalized.suggestedName) {
      testDefinition.settings = testDefinition.settings ?? {};
      testDefinition.settings.test_name = normalized.suggestedName;
      testDefinition.settings.testCaseName = normalized.suggestedName;
    }
  } catch (e: any) {
    const msg = e instanceof EnvironmentParseError ? e.message : (e?.message ?? String(e));
    return NextResponse.json({ error: `testcase.json is not valid: ${msg}` }, { status: 400 });
  }

  // Never edit a testcase while it executes: the run would go on under one
  // definition while the box now holds another. Checked here as well as on
  // the page, because a page opened before the run started still has Save
  // enabled. Two signals, since either can be missed on its own: this
  // login's simulator reporting it busy with this testcase, and the
  // testcase's own record saying IN_PROGRESS recently enough to be real (the
  // box can leave a stale IN_PROGRESS behind a run that died).
  try {
    const busy = await findBusy(opts).catch(() => null);
    const tc: any = await getTestcase(opts, id).catch(() => null);
    const last = tc?.metadata?.lastExecution;
    const startedMs = last?.executedOn ? Date.parse(last.executedOn) : NaN;
    const windowMs = ((Number(last?.testDuration) || 0) + 600) * 1000;
    const recordRunning = String(last?.status ?? '').toUpperCase() === 'IN_PROGRESS'
      && Number.isFinite(startedMs) && Date.now() - startedMs < windowMs;
    if ((busy && busy.testCaseId === id) || recordRunning) {
      return NextResponse.json(
        { ok: false, error: 'This test case is running. Stop it or wait for it to finish before editing it.' },
        { status: 409 },
      );
    }
  } catch { /* could not check — the box will refuse anything it cannot apply */ }

  try {
    const r = await updateTestcaseInPlace(opts, id, testDefinition);
    if (r.failedStep) return NextResponse.json({ ok: false, ...r }, { status: 502 });
    return NextResponse.json({ ok: true, ...r });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 502 });
  }
}

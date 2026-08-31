// POST /api/testcases/<id>/recreate — delete this testcase and recreate it
// from an edited testcase.json. The box has no update API (see
// duplicateTestcase.ts's module header); this is the only way an edit takes
// effect on the Simnovator. The id ALWAYS changes on success — the caller
// should navigate to the new one.

import { NextResponse } from 'next/server';
import { recreateTestcase } from '@/lib/automation/duplicateTestcase';
import { normalizeToTestDefinition, EnvironmentParseError } from '@/lib/environment/parse';
import { uesimApiOptsForSystem, loadInventory } from '@/lib/inventory';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const systemId = body?.systemId as string | undefined;

  const inv = loadInventory();
  const opts = uesimApiOptsForSystem(inv, systemId);
  if (!opts) {
    return NextResponse.json(
      { error: systemId ? `system "${systemId}" is not a testable UESIM` : 'no UESIM in inventory' },
      { status: 400 },
    );
  }

  // Accepts the same shapes the environment importer already trusts (the
  // box's own testcase.json download envelope, a bare testDefinition, or a
  // raw GET /v2/testcases/<id> response) — the page just sends back whatever
  // the user edited in the testcase.json tab, unmodified.
  let testDefinition: any;
  try {
    const normalized = normalizeToTestDefinition(body?.testcaseJson);
    testDefinition = normalized.testDefinition;
    // The box's own testcase.json export names the testcase in TWO places:
    // the prominent top-level Test_Name, and a duplicate copy nested at
    // settings.test_name / settings.testCaseName. normalizeToTestDefinition()
    // already prefers the top-level field when computing suggestedName (see
    // nameOf() in environment/parse.ts) — but recreateTestcase() only ever
    // reads the nested copy. Someone editing the file naturally edits the
    // prominent top-level name and has no reason to know a duplicate exists
    // further down; without this, that edit is silently discarded and the
    // recreated testcase keeps its old name.
    if (normalized.suggestedName) {
      testDefinition.settings = testDefinition.settings ?? {};
      testDefinition.settings.test_name = normalized.suggestedName;
      testDefinition.settings.testCaseName = normalized.suggestedName;
    }
  } catch (e: any) {
    const msg = e instanceof EnvironmentParseError ? e.message : (e?.message ?? String(e));
    return NextResponse.json({ error: `testcase.json is not valid: ${msg}` }, { status: 400 });
  }

  try {
    const r = await recreateTestcase(opts, id, testDefinition);
    if (r.failedStep) return NextResponse.json({ ok: false, ...r }, { status: 502 });
    return NextResponse.json({ ok: true, ...r });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 502 });
  }
}

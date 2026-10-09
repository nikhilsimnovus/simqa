// GET /api/automation/suites/[id]/files[?row=<row name>]
//
// What this suite has saved on the automation server, row by row:
//
//   /root/automation_configs/<Suite Name>/<Test Case Name>/
//       test.json  enb.cfg  mme.cfg  ims.cfg  ots.cfg  <the DB>  ue.cfg
//
// Those copies are what lets a row run on a box that does not hold its test
// case any more — the runner rebuilds it from test.json — so "is it saved, and
// is what is saved usable" is a question with a real answer and, until now, no
// way to ask it. A row that failed with the box's own "CellConfig: Section is
// required but missing" could equally have had no saved copy, a copy in the
// wrong shape, or a copy that was fine.
//
// Read-only: nothing here writes or touches a box. For test.json it also says
// what shape the file is in and what power-on duration it carries, because
// that is the part that decides whether the row can be rebuilt.

import { NextResponse } from 'next/server';
import { getSuite } from '@/lib/automation/store';
import { listTestCaseFiles, readTestCaseFile, testCaseDir, automationRoot } from '@/lib/automation/serverConfigs';
import { definitionFromPack } from '@/lib/automation/importPack';
import { powerOnOf } from '@/lib/automation/durationFit';

export const dynamic = 'force-dynamic';

/** Can this saved test.json actually rebuild the row, and what does it hold? */
function describeTestJson(text: string | undefined) {
  if (text === undefined) return { present: false as const };
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { return { present: true as const, usable: false, why: 'not valid JSON', bytes: text.length }; }
  const { definition, error } = definitionFromPack(parsed);
  if (!definition) return { present: true as const, usable: false, why: error, bytes: text.length };
  const sections = Object.keys(definition).filter((k) => /Config$|^settings$/.test(k));
  return {
    present: true as const,
    usable: true,
    bytes: text.length,
    sections,
    // The two that the box refuses a create without.
    hasCells: !!definition.cellConfig,
    hasPowerCycle: !!definition.powerCycleConfig,
    ...powerOnOf(definition),
  };
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const suite = getSuite(id);
  if (!suite) return NextResponse.json({ ok: false, error: `no suite "${id}"` }, { status: 404 });

  const only = new URL(req.url).searchParams.get('row');
  const rows = (suite.items ?? []).filter((r) => !only || r.name === only);

  return NextResponse.json({
    ok: true,
    suite: suite.name,
    root: automationRoot(),
    rows: rows.map((r) => ({
      row: r.name,
      dir: testCaseDir(r.configSuite ?? suite.name, r.name),
      // What the row points at on a box, so "no id AND no saved copy" is
      // visible as the dead end it is.
      simnovatorTcId: r.simnovatorTcId || null,
      uploadedTestcase: r.uploadedTestcase ?? null,
      durationSec: r.durationSec ?? null,
      files: listTestCaseFiles(r.configSuite ?? suite.name, r.name),
      testJson: describeTestJson(readTestCaseFile(r.configSuite ?? suite.name, r.name, 'test.json')),
    })),
  });
}

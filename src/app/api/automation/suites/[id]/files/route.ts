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

/** The text either side of the character the JSON parser gave up at, which it
 *  names in its own message. Returns undefined when the message carries no
 *  position — the wording differs between runtimes. */
function windowAround(text: string, message: string): { position: number; before: string; after: string } | undefined {
  const m = /position (\d+)/.exec(message);
  if (!m) return undefined;
  const position = Number(m[1]);
  if (!Number.isFinite(position)) return undefined;
  return {
    position,
    before: text.slice(Math.max(0, position - 260), position),
    after: text.slice(position, position + 260),
  };
}

/** Can this saved test.json actually rebuild the row, and what does it hold? */
function describeTestJson(text: string | undefined) {
  if (text === undefined) return { present: false as const };
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch (e: unknown) {
    return {
      present: true as const, usable: false,
      // The parser names the character it gave up at, which is the whole
      // story for a file that was written over by a shorter one.
      why: `not valid JSON: ${(e as Error)?.message ?? 'parse failed'}`, bytes: text.length,
      // Where it stops being JSON is usually the whole story — a write that
      // was cut off looks exactly like this.
      head: text.slice(0, 200), tail: text.slice(-200),
      // And the damage itself. A saved copy is the only thing standing
      // between a row and a deleted test case, so "it is corrupt" is not a
      // useful place to stop: this is what has to be looked at to decide
      // whether the definition can be salvaged or has to be captured again.
      at: windowAround(text, (e as Error)?.message ?? ''),
    };
  }
  const { definition, error } = definitionFromPack(parsed);
  if (!definition) {
    return {
      present: true as const, usable: false, why: error, bytes: text.length,
      // What it IS, since it is not what was expected. Keys only: enough to
      // recognise the shape without serving the file's contents back out.
      keys: parsed && typeof parsed === 'object' ? Object.keys(parsed as object).slice(0, 40) : [],
      head: text.slice(0, 200),
    };
  }
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

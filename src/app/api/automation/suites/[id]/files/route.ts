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
import { listTestCaseFiles, readTestCaseFile, writeTestCaseFiles, testCaseDir, automationRoot } from '@/lib/automation/serverConfigs';
// Only the quoted tag changes — see licenceTag.ts.
import { withLicenceTag } from '@/lib/automation/licenceTag';
import { cleanTag } from '@/lib/automation/licenceChoice';
import { definitionFromText } from '@/lib/automation/importPack';
import { powerOnOf } from '@/lib/automation/durationFit';

export const dynamic = 'force-dynamic';

/** The configs that carry a licence tag. Not exported: a route module may
 *  export only its handlers and Next's own config names. */
const LICENCE_FILES = ['enb.cfg', 'mme.cfg', 'ims.cfg'];

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

/**
 * What each subscriber says about its authentication, without saying the
 * secrets.
 *
 * "SubsConfig: /opc: does not match pattern '^$'" is an argument about which
 * of op/opc/top/topc is selected and which carry a value, and that argument
 * cannot be settled without seeing those two things. The VALUES are key
 * material — K, OPc — so a field is reported as set or not, never quoted.
 */
function subscriberSummary(definition: any) {
  const subs = definition?.subsConfig?.subs ?? definition?.subscriberConfig?.subs;
  if (!Array.isArray(subs)) return undefined;
  const KEYS = ['op', 'opc', 'top', 'topc', 'sharedKey'];
  return subs.slice(0, 12).map((s: any, i: number) => ({
    i,
    algorithm: s?.algorithm ?? null,
    algorithmKeyMode: s?.algorithmKeyMode ?? null,
    cellTypeP: s?.cellTypeP ?? null,
    ueCount: s?.ueCount ?? null,
    // Set, empty string, or absent — the three states the box distinguishes.
    keys: Object.fromEntries(KEYS.map((k) => [
      k,
      s?.[k] === undefined ? 'absent' : (typeof s[k] === 'string' && s[k].trim() !== '' ? 'set' : 'empty'),
    ])),
  }));
}

/** Can this saved test.json actually rebuild the row, and what does it hold? */
function describeTestJson(text: string | undefined) {
  if (text === undefined) return { present: false as const };
  const { definition, error, repaired } = definitionFromText(text);
  if (!definition) {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { /* the error already says so */ }
    return {
      present: true as const, usable: false, why: error, bytes: text.length,
      // What it IS, since it is not what was expected. Keys only: enough to
      // recognise the shape without serving the file's contents back out.
      keys: parsed && typeof parsed === 'object' ? Object.keys(parsed as object).slice(0, 40) : [],
      head: text.slice(0, 200), tail: text.slice(-200),
      // And, for a file that is not JSON at all, the damage itself: a saved
      // copy is the only thing standing between a row and a deleted test
      // case, so "it is corrupt" is not a useful place to stop.
      at: windowAround(text, error ?? ''),
    };
  }
  const sections = Object.keys(definition).filter((k) => /Config$|^settings$/.test(k));
  return {
    present: true as const,
    usable: true,
    bytes: text.length,
    // Usable, but say when it only parsed because comments or a stray comma
    // were forgiven — that is a hand edit, and worth knowing about.
    ...(repaired ? { repaired } : {}),
    sections,
    // The subscriber section, in the terms the box refuses it in. Which key
    // fields carry a value and which mode is selected is the whole of that
    // argument — and the values themselves are key material, so they are
    // counted, never served.
    subscribers: subscriberSummary(definition),
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

  const q = new URL(req.url).searchParams;
  const only = q.get('row');

  // One file's contents, for the run detail's Configs pane. A config is not a
  // secret — the whole point of the folder is that operators work in it — but
  // it is only served one at a time, by name, and only for a row of this
  // suite, so this cannot be turned into a reader for the filesystem.
  const wantFile = q.get('file');
  if (wantFile && only) {
    const row = (suite.items ?? []).find((r) => r.name === only);
    if (!row) return NextResponse.json({ ok: false, error: `no row "${only}" in this suite` }, { status: 404 });
    const text = readTestCaseFile(row.configSuite ?? suite.name, row.name, wantFile);
    if (text === undefined) {
      return NextResponse.json({ ok: false, error: `${wantFile} is not saved for this row` }, { status: 404 });
    }
    return NextResponse.json({ ok: true, row: row.name, file: wantFile, bytes: text.length, text });
  }
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

/**
 * POST /api/automation/suites/[id]/files
 * body: { row, file, tag }
 *
 * Set the licence tag in one of a row's saved configs, in place.
 *
 * Only the quoted tag changes — every other byte of the file is left exactly
 * as it is, so this cannot be used to rewrite a config, only to say which
 * licence it asks for. And only enb.cfg, mme.cfg and ims.cfg carry one.
 *
 * Here because the folder is the lasting copy: when a run has written the
 * wrong licence into it, or a setup's licences are renamed, the alternative is
 * editing files on the server by hand.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const suite = getSuite(id);
  if (!suite) return NextResponse.json({ ok: false, error: `no suite "${id}"` }, { status: 404 });

  let body: any = {};
  try { body = await req.json(); } catch { /* reported below */ }

  const rowName = typeof body.row === 'string' ? body.row : '';
  const file = typeof body.file === 'string' ? body.file : '';
  const tag = cleanTag(body.tag);
  if (!rowName || !file) return NextResponse.json({ ok: false, error: 'row and file are required' }, { status: 400 });
  if (!tag) return NextResponse.json({ ok: false, error: 'tag must be one word, like "rnd-enb"' }, { status: 400 });
  if (!LICENCE_FILES.includes(file)) {
    return NextResponse.json(
      { ok: false, error: `only ${LICENCE_FILES.join(', ')} carry a licence tag` }, { status: 400 });
  }

  const row = (suite.items ?? []).find((r) => r.name === rowName);
  if (!row) return NextResponse.json({ ok: false, error: `no row "${rowName}" in this suite` }, { status: 404 });

  const suiteFolder = row.configSuite ?? suite.name;
  const text = readTestCaseFile(suiteFolder, row.name, file);
  if (text === undefined) {
    return NextResponse.json({ ok: false, error: `${file} is not saved for this row` }, { status: 404 });
  }

  const next = withLicenceTag(text, tag);
  if (!next.changed) {
    return NextResponse.json({
      ok: true, row: row.name, file, tag,
      changed: false,
      note: next.from === undefined
        ? `${file} names no licence server, so there is nowhere to put a tag`
        : `${file} already asks for "${tag}"`,
    });
  }
  const w = writeTestCaseFiles(suiteFolder, row.name, { [file]: next.text });
  return NextResponse.json({
    ok: true, row: row.name, file, from: next.from, tag, changed: true, dir: w.dir, written: w.written,
  });
}

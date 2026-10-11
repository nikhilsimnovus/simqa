// GET /api/automation/suites/[id]/licences
//
// Which licence each of this suite's configs asks the licence server for, so
// the Run dialog can show it and offer another.
//
//   license_server: {server_addr: "192.168.0.11:9051", tag: "oran-enb"},
//
// Read from the copies on the automation server, because those are the ones
// the run pushes — reading the callbox would report whatever is linked there
// now, which is usually another row's.
//
// Read-only. Choosing a different tag is a per-run decision and travels with
// the run request; nothing is written here.

import { NextResponse } from 'next/server';
import { getSuite } from '@/lib/automation/store';
import { readTestCaseFile } from '@/lib/automation/serverConfigs';
import { licenceTagOf } from '@/lib/automation/licenceTag';

export const dynamic = 'force-dynamic';

/** The three configs that carry a licence tag, and the file each is kept as.
 *  Not exported: a route module may only export the handlers and Next's own
 *  config names, and anything else fails the build. */
const LICENCE_ROLES = [
  { role: 'enb', file: 'enb.cfg', label: 'enb.cfg' },
  { role: 'mme', file: 'mme.cfg', label: 'mme.cfg' },
  { role: 'ims', file: 'ims.cfg', label: 'ims.cfg' },
] as const;

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const suite = getSuite(id);
  if (!suite) return NextResponse.json({ ok: false, error: `no suite "${id}"` }, { status: 404 });

  const rows = suite.items ?? [];
  const roles = LICENCE_ROLES.map(({ role, file, label }) => {
    const perRow = rows.map((r) => {
      const text = readTestCaseFile(r.configSuite ?? suite.name, r.name, file);
      return { row: r.name, tag: text === undefined ? null : (licenceTagOf(text) ?? null) };
    });
    // One tag is the normal case — every row of a suite usually shares a
    // config. When they genuinely differ, say so rather than picking one:
    // setting a tag then applies to all of them, which is a bigger action
    // than it looks if the reader thinks there was only ever one.
    const tags = [...new Set(perRow.map((p) => p.tag).filter((t): t is string => !!t))];
    return { role, file, label, tags, rows: perRow.filter((p) => p.tag !== null) };
  }).filter((r) => r.rows.length > 0);

  return NextResponse.json({ ok: true, suite: suite.name, roles });
}

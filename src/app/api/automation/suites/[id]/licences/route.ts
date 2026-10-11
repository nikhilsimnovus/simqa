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
// Grouped by the CONFIG FILE the rows picked, not flattened to a list of
// tags. A suite's rows do not all run the same config: User_Plane's ten rows
// use Mohan_ims.cfg for four and demo-ims.cfg for six, and those ask for
// rnd-mme and mme-oran respectively. Reporting that as "rnd-mme, mme-oran"
// was true and useless — it could not be reconciled with any one file an
// operator opened.
//
// An EMPTY tag is reported as its own thing rather than dropped. Five of
// those ten rows have `tag: ""` in their mme.cfg, and filtering falsy values
// out of the list made them read as sharing the tag the other five had.
//
// Read-only. Choosing a different tag is a per-run decision and travels with
// the run request; nothing is written here.

import { NextResponse } from 'next/server';
import { getSuite } from '@/lib/automation/store';
import { readTestCaseFile } from '@/lib/automation/serverConfigs';
import { licenceTagOf } from '@/lib/automation/licenceTag';
import type { SuiteItem } from '@/lib/inventory';

export const dynamic = 'force-dynamic';

/** The three configs that carry a licence tag: the file the folder keeps each
 *  as, and where the row records which config it picked.
 *  Not exported — a route module may only export the handlers and Next's own
 *  config names, and anything else fails the production build. */
const LICENCE_ROLES = [
  { role: 'enb', file: 'enb.cfg', label: 'enb.cfg', pick: (r: SuiteItem) => r.callboxCfg },
  { role: 'mme', file: 'mme.cfg', label: 'mme.cfg', pick: (r: SuiteItem) => r.mmeCfg },
  { role: 'ims', file: 'ims.cfg', label: 'ims.cfg', pick: (r: SuiteItem) => r.imsCfg },
] as const;

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const suite = getSuite(id);
  if (!suite) return NextResponse.json({ ok: false, error: `no suite "${id}"` }, { status: 404 });

  const rows = suite.items ?? [];
  const roles = LICENCE_ROLES.map(({ role, file, label, pick }) => {
    /** One group per (config file, tag) — which is what an operator can check
     *  against, because a file is the thing they can open. */
    const groups = new Map<string, { config: string; tag: string | null; rows: string[] }>();
    for (const r of rows) {
      const config = pick(r);
      if (!config) continue;
      const text = readTestCaseFile(r.configSuite ?? suite.name, r.name, file);
      if (text === undefined) continue;             // nothing saved for this row yet
      // undefined = the config names no licence server at all.
      // '' = it names one, with an empty tag. Those are different facts.
      const found = licenceTagOf(text);
      const tag = found === undefined ? null : found;
      const key = `${config}\u0000${tag ?? '\u0001none'}`;
      const g = groups.get(key) ?? { config, tag, rows: [] };
      g.rows.push(r.name);
      groups.set(key, g);
    }
    return {
      role, file, label,
      groups: [...groups.values()].sort((a, b) => b.rows.length - a.rows.length),
    };
  }).filter((r) => r.groups.length > 0);

  return NextResponse.json({ ok: true, suite: suite.name, roles });
}

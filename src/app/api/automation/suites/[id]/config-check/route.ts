// POST /api/automation/suites/[id]/config-check
//
// Asked before a suite runs: are the lab configs still the ones this suite ran
// with last time? Files on the callbox and the UE are edited between runs, so a
// re-run can quietly measure something else. Each row's six files are read and
// compared with the newest saved version; rows that differ come back named, and
// the Run dialog says so instead of starting.
//
// A row that has never run has nothing to compare and is simply absent from the
// answer — a first run is not a warning.
//
// Read-only. Nothing is written here; the new version is kept by the run
// itself, once the operator goes ahead.

import { NextResponse } from 'next/server';
import { getSuite } from '@/lib/automation/store';
import { loadInventory, getSystem } from '@/lib/inventory';
import { checkRowConfigs } from '@/lib/suiteConfigStore';
import { ueSystemForSimnovator } from '@/lib/automation/runner';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const suite = getSuite(id);
  if (!suite) return NextResponse.json({ ok: false, error: `no suite "${id}"` }, { status: 404 });

  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }

  let rows = suite.items ?? [];
  if (Array.isArray(body.itemIds) && body.itemIds.length > 0) {
    const wanted = new Set(body.itemIds.map(String));
    rows = rows.filter(it => wanted.has(it.id));
  }

  const inv = loadInventory();
  const callbox = suite.kind === 'uesim+callbox' && suite.callboxSystemId
    ? getSystem(inv, suite.callboxSystemId)
    : undefined;
  // Resolved exactly as the run resolves it — a suite saved before the Setup
  // step offered the choice gets its UE from the topology, and a check that
  // looked only at ueSystemId would then report ue.cfg as having vanished.
  const ueSystem = ueSystemForSimnovator(inv, suite.uesimSystemId, suite.ueSystemId);

  // Sequentially: these are SSH reads against one or two boxes, and a burst of
  // parallel sessions is how a callbox starts refusing connections.
  const changed: Array<{
    row: string;
    version?: number;
    capturedAt?: string;
    /** Only the files that moved — what the warning leads with. */
    files: Array<{ file: string; state: string; was?: string; now?: string }>;
    /** All six, so the warning can also say what did NOT move: an operator
     *  deciding whether to go ahead wants both halves of that picture. */
    all: Array<{ file: string; state: string; was?: string; now?: string }>;
  }> = [];
  for (const row of rows) {
    try {
      const { diff, capturedAt, version } = await checkRowConfigs(suite.name, row.name, callbox, ueSystem);
      if (diff && !diff.same) {
        changed.push({ row: row.name, version, capturedAt, files: diff.changed, all: diff.files });
      }
    } catch { /* a box we cannot read is not evidence of a change */ }
  }

  return NextResponse.json({ ok: true, checked: rows.length, changed });
}

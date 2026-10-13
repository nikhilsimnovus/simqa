// GET /api/automation/runs/[runId] — fetch one run record in full
//   (includes the per-step verdict array + diagnostics pointer).
//
// Also resolves WHERE the run executed, as a systemId and a box login, so the
// detail page can ask the Simnovator for its own account of each execution —
// its status, its verdict and the checks behind them. A run record stores the
// host and the login NAME, which name a box to a person but are not enough to
// call it: the credentials live in the inventory, against a system id.
//
// Resolved from the suite the run belongs to, falling back to matching the
// recorded host when that suite has since been deleted or re-pointed at
// another box. Absent when neither works, and the page then shows what the run
// itself recorded — which is the same two words, just without the box's own
// copy beside them.

import { NextResponse } from 'next/server';
import { getRun } from '@/lib/automation/runStore';
import { getSuite } from '@/lib/automation/store';
import { loadInventory } from '@/lib/inventory';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ runId: string }> }) {
  const { runId } = await ctx.params;
  const r = getRun(runId);
  if (!r) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });

  const inv = loadInventory();
  const suite = getSuite(r.suiteId);
  let systemId = suite?.uesimSystemId;
  const boxUserId = suite?.boxUserId;

  // The suite is gone, or now points somewhere else than this run executed.
  // The host on the record is the fact; find whichever system carries it.
  if (r.uesimHost) {
    const byHost = inv.systems.find((s) => s.host === r.uesimHost);
    const current = systemId ? inv.systems.find((s) => s.id === systemId) : undefined;
    if (!current || current.host !== r.uesimHost) systemId = byHost?.id ?? systemId;
  }

  return NextResponse.json({
    ok: true,
    run: r,
    // Only the ids — never credentials. The testcase route resolves those
    // itself from the inventory, the same way every other caller does.
    box: systemId ? { systemId, boxUserId: boxUserId ?? null } : null,
  });
}

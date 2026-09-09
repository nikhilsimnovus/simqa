// POST /api/scenarios/[id]/run — fire this scenario's testcase.
//
// Thin wrapper over the end-to-end runner: a scenario is a saved
// (testcase, system) pair, so running one is exactly startRun() with those
// two values resolved. Everything the runner already does — the busy-box
// guard, preflight, live check status, the report — comes along unchanged.

import { NextResponse } from 'next/server';
import { getScenario, resolveSystemId, recordRun } from '@/lib/scenarios';
import { startRun } from '@/lib/endToEnd/runner';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const scenario = getScenario(id);
  if (!scenario) return NextResponse.json({ ok: false, error: 'scenario not found' }, { status: 404 });

  // An explicit systemId in the body wins; otherwise fall back to the pinned
  // system, then the box it last ran on.
  let explicit: string | undefined;
  try {
    const body = await req.json();
    explicit = body?.systemId ? String(body.systemId) : undefined;
  } catch { /* empty body is fine — means "use the remembered system" */ }

  const systemId = resolveSystemId(scenario, explicit);
  if (!systemId) {
    return NextResponse.json(
      { ok: false, error: 'no system to run on — choose one (this scenario has never run and pins no system)' },
      { status: 400 },
    );
  }

  // Hand the saved cfg set to the runner, which symlinks each slot on the
  // bound callbox and restarts lte once BEFORE preflight — so the radio is
  // wearing the right configs by the time UEs attach. Omitted when the
  // scenario saved none, leaving the box exactly as it is.
  const r = await startRun({
    systemId,
    testcaseId: scenario.testcaseId,
    cfgSelection: scenario.cfgSelection,
  });
  if (!r.ok) return NextResponse.json({ ...r, systemId }, { status: 400 });

  // Only remember the box AFTER the run actually started: recording a system
  // that failed to launch would make the next one-click run repeat a bad
  // default.
  recordRun(id, systemId, r.runId!);
  return NextResponse.json({ ok: true, runId: r.runId, systemId, scenario: getScenario(id) });
}

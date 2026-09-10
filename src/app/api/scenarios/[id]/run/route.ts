// POST /api/scenarios/[id]/run — fire this scenario's testcase.
//
// Thin wrapper over the end-to-end runner: a scenario is a saved
// (topology, testcase) pair, so running one is startRun() with the Simnovator
// resolved from that topology. Everything the runner already does — the
// busy-box guard, cfg bring-up, preflight, live check status, the report —
// comes along unchanged.

import { NextResponse } from 'next/server';
import { getScenario, resolveTopologyId, resolveSystemId, recordRun } from '@/lib/scenarios';
import { loadInventory, getProfile } from '@/lib/inventory';
import { startRun } from '@/lib/endToEnd/runner';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const scenario = getScenario(id);
  if (!scenario) return NextResponse.json({ ok: false, error: 'scenario not found' }, { status: 404 });

  // An explicit choice in the body wins; otherwise fall back to the pinned
  // topology, then the one it last ran on.
  let explicitTopology: string | undefined;
  let explicitSystem: string | undefined;
  try {
    const body = await req.json();
    explicitTopology = body?.topologyId ? String(body.topologyId) : undefined;
    explicitSystem = body?.systemId ? String(body.systemId) : undefined;
  } catch { /* empty body is fine — means "use the remembered target" */ }

  const inv = loadInventory();

  // Topology is the primary selection: it names the Simnovator that owns the
  // testcase AND the callbox whose configs the run links, so one choice
  // settles both.
  const topologyId = resolveTopologyId(scenario, explicitTopology);
  let systemId: string | undefined;
  if (topologyId) {
    const profile = getProfile(inv, topologyId);
    if (!profile) {
      return NextResponse.json(
        { ok: false, error: `topology "${topologyId}" no longer exists in Systems Management` },
        { status: 400 },
      );
    }
    systemId = profile.simnovator ?? profile.uesim;
    if (!systemId) {
      return NextResponse.json(
        { ok: false, error: `topology "${profile.name}" binds no Simnovator or UESIM — nothing can run the testcase` },
        { status: 400 },
      );
    }
  } else {
    // Legacy scenarios saved before topology selection.
    systemId = resolveSystemId(scenario, explicitSystem);
  }

  if (!systemId) {
    return NextResponse.json(
      { ok: false, error: 'no topology to run against — choose one (this scenario has never run and pins nothing)' },
      { status: 400 },
    );
  }

  // Hand the saved cfg set to the runner, which symlinks each slot on the
  // topology's callbox and restarts lte once BEFORE preflight — so the radio
  // is wearing the right configs by the time UEs attach. Omitted when the
  // scenario saved none, leaving the box exactly as it is.
  const r = await startRun({
    systemId,
    testcaseId: scenario.testcaseId,
    cfgSelection: scenario.cfgSelection,
  });
  if (!r.ok) return NextResponse.json({ ...r, systemId, topologyId }, { status: 400 });

  // Only remember the target AFTER the run actually started: recording one
  // whose run failed to launch would make the next one-click run repeat a bad
  // default.
  recordRun(id, systemId, r.runId!, topologyId);
  return NextResponse.json({ ok: true, runId: r.runId, systemId, topologyId, scenario: getScenario(id) });
}

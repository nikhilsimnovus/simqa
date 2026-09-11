// POST /api/scenarios/[id]/run — fire this scenario's testcase.
//
// Thin wrapper over the end-to-end runner: a scenario is a saved
// (target, testcase) pair, so running one is startRun() with the system
// resolved from that target. Everything the runner already does — the
// busy-box guard, cfg bring-up, preflight, live check status, the report —
// comes along unchanged.
//
// Body (optional): { topologyId } or { systemId } to run somewhere other than
// the remembered target.

import { NextResponse } from 'next/server';
import { getScenario, resolveTarget, recordRun, normalizeCfgSelection, type ScenarioCfg } from '@/lib/scenarios';
import { loadInventory, getProfile, getSystem } from '@/lib/inventory';
import { startRun } from '@/lib/endToEnd/runner';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const scenario = getScenario(id);
  if (!scenario) return NextResponse.json({ ok: false, error: 'scenario not found' }, { status: 404 });

  let explicit: { topologyId?: string; systemId?: string } = {};
  try {
    const body = await req.json();
    explicit = {
      topologyId: body?.topologyId ? String(body.topologyId) : undefined,
      systemId: body?.systemId ? String(body.systemId) : undefined,
    };
  } catch { /* empty body is fine — means "use the remembered target" */ }

  const target = resolveTarget(scenario, explicit);
  if (!target) {
    return NextResponse.json(
      { ok: false, error: 'nothing to run against — choose a topology or a system (this scenario has never run and pins neither)' },
      { status: 400 },
    );
  }

  const inv = loadInventory();
  let systemId: string | undefined;
  let topologyId: string | undefined;
  let cfgSelection: ScenarioCfg | undefined;

  if (target.kind === 'topology') {
    const profile = getProfile(inv, target.topologyId);
    if (!profile) {
      return NextResponse.json(
        { ok: false, error: `topology "${target.topologyId}" no longer exists in Systems Management` },
        { status: 400 },
      );
    }
    // Run on the box the testcase was picked from when this topology binds it;
    // otherwise the topology's Simnovator. A testcase id only exists on the
    // box that serves it — sending it anywhere else 404s at trigger.
    const bound = [profile.simnovator, profile.uesim].filter(Boolean) as string[];
    systemId = scenario.testcaseSystemId && bound.includes(scenario.testcaseSystemId)
      ? scenario.testcaseSystemId
      : (profile.simnovator ?? profile.uesim);
    if (!systemId) {
      return NextResponse.json(
        { ok: false, error: `topology "${profile.name}" binds no Simnovator or UESIM — nothing can run the testcase` },
        { status: 400 },
      );
    }
    topologyId = profile.id;
    // Symlinked on this topology's callbox, then one lte restart, BEFORE
    // preflight — so the radio wears the right configs when UEs attach.
    // Normalizing folds a legacy gnb slot into enb, the one link OTS loads.
    cfgSelection = normalizeCfgSelection(scenario.cfgSelection) ?? undefined;
  } else {
    if (!getSystem(inv, target.systemId)) {
      return NextResponse.json(
        { ok: false, error: `system "${target.systemId}" no longer exists in Systems Management` },
        { status: 400 },
      );
    }
    systemId = target.systemId;
    // A single system binds no callbox: REST-only, against the box as it is.
    // A cfg set saved for a topology is deliberately not applied here.
  }

  const r = await startRun({ systemId, topologyId, testcaseId: scenario.testcaseId, cfgSelection });
  if (!r.ok) return NextResponse.json({ ...r, systemId, topologyId }, { status: 400 });

  // Only remember the target AFTER the run actually started: recording one
  // whose run failed to launch would make the next one-click run repeat a bad
  // default.
  recordRun(id, target, systemId, r.runId!);
  return NextResponse.json({ ok: true, runId: r.runId, systemId, topologyId, scenario: getScenario(id) });
}

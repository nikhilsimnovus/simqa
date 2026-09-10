// GET /api/config-fidelity/live/systems
//
// The Simnovators the live capture watches, with how many captures each holds.
// This is the left-hand list on the Live Captures tab, and it is also what
// starts the watcher after a server restart — same lazy-start reason as the
// backup scheduler: middleware forces an Edge bundle, so a startup hook in
// instrumentation.ts cannot resolve node builtins.

import { NextResponse } from 'next/server';
import { loadInventory, getSystem } from '@/lib/inventory';
import { listCaptures, listCapturedIps } from '@/lib/liveFidelity/store';
import { ensureFidelityWatcher, watcherStatus } from '@/lib/liveFidelity/watcher';

export const dynamic = 'force-dynamic';

export async function GET() {
  ensureFidelityWatcher();

  const inv = loadInventory();

  // SIMNOVATOR / SIMNOVATOR_GUI only. A UESIM-typed box is the far END of this
  // feature — where the ue.cfg is read from — not somewhere testcases start, so
  // listing it here would offer boxes that can never produce a capture.
  // Its UE-sim comes from the topology profile, which is what the requirement
  // means by "get this from Topology 'UE' in System Management".
  const simnovators = inv.systems
    .filter((s) => s.type === 'SIMNOVATOR' || s.type === 'SIMNOVATOR_GUI')
    .filter((s, i, all) => all.findIndex((o) => o.host === s.host) === i);

  interface Row {
    id: string; name: string; host: string; type: string;
    topology?: string;
    ueSim?: { id: string; name: string; host: string };
    watchable: boolean; reason?: string;
    captures: number; passed: number; failed: number; lastCaptureAt?: string;
  }

  const rows: Row[] = simnovators.map((s): Row => {
    const profile = inv.profiles.find((p) => p.simnovator === s.id);
    const ue = profile?.uesim ? getSystem(inv, profile.uesim) : undefined;
    const captures = listCaptures(s.host);
    return {
      id: s.id,
      name: s.name,
      host: s.host,
      type: s.type,
      topology: profile?.name,
      ueSim: ue ? { id: ue.id, name: ue.name, host: ue.host } : undefined,
      // Said plainly: without a paired UE-sim there is no ue.cfg to fetch, so
      // this Simnovator can never produce a capture.
      watchable: !!ue,
      reason: ue ? undefined
        : profile ? `topology "${profile.name}" has no UE system, so there is no /root/ue/config to read`
        : 'no topology profile references this Simnovator, so its UE-sim is unknown',
      captures: captures.length,
      passed: captures.filter((c) => c.verdict === 'passed').length,
      failed: captures.filter((c) => c.verdict === 'failed').length,
      lastCaptureAt: captures[0]?.capturedAt,
    };
  });

  // Captures held for a host no longer in inventory are still listed — removing
  // a system must not hide the evidence it produced.
  const known = new Set(rows.map((r) => r.host));
  for (const ip of listCapturedIps()) {
    if (known.has(ip)) continue;
    const captures = listCaptures(ip);
    rows.push({
      id: ip, name: captures[0]?.simnovatorName ?? ip, host: ip, type: 'RETIRED',
      topology: undefined, ueSim: undefined, watchable: false,
      reason: 'no longer in Systems Management — history kept, no new captures',
      captures: captures.length,
      passed: captures.filter((c) => c.verdict === 'passed').length,
      failed: captures.filter((c) => c.verdict === 'failed').length,
      lastCaptureAt: captures[0]?.capturedAt,
    });
  }

  return NextResponse.json({ ok: true, watcher: watcherStatus(), systems: rows });
}

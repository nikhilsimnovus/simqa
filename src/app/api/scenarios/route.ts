// GET  /api/scenarios       — list saved scenarios
// POST /api/scenarios       — create one
import { NextResponse } from 'next/server';
import { listScenarios, createScenario, normalizeCfgSelection } from '@/lib/scenarios';
import { userFromRequest } from '@/lib/identity';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ ok: true, scenarios: listScenarios() });
}

export async function POST(req: Request) {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'body is not valid JSON' }, { status: 400 }); }
  const name = String(body?.name ?? '').trim();
  const testcaseId = String(body?.testcaseId ?? '').trim();
  if (!name) return NextResponse.json({ ok: false, error: 'name required' }, { status: 400 });
  if (!testcaseId) return NextResponse.json({ ok: false, error: 'testcaseId required' }, { status: 400 });
  const topologyId = body?.topologyId ? String(body.topologyId) : undefined;
  const s = createScenario({
    name, testcaseId,
    testcaseName: body?.testcaseName ? String(body.testcaseName) : undefined,
    testcaseSystemId: body?.testcaseSystemId ? String(body.testcaseSystemId) : undefined,
    topologyId,
    // Topology XOR system — a topology already names its Simnovator.
    systemId: !topologyId && body?.systemId ? String(body.systemId) : undefined,
    // Only a topology binds a callbox for these to be linked on.
    cfgSelection: topologyId ? (normalizeCfgSelection(body?.cfgSelection) ?? undefined) : undefined,
    notes: body?.notes ? String(body.notes) : undefined,
  }, userFromRequest(req));
  return NextResponse.json({ ok: true, scenario: s });
}

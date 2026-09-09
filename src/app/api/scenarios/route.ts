// GET  /api/scenarios       — list saved scenarios
// POST /api/scenarios       — create one
import { NextResponse } from 'next/server';
import { listScenarios, createScenario } from '@/lib/scenarios';
import { userFromRequest } from '@/lib/identity';

export const dynamic = 'force-dynamic';

/** Keep only the five known slots, as non-empty strings. Anything else a
 *  client sends is dropped rather than stored and later fed to a symlink. */
function pickCfg(raw: any): { enb?: string; gnb?: string; mme?: string; mme2?: string; ims?: string } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Record<string, string> = {};
  for (const k of ['enb', 'gnb', 'mme', 'mme2', 'ims']) {
    const v = raw[k];
    if (typeof v === 'string' && v.trim()) out[k] = v.trim();
  }
  return Object.keys(out).length ? out : undefined;
}

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
  const s = createScenario({
    name, testcaseId,
    testcaseName: body?.testcaseName ? String(body.testcaseName) : undefined,
    systemId: body?.systemId ? String(body.systemId) : undefined,
    cfgSelection: pickCfg(body?.cfgSelection),
    notes: body?.notes ? String(body.notes) : undefined,
  }, userFromRequest(req));
  return NextResponse.json({ ok: true, scenario: s });
}

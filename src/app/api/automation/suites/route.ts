// GET  /api/automation/suites         — list all saved suites
// POST /api/automation/suites         — create a new suite (body = AutomationSuite minus id)

import { NextResponse } from 'next/server';
import { listSuites, createSuite } from '@/lib/automation/store';
import { userFromRequest } from '@/lib/identity';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ ok: true, suites: listSuites() });
}

export async function POST(req: Request) {
  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }
  if (!body?.name || typeof body.name !== 'string') {
    return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
  }
  const kind: 'uesim-only' | 'uesim+callbox' = body.kind === 'uesim+callbox' ? 'uesim+callbox' : 'uesim-only';
  if (!body.uesimSystemId) {
    return NextResponse.json({ ok: false, error: 'uesimSystemId is required' }, { status: 400 });
  }
  if (kind === 'uesim+callbox' && !body.callboxSystemId) {
    return NextResponse.json({ ok: false, error: 'callboxSystemId is required when kind=uesim+callbox' }, { status: 400 });
  }
  try {
    const by = userFromRequest(req);
    const suite = createSuite({
      name: body.name,
      // Who made this playlist. Recorded once at creation and never
      // overwritten by later edits — updatedBy carries those.
      createdBy: by,
      updatedBy: by,
      kind,
      uesimSystemId: body.uesimSystemId,
      callboxSystemId: body.callboxSystemId,
      uploadedConfigs: body.uploadedConfigs && typeof body.uploadedConfigs === 'object' ? body.uploadedConfigs : undefined,
      callboxConfig: typeof body.callboxConfig === 'string' && body.callboxConfig.trim() ? body.callboxConfig.trim() : undefined,
      defaultDurationSec: typeof body.defaultDurationSec === 'number' && body.defaultDurationSec > 0 ? body.defaultDurationSec : undefined,
      testcaseDurations: body.testcaseDurations && typeof body.testcaseDurations === 'object' ? body.testcaseDurations : undefined,
      removeConfigAfterRun: typeof body.removeConfigAfterRun === 'boolean' ? body.removeConfigAfterRun : undefined,
      items: Array.isArray(body.items) ? body.items.filter((it: any) => it && typeof it === 'object' && it.simnovatorTcId).map((it: any) => ({
        id: typeof it.id === 'string' && it.id ? it.id : `item-${Math.random().toString(36).slice(2, 10)}`,
        name: typeof it.name === 'string' && it.name.trim() ? it.name.trim() : it.simnovatorTcId,
        simnovatorTcId: String(it.simnovatorTcId),
        suiteName: typeof it.suiteName === 'string' && it.suiteName.trim() ? it.suiteName.trim() : undefined,
        callboxCfg: typeof it.callboxCfg === 'string' && it.callboxCfg.trim() ? it.callboxCfg.trim() : undefined,
        mmeCfg: typeof it.mmeCfg === 'string' && it.mmeCfg.trim() ? it.mmeCfg.trim() : undefined,
        imsCfg: typeof it.imsCfg === 'string' && it.imsCfg.trim() ? it.imsCfg.trim() : undefined,
        durationSec: typeof it.durationSec === 'number' && it.durationSec > 0 ? it.durationSec : undefined,
      })) : undefined,
      testcaseIds: Array.isArray(body.testcaseIds) ? body.testcaseIds : [],
      stopOnFail: !!body.stopOnFail,
      notes: body.notes,
    });
    return NextResponse.json({ ok: true, suite });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
  }
}

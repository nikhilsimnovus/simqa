// GET  /api/automation/suites         — list all saved suites
// POST /api/automation/suites         — create a new suite (body = AutomationSuite minus id)

import { NextResponse } from 'next/server';
import { listSuites, createSuite } from '@/lib/automation/store';

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
    const suite = createSuite({
      name: body.name,
      kind,
      uesimSystemId: body.uesimSystemId,
      callboxSystemId: body.callboxSystemId,
      uploadedConfigs: body.uploadedConfigs && typeof body.uploadedConfigs === 'object' ? body.uploadedConfigs : undefined,
      callboxConfigs: Array.isArray(body.callboxConfigs) ? body.callboxConfigs : undefined,
      testcaseIds: Array.isArray(body.testcaseIds) ? body.testcaseIds : [],
      stopOnFail: !!body.stopOnFail,
      notes: body.notes,
    });
    return NextResponse.json({ ok: true, suite });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
  }
}

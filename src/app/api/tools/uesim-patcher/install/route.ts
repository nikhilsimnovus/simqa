// POST /api/tools/uesim-patcher/install
// Body: { systemId: string }
// Uploads scripts/lab-tools/patch_ue_cfg.sh to the UESIM box, installs
// inotify-tools if missing, and starts the watcher in the background.

import { NextResponse } from 'next/server';
import { loadInventory, getSystem } from '@/lib/inventory';
import { install } from '@/lib/labTools';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  let body: { systemId?: string } = {};
  try { body = await req.json(); } catch { /* keep empty */ }
  if (!body.systemId) return NextResponse.json({ ok: false, detail: 'systemId required' }, { status: 400 });
  const inv = loadInventory();
  const sys = getSystem(inv, body.systemId);
  if (!sys) return NextResponse.json({ ok: false, detail: `system "${body.systemId}" not in inventory` }, { status: 404 });
  const r = await install(sys);
  return NextResponse.json(r, { status: r.ok ? 200 : 500 });
}

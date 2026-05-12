// POST /api/tools/uesim-patcher/uninstall
// Body: { systemId: string; removeBackups?: boolean }
// Stops the watcher and removes the script + log from the UESIM. If
// removeBackups is true, also removes the .orig.<ts> backup files under
// /root/ue/config/.

import { NextResponse } from 'next/server';
import { loadInventory, getSystem } from '@/lib/inventory';
import { uninstall } from '@/lib/labTools';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  let body: { systemId?: string; removeBackups?: boolean } = {};
  try { body = await req.json(); } catch { /* keep empty */ }
  if (!body.systemId) return NextResponse.json({ ok: false, detail: 'systemId required' }, { status: 400 });
  const inv = loadInventory();
  const sys = getSystem(inv, body.systemId);
  if (!sys) return NextResponse.json({ ok: false, detail: `system "${body.systemId}" not in inventory` }, { status: 404 });
  const r = await uninstall(sys, { removeBackups: !!body.removeBackups });
  return NextResponse.json(r, { status: r.ok ? 200 : 500 });
}

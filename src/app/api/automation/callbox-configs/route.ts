// GET /api/automation/callbox-configs?systemId=sys-2
//
// Lists files under /root/enb/config on the chosen callbox via SSH.
// Used by the Automation Suite wizard so the user can pick which eNB
// config to bind into a uesim+callbox suite (instead of uploading).

import { NextResponse } from 'next/server';
import { loadInventory, getSystem } from '@/lib/inventory';
import { readCommand } from '@/lib/configFidelity/ssh';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const systemId = url.searchParams.get('systemId');
  if (!systemId) return NextResponse.json({ ok: false, error: 'systemId required' }, { status: 400 });
  const inv = loadInventory();
  const sys = getSystem(inv, systemId);
  if (!sys) return NextResponse.json({ ok: false, error: `no inventory system "${systemId}"` }, { status: 404 });
  if (sys.type !== 'CALLBOX') {
    return NextResponse.json({ ok: false, error: `system "${systemId}" is not a CALLBOX (type=${sys.type})` }, { status: 400 });
  }

  try {
    // ls -la with name + size + mtime; skip "." / ".." entries.
    const raw = await readCommand(sys, 'ls -la /root/enb/config 2>/dev/null | awk \'NR>1 && $NF != "." && $NF != ".." { printf "%s\\t%s\\t%s %s %s\\n", $NF, $5, $6, $7, $8 }\'');
    const files = raw.split('\n').filter(Boolean).map(line => {
      const [name, size, mtime] = line.split('\t');
      return { name, size: Number(size) || 0, mtime: (mtime ?? '').trim() };
    }).filter(f => f.name);
    return NextResponse.json({ ok: true, host: sys.host, dir: '/root/enb/config', files });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
  }
}

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
    // Use `find -printf` to get the mtime as an epoch float so we can sort
    // deterministically. Format: <epoch>\t<size>\t<name>. Hidden files
    // (leading dot) are skipped per the lab convention — .md5 etc. aren't
    // testcase configs.
    const cmd = `find /root/enb/config -maxdepth 1 -type f ! -name '.*' -printf '%T@\\t%s\\t%f\\n' 2>/dev/null`;
    const raw = await readCommand(sys, cmd);
    const files = raw.split('\n').filter(Boolean).map(line => {
      const [epoch, size, ...nameParts] = line.split('\t');
      const name = nameParts.join('\t');
      const epochNum = Number(epoch) || 0;
      return {
        name,
        size: Number(size) || 0,
        mtimeEpoch: epochNum,
        // Pretty mtime for the UI — ISO is sortable + unambiguous.
        mtime: epochNum ? new Date(epochNum * 1000).toISOString().slice(0, 19).replace('T', ' ') : '',
      };
    }).filter(f => f.name);
    // Sort newest first.
    files.sort((a, b) => b.mtimeEpoch - a.mtimeEpoch);
    return NextResponse.json({ ok: true, host: sys.host, dir: '/root/enb/config', files });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
  }
}

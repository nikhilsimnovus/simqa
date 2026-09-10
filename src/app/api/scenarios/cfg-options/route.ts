// GET /api/scenarios/cfg-options?topologyId=<profile id>  (or ?systemId= for
// legacy callers)
//
// The cfg files available on the callbox bound to a given Simnovator, split
// by slot, plus what is currently linked and which subscriber DB each MME
// config pulls in. One call so the scenario editor can populate every
// dropdown without the page orchestrating four round trips.
import { NextResponse } from 'next/server';
import { loadInventory, callboxForSimnovator, callboxForProfile, getProfile } from '@/lib/inventory';
import { currentCfgLinks, ueDbForAll } from '@/lib/labCfgLink';
import { readCommand } from '@/lib/configFidelity/ssh';

export const dynamic = 'force-dynamic';

async function listDir(box: any, dir: string): Promise<string[]> {
  try {
    // sudo first: /root is 0700 on some callboxes.
    const out = await readCommand(box, `sudo -n ls -1 ${dir} 2>/dev/null || ls -1 ${dir} 2>/dev/null || true`);
    return out.split('\n').map((l) => l.trim()).filter((l) => l.endsWith('.cfg')).sort();
  } catch {
    return [];
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const topologyId = url.searchParams.get('topologyId') ?? '';
  const systemId = url.searchParams.get('systemId') ?? '';
  if (!topologyId && !systemId) {
    return NextResponse.json({ ok: false, error: 'topologyId (or legacy systemId) required' }, { status: 400 });
  }
  const inv = loadInventory();
  // Topology first — it names the callbox directly, so no guessing which box
  // a bare system is wired to.
  const box = topologyId
    ? callboxForProfile(inv, getProfile(inv, topologyId))
    : callboxForSimnovator(inv, systemId);
  if (!box) {
    // Not an error: a REST-only setup has no callbox, and the editor should
    // simply show no cfg pickers rather than a failure.
    return NextResponse.json({ ok: true, callbox: null, enb: [], mme: [], current: {}, ueDb: {} });
  }

  const [enbFiles, mmeFiles, current] = await Promise.all([
    listDir(box, '/root/enb/config'),
    listDir(box, '/root/mme/config'),
    currentCfgLinks(box).catch(() => ({})),
  ]);

  // Which DB each MME config includes — derived, read-only context, in ONE
  // ssh round trip. Doing this per-file took 88s on the real callbox and left
  // the editor stuck on "reading the callbox…".
  const ueDb = await ueDbForAll(box).catch(() => ({}));

  return NextResponse.json({
    ok: true,
    callbox: { id: box.id, name: box.name, host: box.host },
    enb: enbFiles, mme: mmeFiles, current, ueDb,
  });
}

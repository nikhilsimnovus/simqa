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

/**
 * List a callbox config directory, reporting a failure instead of hiding it.
 *
 * This used to `catch` and return [], so a read that failed — typically a cold
 * SSH handshake on the first request after the server starts — came back as an
 * EMPTY list. The editor then rendered empty dropdowns, indistinguishable from
 * a callbox that genuinely has no configs, and nothing reached the server log:
 * a real request showed 0 eNB / 0 MME against a box holding 171 and 46.
 */
async function listDir(box: any, dir: string): Promise<{ files: string[]; error?: string }> {
  try {
    // sudo first: /root is 0700 on some callboxes.
    const out = await readCommand(box, `sudo -n ls -1 ${dir} 2>/dev/null || ls -1 ${dir} 2>/dev/null || true`);
    return { files: out.split('\n').map((l) => l.trim()).filter((l) => l.endsWith('.cfg')).sort() };
  } catch (e: any) {
    const error = e?.message ?? String(e);
    console.error(`[scenarios/cfg-options] could not list ${dir} on ${box?.host}: ${error}`);
    return { files: [], error };
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
    return NextResponse.json({ ok: true, callbox: null, enb: [], mme: [], current: {}, ueDb: {}, readErrors: [] });
  }

  const [enbRes, mmeRes, current] = await Promise.all([
    listDir(box, '/root/enb/config'),
    listDir(box, '/root/mme/config'),
    currentCfgLinks(box).catch(() => ({})),
  ]);

  // Which DB each MME config includes — derived, read-only context, in ONE
  // ssh round trip. Doing this per-file took 88s on the real callbox and left
  // the editor stuck on "reading the callbox…".
  const ueDb = await ueDbForAll(box).catch(() => ({}));

  // gnb.cfg is not a slot the editor offers — OTS loads only enb.cfg, for LTE
  // and NR alike — so it is not reported as "current" either. On .107 a stale
  // gnb.cfg link would otherwise pre-fill a selection nothing reads.
  const currentSlots: Record<string, unknown> = { ...current };
  delete currentSlots.gnb;

  return NextResponse.json({
    ok: true,
    callbox: { id: box.id, name: box.name, host: box.host },
    enb: enbRes.files, mme: mmeRes.files, current: currentSlots, ueDb,
    // Non-empty means a list above may be empty because the READ failed, not
    // because the directory is — the editor says so instead of showing blank
    // dropdowns.
    readErrors: [
      ...(enbRes.error ? [`/root/enb/config: ${enbRes.error}`] : []),
      ...(mmeRes.error ? [`/root/mme/config: ${mmeRes.error}`] : []),
    ],
  });
}

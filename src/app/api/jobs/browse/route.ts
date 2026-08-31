// GET /api/jobs/browse?setupHost=192.168.1.102&kind=ue|enb|mme|app|build
//
// Lists real files for the Build step's Browse buttons, so picking a component
// file means choosing something that exists rather than typing a name from
// memory and finding out at install time.
//
// Which machine holds which files comes from the topology profile, not from
// the caller: enb/mme configs live on the callbox, ue configs on the UE server,
// app configs on the app server, and builds in the station's own build
// directory. The directory for each kind is looked up in a fixed map for the
// same reason the automation route does it — this runs `find` over SSH as
// root, and a caller-supplied path would be an arbitrary directory read.

import { NextResponse } from 'next/server';
import { loadInventory, getSystem, type InventorySystem } from '@/lib/inventory';
import { getSetup } from '@/lib/jobTracker/setups';
import { readCommand } from '@/lib/configFidelity/ssh';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/** kind → which machine in the topology, and which directory on it. */
const KINDS: Record<string, { role: 'callbox' | 'ue' | 'app' | 'simnovator'; dir: string; label: string }> = {
  enb:   { role: 'callbox',    dir: '/root/enb/config', label: 'eNB / gNB configs' },
  mme:   { role: 'callbox',    dir: '/root/mme/config', label: 'MME / IMS configs' },
  ue:    { role: 'ue',         dir: '/root/ue/config',  label: 'UE configs' },
  app:   { role: 'app',        dir: '/root/app/config', label: 'App server configs' },
  build: { role: 'simnovator', dir: '/root/builds',     label: 'Builds on the station' },
};

export async function GET(req: Request) {
  const url = new URL(req.url);
  const setupHost = (url.searchParams.get('setupHost') ?? '').trim();
  const kind = (url.searchParams.get('kind') ?? '').trim();
  const spec = KINDS[kind];
  if (!setupHost) return NextResponse.json({ ok: false, error: 'setupHost required' }, { status: 400 });
  if (!spec) {
    return NextResponse.json({ ok: false, error: `unknown kind "${kind}" (expected ${Object.keys(KINDS).join(' | ')})` }, { status: 400 });
  }

  const inv = loadInventory();
  const setup = getSetup(setupHost, inv);
  if (!setup) return NextResponse.json({ ok: false, error: `no Simnovator "${setupHost}" in inventory` }, { status: 404 });

  // Resolve the machine that actually holds these files.
  let sys: InventorySystem | undefined;
  if (spec.role === 'simnovator') sys = getSystem(inv, setup.systemId);
  else if (spec.role === 'ue')    sys = setup.ue ? getSystem(inv, setup.ue.systemId) : undefined;
  else if (spec.role === 'app')   sys = setup.app ? getSystem(inv, setup.app.systemId) : undefined;
  else {
    // The callbox is not part of the install topology, so it is looked up from
    // the same profile the rest of the app uses.
    const profile = inv.profiles.find((p) => p.simnovator === setup.systemId);
    sys = profile?.callbox ? getSystem(inv, profile.callbox) : undefined;
  }

  if (!sys) {
    return NextResponse.json({
      ok: false,
      error: `No ${spec.role} bound to ${setupHost} in its topology profile — nothing to browse for ${spec.label}.`,
    }, { status: 404 });
  }

  const hasSsh = !!(sys.password || sys.privateKey);
  if (!hasSsh) {
    // Said plainly rather than surfacing a raw SSH auth failure: the fix is an
    // inventory edit, and the user should be told that, not shown a stack.
    return NextResponse.json({
      ok: false,
      error: `${sys.name} (${sys.host}) has no SSH credentials in inventory.yaml, so its files cannot be listed. Add them in Systems Management, or type the filename directly.`,
      host: sys.host, dir: spec.dir, files: [],
    }, { status: 200 });
  }

  try {
    // `-not -type d` rather than `\( -type f -o -type l \)`: it covers files
    // AND symlinks with no shell parens to escape through a template literal,
    // which is what silently broke this the first time. The escapes below must
    // stay doubled — \t and \n reach find as the two-character sequences its
    // -printf understands; a real tab or newline here would not.
    const cmd = `find ${spec.dir} -maxdepth 1 -not -type d ! -name '.*' -printf '%T@\t%s\t%f\t%l\n' 2>/dev/null`;
    const raw = await readCommand(sys, cmd);
    const files = raw.split('\n').filter(Boolean).map((line) => {
      const [epoch, size, name, target] = line.split('\t');
      const e = Number(epoch) || 0;
      return {
        name,
        size: Number(size) || 0,
        mtimeEpoch: e,
        mtime: e ? new Date(e * 1000).toISOString().slice(0, 19).replace('T', ' ') : '',
        // Present only for symlinks; the UI can show it as "name -> target".
        linkTarget: target ? target.trim() : undefined,
      };
    }).filter((f) => f.name);
    files.sort((a, b) => b.mtimeEpoch - a.mtimeEpoch);
    return NextResponse.json({ ok: true, host: sys.host, dir: spec.dir, label: spec.label, files });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e), host: sys.host, dir: spec.dir, files: [] }, { status: 200 });
  }
}

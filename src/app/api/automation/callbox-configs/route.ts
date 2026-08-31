// GET /api/automation/callbox-configs?systemId=sys-2&dir=enb|mme
//
// Lists config files on the chosen callbox via SSH. `dir` selects which
// directory: 'enb' -> /root/enb/config (gnb/enb cfgs), 'mme' -> /root/mme/config
// (mme + ims cfgs). Used by the Automation Suite wizard so the user can pick
// which configs to bind into a uesim+callbox suite (instead of uploading).
//
// The directory is chosen from a fixed map rather than taken from the query —
// this runs `find` over SSH as root, so an attacker-controlled path would be
// an arbitrary directory read.

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
  const DIRS: Record<string, string> = { enb: '/root/enb/config', mme: '/root/mme/config' };
  const dirKey = url.searchParams.get('dir') ?? 'enb';
  const dir = DIRS[dirKey];
  if (!dir) {
    return NextResponse.json({ ok: false, error: `unknown dir "${dirKey}" (expected ${Object.keys(DIRS).join(' | ')})` }, { status: 400 });
  }

  try {
    // Use `find -printf` to get the mtime as an epoch float so we can sort
    // deterministically. Format: <epoch>\t<size>\t<name>. Hidden files
    // (leading dot) are skipped per the lab convention — .md5 etc. aren't
    // testcase configs.
    // stderr is NOT swallowed. `2>/dev/null` made "directory does not exist on
    // this callbox" and "directory is empty" produce the identical empty list,
    // which is exactly the ambiguity that makes an empty picker unexplainable.
    // readCommand appends stderr, so a missing path comes back and is reported.
    const cmd = `find ${dir} -maxdepth 1 -not -type d ! -name '.*' -printf '%T@\t%s\t%f\n'`;
    const raw = await readCommand(sys, cmd);
    // A find error means the path is not there — say so instead of returning
    // an empty list that reads as "this callbox has no configs".
    if (/No such file or directory|Permission denied/i.test(raw)) {
      return NextResponse.json({
        ok: false, host: sys.host, dir, files: [],
        error: `${sys.name || sys.host}: ${dir} is not present (or not readable). This callbox does not keep its configs there.`,
      });
    }
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
    return NextResponse.json({ ok: true, host: sys.host, dir, files });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
  }
}

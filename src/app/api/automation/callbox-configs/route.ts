// GET /api/automation/callbox-configs?systemId=sys-2&dir=enb|mme|ots
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
import { isPickableCfg, ueDbForAll } from '@/lib/labCfgLink';

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
  // 'ots' is the box's own /root/ots/config — what the stack is actually
  // wired to (ots.cfg names the ENB/MME/IMS config files it loads). Listed,
  // never picked: nothing in a suite chooses it.
  const DIRS: Record<string, string> = { enb: '/root/enb/config', mme: '/root/mme/config', ots: '/root/ots/config' };
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
    // `sudo -n` first, plain find as the fallback.
    //
    // /root is 0700 on some callboxes and readable on others: .106 lists fine
    // as sysadmin, .122 answers "Permission denied" for the identical path —
    // which showed up as an empty picker with no explanation. -n keeps it
    // non-interactive, so a box without passwordless sudo drops straight to the
    // fallback instead of hanging on a password prompt.
    // %y%Y and %m feed isPickableCfg (see below).
    const find = `find ${dir} -maxdepth 1 -not -type d ! -name '.*' -printf '%T@\t%s\t%y%Y\t%m\t%f\n'`;
    const cmd = `sudo -n ${find} 2>/dev/null || ${find}`;
    const raw = await readCommand(sys, cmd);
    // A find error means the path is not there — say so instead of returning
    // an empty list that reads as "this callbox has no configs".
    if (/No such file or directory|Permission denied/i.test(raw)) {
      return NextResponse.json({
        ok: false, host: sys.host, dir, files: [],
        error: `${sys.host}: ${dir} is not present (or not readable). This callbox does not keep its configs there.`,
      });
    }
    // Only entries that are configs — the same rule as the Scenarios and
    // testcase pickers (isPickableCfg). Unfiltered, a newest-first list opened
    // with whatever was touched last: on .122 that was NTN-Handover.tar.gz, a
    // stray "root@192.168.1.57" and the enb.cfg link itself, which as a choice
    // would link enb.cfg to itself.
    const files = raw.split('\n').filter(Boolean).map(line => {
      const [epoch, size, types, mode, ...nameParts] = line.split('\t');
      const name = nameParts.join('\t');
      const epochNum = Number(epoch) || 0;
      return {
        name,
        pickable: isPickableCfg(name, types, mode),
        size: Number(size) || 0,
        mtimeEpoch: epochNum,
        // Pretty mtime for the UI — ISO is sortable + unambiguous.
        mtime: epochNum ? new Date(epochNum * 1000).toISOString().slice(0, 19).replace('T', ' ') : '',
      };
    }).filter(f => f.name && f.pickable).map(({ pickable: _p, ...f }) => f);
    // Sort newest first.
    files.sort((a, b) => b.mtimeEpoch - a.mtimeEpoch);

    // Which subscriber DB each mme cfg pulls in. The DB is not separately
    // selectable — it travels inside the MME config as an `include` line — so
    // it is reported rather than offered, and the picker can show which DB a
    // given mme.cfg brings with it.
    const ueDb = dirKey === 'mme' ? await ueDbForAll(sys).catch(() => ({})) : undefined;

    // ots.cfg is USUALLY a symlink, like enb.cfg and mme.cfg, and then the file
    // it points at is the one the stack loads. Not everywhere: on .106 it is a
    // plain file (-rw-rw-r--, sysadmin) while on .107 it is
    // ots.cfg -> ots.default.cfg. Reading only the link left the column empty
    // on half the lab, which reads as "no ots config" when there plainly is
    // one — so a regular file answers with its own name.
    let otsLink: string | undefined;
    let otsIsLink: boolean | undefined;
    if (dirKey === 'ots') {
      const out = await readCommand(
        sys,
        `sudo -n readlink '${dir}/ots.cfg' 2>/dev/null || readlink '${dir}/ots.cfg' 2>/dev/null || true`,
      ).catch(() => '');
      const target = out.trim().split('/').filter(Boolean).pop();
      if (target) {
        otsLink = target;
        otsIsLink = true;
      } else {
        // Asked of the filesystem, not of `files`.
        //
        // `files` is the PICKABLE list, and ots.cfg is excluded from it for
        // the same reason enb.cfg is: picking it would link it to itself. On
        // .107 ots.cfg is a plain file and the only thing in the directory, so
        // looking for it among the choices reported "no ots config" for a
        // callbox that plainly has one.
        const stat = await readCommand(
          sys,
          `sudo -n test -f '${dir}/ots.cfg' 2>/dev/null && echo yes || test -f '${dir}/ots.cfg' && echo yes || echo no`,
        ).catch(() => 'no');
        if (stat.trim().endsWith('yes')) {
          otsLink = 'ots.cfg';
          otsIsLink = false;
        }
      }
    }
    return NextResponse.json({
      ok: true, host: sys.host, dir, files,
      ...(ueDb ? { ueDb } : {}),
      ...(otsLink ? { otsLink, otsIsLink } : {}),
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
  }
}

// GET /api/testcases/<id>/callbox-configs?systemId=<simnovator>
//
// Lists the REAL cfg files already on the callbox bound to this testcase's
// Simnovator — the same `ls /root/enb/config` / `ls /root/mme/config` calls
// automation/runner.ts already makes when building its cfg picker. Read-only:
// this route never writes anything, so it's safe to hit on every page load.

import { NextResponse } from 'next/server';
import { loadInventory, getSystem } from '@/lib/inventory';
import { readCommand, writeRemoteFile } from '@/lib/configFidelity/ssh';
import { currentCfgLinks } from '@/lib/labCfgLink';

export const dynamic = 'force-dynamic';

/** The callbox bound to a Simnovator via its topology profile — same lookup
 *  automation/runner.ts's ueSystemForSimnovator uses, for the callbox instead
 *  of the UE. */
function callboxForSimnovator(inv: ReturnType<typeof loadInventory>, simnovatorId: string) {
  const profile = inv.profiles.find((p) => p.simnovator === simnovatorId);
  return profile?.callbox ? getSystem(inv, profile.callbox) : undefined;
}

/** `ls -1 <dir>` -> real filenames, blank/noise lines dropped. */
function parseListing(raw: string): string[] {
  return raw.split('\n').map((s) => s.trim()).filter(Boolean);
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const systemId = new URL(req.url).searchParams.get('systemId') ?? undefined;
  const inv = loadInventory();

  const sim = systemId ? getSystem(inv, systemId) : undefined;
  if (!sim) {
    return NextResponse.json({ error: systemId ? `system "${systemId}" not found` : 'systemId required' }, { status: 400 });
  }
  const callbox = callboxForSimnovator(inv, sim.id);
  if (!callbox) {
    return NextResponse.json({
      error: `No callbox bound to ${sim.name || sim.host} in Systems Management → Topology Setup.`,
    }, { status: 404 });
  }
  if (!callbox.username) {
    return NextResponse.json({
      error: `${callbox.name || callbox.host} has no SSH credentials set in Systems Management.`,
    }, { status: 400 });
  }

  try {
    const [radioRaw, coreRaw, current] = await Promise.all([
      readCommand(callbox, 'ls -1 /root/enb/config 2>/dev/null'),
      readCommand(callbox, 'ls -1 /root/mme/config 2>/dev/null'),
      currentCfgLinks(callbox),
    ]);

    return NextResponse.json({
      ok: true,
      callboxId: callbox.id,
      callboxHost: callbox.host,
      testcaseId: id,
      // Radio (eNB/gNB) and core (MME/IMS) cfgs live in different directories
      // on the box, so the picker needs two separate candidate lists.
      radioFiles: parseListing(radioRaw),
      coreFiles: parseListing(coreRaw),
      current,
    });
  } catch (e: any) {
    return NextResponse.json({ error: `${callbox.host} unreachable: ${e?.message ?? e}` }, { status: 502 });
  }
}

/** Filesystem-safe basename — same convention automation/runner.ts uses for
 *  uploaded cfg filenames. */
const safeName = (s: string) => s.replace(/[^\w.\-]/g, '_');

/** POST /api/testcases/<id>/callbox-configs — write an edited cfg as a NEW
 *  file on the callbox (never overwrites an existing symlink target), so it
 *  becomes a real pickable choice in the Run Configuration selects rather
 *  than a dead-end local edit. The box has no "update a cfg" concept either —
 *  a new file is the only way an edit is real. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  await ctx.params; // id isn't needed for the write itself — kept for route symmetry with GET
  const body = await req.json().catch(() => null);
  const systemId = body?.systemId as string | undefined;
  const role = body?.role as string | undefined;
  const filenameRaw = body?.filename as string | undefined;
  const content = body?.content;

  if (role !== 'enb' && role !== 'mme' && role !== 'ims') {
    return NextResponse.json({ error: 'role must be one of enb, mme, ims' }, { status: 400 });
  }
  if (!filenameRaw?.trim() || typeof content !== 'string') {
    return NextResponse.json({ error: 'filename and content are required' }, { status: 400 });
  }

  const inv = loadInventory();
  const sim = systemId ? getSystem(inv, systemId) : undefined;
  if (!sim) {
    return NextResponse.json({ error: systemId ? `system "${systemId}" not found` : 'systemId required' }, { status: 400 });
  }
  const callbox = callboxForSimnovator(inv, sim.id);
  if (!callbox) {
    return NextResponse.json({
      error: `No callbox bound to ${sim.name || sim.host} in Systems Management → Topology Setup.`,
    }, { status: 404 });
  }
  if (!callbox.username) {
    return NextResponse.json({
      error: `${callbox.name || callbox.host} has no SSH credentials set in Systems Management.`,
    }, { status: 400 });
  }

  const filename = safeName(filenameRaw.trim());
  const dir = role === 'enb' ? '/root/enb/config' : '/root/mme/config';
  const target = `${dir}/${filename}`;

  try {
    await writeRemoteFile(callbox, target, content);
    return NextResponse.json({ ok: true, filename, path: target, role });
  } catch (e: any) {
    return NextResponse.json({ error: `${callbox.host} unreachable or write failed: ${e?.message ?? e}` }, { status: 502 });
  }
}

// GET /api/box-users?systemId=…&probe=1
//
// The box logins a setup offers, for the "Run as" pickers.
//
// probe=1 additionally asks the Simnovator which simulator each login owns and
// whether it is busy. That is what makes concurrency legible: three logins on
// one box are three separate pieces of hardware, so System Management can show
// "sruthi → UE-Simulator1" rather than implying they queue behind each other.
// Best-effort by design — a login whose password is wrong, or a box that is
// down, returns the login with no simulator instead of failing the whole list.
//
// Deliberately NOT part of /api/inventory: that endpoint round-trips whole
// systems (System Management has to edit the passwords, so it receives them).
// A picker only needs to name the choices, so this returns id/username/label
// and never the password — the browser has no use for it, and the fewer places
// a credential travels the better.

import { NextResponse } from 'next/server';
import { loadInventory, listBoxUsers, getSystem } from '@/lib/inventory';
import { resolveUserSimulator } from '@/lib/executions';

export const dynamic = 'force-dynamic';

/** What one login owns on the box, or why we cannot say. */
async function probeOne(host: string, u: { username: string; password: string }) {
  try {
    const sim = await resolveUserSimulator({ host, username: u.username, password: u.password });
    if (!sim) return { simulator: null as null, reason: 'no simulator assigned to this login' };
    return { simulator: { id: sim.id, name: sim.name, availability: sim.availability } };
  } catch (e: any) {
    // Never the password, never a stack — just why the box would not say.
    const msg = String(e?.message ?? e);
    return { simulator: null as null, reason: /401|403|login failed/i.test(msg) ? 'the box rejected this login' : 'the box did not answer' };
  }
}

export async function GET(req: Request) {
  const systemId = (new URL(req.url).searchParams.get('systemId') ?? '').trim();
  if (!systemId) return NextResponse.json({ ok: false, error: 'systemId required' }, { status: 400 });

  const inv = loadInventory();
  const sys = getSystem(inv, systemId);
  if (!sys) return NextResponse.json({ ok: false, error: `no system "${systemId}"` }, { status: 404 });

  const listed = listBoxUsers(sys);
  const probe = new URL(req.url).searchParams.get('probe') === '1';
  // Sequential on purpose: each probe is a login plus a list, and firing five
  // at once at one box is how the login endpoint starts timing out.
  const probed = probe
    ? await Promise.all(listed.map(async (u) => ({ id: u.id, ...(await probeOne(sys.host, u)) })))
    : [];
  const byId = new Map(probed.map((p) => [p.id, p]));

  const users = listed.map((u) => ({
    id: u.id,
    username: u.username,
    label: u.label,
    ...(probe ? { simulator: byId.get(u.id)?.simulator ?? null, reason: byId.get(u.id)?.reason } : {}),
  }));
  return NextResponse.json({
    ok: true,
    systemId: sys.id,
    host: sys.host,
    users,
    // True when the setup has no explicit users and everything falls back to
    // the setup-wide credential — the picker says so instead of looking empty.
    usingSetupDefault: !(sys.uesimUsers ?? []).some((u) => u?.username),
  });
}

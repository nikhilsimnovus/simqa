// GET /api/stations/box-admin?systemId=sys-11
//
// What an administrator sees on a Simnovator, which is a different thing from
// what an operator sees:
//
//   * how the box is installed — regular or container — and how it hands out
//     RF, from /v2/hosts;
//   * every login the box has, the role it holds, and the simulators assigned
//     to it, from /v2/users (admin only);
//   * every simulator, with its connectivity and the RF cards it holds;
//   * the product version.
//
// admin is not an operator: it manages the box and the Simnovator does not
// execute test cases as it. So this is deliberately a VIEW and nothing else —
// nothing here starts, stops or changes anything.
//
// It reads through an admin login registered for that system in System
// Management. Without one it says so rather than guessing: a plain login is
// scoped to itself and simply cannot answer these questions.
//
// Credentials never appear in the response.

import { NextResponse } from 'next/server';
import { loadInventory, getSystem, uesimApiOptsForSystem, listBoxUsers } from '@/lib/inventory';
import {
  readBoxUsers, readHosts, installModeOf, installLine, executingLogins,
} from '@/lib/automation/boxRoles';
import { readSimulator } from '@/lib/automation/simulatorChoice';

export const dynamic = 'force-dynamic';

async function asJson(host: string, token: string, path: string): Promise<any> {
  const r = await fetch(`http://${host}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(8_000),
  });
  if (!r.ok) return { __status: r.status };
  return r.json();
}

export async function GET(req: Request) {
  const systemId = (new URL(req.url).searchParams.get('systemId') ?? '').trim();
  if (!systemId) return NextResponse.json({ ok: false, error: 'systemId required' }, { status: 400 });

  const inv = loadInventory();
  const sys = getSystem(inv, systemId);
  if (!sys) return NextResponse.json({ ok: false, error: `no system "${systemId}"` }, { status: 404 });

  // An admin login registered for this box. Picked by the role the box
  // states, falling back to the name the product ships with.
  const logins = listBoxUsers(sys);
  const adminLogin = logins.find((u) => u.username.trim().toLowerCase() === 'admin');
  if (!adminLogin) {
    return NextResponse.json({
      ok: true, host: sys.host, haveAdmin: false,
      note: 'No admin login is registered for this Simnovator in System Management, '
        + 'so its users, install mode and RF assignments cannot be read. '
        + 'An operator login is scoped to itself and cannot answer them.',
    });
  }

  const opts = uesimApiOptsForSystem(inv, systemId, adminLogin.id);
  if (!opts) return NextResponse.json({ ok: false, error: 'that login is not usable' }, { status: 404 });

  try {
    const { ensureToken } = await import('@/lib/uesimClient');
    const token = await ensureToken(opts.host, opts.username, opts.password);

    const [usersJ, hostsJ, simsJ, versionJ] = await Promise.all([
      asJson(opts.host, token, '/v2/users'),
      asJson(opts.host, token, '/v2/hosts'),
      asJson(opts.host, token, '/v2/simulators'),
      asJson(opts.host, token, '/v2/version'),
    ]);

    const users = readBoxUsers(usersJ);
    const hosts = readHosts(hostsJ);
    const simulators = (simsJ?.items ?? simsJ?.data ?? []).map(readSimulator).filter(Boolean);
    const ownerOf = new Map<string, string[]>();
    for (const u of users) for (const s of u.simulators) {
      ownerOf.set(s.id, [...(ownerOf.get(s.id) ?? []), u.username]);
    }

    return NextResponse.json({
      ok: true,
      host: opts.host,
      haveAdmin: true,
      // 403 here means user management is switched off on this build.
      usersReadable: usersJ?.__status === undefined,
      version: versionJ?.simnovator ?? null,
      installMode: installModeOf(hosts) ?? null,
      installLine: installLine(hosts),
      hosts,
      users,
      executing: executingLogins(users),
      simulators: simulators.map((s: any) => ({
        ...s,
        assignedTo: ownerOf.get(s.id) ?? [],
        cardHolders: hosts.flatMap((h) => h.cards.filter((c) => c.holder === s.name).map((c) => c.device)),
      })),
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 502 });
  }
}

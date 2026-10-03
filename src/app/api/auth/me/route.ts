// GET  /api/auth/me           → the signed-in account, as far as it is safe to show
// POST /api/auth/me { email } → set the address a reset link would go to
//
// Never includes a hash, a salt, a session token or a reset token.

import { NextResponse } from 'next/server';
import { publicUser, setEmail } from '@/lib/users';
import { userFromRequest } from '@/lib/identity';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const me = userFromRequest(req);
  if (!me) return NextResponse.json({ ok: false, error: 'Sign in first.' }, { status: 401 });
  const user = publicUser(me);
  if (!user) return NextResponse.json({ ok: false, error: 'Sign in first.' }, { status: 401 });
  return NextResponse.json({ ok: true, user });
}

export async function POST(req: Request) {
  const me = userFromRequest(req);
  if (!me) return NextResponse.json({ ok: false, error: 'Sign in first.' }, { status: 401 });
  let body: any = {};
  try { body = await req.json(); } catch { /* handled below */ }
  const r = setEmail(me, String(body?.email ?? ''));
  return r.ok
    ? NextResponse.json({ ok: true, user: publicUser(me) })
    : NextResponse.json({ ok: false, error: r.error }, { status: 400 });
}

// GET  /api/auth/me   → the signed-in account, as far as it is safe to show
// POST /api/auth/me   → edit your own profile: { firstName, lastName, email }
//
// Never includes a hash, a salt, a session token or anything about another
// account. The username is not editable here — it is what every suite, run and
// campaign is attributed to — and a POST that tries to set one is ignored
// rather than obeyed.

import { NextResponse } from 'next/server';
import { publicUser, setProfile } from '@/lib/users';
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

  // Only the fields actually sent are touched.
  const edit: { firstName?: string; lastName?: string; email?: string } = {};
  if (body?.firstName !== undefined) edit.firstName = String(body.firstName);
  if (body?.lastName !== undefined)  edit.lastName  = String(body.lastName);
  if (body?.email !== undefined)     edit.email     = String(body.email);

  const r = setProfile(me, edit);
  return r.ok
    ? NextResponse.json({ ok: true, user: publicUser(me) })
    : NextResponse.json({ ok: false, field: r.field, error: r.error }, { status: 400 });
}

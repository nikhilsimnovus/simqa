// POST /api/auth/change-password { currentPassword, newPassword, confirm }
//
// Only for the account already signed in, and only after the current password
// is checked again: a session left open on a shared lab machine must not be
// enough to take the account over.
//
// Succeeding ends every other session for that account — setPassword bumps the
// session epoch — and kills any outstanding reset link. This browser is given
// a fresh cookie, so the person who just changed it stays signed in.

import { NextResponse } from 'next/server';
import { verifyUser, setPassword, sessionEpoch } from '@/lib/users';
import { userFromRequest } from '@/lib/identity';
import { setSessionCookie } from '@/lib/authCookie';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const me = userFromRequest(req);
  if (!me) return NextResponse.json({ ok: false, error: 'Sign in first.' }, { status: 401 });

  let body: any = {};
  try { body = await req.json(); } catch { /* handled below */ }
  const current = String(body?.currentPassword ?? '');
  const next = String(body?.newPassword ?? '');
  const confirm = String(body?.confirm ?? next);

  if (!current || !next) {
    return NextResponse.json({ ok: false, error: 'Enter your current and new password.' }, { status: 400 });
  }
  if (next !== confirm) {
    return NextResponse.json({ ok: false, field: 'confirm', error: 'Passwords do not match.' }, { status: 400 });
  }
  if (!verifyUser(me, current)) {
    return NextResponse.json({ ok: false, field: 'current', error: 'Your current password is not correct.' }, { status: 400 });
  }

  try {
    const r = setPassword(me, next);
    if (!r.ok) return NextResponse.json({ ok: false, field: 'new', error: r.error }, { status: 400 });

    const res = NextResponse.json({ ok: true, message: 'Password changed successfully.' });
    // Keep THIS browser signed in under the new epoch; every other session is
    // now behind it and will be refused.
    setSessionCookie(res, req, me, sessionEpoch(me), true);
    return res;
  } catch (e) {
    console.error('[auth] change password failed:', (e as any)?.message ?? e);
    return NextResponse.json({ ok: false, error: 'Something went wrong. Please try again.' }, { status: 500 });
  }
}

// POST /api/auth/logout — end the session.
//
// { everywhere: true } ends every session for the account, not just this
// browser's: the session cookie is stateless, so dropping the cookie alone
// would leave a copy taken off this machine working until it expired. Bumping
// the account's session epoch is what actually invalidates them.

import { NextResponse } from 'next/server';
import { userFromRequest } from '@/lib/identity';
import { bumpSessionEpoch } from '@/lib/users';
import { clearSessionCookie } from '@/lib/authCookie';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  let body: any = {};
  try { body = await req.json(); } catch { /* an empty body is the normal case */ }

  let everywhere = false;
  if (body?.everywhere === true) {
    const me = userFromRequest(req);
    if (me) { bumpSessionEpoch(me); everywhere = true; }
  }

  const res = NextResponse.json({ ok: true, everywhere });
  clearSessionCookie(res, req);
  return res;
}

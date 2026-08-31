// POST /api/auth/signup  { username, password } → create an account and sign in
//
// Open registration: anyone who can reach SimQA can make an account. That is
// the intent for a shared lab tool — the point is that every action has a real
// owner, not that access is restricted.

import { NextResponse } from 'next/server';
import { createUser, verifyUser } from '@/lib/users';
import { SESSION_COOKIE, SESSION_MAX_AGE_SEC, normalizeUser, isValidUser } from '@/lib/identity';
import { createSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  let body: any = {};
  try { body = await req.json(); } catch { /* invalid below */ }

  const username = normalizeUser(body?.username ?? '');
  const password = String(body?.password ?? '');

  if (!isValidUser(username)) {
    return NextResponse.json({ ok: false, error: 'Enter a username of at least 2 characters.' }, { status: 400 });
  }

  const created = createUser(username, password);
  if (!created.ok) {
    return NextResponse.json({ ok: false, error: created.error }, { status: 400 });
  }

  // Sign them straight in — re-typing the password they just chose adds
  // nothing. Verified rather than assumed, so the session is only ever minted
  // off a real credential check.
  const who = verifyUser(username, password);
  if (!who) {
    return NextResponse.json({ ok: false, error: 'Account created, but sign-in failed. Try signing in.' }, { status: 500 });
  }

  const res = NextResponse.json({ ok: true, user: who });
  res.cookies.set(SESSION_COOKIE, createSession(who), {
    path: '/',
    maxAge: SESSION_MAX_AGE_SEC,
    sameSite: 'lax',
    httpOnly: true,   // it's a credential — scripts must not read it
  });
  return res;
}

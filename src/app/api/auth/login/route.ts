// POST /api/auth/login  { username, password } → verify and start a session
//
// Failures are deliberately indistinguishable: "no such account" and "wrong
// password" return the same message, so the response cannot be used to
// enumerate who has an account.

import { NextResponse } from 'next/server';
import { verifyUser, countUsers } from '@/lib/users';
import { SESSION_COOKIE, SESSION_MAX_AGE_SEC, normalizeUser } from '@/lib/identity';
import { createSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  let body: any = {};
  try { body = await req.json(); } catch { /* invalid below */ }

  const username = normalizeUser(body?.username ?? body?.user ?? '');
  const password = String(body?.password ?? '');

  if (!username || !password) {
    return NextResponse.json({ ok: false, error: 'Enter your username and password.' }, { status: 400 });
  }

  const who = verifyUser(username, password);
  if (!who) {
    return NextResponse.json({
      ok: false,
      error: 'Incorrect username or password.',
      // Not a hint about this account — just the fact that nobody has
      // registered yet, which is worth saying on a fresh install.
      noAccountsYet: countUsers() === 0,
    }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true, user: who });
  res.cookies.set(SESSION_COOKIE, createSession(who), {
    path: '/',
    maxAge: SESSION_MAX_AGE_SEC,
    sameSite: 'lax',
    httpOnly: true,
  });
  return res;
}

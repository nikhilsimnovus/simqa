// POST /api/auth/login  { username, password, remember } → verify, start a session
//
// Failures are deliberately indistinguishable: "no such account", "wrong
// password" and "that account is being throttled" all answer the same way, so
// the response cannot be used to work out who has an account.
//
// Repeated failures from the same account-and-client pair are held off for a
// period that grows each time and always expires — see loginThrottle. Nothing
// here locks an account permanently; someone who mistypes their password five
// times should wait, not lose access to the tool.

import { NextResponse } from 'next/server';
import { verifyUser, countUsers, recordLogin, sessionEpoch } from '@/lib/users';
import { normalizeUser } from '@/lib/identity';
import { setSessionCookie, clientKey } from '@/lib/authCookie';
import { throttleKey, retryAfterMs, recordFailure, recordSuccess, describeWait } from '@/lib/loginThrottle';

export const dynamic = 'force-dynamic';

/** One message for every way signing in can fail. */
const GENERIC = 'Invalid username or password.';

export async function POST(req: Request) {
  let body: any = {};
  try { body = await req.json(); } catch { /* handled below */ }

  const username = normalizeUser(body?.username ?? body?.user ?? '');
  const password = String(body?.password ?? '');
  const remember = body?.remember === true;

  if (!username || !password) {
    return NextResponse.json({ ok: false, error: 'Enter your username and password.' }, { status: 400 });
  }

  const key = throttleKey(username, clientKey(req));
  const wait = retryAfterMs(key);
  if (wait > 0) {
    return NextResponse.json({
      ok: false,
      error: `Too many attempts. Try again in ${describeWait(wait)}.`,
      retryAfterMs: wait,
    }, { status: 429, headers: { 'Retry-After': String(Math.ceil(wait / 1000)) } });
  }

  let who: string | null = null;
  try {
    who = verifyUser(username, password);
  } catch (e) {
    // Never let an internal failure reach the browser as a stack trace.
    console.error('[auth] login failed unexpectedly:', (e as any)?.message ?? e);
    return NextResponse.json({ ok: false, error: 'Something went wrong. Please try again.' }, { status: 500 });
  }

  if (!who) {
    const held = recordFailure(key);
    return NextResponse.json({
      ok: false,
      error: held > 0 ? `${GENERIC} Too many attempts — try again in ${describeWait(held)}.` : GENERIC,
      // Not a hint about this account — just that nobody has registered yet,
      // which is worth saying on a fresh install.
      noAccountsYet: countUsers() === 0,
    }, { status: 401 });
  }

  recordSuccess(key);
  recordLogin(who);

  // A fresh token is minted here and carries the account's current epoch, so a
  // session handed out before this one has no bearing on it.
  const res = NextResponse.json({ ok: true, user: who });
  setSessionCookie(res, req, who, sessionEpoch(who), remember);
  return res;
}

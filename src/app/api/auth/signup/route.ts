// POST /api/auth/signup  { username, email, password } → create an account and sign in
//
// Open registration: anyone who can reach SimQA can make an account. That is
// the intent for a shared lab tool — the point is that every action has a real
// owner, not that access is restricted.
//
// The password policy and both uniqueness checks are enforced here, not in the
// browser. The form checks the same rules as you type, but that is for the
// person's benefit; this is the one that counts.

import { NextResponse } from 'next/server';
import { createUser, verifyUser, sessionEpoch } from '@/lib/users';
import { normalizeUser, isValidUser } from '@/lib/identity';
import { setSessionCookie } from '@/lib/authCookie';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  let body: any = {};
  try { body = await req.json(); } catch { /* handled below */ }

  const username = normalizeUser(body?.username ?? '');
  const email = String(body?.email ?? '').trim();
  const password = String(body?.password ?? '');
  const confirm = String(body?.confirm ?? password);

  if (!isValidUser(username)) {
    return NextResponse.json({ ok: false, field: 'username', error: 'Enter a username.' }, { status: 400 });
  }
  if (password !== confirm) {
    return NextResponse.json({ ok: false, field: 'confirm', error: 'Passwords do not match.' }, { status: 400 });
  }

  const created = createUser(username, password, email);
  if (!created.ok) {
    return NextResponse.json({ ok: false, field: created.field, error: created.error }, { status: 400 });
  }

  // Signed straight in — retyping the password just chosen adds nothing.
  // Verified rather than assumed, so a session is only ever minted off a real
  // credential check.
  const who = verifyUser(username, password);
  if (!who) {
    return NextResponse.json({ ok: false, error: 'Account created, but sign-in failed. Try signing in.' }, { status: 500 });
  }

  const res = NextResponse.json({ ok: true, user: who });
  setSessionCookie(res, req, who, sessionEpoch(who), body?.remember === true);
  return res;
}

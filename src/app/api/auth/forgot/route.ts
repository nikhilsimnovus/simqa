// POST /api/auth/forgot  { identifier } → start a password reset
//
// The answer is the same whether or not anything matched. A reset endpoint
// that says "no such account" is a way to find out who has one, which is worth
// more to an attacker than the reset itself.
//
// The link is never returned here — only delivered (see resetDelivery).

import { NextResponse } from 'next/server';
import { startPasswordReset, publicUser } from '@/lib/users';
import { deliverResetLink } from '@/lib/resetDelivery';
import { clientKey } from '@/lib/authCookie';
import { throttleKey, retryAfterMs, recordFailure, describeWait } from '@/lib/loginThrottle';

export const dynamic = 'force-dynamic';

const SAME_ANSWER = 'If an account exists for this information, a password reset link has been sent.';

export async function POST(req: Request) {
  let body: any = {};
  try { body = await req.json(); } catch { /* handled below */ }
  const identifier = String(body?.identifier ?? '').trim();

  if (!identifier) {
    return NextResponse.json({ ok: false, error: 'Enter your username or email.' }, { status: 400 });
  }

  // Throttled like a login: without it this is a free way to spray reset
  // requests at every username someone can think of.
  const key = throttleKey(`forgot:${identifier}`, clientKey(req));
  const wait = retryAfterMs(key);
  if (wait > 0) {
    return NextResponse.json(
      { ok: false, error: `Too many requests. Try again in ${describeWait(wait)}.` },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(wait / 1000)) } },
    );
  }
  recordFailure(key);   // every request counts, matched or not

  try {
    const started = startPasswordReset(identifier);
    if (started) {
      const base = (process.env.SIMQA_PUBLIC_URL ?? '').trim() || new URL(req.url).origin;
      await deliverResetLink({
        username: started.username,
        email: publicUser(started.username)?.email,
        link: `${base}/reset?token=${encodeURIComponent(started.token)}`,
        expiresAt: started.expiresAt,
      });
    }
  } catch (e) {
    // Logged on the server, never shown: the person asking must not be able to
    // tell a failure from a match.
    console.error('[auth] password reset request failed:', (e as any)?.message ?? e);
  }

  return NextResponse.json({ ok: true, message: SAME_ANSWER });
}

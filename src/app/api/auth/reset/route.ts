// GET  /api/auth/reset?token=…             → is this link still good?
// POST /api/auth/reset { token, password } → set the new password
//
// The check and the spend are separate calls for the page's sake — an expired
// link should say so before someone types a password — but the POST re-checks
// and consumes in one step inside the store. A token verified in one place and
// spent in another is a token that can be used twice.

import { NextResponse } from 'next/server';
import { checkResetToken, resetPasswordWithToken } from '@/lib/users';

export const dynamic = 'force-dynamic';

/** Why a link does not work, worded for whoever clicked it. */
const WHY: Record<string, string> = {
  invalid: 'This password reset link is not valid. Request a new one.',
  expired: 'This password reset link has expired. Request a new one.',
  used: 'This password reset link has already been used. Request a new one.',
};

export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get('token') ?? '';
  const check = checkResetToken(token);
  return check.ok
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ ok: false, reason: check.reason, error: WHY[check.reason] }, { status: 400 });
}

export async function POST(req: Request) {
  let body: any = {};
  try { body = await req.json(); } catch { /* handled below */ }
  const token = String(body?.token ?? '');
  const password = String(body?.password ?? '');
  const confirm = String(body?.confirm ?? password);

  if (password !== confirm) {
    return NextResponse.json({ ok: false, error: 'Passwords do not match.' }, { status: 400 });
  }

  try {
    const r = resetPasswordWithToken(token, password);
    if (!r.ok) {
      return NextResponse.json(
        { ok: false, reason: r.reason, error: r.reason === 'policy' ? r.error : WHY[r.reason] },
        { status: 400 },
      );
    }
    // No session is started here, on purpose: whoever reset the password proves
    // it by signing in with it, and a stolen link cannot be turned straight
    // into a signed-in browser.
    return NextResponse.json({ ok: true, message: 'Your password has been reset successfully.' });
  } catch (e) {
    console.error('[auth] password reset failed:', (e as any)?.message ?? e);
    return NextResponse.json({ ok: false, error: 'Something went wrong. Please try again.' }, { status: 500 });
  }
}

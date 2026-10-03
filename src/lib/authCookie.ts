// How a session cookie is set, in one place, so login, signup and reset
// cannot drift into setting it three slightly different ways.
//
// httpOnly: the token is a credential — page scripts have no business reading
// it, and the UI gets the display name from the server instead.
// sameSite lax: the cookie rides a normal navigation back into the app but not
// a cross-site form post.
// secure: on when the request arrived over HTTPS. Not hardcoded, because this
// is deployed on a lab network over plain HTTP and a cookie marked secure
// there would simply never be sent.

import type { NextResponse } from 'next/server';
import { SESSION_COOKIE } from './identity';
import { SESSION_MAX_AGE_SEC, createSession } from './session';

/** A session that ends when the browser does, for someone who did not ask to
 *  be remembered on this machine. */
export const BROWSER_SESSION = 'browser-session';

export function setSessionCookie(
  res: NextResponse,
  req: Request,
  username: string,
  epoch: number,
  remember: boolean,
): void {
  const secure = new URL(req.url).protocol === 'https:';
  // A token is always given a lifetime; "remember me" decides whether the
  // COOKIE outlives the browser, not whether the token is open-ended.
  const token = createSession(username, epoch, SESSION_MAX_AGE_SEC);
  res.cookies.set(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure,
    ...(remember ? { maxAge: SESSION_MAX_AGE_SEC } : {}),
  });
}

export function clearSessionCookie(res: NextResponse, req: Request): void {
  const secure = new URL(req.url).protocol === 'https:';
  res.cookies.set(SESSION_COOKIE, '', { path: '/', httpOnly: true, sameSite: 'lax', secure, maxAge: 0 });
}

/** Who is asking, for throttling. Behind a reverse proxy the first
 *  X-Forwarded-For hop is the closest thing to a client address available. */
export function clientKey(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for') ?? '';
  const first = fwd.split(',')[0]?.trim();
  return first || req.headers.get('x-real-ip') || 'local';
}

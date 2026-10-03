// Who is signed in to SimQA.
//
// The name is used for attribution — who created a playlist or testcase, who
// submitted the last job, who last used a box — and, since accounts exist, it
// is backed by a real password check (see users.ts) and carried in an
// HMAC-signed session cookie (see session.ts) so it cannot be forged from the
// browser console.
//
// A valid signature is not enough on its own: the token also carries the
// account's session epoch, and a token minted before the account moved past it
// — a password change, or signing out everywhere — is refused here. That is
// what makes ending a session mean something when the cookie itself is
// stateless.

import { cookies } from 'next/headers';
import { readSessionFull } from './session';
import { sessionEpoch } from './users';

/** Cookie carrying the signed session token. httpOnly: the token is a
 *  credential, so page scripts have no business reading it — the UI gets the
 *  display name from the server instead. */
export const SESSION_COOKIE = 'simqa-session';

export { SESSION_MAX_AGE_SEC } from './session';

/** The user a token really stands for: signature, expiry, and the account's
 *  current session epoch. '' when any of the three says no. */
function verified(token: string | undefined): string {
  const { username, epoch } = readSessionFull(token);
  if (!username) return '';
  const current = sessionEpoch(username);
  // 0 means the account is gone; anything older than current was ended.
  if (current === 0 || epoch < current) return '';
  return normalizeUser(username);
}

/** C0 controls and DEL — stripped so a name can never break a log line, a
 *  filename, or a Set-Cookie header. Written as escapes on purpose: literal
 *  control bytes here are invisible in every editor and defeat text matching. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/**
 * Normalise a typed name into what gets stored and attributed.
 *
 * Kept permissive — real names, handles and emails are all fine — but bounded
 * and stripped of anything that would corrupt the places the name gets written.
 */
export function normalizeUser(raw: string): string {
  return String(raw ?? '')
    .replace(CONTROL_CHARS, '')
    .replace(/[;,]/g, ' ')      // cookie + CSV separators
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 64);
}

/** True when the name is usable at all. Any name goes — the only limits left
 *  are the ones normalizeUser already applies for safety: no control bytes, and
 *  a bound so a name cannot be unbounded in a log line or a filename. */
export function isValidUser(raw: string): boolean {
  const u = normalizeUser(raw);
  return u.length >= 1 && u.length <= 64;
}

/**
 * The signed-in user, server-side. Returns '' when nobody is signed in or the
 * session is invalid/expired. Callers recording attribution should store
 * undefined rather than '' so an un-attributed record stays honestly so.
 */
export async function currentUser(): Promise<string> {
  try {
    const jar = await cookies();
    return verified(jar.get(SESSION_COOKIE)?.value);
  } catch {
    // cookies() throws outside a request scope (e.g. a background runner).
    return '';
  }
}

/** Same as currentUser but yields undefined instead of '' — the shape most
 *  attribution fields want. */
export async function currentUserOrUndefined(): Promise<string | undefined> {
  const u = await currentUser();
  return u || undefined;
}

/** Read + verify the session from a request's own cookie header. For route
 *  handlers that already have the Request. */
export function userFromRequest(req: Request): string | undefined {
  const raw = req.headers.get('cookie') ?? '';
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() !== SESSION_COOKIE) continue;
    const val = verified(decodeURIComponent(part.slice(idx + 1).trim()));
    return val || undefined;
  }
  return undefined;
}

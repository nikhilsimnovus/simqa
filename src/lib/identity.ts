// Who is signed in to SimQA.
//
// The name is used for attribution — who created a playlist or testcase, who
// submitted the last job, who last used a box — and, since accounts exist, it
// is backed by a real password check (see users.ts) and carried in an
// HMAC-signed session cookie (see session.ts) so it cannot be forged from the
// browser console.
//
// Scope, stated plainly: lightweight sign-in for a shared lab tool on a trusted
// network. No rate limiting, MFA, or password reset.

import { cookies } from 'next/headers';
import { readSession } from './session';

/** Cookie carrying the signed session token. httpOnly: the token is a
 *  credential, so page scripts have no business reading it — the UI gets the
 *  display name from the server instead. */
export const SESSION_COOKIE = 'simqa-session';

export { SESSION_MAX_AGE_SEC } from './session';

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

/** True when the name is shaped like a usable username. */
export function isValidUser(raw: string): boolean {
  const u = normalizeUser(raw);
  return u.length >= 2 && u.length <= 64;
}

/**
 * The signed-in user, server-side. Returns '' when nobody is signed in or the
 * session is invalid/expired. Callers recording attribution should store
 * undefined rather than '' so an un-attributed record stays honestly so.
 */
export async function currentUser(): Promise<string> {
  try {
    const jar = await cookies();
    return normalizeUser(readSession(jar.get(SESSION_COOKIE)?.value));
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
    const val = normalizeUser(readSession(decodeURIComponent(part.slice(idx + 1).trim())));
    return val || undefined;
  }
  return undefined;
}

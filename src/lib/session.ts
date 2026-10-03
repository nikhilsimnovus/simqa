// Signed session tokens.
//
// Why this exists: before accounts, the identity cookie was just the username,
// so anyone could type `document.cookie = "simqa-user=alice"` and be Alice.
// That was fine when it was only a name badge, but once there is a password the
// cookie has to actually prove the password was checked — otherwise the login
// form is theatre and attribution can be spoofed from the browser console.
//
// A token is `<base64url(payload)>.<hmac>`, where payload is {u, exp}. The HMAC
// is over the exact payload string, so neither the username nor the expiry can
// be edited without invalidating it.
//
// Node-only (uses node:crypto). Middleware runs on the Edge runtime and cannot
// import this — it does a cheap presence check for redirects, while every
// server component and route handler verifies properly via identity.ts.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const SECRET_FILE = () => path.join(process.cwd(), 'data', '.session-secret');

/** Sessions last a working month — long enough not to nag, short enough that a
 *  forgotten browser on a lab PC doesn't stay signed in forever. */
export const SESSION_MAX_AGE_SEC = 60 * 60 * 24 * 30;

let cachedSecret: string | undefined;

/**
 * HMAC secret. Taken from SIMQA_SESSION_SECRET when set (the right way to do it
 * for a real deployment); otherwise generated once and persisted under data/,
 * which is gitignored. Regenerating it simply invalidates existing sessions —
 * everyone signs in again, nothing is lost.
 */
function secret(): string {
  if (cachedSecret) return cachedSecret;
  const fromEnv = process.env.SIMQA_SESSION_SECRET?.trim();
  if (fromEnv) { cachedSecret = fromEnv; return cachedSecret; }
  try {
    cachedSecret = fs.readFileSync(SECRET_FILE(), 'utf8').trim();
    if (cachedSecret) return cachedSecret;
  } catch { /* not created yet */ }
  const generated = randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(path.dirname(SECRET_FILE()), { recursive: true });
    fs.writeFileSync(SECRET_FILE(), generated, { mode: 0o600 });
  } catch { /* read-only fs: fall back to a per-process secret */ }
  cachedSecret = generated;
  return cachedSecret;
}

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const unb64url = (s: string) => Buffer.from(s, 'base64url').toString('utf8');

function sign(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('base64url');
}

/**
 * Mint a token for `username`, valid for SESSION_MAX_AGE_SEC.
 *
 * `e` is the account's session epoch at the moment of signing. The cookie is
 * stateless — nothing on the server remembers it — so without that number
 * there would be no way to end a session that has already been handed out:
 * signing out would only drop the browser's copy, and a password change would
 * leave every other session running. readSession returns it; identity.ts
 * refuses a token whose epoch is behind the account's.
 */
export function createSession(username: string, epoch = 1, maxAgeSec = SESSION_MAX_AGE_SEC): string {
  const payload = b64url(JSON.stringify({
    u: username,
    e: epoch,
    exp: Math.floor(Date.now() / 1000) + maxAgeSec,
  }));
  return `${payload}.${sign(payload)}`;
}

/**
 * Verify a token and return its username, or '' if it is missing, malformed,
 * tampered with, or expired.
 */
export function readSession(token: string | undefined): string {
  return readSessionFull(token).username;
}

/** The username AND the epoch the token was minted under. '' when the token is
 *  missing, malformed, tampered with or expired. */
export function readSessionFull(token: string | undefined): { username: string; epoch: number } {
  const none = { username: '', epoch: 0 };
  if (!token) return none;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return none;
  const payload = token.slice(0, dot);
  const mac = token.slice(dot + 1);

  const expected = Buffer.from(sign(payload), 'utf8');
  const actual = Buffer.from(mac, 'utf8');
  // Length check first: timingSafeEqual throws on a length mismatch.
  if (expected.length !== actual.length) return none;
  if (!timingSafeEqual(expected, actual)) return none;

  try {
    const { u, e, exp } = JSON.parse(unb64url(payload));
    if (typeof u !== 'string' || typeof exp !== 'number') return none;
    if (exp * 1000 < Date.now()) return none;
    // Tokens minted before epochs existed count as epoch 1, which is what a
    // fresh account starts at — so nobody is signed out by this arriving.
    return { username: u, epoch: typeof e === 'number' ? e : 1 };
  } catch {
    return none;
  }
}

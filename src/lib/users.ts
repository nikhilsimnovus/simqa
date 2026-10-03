// SimQA accounts — stored in data/users.json, mode 0600.
//
// Passwords are NEVER stored or logged in plaintext. Each account gets its own
// random salt and the password goes through scrypt, which is deliberately slow
// and memory-hard so a stolen users.json cannot be brute-forced cheaply.
// Verification uses timingSafeEqual, so a wrong password takes the same time to
// reject regardless of how much of the hash matched, and an account that does
// not exist is hashed against anyway so its absence cannot be timed either.
//
// What a record holds, and why:
//
//   salt + hash          the password, one-way
//   passwordHistory      the last few, so a reset cannot reuse a recent one
//   sessionEpoch         bumped to invalidate every session already issued —
//                        this is what makes "sign out everywhere" and "changing
//                        your password ends other sessions" true rather than
//                        cosmetic, because the session cookie is stateless
//   reset                a HASHED single-use token with an expiry; the token
//                        itself exists only in the link that was sent
//   lastLoginAt,
//   passwordChangedAt    shown on the account page
//
// Nothing here returns a hash, a salt or a token to a caller that could put it
// in a response.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { checkPassword } from './passwordPolicy';

interface StoredHash { salt: string; hash: string; at?: string }

export interface UserRecord {
  username: string;
  /** Optional: accounts predate it, and it is only used for password reset. */
  email?: string;
  salt: string;
  hash: string;
  createdAt: string;
  updatedAt?: string;
  lastLoginAt?: string;
  passwordChangedAt?: string;
  /** Sessions minted before this number are refused. Starts at 1. */
  sessionEpoch?: number;
  /** Most recent first, newest few only. */
  passwordHistory?: StoredHash[];
  reset?: {
    /** sha256 of the token in the link — never the token itself. */
    tokenHash: string;
    expiresAt: string;
    createdAt: string;
    usedAt?: string;
  };
}

interface Store { users: UserRecord[] }

const FILE = () => path.join(process.cwd(), 'data', 'users.json');
const KEYLEN = 64;
/** How many previous passwords a new one may not match. */
const HISTORY_DEPTH = 5;
/** A reset link is useful for half an hour and then it is not. */
export const RESET_TTL_MS = 30 * 60_000;

function read(): Store {
  try {
    const j = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    return Array.isArray(j?.users) ? j : { users: [] };
  } catch {
    return { users: [] };   // no file yet
  }
}

function write(s: Store): void {
  fs.mkdirSync(path.dirname(FILE()), { recursive: true });
  fs.writeFileSync(FILE(), JSON.stringify(s, null, 2), { mode: 0o600 });
}

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, KEYLEN).toString('hex');
}

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex'), y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Usernames are matched case-insensitively, so "Sruthi" and "sruthi" are one
 *  account and cannot both be registered. */
function key(username: string): string {
  return (username ?? '').trim().toLowerCase();
}

/** Deliberately permissive — this is a shape check, not an attempt to decide
 *  which addresses exist. */
export function isValidEmail(email: string): boolean {
  const e = (email ?? '').trim();
  return e.length >= 5 && e.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

export function userExists(username: string): boolean {
  const k = key(username);
  return read().users.some((u) => key(u.username) === k);
}

export function emailTaken(email: string, exceptUsername?: string): boolean {
  const e = (email ?? '').trim().toLowerCase();
  if (!e) return false;
  return read().users.some(u =>
    (u.email ?? '').toLowerCase() === e && key(u.username) !== key(exceptUsername ?? ''));
}

export function listUsernames(): string[] {
  return read().users.map((u) => u.username);
}

export function countUsers(): number {
  return read().users.length;
}

/** Everything about an account that is safe to show its owner. */
export interface PublicUser {
  username: string;
  email?: string;
  createdAt: string;
  lastLoginAt?: string;
  passwordChangedAt?: string;
}

export function publicUser(username: string): PublicUser | null {
  const u = read().users.find(x => key(x.username) === key(username));
  if (!u) return null;
  return {
    username: u.username,
    email: u.email,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt,
    passwordChangedAt: u.passwordChangedAt,
  };
}

export interface CreateResult { ok: boolean; error?: string; field?: 'username' | 'email' | 'password' }

/** Register an account. Rejects duplicates and anything the password policy
 *  turns down; never returns or stores the raw password. */
export function createUser(username: string, password: string, email?: string): CreateResult {
  const name = (username ?? '').trim();
  if (name.length < 2)  return { ok: false, field: 'username', error: 'Username must be at least 2 characters.' };
  if (name.length > 64) return { ok: false, field: 'username', error: 'Username must be 64 characters or fewer.' };

  const mail = (email ?? '').trim();
  if (mail && !isValidEmail(mail)) return { ok: false, field: 'email', error: 'Enter a valid email address.' };

  const pw = checkPassword(password);
  if (!pw.ok) return { ok: false, field: 'password', error: pw.error };

  const s = read();
  if (s.users.some((u) => key(u.username) === key(name))) {
    return { ok: false, field: 'username', error: 'Username already exists.' };
  }
  if (mail && s.users.some(u => (u.email ?? '').toLowerCase() === mail.toLowerCase())) {
    return { ok: false, field: 'email', error: 'Email is already registered.' };
  }

  const salt = randomBytes(16).toString('hex');
  const now = new Date().toISOString();
  s.users.push({
    username: name,
    email: mail || undefined,
    salt,
    hash: hashPassword(password, salt),
    createdAt: now,
    passwordChangedAt: now,
    sessionEpoch: 1,
  });
  write(s);
  return { ok: true };
}

/**
 * Check a username/password pair.
 *
 * Returns the stored username (with its original capitalisation) on success,
 * null otherwise. The caller must NOT distinguish "no such user" from "wrong
 * password" in what it shows — that difference tells an attacker which
 * usernames exist.
 */
export function verifyUser(username: string, password: string): string | null {
  const rec = read().users.find((u) => key(u.username) === key(username));
  if (!rec) {
    // Hash anyway so a missing account takes about as long as a wrong
    // password — otherwise response time alone reveals who has an account.
    hashPassword(password, 'absent-account-timing-equaliser');
    return null;
  }
  return sameHash(rec.hash, hashPassword(password, rec.salt)) ? rec.username : null;
}

/** Note a successful sign-in. Attribution only — never gates anything. */
export function recordLogin(username: string): void {
  const s = read();
  const u = s.users.find(x => key(x.username) === key(username));
  if (!u) return;
  u.lastLoginAt = new Date().toISOString();
  write(s);
}

/** The epoch a session must carry to still be valid. Sessions issued before a
 *  password change or a "sign out everywhere" carry an older one. */
export function sessionEpoch(username: string): number {
  const u = read().users.find(x => key(x.username) === key(username));
  return u ? (u.sessionEpoch ?? 1) : 0;
}

/** End every session already issued for this account. */
export function bumpSessionEpoch(username: string): number {
  const s = read();
  const u = s.users.find(x => key(x.username) === key(username));
  if (!u) return 0;
  u.sessionEpoch = (u.sessionEpoch ?? 1) + 1;
  u.updatedAt = new Date().toISOString();
  write(s);
  return u.sessionEpoch;
}

export interface SetPasswordResult { ok: boolean; error?: string }

/**
 * Replace an account's password.
 *
 * Enforces the policy, refuses the current password and the last few before
 * it, invalidates any outstanding reset link, and bumps the session epoch so
 * sessions opened with the old password stop working. The caller decides
 * whether the person proved themselves with the old password or with a reset
 * token — this does not care, and must not be reachable without one of them.
 */
export function setPassword(username: string, newPassword: string): SetPasswordResult {
  const pw = checkPassword(newPassword);
  if (!pw.ok) return { ok: false, error: pw.error };

  const s = read();
  const u = s.users.find(x => key(x.username) === key(username));
  if (!u) return { ok: false, error: 'Unable to change the password.' };

  if (sameHash(u.hash, hashPassword(newPassword, u.salt))) {
    return { ok: false, error: 'Choose a password you have not used before.' };
  }
  for (const old of (u.passwordHistory ?? [])) {
    if (sameHash(old.hash, hashPassword(newPassword, old.salt))) {
      return { ok: false, error: 'Choose a password you have not used recently.' };
    }
  }

  const now = new Date().toISOString();
  u.passwordHistory = [{ salt: u.salt, hash: u.hash, at: u.passwordChangedAt ?? u.createdAt },
    ...(u.passwordHistory ?? [])].slice(0, HISTORY_DEPTH);
  u.salt = randomBytes(16).toString('hex');
  u.hash = hashPassword(newPassword, u.salt);
  u.passwordChangedAt = now;
  u.updatedAt = now;
  u.sessionEpoch = (u.sessionEpoch ?? 1) + 1;   // other sessions end here
  delete u.reset;                               // any outstanding link dies
  write(s);
  return { ok: true };
}

/** Set or clear an account's email. */
export function setEmail(username: string, email: string): { ok: boolean; error?: string } {
  const mail = (email ?? '').trim();
  if (mail && !isValidEmail(mail)) return { ok: false, error: 'Enter a valid email address.' };
  if (mail && emailTaken(mail, username)) return { ok: false, error: 'Email is already registered.' };
  const s = read();
  const u = s.users.find(x => key(x.username) === key(username));
  if (!u) return { ok: false, error: 'Unable to update the account.' };
  u.email = mail || undefined;
  u.updatedAt = new Date().toISOString();
  write(s);
  return { ok: true };
}

const tokenHash = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

/**
 * Start a password reset for whoever matches this username or email.
 *
 * Returns the raw token ONCE, for the link being delivered; only its hash is
 * stored, so the file cannot be used to mint a reset. Returns null when
 * nothing matches — and the caller must answer identically either way, or the
 * endpoint becomes a way to find out who has an account.
 */
export function startPasswordReset(identifier: string): { username: string; token: string; expiresAt: string } | null {
  const id = (identifier ?? '').trim().toLowerCase();
  if (!id) return null;
  const s = read();
  const u = s.users.find(x => key(x.username) === id || (x.email ?? '').toLowerCase() === id);
  if (!u) return null;

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + RESET_TTL_MS).toISOString();
  // A new request replaces any earlier one: the old link stops working.
  u.reset = { tokenHash: tokenHash(token), expiresAt, createdAt: new Date().toISOString() };
  u.updatedAt = new Date().toISOString();
  write(s);
  return { username: u.username, token, expiresAt };
}

export type ResetCheck =
  | { ok: true; username: string }
  | { ok: false; reason: 'invalid' | 'expired' | 'used' };

/** Is this reset link still good? Used by the page before it shows the form,
 *  so an expired link says so instead of failing after the password is typed. */
export function checkResetToken(token: string): ResetCheck {
  const h = tokenHash(String(token ?? ''));
  const u = read().users.find(x => x.reset?.tokenHash === h);
  if (!u || !u.reset) return { ok: false, reason: 'invalid' };
  if (u.reset.usedAt) return { ok: false, reason: 'used' };
  if (Date.parse(u.reset.expiresAt) < Date.now()) return { ok: false, reason: 'expired' };
  return { ok: true, username: u.username };
}

/**
 * Spend a reset token and set the new password.
 *
 * One call does both on purpose: a token that is checked in one place and
 * consumed in another is a token that can be used twice.
 */
export function resetPasswordWithToken(token: string, newPassword: string):
  { ok: true; username: string } | { ok: false; reason: 'invalid' | 'expired' | 'used' | 'policy'; error?: string } {
  const check = checkResetToken(token);
  if (!check.ok) return { ok: false, reason: check.reason };

  const result = setPassword(check.username, newPassword);
  if (!result.ok) return { ok: false, reason: 'policy', error: result.error };

  // setPassword drops `reset` entirely, so the link cannot be replayed. Mark
  // it spent as well for the case where that ever stops being true.
  const s = read();
  const u = s.users.find(x => key(x.username) === key(check.username));
  if (u?.reset) { u.reset.usedAt = new Date().toISOString(); write(s); }
  return { ok: true, username: check.username };
}

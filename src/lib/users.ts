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
//   lastLoginAt,
//   passwordChangedAt    shown on the account page
//
// Nothing here returns a hash, a salt or a token to a caller that could put it
// in a response.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { checkPassword } from './passwordPolicy';

interface StoredHash { salt: string; hash: string; at?: string }

export interface UserRecord {
  username: string;
  /** Who the person is, as they want to be called. All optional: every
   *  account predates these fields, and none of them gate anything. */
  firstName?: string;
  lastName?: string;
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
}

interface Store { users: UserRecord[] }

const FILE = () => path.join(process.cwd(), 'data', 'users.json');
const KEYLEN = 64;
/** How many previous passwords a new one may not match. */
const HISTORY_DEPTH = 5;

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
  firstName?: string;
  lastName?: string;
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
    firstName: u.firstName,
    lastName: u.lastName,
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
  if (name.length < 1)  return { ok: false, field: 'username', error: 'Enter a username.' };
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
 * it, and bumps the session epoch so sessions opened with the old password
 * stop working. It must not be reachable without the current password — see
 * the change-password route, which checks it first.
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
  write(s);
  return { ok: true };
}

export interface ProfileEdit { firstName?: string; lastName?: string; email?: string }

/**
 * Edit the parts of an account its owner is allowed to change.
 *
 * The username is deliberately not among them: it is the name every suite,
 * run and campaign in the system is attributed to, and letting it change would
 * silently rewrite who did what. Only the fields actually sent are touched, so
 * a form that posts one of them cannot blank the other two.
 */
export function setProfile(username: string, edit: ProfileEdit): { ok: boolean; field?: 'firstName' | 'lastName' | 'email'; error?: string } {
  const clean = (v: string) => v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60);

  const s = read();
  const u = s.users.find(x => key(x.username) === key(username));
  if (!u) return { ok: false, error: 'Unable to update the account.' };

  if (edit.firstName !== undefined) u.firstName = clean(edit.firstName) || undefined;
  if (edit.lastName !== undefined)  u.lastName  = clean(edit.lastName) || undefined;

  if (edit.email !== undefined) {
    const mail = (edit.email ?? '').trim();
    if (mail && !isValidEmail(mail)) return { ok: false, field: 'email', error: 'Enter a valid email address.' };
    if (mail && emailTaken(mail, username)) return { ok: false, field: 'email', error: 'Email is already registered.' };
    u.email = mail || undefined;
  }

  u.updatedAt = new Date().toISOString();
  write(s);
  return { ok: true };
}

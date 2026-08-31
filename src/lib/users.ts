// SimQA accounts — username + password, stored in data/users.json.
//
// Passwords are NEVER stored or logged in plaintext. Each account gets its own
// random salt and the password is put through scrypt, which is deliberately
// slow and memory-hard so a stolen users.json cannot be brute-forced cheaply.
// Verification uses timingSafeEqual so a wrong password takes the same time to
// reject regardless of how much of the hash matched.
//
// Scope, stated honestly: this is lightweight sign-in for a shared lab tool on
// a trusted network. It gives every action a real, credentialed owner for
// attribution. It is not a hardened public-internet auth system — there is no
// rate limiting, MFA, password reset, or account lockout.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export interface UserRecord {
  username: string;
  /** Hex salt, unique per account. */
  salt: string;
  /** Hex scrypt hash of (password, salt). */
  hash: string;
  createdAt: string;
}

interface Store { users: UserRecord[] }

const FILE = () => path.join(process.cwd(), 'data', 'users.json');

/** scrypt cost. N=16384 is the Node default and takes ~50-100ms here — slow
 *  enough to hurt an attacker, fast enough that login feels instant. */
const KEYLEN = 64;

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

/** Usernames are matched case-insensitively so "Sruthi" and "sruthi" are the
 *  same account and can't be registered twice. */
function key(username: string): string {
  return username.trim().toLowerCase();
}

export function userExists(username: string): boolean {
  const k = key(username);
  return read().users.some((u) => key(u.username) === k);
}

export function listUsernames(): string[] {
  return read().users.map((u) => u.username);
}

export function countUsers(): number {
  return read().users.length;
}

export interface CreateResult { ok: boolean; error?: string }

/** Register a new account. Rejects duplicates and weak input; never returns
 *  or stores the raw password. */
export function createUser(username: string, password: string): CreateResult {
  const name = username.trim();
  if (name.length < 2)     return { ok: false, error: 'Username must be at least 2 characters.' };
  if (name.length > 64)    return { ok: false, error: 'Username must be 64 characters or fewer.' };
  if (password.length < 6) return { ok: false, error: 'Password must be at least 6 characters.' };
  if (password.length > 200) return { ok: false, error: 'Password is too long.' };

  const s = read();
  if (s.users.some((u) => key(u.username) === key(name))) {
    return { ok: false, error: `"${name}" is already taken. Sign in instead, or pick another name.` };
  }

  const salt = randomBytes(16).toString('hex');
  s.users.push({
    username: name,
    salt,
    hash: hashPassword(password, salt),
    createdAt: new Date().toISOString(),
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
  const expected = Buffer.from(rec.hash, 'hex');
  const actual = Buffer.from(hashPassword(password, rec.salt), 'hex');
  if (expected.length !== actual.length) return null;
  return timingSafeEqual(expected, actual) ? rec.username : null;
}

// Slowing down someone guessing passwords, without locking out the person who
// simply mistyped theirs.
//
// Counted per (account, client) pair: a wrong password from one desk must not
// lock the account for everyone else, and a script working through a list of
// usernames from one address is still throttled because the address half
// matches. After a few failures the pair is held off for a period that grows
// with each further failure, and it always expires — nothing here locks an
// account permanently, which would turn a nuisance into an outage.
//
// A success clears the record. The state lives on globalThis so a dev
// recompile or a second copy of this module cannot quietly hand an attacker a
// fresh allowance (the same reason the suite progress store lives there).
//
// Pure except for the clock, which is injectable, so node --test can drive it.

export interface ThrottleConfig {
  /** Failures allowed before any delay is imposed. */
  freeAttempts: number;
  /** First lock, doubling with each failure beyond it. */
  baseLockMs: number;
  /** However many failures pile up, a lock never exceeds this. */
  maxLockMs: number;
  /** A quiet period this long forgets the failures entirely. */
  forgetAfterMs: number;
}

export const DEFAULT_THROTTLE: ThrottleConfig = {
  freeAttempts: 5,
  baseLockMs: 30_000,        // 30s
  maxLockMs: 15 * 60_000,    // 15 minutes, never more
  forgetAfterMs: 60 * 60_000,
};

interface Entry { failures: number; lastFailAt: number; lockedUntil: number }

function store(): Map<string, Entry> {
  const g = globalThis as any;
  if (!g.__simqaLoginThrottle__) g.__simqaLoginThrottle__ = new Map<string, Entry>();
  return g.__simqaLoginThrottle__ as Map<string, Entry>;
}

/** One bucket per account-and-client. The username is lowercased so case does
 *  not hand out a fresh allowance. */
export const throttleKey = (username: string, client: string) =>
  `${(username ?? '').trim().toLowerCase()}|${client || 'unknown'}`;

/** How long this pair must wait, in ms. 0 means go ahead. */
export function retryAfterMs(key: string, now = Date.now(), cfg = DEFAULT_THROTTLE): number {
  const e = store().get(key);
  if (!e) return 0;
  if (now - e.lastFailAt > cfg.forgetAfterMs) { store().delete(key); return 0; }
  return e.lockedUntil > now ? e.lockedUntil - now : 0;
}

/** Record a failed attempt and return how long the pair is now held off. */
export function recordFailure(key: string, now = Date.now(), cfg = DEFAULT_THROTTLE): number {
  const s = store();
  const prev = s.get(key);
  const stale = prev && now - prev.lastFailAt > cfg.forgetAfterMs;
  const failures = (stale || !prev ? 0 : prev.failures) + 1;

  let lockedUntil = 0;
  if (failures > cfg.freeAttempts) {
    const over = failures - cfg.freeAttempts - 1;          // 0 on the first lock
    const wait = Math.min(cfg.baseLockMs * 2 ** over, cfg.maxLockMs);
    lockedUntil = now + wait;
  }
  s.set(key, { failures, lastFailAt: now, lockedUntil });
  return lockedUntil ? lockedUntil - now : 0;
}

/** A successful sign-in wipes the slate for that pair. */
export function recordSuccess(key: string): void {
  store().delete(key);
}

/** For the message shown to the person waiting. */
export function describeWait(ms: number): string {
  const secs = Math.ceil(ms / 1000);
  if (secs < 60) return `${secs} second${secs === 1 ? '' : 's'}`;
  const mins = Math.ceil(secs / 60);
  return `${mins} minute${mins === 1 ? '' : 's'}`;
}

/** Testing seam — drops all state. */
export function resetThrottle(): void {
  store().clear();
}

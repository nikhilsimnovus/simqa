// Polling helpers used by the end-to-end runner. Wrap setTimeout into
// abort-aware async waits, and provide a small `pollUntil` for the common
// "keep hitting the API until a predicate holds, or give up" pattern.

export interface PollOptions {
  intervalMs: number;
  timeoutMs: number;
  isCanceled?: () => boolean;
}

export interface PollResult<T> {
  ok: boolean;
  value?: T;
  elapsedMs: number;
  reason?: 'timeout' | 'canceled' | 'error';
  error?: Error;
}

/**
 * Repeatedly call `probe` until it returns a non-undefined value, or until
 * timeoutMs elapses, or until isCanceled() returns true. Always waits
 * intervalMs between probes.
 *
 * Errors thrown by `probe` are caught and counted but don't end the poll —
 * useful for "the box is starting up, give it time" semantics. After
 * three consecutive errors we surface the last one in result.error so the
 * caller can show it.
 */
export async function pollUntil<T>(
  probe: () => Promise<T | undefined>,
  opts: PollOptions,
): Promise<PollResult<T>> {
  const t0 = Date.now();
  let lastErr: Error | undefined;
  let consecutiveErrors = 0;
  while (true) {
    if (opts.isCanceled?.()) {
      return { ok: false, elapsedMs: Date.now() - t0, reason: 'canceled' };
    }
    try {
      const v = await probe();
      if (v !== undefined) return { ok: true, value: v, elapsedMs: Date.now() - t0 };
      consecutiveErrors = 0;
    } catch (e: any) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      consecutiveErrors += 1;
      if (consecutiveErrors >= 5) {
        // 5 errors in a row — bail before timeout. Probably never going to recover.
        return { ok: false, elapsedMs: Date.now() - t0, reason: 'error', error: lastErr };
      }
    }
    if (Date.now() - t0 >= opts.timeoutMs) {
      return { ok: false, elapsedMs: Date.now() - t0, reason: 'timeout', error: lastErr };
    }
    // Abort-aware sleep.
    const sleepUntil = Date.now() + opts.intervalMs;
    while (Date.now() < sleepUntil) {
      if (opts.isCanceled?.()) {
        return { ok: false, elapsedMs: Date.now() - t0, reason: 'canceled' };
      }
      await new Promise((r) => setTimeout(r, Math.min(200, sleepUntil - Date.now())));
    }
  }
}

/** Abort-aware sleep. */
export async function sleep(ms: number, isCanceled?: () => boolean): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (isCanceled?.()) return false;
    await new Promise((r) => setTimeout(r, Math.min(200, end - Date.now())));
  }
  return true;
}

// Why a box did not answer, in words.
//
// "unavailable" is true and useless. The three things it covers — the machine
// is off, the machine is up but its web service is not, and the machine
// answers but refuses SimQA's login — need three different people to do three
// different things, and the tile said the same word for all of them.
//
// Measured on 192.168.1.95, 2026-10-23: SSH answered with a banner while
// port 80 accepted the connection and closed it without a byte. The machine
// was up; the Simnovator's web service was not. The dashboard said
// "unavailable — powered off, rebooting, or unreachable", which is three
// guesses, none of them this.
//
// Node's fetch buries the cause: the Error it throws says only "fetch
// failed", and the code (ECONNRESET, ECONNREFUSED, …) is on `cause`, one or
// two levels down. Everything here is about digging that out and saying it
// plainly.
//
// Pure, imports nothing, so node --test loads it directly.

export interface ProbeFailure {
  /** One sentence an operator can act on. */
  text: string;
  /** The raw code, for anyone who wants to grep: ECONNRESET, HTTP 401, … */
  code?: string;
  /** What to do about it, when there is an obvious next step. */
  hint?: string;
}

/** The deepest `cause` chain entry that carries a code. */
function rootCode(e: unknown): string | undefined {
  let cur: any = e;
  for (let depth = 0; cur && depth < 6; depth++) {
    const code = cur.code ?? cur.errno;
    if (typeof code === 'string' && code) return code;
    cur = cur.cause;
  }
  return undefined;
}

function messageOf(e: unknown): string {
  const m = (e as any)?.message;
  return typeof m === 'string' ? m : String(e ?? '');
}

/**
 * Turn whatever a probe threw into something worth showing.
 *
 * `what` names the call that failed, for the cases where the message is the
 * only clue — it is never guessed at.
 */
export function describeProbeError(e: unknown, opts: { host?: string; timeoutMs?: number } = {}): ProbeFailure {
  const msg = messageOf(e);
  const code = rootCode(e);
  const box = opts.host ? `${opts.host}` : 'the box';

  // An HTTP answer that was not what we wanted. The client throws these with
  // the status in the message, and they mean the machine is FINE — which is
  // the opposite of what "unavailable" suggests.
  const http = /\b(\d{3})\b/.exec(/status|HTTP|login failed|unauthor/i.test(msg) ? msg : '');
  const status = http ? Number(http[1]) : undefined;
  if (status === 401 || status === 403 || /unauthor|forbidden/i.test(msg)) {
    return {
      text: `${box} answered but refused the login SimQA has for it`,
      code: `HTTP ${status ?? 401}`,
      hint: 'Check this system’s box login in System Management.',
    };
  }
  if (status && status >= 500) {
    return { text: `${box} answered with a server error (HTTP ${status})`, code: `HTTP ${status}` };
  }

  switch (code) {
    case 'ECONNRESET':
    case 'UND_ERR_SOCKET':
      return {
        text: `${box} accepted the connection and closed it without answering — the machine is up, its web service is not`,
        code: code,
        hint: 'Sign in over SSH and restart the Simnovator service.',
      };
    case 'ECONNREFUSED':
      return {
        text: `${box} refused the connection — nothing is listening on that port`,
        code,
        hint: 'The Simnovator service is stopped, or it is listening on another port.',
      };
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return { text: `no route to ${box} — it is off the network`, code };
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return { text: `${box} could not be resolved`, code };
    case 'ETIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
      return {
        text: `${box} did not answer in time — powered off, or a firewall is dropping the request`,
        code,
      };
    case 'ECONNABORTED':
    case 'EPIPE':
      return { text: `the connection to ${box} broke while it was answering`, code };
    case 'CERT_HAS_EXPIRED':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
      return { text: `${box} answered but its certificate was rejected`, code };
    default:
      break;
  }

  // Our own withTimeout, and AbortController.
  if (/timed out|timeout|AbortError/i.test(msg) || (e as any)?.name === 'AbortError' || (e as any)?.name === 'TimeoutError') {
    const secs = opts.timeoutMs ? ` within ${Math.round(opts.timeoutMs / 1000)}s` : '';
    return { text: `${box} did not answer${secs}`, code: 'timeout' };
  }

  // "fetch failed" with nothing under it: say what we know, which is that the
  // request never completed, rather than repeating a phrase that means
  // nothing to the person reading it.
  if (/fetch failed/i.test(msg)) {
    return { text: `${box} could not be reached`, code: 'fetch failed' };
  }

  return { text: msg ? `${box}: ${msg}` : `${box} could not be reached`, code };
}

/** The one-line form, for a tooltip or a log. */
export function probeErrorLine(f: ProbeFailure | undefined): string | undefined {
  if (!f) return undefined;
  return [f.text, f.code ? `(${f.code})` : '', f.hint ?? ''].filter(Boolean).join(' ');
}

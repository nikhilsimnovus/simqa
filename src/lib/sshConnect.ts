// Shared SSH connect wrapper — the one place handshake policy lives.
//
// Why this exists: the repo grew five separate `ssh.connect({...})` call
// sites with timeouts ranging from 10s to 20s, and the lab boxes routinely
// exceed the short ones on a COLD handshake (observed: ~20s on first contact
// while the very next attempt completes in ~3s — the signature of sshd doing
// a reverse-DNS lookup that has to time out before auth proceeds). The
// result was flaky, path-dependent failures: /api/backup/gnb timing out
// against the same box that /api/automation/callbox-configs had just
// listed files on.
//
// Policy: a generous 30s handshake budget, and one retry on a handshake
// timeout — the retry is cheap precisely because the box's resolver cache
// is warm by then. Auth/config building stays with the callers; only the
// connect step is centralized.

import { NodeSSH } from 'node-ssh';
import type { Config } from 'node-ssh';

const HANDSHAKE_TIMEOUT_MS = 30_000;

function isHandshakeTimeout(e: unknown): boolean {
  const msg = String((e as any)?.message ?? e ?? '');
  return /timed out|timeout/i.test(msg) && /handshake/i.test(msg);
}

/**
 * Connect `ssh` with the shared handshake policy. Callers pass their fully
 * built config; `readyTimeout` is defaulted (not overridden) so a caller
 * with a genuinely different need can still say so explicitly.
 */
export async function connectSsh(ssh: NodeSSH, config: Config): Promise<NodeSSH> {
  const cfg: Config = { readyTimeout: HANDSHAKE_TIMEOUT_MS, ...config };
  try {
    return await ssh.connect(cfg);
  } catch (e) {
    if (!isHandshakeTimeout(e)) throw e;
    // Cold-handshake stall — retry once now that the box has warmed up.
    return await ssh.connect(cfg);
  }
}

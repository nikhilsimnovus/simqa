// Per-system backup status and the 30-minute retry window.
//
// There is deliberately no retry loop anywhere in this feature. The scheduler
// already runs every five minutes, so each cycle IS the retry — a separate
// timer would mean two things racing to talk to the same box, and a system that
// is down for an hour would accumulate a backlog of pending retries.
//
// What this module owns instead is the WINDOW: how long a system has been
// failing, and therefore whether it is still worth calling "retrying" or should
// now be reported to the user as failed.
//
// IMPORTS: node builtins only — see the note in store.ts. Times are passed in
// rather than read from the clock so the tests can walk the window without
// waiting thirty real minutes.

import * as fs from 'node:fs';
import * as path from 'node:path';

export type SystemBackupState = 'ok' | 'retrying' | 'failed' | 'never-run';

/** How long a system may keep failing before it is reported as failed. */
export const RETRY_WINDOW_MS = 30 * 60 * 1000;

export interface SystemStatus {
  ip: string;
  systemId?: string;
  /** UESIM / CALLBOX / SIMNOVATOR — carried so a failure message can name the
   *  kind of box, not just its address. */
  systemType?: string;
  state: SystemBackupState;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  /** When the current run of failures started. Cleared by any success, so the
   *  window measures CONSECUTIVE failure, not failures ever. */
  firstFailedAt?: string;
  /** Last failure reason, already scrubbed of anything credential-shaped. */
  lastError?: string;
  /** Non-fatal observations from the last cycle — a directory this box does
   *  not have, a file over the size cap. Not failures. */
  notes?: string[];
  /** Counts from the last successful cycle, for the UI. */
  added?: number;
  updated?: number;
  unchanged?: number;
}

export interface BackupStatusFile {
  lastCycleStartedAt?: string;
  lastCycleFinishedAt?: string;
  lastCycleMs?: number;
  systems: Record<string, SystemStatus>;
}

function statusPath(): string {
  const root = process.env.SIMQA_BACKUP_ROOT || path.join(process.cwd(), 'data', 'backups');
  return path.join(root, '_status.json');
}

export function readStatus(): BackupStatusFile {
  try {
    const s = JSON.parse(fs.readFileSync(statusPath(), 'utf8')) as BackupStatusFile;
    if (!s.systems) s.systems = {};
    return s;
  } catch {
    return { systems: {} };
  }
}

export function writeStatus(s: BackupStatusFile): void {
  const p = statusPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, p);
}

/**
 * Strip anything credential-shaped out of an error before it is stored.
 *
 * Failure reasons end up in _status.json, in the API response and on screen. An
 * ssh2 error can quote a key block or a command line, and none of that may
 * leak. Better to over-redact a message than to persist a private key.
 */
export function scrubError(raw: unknown): string {
  let s = raw instanceof Error ? (raw.message || String(raw)) : String(raw ?? '');
  s = s.replace(/-----BEGIN[\s\S]*?-----END[^-]*-----/g, '[private key redacted]');
  s = s.replace(/(password|passphrase|token|secret|authorization)\s*[:=]\s*\S+/gi, '$1: [redacted]');
  s = s.replace(/\s+/g, ' ').trim();
  return s.slice(0, 300);
}

/** Record a successful backup: clears the failure window entirely, so the next
 *  failure starts a fresh 30 minutes rather than inheriting an old one. */
export function markSuccess(
  st: BackupStatusFile,
  ip: string,
  info: { systemId?: string; systemType?: string; added: number; updated: number; unchanged: number; now?: string },
): SystemStatus {
  const now = info.now ?? new Date().toISOString();
  const cur = st.systems[ip] ?? { ip, state: 'never-run' as SystemBackupState };
  const next: SystemStatus = {
    ...cur,
    ip,
    systemId: info.systemId ?? cur.systemId,
    systemType: info.systemType ?? cur.systemType,
    state: 'ok',
    lastAttemptAt: now,
    lastSuccessAt: now,
    firstFailedAt: undefined,
    lastError: undefined,
    added: info.added,
    updated: info.updated,
    unchanged: info.unchanged,
  };
  st.systems[ip] = next;
  return next;
}

/**
 * Record a failed backup.
 *
 * Stays 'retrying' until the system has been failing for RETRY_WINDOW_MS, then
 * flips to 'failed'. The distinction is the whole point: a box rebooting should
 * not raise an alarm, a box that has been unreachable for half an hour should.
 */
export function markFailure(
  st: BackupStatusFile,
  ip: string,
  info: { systemId?: string; systemType?: string; error: unknown; now?: string },
): SystemStatus {
  const now = info.now ?? new Date().toISOString();
  const cur = st.systems[ip] ?? { ip, state: 'never-run' as SystemBackupState };
  const firstFailedAt = cur.firstFailedAt ?? now;
  const failingForMs = Date.parse(now) - Date.parse(firstFailedAt);
  const next: SystemStatus = {
    ...cur,
    ip,
    systemId: info.systemId ?? cur.systemId,
    systemType: info.systemType ?? cur.systemType,
    state: failingForMs >= RETRY_WINDOW_MS ? 'failed' : 'retrying',
    lastAttemptAt: now,
    firstFailedAt,
    lastError: scrubError(info.error),
  };
  st.systems[ip] = next;
  return next;
}

/** How long a system has been failing, in ms. 0 when it is not failing. */
export function failingForMs(s: SystemStatus, now = new Date().toISOString()): number {
  if (!s.firstFailedAt) return 0;
  return Math.max(0, Date.parse(now) - Date.parse(s.firstFailedAt));
}

/**
 * The message shown to the user for a system that has exhausted its window.
 *
 * Names the setup type and IP because that is what identifies a box in the lab
 * — "backup failed" on its own tells an operator nothing about where to go.
 */
export function failureMessage(s: SystemStatus, now = new Date().toISOString()): string {
  const mins = Math.round(failingForMs(s, now) / 60000);
  const type = s.systemType ?? 'System';
  return `Backup failed — ${type} at ${s.ip} has not been reachable for ${mins} minutes.`
    + (s.lastError ? ` Reason: ${s.lastError}` : '');
}

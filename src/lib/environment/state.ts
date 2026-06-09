// In-process state for the running auto-create job (single process).
// Mirrors the bulk-tests state pattern: one job at a time, polled via
// /api/environments/autocreate-status.
//
// We ALSO persist the finished result + last progress to disk. In Next.js
// dev mode the route handlers can land in separate module instances, so
// the in-memory singleton isn't always shared between the autocreate
// route and the status route. The disk snapshot lets the status endpoint
// fall back to the on-disk copy. (Production `npm start` shares one
// process so the in-memory path is used; the disk copy is harmless.)

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AutoCreateProgress, AutoCreateResult } from './runGenerator';

export interface AutoCreateState {
  progress?: AutoCreateProgress;
  result?: AutoCreateResult;
  abort?: AbortController;
  environmentId?: string;
}

const STATE: { autocreate: AutoCreateState } = { autocreate: {} };

const SNAP_FILE = () => path.join(process.cwd(), 'data', 'environment-autocreate-state.json');

function snapshot(): void {
  try {
    fs.mkdirSync(path.dirname(SNAP_FILE()), { recursive: true });
    // Don't serialize the AbortController.
    const { progress, result, environmentId } = STATE.autocreate;
    fs.writeFileSync(SNAP_FILE(), JSON.stringify({ progress, result, environmentId }));
  } catch { /* best effort */ }
}

function readSnapshot(): AutoCreateState | null {
  try {
    return JSON.parse(fs.readFileSync(SNAP_FILE(), 'utf8'));
  } catch { return null; }
}

export function getAutoCreateState(): AutoCreateState {
  // If the in-memory state is empty (dev module isolation), fall back to
  // the disk snapshot so the status endpoint still reports progress.
  if (!STATE.autocreate.progress && !STATE.autocreate.result) {
    const snap = readSnapshot();
    if (snap) return snap;
  }
  return STATE.autocreate;
}

export function setAutoCreateState(s: AutoCreateState): void {
  STATE.autocreate = s;
  snapshot();
}

/** Call after mutating progress/result so the disk snapshot stays fresh. */
export function persistAutoCreateState(): void {
  snapshot();
}

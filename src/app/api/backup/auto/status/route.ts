// GET /api/backup/auto/status
//
// Per-system state of the automatic backup, plus the health of the scheduler
// itself. This is also where the scheduler gets STARTED: it cannot be launched
// from instrumentation.ts (middleware forces an Edge bundle that cannot resolve
// node:fs — see the long note in src/lib/backup/scheduler.ts), so the first
// request to touch this route after a server restart is what gets backups
// running again.

import { NextResponse } from 'next/server';
import { loadInventory } from '@/lib/inventory';
import { readStatus, failingForMs, failureMessage, RETRY_WINDOW_MS, type SystemStatus } from '@/lib/backup/status';
import { ensureBackupScheduler, schedulerStatus } from '@/lib/backup/scheduler';
import { backupTargets } from '@/lib/backup/collectors';
import { countByCategory } from '@/lib/backup/store';

export const dynamic = 'force-dynamic';

export async function GET() {
  ensureBackupScheduler();

  const inv = loadInventory();
  const targets = backupTargets(inv);
  const st = readStatus();
  const now = new Date().toISOString();

  const systems = targets.map((t) => {
    const s: SystemStatus | undefined = st.systems[t.ip];
    const state = s?.state ?? 'never-run';
    const held = countByCategory(t.ip);
    return {
      ip: t.ip,
      name: t.sys.name,
      systemType: t.systemType,
      kinds: t.kinds,
      state,
      lastAttemptAt: s?.lastAttemptAt,
      lastSuccessAt: s?.lastSuccessAt,
      added: s?.added, updated: s?.updated, unchanged: s?.unchanged,
      notes: s?.notes ?? [],
      // Credentials never reach here: lastError has already been through
      // scrubError() before it was written to _status.json.
      reason: state === 'failed' && s ? failureMessage(s, now) : s?.lastError,
      failingForMin: s ? Math.round(failingForMs(s, now) / 60000) : 0,
      files: held,
    };
  });

  return NextResponse.json({
    ok: true,
    scheduler: schedulerStatus(),
    retryWindowMin: RETRY_WINDOW_MS / 60000,
    lastCycleStartedAt: st.lastCycleStartedAt,
    lastCycleFinishedAt: st.lastCycleFinishedAt,
    lastCycleMs: st.lastCycleMs,
    systems,
  });
}

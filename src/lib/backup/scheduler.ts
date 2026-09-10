// The 5-minute backup cycle.
//
// Structure is copied from stationMonitor.ts on purpose — same globalThis
// singleton, same in-flight guard, same lazy start — because those three
// properties were each learned from a bug there, and this job has exactly the
// same failure modes with a heavier per-tick cost.
//
// SAFETY: this runs inside the Next server process, so it must never be able to
// wedge it. Cycles never overlap, at most four boxes are visited at once, and
// every system is wrapped so one unreachable machine can only affect its own
// status — not the cycle, and not the other systems.

import {
  loadInventory, type Inventory,
} from '../inventory';
import { readManifest, writeManifest } from './store';
import { readStatus, writeStatus, markSuccess, markFailure } from './status';
import { backupTargets, collectTarget, type BackupTarget } from './collectors';

/** Minutes between cycles. The spec asks for 5; SIMQA_BACKUP_INTERVAL_MIN is
 *  there for a lab that wants it slower, not for tuning it below 1. */
const INTERVAL_MIN = Math.max(1, Number(process.env.SIMQA_BACKUP_INTERVAL_MIN) || 5);

/** Boxes visited at once. Four keeps a slow or dead machine from holding up the
 *  rest without opening an SSH session to the whole lab simultaneously. */
const CONCURRENCY = 4;

export interface CycleSummary {
  startedAt: string;
  finishedAt: string;
  ms: number;
  systems: number;
  ok: number;
  failed: number;
  added: number;
  updated: number;
  unchanged: number;
}

interface SchedulerState {
  timer: ReturnType<typeof setInterval> | null;
  /** The cycle in progress, if any. A caller wanting a run now joins this
   *  instead of starting a competing one — two cycles against the same box
   *  would interleave their manifest writes and lose one set of updates. */
  inFlight: Promise<CycleSummary> | null;
  lastCycle: CycleSummary | null;
}

/**
 * State lives on globalThis, NOT in module scope.
 *
 * Next re-evaluates a module on every hot reload with no dispose hook, so a
 * module-scoped guard is fresh in each new instance and every edit in this
 * import graph would leave another timer running. That exact bug produced
 * overlapping station polls once already; here it would mean several cycles
 * SSH-ing into the same lab boxes at once.
 */
const GLOBAL_KEY = '__simqaBackupScheduler__';

function state(): SchedulerState {
  const g = globalThis as any;
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = { timer: null, inFlight: null, lastCycle: null } as SchedulerState;
  return g[GLOBAL_KEY] as SchedulerState;
}

/** Run `worker` over `items`, at most `limit` at a time. */
async function pool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await worker(items[i]);
    }
  });
  await Promise.all(runners);
}

/** Back up one target and record its outcome. Never throws: a failure here is a
 *  status entry, not an interruption of the cycle. */
async function backupOne(t: BackupTarget, inv: Inventory, now: string): Promise<{ ok: boolean; added: number; updated: number; unchanged: number }> {
  const manifest = readManifest(t.ip);
  manifest.systemId = t.systemIds.join(',');
  manifest.systemType = t.systemType;

  try {
    const r = await collectTarget(t, inv, manifest, now);
    // Written even when nothing changed: lastSeen advanced for every file the
    // box still has, and that is what tells the UI which stored files have
    // since disappeared from the source.
    writeManifest(manifest);

    const st = readStatus();
    markSuccess(st, t.ip, {
      systemId: t.systemIds.join(','), systemType: t.systemType,
      added: r.added, updated: r.updated, unchanged: r.unchanged, now,
    });
    st.systems[t.ip].notes = r.notes.slice(0, 5);
    writeStatus(st);
    return { ok: true, added: r.added, updated: r.updated, unchanged: r.unchanged };
  } catch (e) {
    // Whatever we did manage to store before the failure is kept — a box that
    // dies halfway through should not cost us the files we already read.
    try { writeManifest(manifest); } catch { /* the status entry below is what matters */ }
    const st = readStatus();
    markFailure(st, t.ip, { systemId: t.systemIds.join(','), systemType: t.systemType, error: e, now });
    writeStatus(st);
    return { ok: false, added: 0, updated: 0, unchanged: 0 };
  }
}

/** One full pass over every system. Exported so a route can run it directly. */
export async function runCycle(): Promise<CycleSummary> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const inv = loadInventory();
  const targets = backupTargets(inv);

  const st0 = readStatus();
  st0.lastCycleStartedAt = startedAt;
  writeStatus(st0);

  let ok = 0, failed = 0, added = 0, updated = 0, unchanged = 0;
  await pool(targets, CONCURRENCY, async (t) => {
    const r = await backupOne(t, inv, startedAt);
    if (r.ok) ok += 1; else failed += 1;
    added += r.added; updated += r.updated; unchanged += r.unchanged;
  });

  const summary: CycleSummary = {
    startedAt,
    finishedAt: new Date().toISOString(),
    ms: Date.now() - t0,
    systems: targets.length,
    ok, failed, added, updated, unchanged,
  };

  const st = readStatus();
  st.lastCycleStartedAt = summary.startedAt;
  st.lastCycleFinishedAt = summary.finishedAt;
  st.lastCycleMs = summary.ms;
  writeStatus(st);

  state().lastCycle = summary;
  return summary;
}

/**
 * One cycle, at most one at a time.
 *
 * A caller arriving mid-cycle gets the running one rather than a second pass.
 * This is what "Back up now" joins, and it is also the retry: there is no
 * separate retry timer anywhere in this feature, because a system that has been
 * failing for 20 minutes has already been retried four times by this loop.
 */
export function tick(): Promise<CycleSummary> {
  const s = state();
  if (s.inFlight) return s.inFlight;
  s.inFlight = runCycle()
    .catch((e: any) => {
      // A throw here is a bug in the cycle itself, not a box failing — per-system
      // errors are handled in backupOne. Record it and let the next tick try.
      const failedAt = new Date().toISOString();
      console.error('[backup] cycle failed:', e?.message ?? e);
      return {
        startedAt: failedAt, finishedAt: failedAt, ms: 0,
        systems: 0, ok: 0, failed: 0, added: 0, updated: 0, unchanged: 0,
      } as CycleSummary;
    })
    .finally(() => { s.inFlight = null; });
  return s.inFlight;
}

/**
 * Start the scheduler. Idempotent.
 *
 * WHY NOT instrumentation.ts, which is where a startup hook belongs: middleware
 * forces Next to produce an Edge bundle and it compiles instrumentation.ts for
 * both runtimes. Edge cannot resolve node builtins, and webpack traces through
 * an `await import()` even behind a `NEXT_RUNTIME === 'nodejs'` guard, so the
 * Edge build fails on `fs` and takes the whole app down. stationMonitor.ts
 * documents the same finding at length.
 *
 * The cost is a gap: nothing is backed up between a server restart and the first
 * request. That is visible rather than hidden — lastCycleFinishedAt simply stops
 * advancing, and the status card shows it.
 */
export function startBackupScheduler(): void {
  const s = state();
  if (s.timer) return;
  s.timer = setInterval(tick, INTERVAL_MIN * 60_000);
  // A backup job must not be the reason the process refuses to exit.
  (s.timer as any).unref?.();

  // First pass shortly after boot, not immediately: let the server finish
  // starting before adding SSH sessions to the whole lab on top of it.
  const kick = setTimeout(tick, 10_000);
  (kick as any).unref?.();

  console.log(`[backup] automatic backup every ${INTERVAL_MIN} min`);
}

export function stopBackupScheduler(): void {
  const s = state();
  if (s.timer) { clearInterval(s.timer); s.timer = null; }
}

/** Make sure the scheduler is running. Cheap to call from any route — after the
 *  first call it is a boolean check. */
export function ensureBackupScheduler(): void {
  if (process.env.SIMQA_DISABLE_BACKUP === '1') return;
  startBackupScheduler();
}

/** Health of the scheduler itself, for the API to report. */
export function schedulerStatus(): { running: boolean; intervalMin: number; busy: boolean; lastCycle: CycleSummary | null } {
  const s = state();
  return { running: !!s.timer, intervalMin: INTERVAL_MIN, busy: !!s.inFlight, lastCycle: s.lastCycle };
}

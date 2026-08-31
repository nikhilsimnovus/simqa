// Playlist execution for a submitted job.
//
// Runs the playlist's testcases on the selected Simnovator, one at a time
// (the box enforces a system-wide execution mutex anyway), recording a verdict
// and a log line for each. Everything it learns goes into the job record so the
// history table and the log view can be rebuilt from disk after a restart.
//
// Deliberately narrower than lib/automation/runner.ts: that one also generates
// and pushes cfgs and manages symlinks. A job runs testcases that already exist
// on the box against the build this job just installed, so it only needs
// resolve → trigger → poll → record.

import { loadInventory } from '../inventory';
import { listTestcases, getTestcase, listSimulators, startExecution, type ApiOpts } from '../uesimClient';
import { getSetup } from './setups';
import { getPlaylist } from './playlists';
import { appendLog, getJob, saveJob, updateJob } from './store';
import type { Job, TestcaseResult } from './types';

/** Per-testcase ceiling. A long-hour case can legitimately run for a while, so
 *  this is generous; override with SIMQA_JOB_TESTCASE_MAX_SEC. */
const TESTCASE_MAX_SEC = Math.max(60, Number(process.env.SIMQA_JOB_TESTCASE_MAX_SEC) || 1800);
/** How long to wait for the box to go idle before triggering. */
const IDLE_WAIT_SEC = 300;
const POLL_MS = 3_000;

const TERMINAL = new Set(['COMPLETED', 'STOPPED', 'ABORTED', 'ERROR', 'FAILED', 'INCOMPLETE']);

function log(key: string, level: 'info' | 'stdout' | 'error' | 'step', line: string): void {
  appendLog(key, { phase: 'execution', level, line });
}

/**
 * Every testcase on the box, by name.
 *
 * NOTE the paging contract: the box's `offset` parameter is a PAGE INDEX, not a
 * row offset. Advancing it by the number of rows returned asks for page 201 and
 * gets a 400.
 */
async function testcasesByName(opts: ApiOpts): Promise<Map<string, string>> {
  const byName = new Map<string, string>();
  const PAGE = 1000;
  for (let pageIndex = 0; pageIndex < 50; pageIndex++) {
    const page = await listTestcases(opts, PAGE, pageIndex);
    const items = page.items ?? [];
    if (items.length === 0) break;
    for (const t of items) if (t?.name && !byName.has(t.name)) byName.set(t.name, t.id);
    if (items.length < PAGE) break;
    if (typeof page.total === 'number' && (pageIndex + 1) * PAGE >= page.total) break;
  }
  return byName;
}

/**
 * The simulator to run on.
 *
 * TWO things matter here and both were wrong before:
 *
 *  1. The trigger MUST carry a simulatorId. POST /v2/testcases/{id}/executions
 *     rejects with 500 "No default simulator found" without one (a box-side
 *     regression around 4.0.0_260605). Triggering with an empty body meant
 *     every testcase in a playlist failed instantly.
 *
 *  2. It must be an AVAILABLE simulator, not simply the first one. On .95 the
 *     first entry is "QA-Setup", which reports UNAVAILABLE and will not take
 *     work; the usable one is second in the list.
 */
async function pickSimulator(opts: ApiOpts): Promise<{ id: string; name?: string } | null> {
  try {
    const sims = (await listSimulators(opts)).items ?? [];
    const usable = sims.find((s: any) => String(s?.availability ?? '').toUpperCase() === 'AVAILABLE');
    const busy = sims.find((s: any) => String(s?.availability ?? '').toUpperCase() === 'BUSY');
    const chosen = usable ?? busy;   // BUSY is fine — we wait for idle separately
    return chosen ? { id: String(chosen.id), name: chosen.name } : null;
  } catch {
    return null;
  }
}

/** Wait until no simulator reports BUSY. Returns the blocker's name if it never
 *  went idle, so the log can say what we were waiting for. */
async function waitForIdle(opts: ApiOpts, maxSec: number): Promise<string | null> {
  const deadline = Date.now() + maxSec * 1000;
  let blocker: string | null = null;
  while (Date.now() < deadline) {
    try {
      const sims = await listSimulators(opts);
      const busy = (sims.items ?? []).find((s: any) => String(s?.availability ?? '').toUpperCase() === 'BUSY');
      if (!busy) return null;
      blocker = busy.name ?? busy.id ?? 'a simulator';
    } catch {
      // Box unreachable mid-wait: report it rather than spinning silently.
      return 'the box stopped responding';
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return blocker;
}

interface ExecState { status?: string; result?: string; executionId?: string; durationSeconds?: number }

async function lastExecution(opts: ApiOpts, tcId: string): Promise<ExecState | null> {
  try {
    const tc: any = await getTestcase(opts, tcId);
    const le = tc?.metadata?.lastExecution;
    if (!le) return null;
    return {
      status: le.status, result: le.result,
      executionId: le.executionId, durationSeconds: le.durationSeconds,
    };
  } catch { return null; }
}

/** Poll until the box reports a terminal status for OUR execution. */
async function pollToTerminal(
  opts: ApiOpts, tcId: string, ourExecId: string | undefined, maxSec: number,
): Promise<ExecState | null> {
  const deadline = Date.now() + maxSec * 1000;
  let last: ExecState | null = null;
  while (Date.now() < deadline) {
    const s = await lastExecution(opts, tcId);
    if (s) {
      last = s;
      // Only trust a terminal status once the box's lastExecution is the one we
      // triggered — otherwise the PREVIOUS run's verdict looks like ours.
      const ours = !ourExecId || s.executionId === ourExecId;
      if (ours && s.status && TERMINAL.has(String(s.status).toUpperCase())) return s;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return last;
}

/**
 * Execute a job's playlist. Long-running: callers start it without awaiting and
 * let the job record carry progress.
 */
export async function executeJob(key: string): Promise<void> {
  const job = getJob(key);
  if (!job) return;

  const inv = loadInventory();
  const setup = getSetup(job.setupHost, inv);
  const playlist = job.playlistId ? getPlaylist(job.playlistId) : undefined;

  const fail = (why: string) => {
    log(key, 'error', why);
    updateJob(key, (j) => {
      j.status = 'failed';
      j.steps.execution = { ...j.steps.execution, status: 'failed', finishedAt: new Date().toISOString(), detail: why };
      j.finishedAt = new Date().toISOString();
    });
  };

  if (!setup) return fail(`Setup ${job.setupHost} is no longer in inventory.`);
  if (!playlist) return fail(`Playlist "${job.playlistId}" no longer exists.`);

  // The inventory record (credentials); distinct from the box's simulator,
  // which is picked below.
  const sys = inv.systems.find((s) => s.id === setup.systemId);
  const opts: ApiOpts = {
    host: setup.host,
    username: sys?.uesim?.username ?? sys?.username ?? 'admin',
    password: sys?.uesim?.password ?? sys?.password ?? 'admin',
  };

  const startedAt = new Date().toISOString();
  updateJob(key, (j) => {
    j.status = 'in_progress';
    j.startedAt = startedAt;
    j.steps.execution = { status: 'running', startedAt };
    j.testcases = playlist.testcases.map((name): TestcaseResult => ({ name, status: 'queued' }));
  });
  log(key, 'step', `Executing playlist "${playlist.name}" (${playlist.testcases.length} testcases) on ${setup.host}`);

  // ── Resolve names → ids once ──────────────────────────────────────────
  let byName: Map<string, string>;
  try {
    byName = await testcasesByName(opts);
    log(key, 'info', `Box has ${byName.size} testcases.`);
  } catch (e: any) {
    return fail(`Could not list testcases on ${setup.host}: ${e?.message ?? e}`);
  }

  // ── Pick the simulator every trigger will be pinned to ────────────────
  const sim = await pickSimulator(opts);
  if (!sim) {
    return fail(
      `No usable simulator on ${setup.host}. Every trigger needs a simulatorId — without one the box rejects the execution with "No default simulator found".`,
    );
  }
  log(key, 'info', `Using simulator ${sim.id}${sim.name ? ` (${sim.name})` : ''} for every trigger.`);

  const setTc = (i: number, patch: Partial<TestcaseResult>) => {
    updateJob(key, (j) => { j.testcases[i] = { ...j.testcases[i], ...patch }; });
  };

  let passed = 0, failed = 0, skipped = 0;

  for (let i = 0; i < playlist.testcases.length; i++) {
    const name = playlist.testcases[i];
    const tcId = byName.get(name);

    if (!tcId) {
      // Not a silent skip: the playlist named something this box does not have,
      // which means the job did not do what it said it would.
      skipped++;
      setTc(i, { status: 'skipped', detail: `No testcase named "${name}" on ${setup.host}.`, finishedAt: new Date().toISOString() });
      log(key, 'error', `[${i + 1}/${playlist.testcases.length}] ${name} — SKIPPED: not present on this box.`);
      continue;
    }

    log(key, 'step', `[${i + 1}/${playlist.testcases.length}] ${name} — waiting for an execution slot…`);
    const blocker = await waitForIdle(opts, IDLE_WAIT_SEC);
    if (blocker) {
      failed++;
      setTc(i, { status: 'failed', detail: `Box never went idle — ${blocker} still running.`, finishedAt: new Date().toISOString() });
      log(key, 'error', `[${i + 1}/${playlist.testcases.length}] ${name} — FAILED: box busy for ${IDLE_WAIT_SEC}s (${blocker}).`);
      continue;
    }

    const tcStart = new Date().toISOString();
    setTc(i, { status: 'running', startedAt: tcStart });
    log(key, 'info', `[${i + 1}/${playlist.testcases.length}] ${name} — triggering…`);

    let ourExecId: string | undefined;
    try {
      // simulatorId is required — see pickSimulator.
      const started: any = await startExecution(opts, tcId, { simulatorId: sim.id });
      ourExecId = started?.executionId ?? started?.id;
      log(key, 'info', `  triggered on simulator ${sim.id}${ourExecId ? ` (execution ${ourExecId})` : ''}`);
    } catch (e: any) {
      failed++;
      setTc(i, { status: 'failed', detail: `Trigger rejected: ${e?.message ?? e}`, finishedAt: new Date().toISOString() });
      log(key, 'error', `[${i + 1}/${playlist.testcases.length}] ${name} — FAILED to trigger: ${e?.message ?? e}`);
      continue;
    }

    const final = await pollToTerminal(opts, tcId, ourExecId, TESTCASE_MAX_SEC);
    const verdict = String(final?.result ?? '').toUpperCase();
    const status = String(final?.status ?? '').toUpperCase();
    const finishedAt = new Date().toISOString();

    if (!final) {
      failed++;
      setTc(i, { status: 'failed', detail: `No result within ${TESTCASE_MAX_SEC}s.`, finishedAt, executionId: ourExecId });
      log(key, 'error', `[${i + 1}/${playlist.testcases.length}] ${name} — FAILED: no terminal state within ${TESTCASE_MAX_SEC}s.`);
    } else if (verdict === 'PASS') {
      passed++;
      setTc(i, { status: 'passed', detail: `${status}${final.durationSeconds ? ` · ${final.durationSeconds}s` : ''}`, finishedAt, executionId: final.executionId });
      log(key, 'info', `[${i + 1}/${playlist.testcases.length}] ${name} — PASSED (${status}).`);
    } else {
      failed++;
      const detail = `${status || 'no status'}${verdict ? ` / ${verdict}` : ''}`;
      setTc(i, { status: 'failed', detail, finishedAt, executionId: final.executionId });
      log(key, 'error', `[${i + 1}/${playlist.testcases.length}] ${name} — FAILED (${detail}).`);
    }
  }

  const allPassed = failed === 0 && skipped === 0 && passed > 0;
  const summary = `${passed} passed, ${failed} failed, ${skipped} skipped.`;
  log(key, 'step', `Playlist finished — ${summary}`);
  if (skipped > 0 && failed === 0) {
    log(key, 'error', 'Marked failed because part of the playlist never ran — a job that skipped work did not verify the build.');
  }

  updateJob(key, (j) => {
    j.status = allPassed ? 'passed' : 'failed';
    j.finishedAt = new Date().toISOString();
    j.steps.execution = {
      ...j.steps.execution,
      status: allPassed ? 'ok' : 'failed',
      finishedAt: j.finishedAt,
      detail: summary,
    };
  });
}

/** Fire-and-forget wrapper — never lets a rejection escape into the request. */
export function startJobExecution(key: string): void {
  executeJob(key).catch((e: any) => {
    log(key, 'error', `Execution crashed: ${e?.message ?? e}`);
    const j: Job | undefined = getJob(key);
    if (j) {
      j.status = 'failed';
      j.finishedAt = new Date().toISOString();
      j.steps.execution = { ...j.steps.execution, status: 'failed', detail: String(e?.message ?? e) };
      saveJob(j);
    }
  });
}

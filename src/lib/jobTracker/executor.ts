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

import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadInventory, type Inventory } from '../inventory';
import { runBuildInstall, buildInstallCommand, type InstallEvent, type BuildInstallRequest } from '../buildInstaller';
import { listTestcases, getTestcase, listSimulators, startExecution, type ApiOpts } from '../uesimClient';
import { getSetup, installHostsFor, resolveInstallTarget, type JobSetup } from './setups';
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
/**
 * Install the build a submitted job is carrying, on the server.
 *
 * The wizard records WHICH build to install and stops there — the install used
 * to run in the browser, so closing the tab abandoned a live lab install. It
 * runs here instead, as the job's first phase, and streams into the job log so
 * the detail page shows it whether or not anyone is watching.
 *
 * Accepts both shapes the Build step can produce: an http(s) URL to wget, or an
 * absolute path to a build already staged on the station (Browse lists those),
 * which skips the fetch entirely.
 *
 * Returns false when the install failed — the job has already been marked
 * build_failed by then, and execution must not continue against a build that
 * never landed.
 */
async function installPendingBuild(
  key: string,
  buildUrl: string | undefined,
  setup: JobSetup,
  inv: Inventory,
): Promise<boolean> {
  const ref = (buildUrl ?? '').trim();
  if (!ref) {
    log(key, 'error', 'Build install was queued but no build was recorded.');
    updateJob(key, (j) => {
      j.status = 'build_failed';
      j.steps.build = { ...j.steps.build, status: 'failed', finishedAt: new Date().toISOString(), detail: 'no build recorded' };
      j.finishedAt = new Date().toISOString();
    });
    return false;
  }

  const resolved = resolveInstallTarget(inv, setup.host);
  if ('error' in resolved) {
    log(key, 'error', resolved.error);
    updateJob(key, (j) => {
      j.status = 'build_failed';
      j.steps.build = { ...j.steps.build, status: 'failed', finishedAt: new Date().toISOString(), detail: resolved.error };
      j.finishedAt = new Date().toISOString();
    });
    return false;
  }
  // A shallow copy with just this system retyped, so a SIMNOVATOR_GUI entry can
  // install against itself. The file on disk is untouched — we do not rewrite
  // the user's configuration to satisfy a type check.
  const installInv = resolved.retype
    ? { ...inv, systems: inv.systems.map((s) => (s.id === resolved.systemId ? { ...s, type: 'SIMNOVATOR' as const } : s)) }
    : inv;

  // An absolute path means the build is already on the station: hand it to the
  // installer as localFile so it skips preflight + wget.
  const isStaged = ref.startsWith('/');
  const req: BuildInstallRequest = {
    systemId: resolved.systemId,
    ...(isStaged ? { localFile: ref } : { buildUrl: ref }),
    hosts: installHostsFor(setup),
  };
  const installCommand = buildInstallCommand(req);
  const buildId = `${key}-${Date.now().toString(36)}`;
  const buildDir = path.join(process.cwd(), 'data', 'builds', buildId);
  fs.mkdirSync(buildDir, { recursive: true });

  const startedAt = new Date().toISOString();
  updateJob(key, (j) => {
    j.status = 'build_installing';
    j.steps.build = { status: 'running', startedAt };
    j.build.buildId = buildId;
    j.build.installCommand = installCommand;
  });
  log(key, 'step', `Build install started on ${setup.host}`);
  log(key, 'info', isStaged ? `Build already on the station: ${ref}` : `Build URL: ${ref}`);
  log(key, 'info', `Install command: ${installCommand}`);

  let ok = false;
  try {
    const r = await runBuildInstall({
      inv: installInv,
      req,
      buildDir,
      emit: (e: InstallEvent) => {
        if (e.type === 'log') {
          appendLog(key, {
            phase: 'build',
            level: e.stream === 'error' || e.stream === 'stderr' ? 'error' : e.stream === 'info' ? 'info' : 'stdout',
            line: e.line, ts: e.ts,
          });
        } else if (e.type === 'step') {
          appendLog(key, { phase: 'build', level: 'step', ts: e.ts, line: `${e.step.toUpperCase()} ${e.status}${e.detail ? ` :: ${e.detail}` : ''}` });
        }
      },
    });
    ok = r.ok;
  } catch (e: any) {
    log(key, 'error', `Build install threw: ${e?.message ?? e}`);
    ok = false;
  }

  const finishedAt = new Date().toISOString();
  updateJob(key, (j) => {
    j.build.installPending = false;          // attempted either way
    if (ok) {
      j.build.installedAt = finishedAt;
      j.steps.build = { ...j.steps.build, status: 'ok', finishedAt, detail: 'Build installed' };
    } else {
      j.status = 'build_failed';
      j.steps.build = { ...j.steps.build, status: 'failed', finishedAt, detail: 'Build install failed' };
      j.finishedAt = finishedAt;
    }
  });
  log(key, 'step', ok ? 'Build install completed' : 'Build install FAILED — not executing test cases against a build that never landed');
  return ok;
}
export async function executeJob(key: string): Promise<void> {
  const job = getJob(key);
  if (!job) return;

  const inv = loadInventory();
  const setup = getSetup(job.setupHost, inv);
  // Optional now. A job may run individually-picked test cases with no
  // playlist at all (wizard "Individual Test Cases" mode), and failing here
  // would have killed every such job the moment it was submitted.
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
  if (job.playlistId && !playlist) return fail(`Playlist "${job.playlistId}" no longer exists.`);
  if (!job.testcases.length) return fail('This job has no test cases selected.');

  // ── Build install ─────────────────────────────────────────────────────
  // Submit records WHICH build to install and leaves it pending; the install
  // itself belongs here, on the server, so it survives the browser closing.
  if (job.build.installPending && !job.build.skipped) {
    const ok = await installPendingBuild(key, job.build.buildUrl, setup, inv);
    if (!ok) return;                       // installPendingBuild already failed the job
    const after = getJob(key);
    if (!after || after.status === 'build_failed') return;
  }

  // The inventory record (credentials); distinct from the box's simulator,
  // which is picked below.
  const sys = inv.systems.find((s) => s.id === setup.systemId);
  const opts: ApiOpts = {
    host: setup.host,
    username: sys?.uesim?.username ?? sys?.username ?? 'admin',
    password: sys?.uesim?.password ?? sys?.password ?? 'admin',
  };

  const startedAt = new Date().toISOString();
  // job.testcases is the SELECTION made in the wizard — possibly a subset of
  // the playlist, or a standalone set. Re-deriving it from the playlist here
  // (as this used to) silently ran all ten when the user had picked two.
  const names = job.testcases.map((t) => t.name);
  updateJob(key, (j) => {
    j.status = 'in_progress';
    j.startedAt = startedAt;
    j.steps.execution = { status: 'running', startedAt };
    j.testcases = names.map((name): TestcaseResult => ({ name, status: 'queued' }));
  });
  log(key, 'step', playlist
    ? `Executing "${playlist.name}" — ${names.length}${job.playlistTestcases && names.length !== job.playlistTestcases.length ? ` of ${job.playlistTestcases.length}` : ''} test case(s) on ${setup.host}`
    : `Executing ${names.length} individually-selected test case(s) on ${setup.host}`);

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

  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const tcId = byName.get(name);

    if (!tcId) {
      // Not a silent skip: the playlist named something this box does not have,
      // which means the job did not do what it said it would.
      skipped++;
      setTc(i, { status: 'skipped', detail: `No testcase named "${name}" on ${setup.host}.`, finishedAt: new Date().toISOString() });
      log(key, 'error', `[${i + 1}/${names.length}] ${name} — SKIPPED: not present on this box.`);
      continue;
    }

    log(key, 'step', `[${i + 1}/${names.length}] ${name} — waiting for an execution slot…`);
    const blocker = await waitForIdle(opts, IDLE_WAIT_SEC);
    if (blocker) {
      failed++;
      setTc(i, { status: 'failed', detail: `Box never went idle — ${blocker} still running.`, finishedAt: new Date().toISOString() });
      log(key, 'error', `[${i + 1}/${names.length}] ${name} — FAILED: box busy for ${IDLE_WAIT_SEC}s (${blocker}).`);
      continue;
    }

    const tcStart = new Date().toISOString();
    setTc(i, { status: 'running', startedAt: tcStart });
    log(key, 'info', `[${i + 1}/${names.length}] ${name} — triggering…`);

    let ourExecId: string | undefined;
    try {
      // simulatorId is required — see pickSimulator.
      const started: any = await startExecution(opts, tcId, { simulatorId: sim.id });
      ourExecId = started?.executionId ?? started?.id;
      log(key, 'info', `  triggered on simulator ${sim.id}${ourExecId ? ` (execution ${ourExecId})` : ''}`);
    } catch (e: any) {
      failed++;
      setTc(i, { status: 'failed', detail: `Trigger rejected: ${e?.message ?? e}`, finishedAt: new Date().toISOString() });
      log(key, 'error', `[${i + 1}/${names.length}] ${name} — FAILED to trigger: ${e?.message ?? e}`);
      continue;
    }

    const final = await pollToTerminal(opts, tcId, ourExecId, TESTCASE_MAX_SEC);
    const verdict = String(final?.result ?? '').toUpperCase();
    const status = String(final?.status ?? '').toUpperCase();
    const finishedAt = new Date().toISOString();

    if (!final) {
      failed++;
      setTc(i, { status: 'failed', detail: `No result within ${TESTCASE_MAX_SEC}s.`, finishedAt, executionId: ourExecId });
      log(key, 'error', `[${i + 1}/${names.length}] ${name} — FAILED: no terminal state within ${TESTCASE_MAX_SEC}s.`);
    } else if (verdict === 'PASS') {
      passed++;
      setTc(i, { status: 'passed', detail: `${status}${final.durationSeconds ? ` · ${final.durationSeconds}s` : ''}`, finishedAt, executionId: final.executionId });
      log(key, 'info', `[${i + 1}/${names.length}] ${name} — PASSED (${status}).`);
    } else {
      failed++;
      const detail = `${status || 'no status'}${verdict ? ` / ${verdict}` : ''}`;
      setTc(i, { status: 'failed', detail, finishedAt, executionId: final.executionId });
      log(key, 'error', `[${i + 1}/${names.length}] ${name} — FAILED (${detail}).`);
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

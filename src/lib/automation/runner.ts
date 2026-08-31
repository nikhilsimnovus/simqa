// Per-suite runner. Branches on suite.kind:
//
//   kind == 'uesim-only'
//     testcaseIds are Simnovator REST testcase ids — for each one fire
//     POST /v2/testcases/{id}/executions and capture the execution id.
//
//   kind == 'uesim+callbox'
//     testcaseIds are filenames under /root/enb/config on the callbox.
//     For each filename:
//       - If the file is in suite.uploadedConfigs, scp it onto the
//         callbox at /root/enb/config/<filename> (sftp createWriteStream
//         — atomic, handles binary).
//       - Else: the file is already on the box (the user picked it from
//         the live `ls`), so we just verify it's still there.
//     We don't restart the eNB service (too lab-specific). The run
//     result tells the operator exactly which files are now staged so
//     they can activate manually.
//
// Sequential in both modes (the Simnovator box has a system-wide
// execution mutex anyway; sequential SFTP keeps callbox load sane).

import { loadInventory, getSystem, uesimApiOptsForSystem, type AutomationSuite, type SuiteItem } from '../inventory';
import { withSsh, readCommand } from '../configFidelity/ssh';
import { sudoLink } from '../labCfgLink';
import { saveRun, newRunId, type RunRecord } from './runStore';
import { triggerPerfQaCollection, DEFAULT_PERFQA_URL } from './diagnostics';
import { duplicateTestcase } from './duplicateTestcase';

/** How long to give the box before asking whether any UE attached. The UEs are
 *  powered on over the first ~30-40s (attachRate-dependent), so checking sooner
 *  reports a false "nothing attached". */
const ATTACH_CHECK_DELAY_SEC = 55;

interface AttachEvidence {
  /** Distinct UEs seen in NAS state 5GMM-REGISTERED. */
  registered: number;
  /** Distinct UEs that exchanged a DCCH message — that channel only exists once
   *  RRC is established, so it proves the UE found the cell and connected. */
  rrcConnected: number;
  /** "No cell available" lines: the UE searched and found nothing. */
  noCell: number;
  /** Whether any log file for this testcase was found at all. */
  sawLog: boolean;
}

/**
 * Gather evidence of whether UEs attached, from the UE simulator's log.
 *
 * The box's own verdict is useless for this — its only criterion is
 * Avg_DL_BLER <= 5%, which 0 attached UEs satisfies trivially.
 *
 * Deliberately reads SEVERAL signals rather than one. `5GMM-REGISTERED` is a
 * NAS message, and a testcase whose logging profile is e.g. "rrc_debug" logs no
 * NAS at all — counting only that reported "nothing attached" for a run that was
 * attaching fine. DCCH traffic is visible under any profile that logs RRC, and
 * "No cell available" is the positive signal of the failure we actually care
 * about (gnb cfg on a different band from the testcase).
 *
 * The log rotates at 5 MB (a 10s 64-UE test wrote ~926 MB across five segments),
 * so the live file AND every rotated segment are read. Counting happens on the
 * UE box — only the numbers cross the wire.
 */
async function gatherAttachEvidence(ueSys: any, tcName: string): Promise<AttachEvidence | null> {
  const q = tcName.replace(/'/g, "'\\''");
  const files = `/tmp/'${q}'.log /var/log/lte/'${q}'.log.*`;
  const cmd = [
    `F=$(ls ${files} 2>/dev/null | wc -l)`,
    `R=$(cat ${files} 2>/dev/null | grep -h '5GMM-REGISTERED' | awk '{print $5}' | sort -u | wc -l)`,
    `C=$(cat ${files} 2>/dev/null | grep -h 'DCCH-NR' | awk '{print $5}' | sort -u | wc -l)`,
    `N=$(cat ${files} 2>/dev/null | grep -hc 'No cell available' || true)`,
    `echo "$R $C $N $F"`,
  ].join('; ');
  try {
    const out = String(await readCommand(ueSys, cmd)).trim().split(/\s+/).map(Number);
    if (out.length < 4 || out.some(n => !Number.isFinite(n))) return null;
    return { registered: out[0], rrcConnected: out[1], noCell: out[2], sawLog: out[3] > 0 };
  } catch {
    return null;
  }
}

/** The UE simulator bound to a Simnovator by a topology profile — that's the box
 *  whose log carries the attach evidence. */
function ueSystemForSimnovator(inv: ReturnType<typeof loadInventory>, simnovatorId?: string) {
  if (!simnovatorId) return undefined;
  const profile = (inv.profiles ?? []).find(p => p.simnovator === simnovatorId);
  return profile?.uesim ? getSystem(inv, profile.uesim) : undefined;
}

/** Slack added to the poll window on top of the requested duration, to cover the
 *  box's power-on/attach/teardown phases (powerOnTime is roughly session + 50s,
 *  and a looped power-cycle profile runs it twice). */
const POLL_MARGIN_SEC = 180;

export interface SuiteRunStep {
  testcaseId: string;
  status: number;
  ok: boolean;
  executionId?: string;
  /** Final verdict pulled from the box AFTER the test stops. Populated
   *  for tc rows that reached a terminal state (whether by the test
   *  finishing naturally or by us stopping it after the duration
   *  window). One of: PASS, FAIL, INCOMPLETE, ABORTED, STOPPED,
   *  TIMEOUT, ERROR — or '' if we never got a status back. */
  verdict?: string;
  /** Box's last reported execution status text (for diagnostics). */
  boxStatus?: string;
  /** Whether the test was stopped explicitly by simqa (vs. finished
   *  on its own within the duration window). */
  stopped?: boolean;
  detail?: string;
  durationMs: number;
}

export interface SuiteRunResult {
  startedAt: string;
  finishedAt: string;
  suiteId: string;
  suiteName: string;
  kind: 'uesim-only' | 'uesim+callbox';
  uesimHost?: string;
  callboxHost?: string;
  total: number;
  passed: number;
  failed: number;
  steps: SuiteRunStep[];
}

interface RunOpts {
  signal?: AbortSignal;
  onProgress?: (done: number, total: number, currentId?: string) => void;
  /** Fired as each row settles, so a caller can surface per-testcase status
   *  while the run is still going rather than only in the final record. */
  onStep?: (step: SuiteRunStep) => void;
  /** Signed-in user who submitted this job, for attribution on the saved
   *  record. Absent when triggered outside a browser session. */
  submittedBy?: string;
  /** When true, fire a perf-qa collection job alongside the run + stash
   *  the job id on the run record. Off by default — the customer may not
   *  have perf-qa deployed. */
  collectDiagnostics?: boolean;
  /** Override the perf-qa URL (otherwise SIMQA_PERFQA_URL / default). */
  perfQaUrl?: string;
  /** perf-qa profile name to load before collecting. */
  perfQaProfile?: string;
}

/** Best-effort capture of the box build version — used to stamp the run
 *  record so QA can compare runs across builds. */
async function fetchBuildVersion(host: string, token: string): Promise<string | undefined> {
  try {
    const r = await fetch(`http://${host}/v2/version`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000) });
    if (!r.ok) return undefined;
    const j: any = await r.json();
    const v = j?.simnovator?.version;
    const b = j?.simnovator?.build;
    return v && b ? `${v} (${b})` : (v ?? undefined);
  } catch { return undefined; }
}

/** Terminal states the box reports on a finished execution. We poll
 *  until we hit one of these or run out the per-testcase duration. */
const TERMINAL_STATUSES = new Set(['Completed', 'Failed', 'Aborted', 'Stopped', 'Passed', 'INCOMPLETE']);

interface ExecutionState {
  status?: string;
  result?: string;
  executionId?: string;
  durationSeconds?: number;
}

async function fetchLastExecution(host: string, token: string, tcId: string): Promise<ExecutionState | null> {
  try {
    const r = await fetch(`http://${host}/v2/testcases/${encodeURIComponent(tcId)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!r.ok) return null;
    const j: any = await r.json();
    const le = j?.metadata?.lastExecution;
    if (!le) return null;
    return {
      status: le.status, result: le.result,
      executionId: le.executionId, durationSeconds: le.durationSeconds,
    };
  } catch { return null; }
}

/** Poll a testcase's lastExecution.status until we see a terminal state
 *  or hit the per-testcase duration budget (seconds). Returns the
 *  final state captured, or null if the box never reported. */
async function pollExecutionToTerminal(host: string, token: string, tcId: string, triggerExecId: string | undefined, maxWaitSec: number, signal?: AbortSignal): Promise<ExecutionState | null> {
  const deadline = Date.now() + Math.max(5, maxWaitSec) * 1000;
  let last: ExecutionState | null = null;
  while (Date.now() < deadline && !signal?.aborted) {
    const s = await fetchLastExecution(host, token, tcId);
    if (s) {
      last = s;
      // Wait until the box has SEEN our trigger (its lastExecution.id
      // matches the one our POST returned). If our POST didn't return
      // an id, we fall back to "any terminal status will do".
      const ours = !triggerExecId || s.executionId === triggerExecId;
      if (ours && s.status && TERMINAL_STATUSES.has(s.status)) return s;
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  return last;
}

/** Stop an in-flight execution then settle into a terminal verdict.
 *
 *  Used when the duration window expires before the test stopped on its
 *  own — we explicitly POST /v2/testcases/executions/{eid}/stop, wait a
 *  few seconds for the box to settle to a terminal state, then GET the
 *  testcase one last time so the verdict surfaced to the user reflects
 *  the FINAL state (Stopped/Aborted/etc). Without this, a long test
 *  would just show "no terminal state within Ns" with no result.
 *
 *  Best-effort — every failure mode (stop returns 4xx, GET 404s, …)
 *  falls through to whatever lastExecution we captured before. */
async function stopAndFinalize(host: string, token: string, tcId: string, execId: string | undefined, signal?: AbortSignal, simulatorId?: string): Promise<ExecutionState | null> {
  if (!execId) return null;
  try {
    const simQ = simulatorId ? `?simulatorId=${encodeURIComponent(simulatorId)}` : '';
    await fetch(`http://${host}/v2/testcases/executions/${encodeURIComponent(execId)}/stop${simQ}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(10_000),
    });
  } catch { /* ignore — we'll still poll for the settle */ }
  // Give the box a moment to write the final status. Poll briefly.
  const settleDeadline = Date.now() + 10_000;
  let last: ExecutionState | null = null;
  while (Date.now() < settleDeadline && !signal?.aborted) {
    const s = await fetchLastExecution(host, token, tcId);
    if (s) {
      last = s;
      if (s.status && TERMINAL_STATUSES.has(s.status)) return s;
    }
    await new Promise(r => setTimeout(r, 1500));
  }
  return last;
}

/** Map the box's (status, result) pair to a single uppercase verdict the
 *  result table can show in one column. */
function deriveVerdict(state: ExecutionState | null, timedOut: boolean): string {
  if (!state && !timedOut) return '';
  if (!state) return 'TIMEOUT';
  const result = (state.result ?? '').toUpperCase();
  const status = (state.status ?? '').toUpperCase();
  if (result === 'PASS' || result === 'PASSED' || status === 'PASSED') return 'PASS';
  if (result === 'FAIL' || result === 'FAILED' || status === 'FAILED') return 'FAIL';
  if (result === 'INCOMPLETE') return 'INCOMPLETE';
  if (status === 'ABORTED') return 'ABORTED';
  if (status === 'STOPPED') return 'STOPPED';
  if (status === 'COMPLETED' && result === 'ERROR') return 'ERROR';
  return result || status || 'UNKNOWN';
}

async function login(host: string, username: string, password: string): Promise<string> {
  const r = await fetch(`http://${host}/v2/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
    // Bounded — an unreachable box would otherwise hang the whole suite run.
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`login ${r.status}`);
  const j: any = await r.json();
  return j.access_token ?? j.token;
}

/** Fetch the first available simulator's id. The box's POST
 *  /v2/testcases/{id}/executions now rejects with 500 "No default
 *  simulator found" when no ?simulatorId=… is passed (regression
 *  introduced ~4.0.0_260605); pin every trigger to the first sim. */
async function fetchFirstSimulatorId(host: string, token: string): Promise<string | undefined> {
  try {
    const r = await fetch(`http://${host}/v2/simulators`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!r.ok) return undefined;
    const j: any = await r.json();
    const sims = j?.items ?? j?.data ?? [];
    return sims[0]?.id ? String(sims[0].id) : undefined;
  } catch { return undefined; }
}

/**
 * Block until the simulator is free, or `maxSec` elapses.
 *
 * Suite rows run one after another, but the box doesn't drop `availability:
 * BUSY` the instant an execution stops — so triggering row 2 straight after row
 * 1 finished can 409. Waiting here is what makes "second one executes
 * automatically when the first stops" actually hold.
 *
 * Returns the name of whatever is still running if it never went idle.
 */
async function waitForSimulatorIdle(host: string, token: string, maxSec: number, signal?: AbortSignal): Promise<string | null> {
  const deadline = Date.now() + maxSec * 1000;
  let last: string | null = null;
  while (Date.now() < deadline && !signal?.aborted) {
    try {
      const r = await fetch(`http://${host}/v2/simulators`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (r.ok) {
        const j: any = await r.json();
        const sims: any[] = j?.items ?? j?.data ?? [];
        const busy = sims.find(s => String(s?.availability ?? '').toUpperCase() === 'BUSY');
        if (!busy) return null;
        last = busy.name ?? busy.id ?? 'a test case';
      }
    } catch { /* transient — keep waiting */ }
    await new Promise(res => setTimeout(res, 3_000));
  }
  return last;
}

async function runUesimOnly(suite: AutomationSuite, opts: RunOpts): Promise<SuiteRunResult> {
  const startedAt = new Date().toISOString();
  const inv = loadInventory();
  const ueOpts = uesimApiOptsForSystem(inv, suite.uesimSystemId ?? '');
  if (!ueOpts) throw new Error(`suite uesimSystemId "${suite.uesimSystemId}" not testable`);
  const token = await login(ueOpts.host, ueOpts.username, ueOpts.password);
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const simulatorId = await fetchFirstSimulatorId(ueOpts.host, token);
  const triggerBody = JSON.stringify(simulatorId ? { simulatorId } : {});
  const steps: SuiteRunStep[] = [];
  let passed = 0, failed = 0;

  const defaultDur = suite.defaultDurationSec ?? 10;
  for (const tcId of suite.testcaseIds) {
    if (opts.signal?.aborted) break;
    opts.onProgress?.(steps.length, suite.testcaseIds.length, tcId);
    const t0 = Date.now();
    const durSec = suite.testcaseDurations?.[tcId] ?? defaultDur;
    try {
      // The box's POST .../executions needs `{simulatorId}` in the BODY
      // (returns 500 "No default simulator found" without it), and holds
      // the HTTP connection open for the WHOLE testDuration (minutes).
      // Fire-and-forget: kick the trigger, give it 3s to register, then
      // proceed to polling. The poll loop reads metadata.lastExecution
      // for the real verdict, so the trigger response body is unneeded.
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 3000);
      let r: { ok: boolean; status: number };
      try {
        const resp = await fetch(`http://${ueOpts.host}/v2/testcases/${encodeURIComponent(tcId)}/executions`, {
          method: 'POST', headers: H, body: triggerBody, signal: ac.signal,
        });
        r = { ok: resp.ok, status: resp.status };
      } catch (e: any) {
        // AbortError is expected (we cut the connection after 3s) — treat
        // it as kickoff-OK. Any other error (network, DNS) is a real fail.
        if (e?.name === 'AbortError') r = { ok: true, status: 202 };
        else throw e;
      } finally {
        clearTimeout(timer);
      }
      const triggerOk = r.ok || r.status === 200 || r.status === 201 || r.status === 202;
      if (!triggerOk) {
        steps.push({
          testcaseId: tcId, status: r.status, ok: false,
          detail: `trigger ${r.status} — likely missing simulatorId in body`,
          durationMs: Date.now() - t0,
        });
        failed += 1;
        if (suite.stopOnFail) break;
        continue;
      }
      // Give the box a tick to register the execution before the first poll.
      await new Promise(res => setTimeout(res, 1500));
      // execId is read from lastExecution by the poller since we abort
      // the trigger fetch before getting its body.
      let finalState = await pollExecutionToTerminal(ueOpts.host, token, tcId, undefined, durSec, opts.signal);
      const execId = finalState?.executionId;
      let stoppedByUs = false;
      const naturallyDone = finalState?.status && TERMINAL_STATUSES.has(finalState.status);
      if (!naturallyDone && execId && !opts.signal?.aborted) {
        const settled = await stopAndFinalize(ueOpts.host, token, tcId, execId, opts.signal, simulatorId);
        if (settled) finalState = settled;
        stoppedByUs = true;
      }
      const verdict = deriveVerdict(finalState, !finalState);
      const passLike = verdict === 'PASS';
      steps.push({
        testcaseId: tcId, status: r.status, ok: passLike,
        executionId: finalState?.executionId ?? execId,
        verdict, boxStatus: finalState?.status, stopped: stoppedByUs,
        detail: finalState
          ? `verdict=${verdict} status=${finalState.status ?? '?'} result=${finalState.result ?? '?'} dur=${finalState.durationSeconds ?? '?'}s${stoppedByUs ? ' (stopped by simqa)' : ''}`
          : `triggered but no terminal state within ${durSec}s — stop attempted${stoppedByUs ? '; box never settled' : ''}`,
        durationMs: Date.now() - t0,
      });
      if (passLike) passed += 1; else { failed += 1; if (suite.stopOnFail) break; }
    } catch (e: any) {
      steps.push({ testcaseId: tcId, status: 0, ok: false, detail: `threw: ${e?.message ?? e}`, durationMs: Date.now() - t0 });
      failed += 1;
      if (suite.stopOnFail) break;
    }
  }
  opts.onProgress?.(steps.length, suite.testcaseIds.length);
  const buildVersion = await fetchBuildVersion(ueOpts.host, token);
  return {
    startedAt, finishedAt: new Date().toISOString(),
    suiteId: suite.id, suiteName: suite.name, kind: 'uesim-only',
    uesimHost: ueOpts.host,
    total: suite.testcaseIds.length, passed, failed, steps,
    buildVersion,
  } as SuiteRunResult & { buildVersion?: string };
}

async function runCallbox(suite: AutomationSuite, opts: RunOpts): Promise<SuiteRunResult & { buildVersion?: string }> {
  const startedAt = new Date().toISOString();
  const inv = loadInventory();
  const sys = suite.callboxSystemId ? getSystem(inv, suite.callboxSystemId) : undefined;
  if (!sys || sys.type !== 'CALLBOX') throw new Error(`suite callboxSystemId "${suite.callboxSystemId}" is not a CALLBOX`);
  const ueOpts = uesimApiOptsForSystem(inv, suite.uesimSystemId ?? '');
  if (!ueOpts) throw new Error(`suite uesimSystemId "${suite.uesimSystemId}" not testable`);

  const safe = (s: string) => s.replace(/[^\w.\-]/g, '_');
  const steps: SuiteRunStep[] = [];
  let passed = 0, failed = 0;

  // Total = (1 callbox-config-push step if configured) + Simnovator-trigger steps.
  // The page renders these as prefixed step ids (cfg:foo / tc:bar).
  const cfg = suite.callboxConfig;
  const tcs = suite.testcaseIds;
  const total = (cfg ? 1 : 0) + tcs.length;
  let done = 0;

  // ── Phase 1: push/verify the single callbox config (if set) ─────
  let existing = new Set<string>();
  try {
    const raw = await readCommand(sys, 'sudo -n ls -1 /root/enb/config 2>/dev/null || ls -1 /root/enb/config 2>/dev/null');
    existing = new Set(raw.split('\n').map(s => s.trim()).filter(Boolean));
  } catch { /* leave empty — upload still attempts */ }

  // The callbox phase is now 3 steps when a config is set:
  //   1. cfg-push    scp the upload (or verify the picked file exists)
  //   2. cfg-link    ln -sf /root/enb/config/<name> /root/enb/config/enb.cfg
  //   3. cfg-restart `sudo service lte restart`
  //                  then wait ~15s for the eNB process to bind sockets
  // The total bumps by 3 instead of 1 to reflect the multi-step bring-up.
  const totalWithBringUp = (cfg ? 3 : 0) + tcs.length;

  if (cfg && !opts.signal?.aborted) {
    const safeName = safe(cfg);
    const target = `/root/enb/config/${safeName}`;
    const linkPath = `/root/enb/config/enb.cfg`;
    const isUpload = !!suite.uploadedConfigs?.[cfg];

    // Step 1: cfg push
    opts.onProgress?.(done, totalWithBringUp, `cfg-push:${cfg}`);
    const t0 = Date.now();
    let cfgPushed = false;
    try {
      if (isUpload) {
        const b64 = suite.uploadedConfigs![cfg];
        const buf = Buffer.from(b64, 'base64');
        await withSsh(sys, async (ssh) => {
          const sftp = await ssh.requestSFTP();
          await new Promise<void>((resolve, reject) => {
            const ws = sftp.createWriteStream(target);
            ws.on('close', () => resolve());
            ws.on('error', reject);
            ws.end(buf);
          });
        });
        steps.push({
          testcaseId: `cfg-push:${cfg}`, status: 200, ok: true,
          detail: `uploaded ${buf.length}B → ${target} (overwrote=${existing.has(safeName)})`,
          durationMs: Date.now() - t0,
        });
        cfgPushed = true; passed += 1;
      } else {
        const present = existing.has(cfg) || existing.has(safeName);
        steps.push({
          testcaseId: `cfg-push:${cfg}`, status: present ? 200 : 404, ok: present,
          detail: present ? `present at ${target}` : `missing on callbox /root/enb/config`,
          durationMs: Date.now() - t0,
        });
        if (present) { cfgPushed = true; passed += 1; } else failed += 1;
      }
    } catch (e: any) {
      steps.push({ testcaseId: `cfg-push:${cfg}`, status: 0, ok: false, detail: `ssh: ${e?.message ?? e}`, durationMs: Date.now() - t0 });
      failed += 1;
    }
    done += 1;

    // Step 2: symlink enb.cfg → picked config
    if (cfgPushed) {
      opts.onProgress?.(done, totalWithBringUp, `cfg-link:${cfg}`);
      const t1 = Date.now();
      try {
        await withSsh(sys, async (ssh) => {
          const r = await ssh.execCommand(`sudo -n ln -sfn "${target}" "${linkPath}" 2>/dev/null || ln -sfn "${target}" "${linkPath}"; sudo -n ls -la "${linkPath}" 2>/dev/null || ls -la "${linkPath}"`);
          if (r.code !== 0) throw new Error(r.stderr || r.stdout || `ln exit ${r.code}`);
          return r.stdout;
        });
        steps.push({ testcaseId: `cfg-link:${cfg}`, status: 200, ok: true, detail: `${linkPath} → ${target}`, durationMs: Date.now() - t1 });
        passed += 1;
      } catch (e: any) {
        steps.push({ testcaseId: `cfg-link:${cfg}`, status: 0, ok: false, detail: `ln failed: ${e?.message ?? e}`, durationMs: Date.now() - t1 });
        failed += 1;
        cfgPushed = false;
      }
      done += 1;
    } else {
      // Skip link if push failed.
      done += 1;
    }

    // Step 3: restart the lte service + give it 15s to stabilise
    if (cfgPushed) {
      opts.onProgress?.(done, totalWithBringUp, `cfg-restart:${cfg}`);
      const t2 = Date.now();
      try {
        // The Simnovator callbox uses `service lte restart` — not systemd.
        const restartCmd = `sudo service lte restart`;
        await withSsh(sys, async (ssh) => {
          const r = await ssh.execCommand(restartCmd);
          if (r.code !== 0) throw new Error(r.stderr || r.stdout || `restart exit ${r.code}`);
        });
        // Give the eNB ~15s to bind sockets + come back. The actual
        // UE-attach attempts won't fire until after this sleep.
        await new Promise(r => setTimeout(r, 15_000));
        steps.push({ testcaseId: `cfg-restart:${cfg}`, status: 200, ok: true, detail: `lte service restarted + 15s settle`, durationMs: Date.now() - t2 });
        passed += 1;
      } catch (e: any) {
        steps.push({ testcaseId: `cfg-restart:${cfg}`, status: 0, ok: false, detail: `restart failed: ${e?.message ?? e}`, durationMs: Date.now() - t2 });
        failed += 1;
      }
      done += 1;
    } else {
      done += 1;
    }

    // If the bring-up failed and stopOnFail is set, skip testcases.
    if (suite.stopOnFail && failed > 0) {
      opts.onProgress?.(totalWithBringUp, totalWithBringUp);
      return {
        startedAt, finishedAt: new Date().toISOString(),
        suiteId: suite.id, suiteName: suite.name, kind: 'uesim+callbox',
        callboxHost: sys.host,
        total: totalWithBringUp, passed, failed, steps,
      };
    }
  }

  // ── Phase 2: trigger Simnovator testcases ─────────────────────────
  let token = '';
  let buildVersion: string | undefined;
  if (tcs.length > 0 && !opts.signal?.aborted) {
    try { token = await login(ueOpts.host, ueOpts.username, ueOpts.password); }
    catch (e: any) {
      // Can't even log in — mark all testcase steps failed in a single batch.
      for (const tcId of tcs) {
        steps.push({ testcaseId: `tc:${tcId}`, status: 0, ok: false, detail: `simnovator login: ${e?.message ?? e}`, durationMs: 0 });
        failed += 1;
      }
      done = total;
    }
  }
  if (token) {
    const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const simulatorId = await fetchFirstSimulatorId(ueOpts.host, token);
    const simQ = simulatorId ? `?simulatorId=${encodeURIComponent(simulatorId)}` : '';
    // total may have been bumped by the callbox bring-up steps — use it
    // for progress reporting in both branches.
    const totalProg = (cfg ? 3 : 0) + tcs.length;
    const defaultDur = suite.defaultDurationSec ?? 10;
    for (const tcId of tcs) {
      if (opts.signal?.aborted) break;
      opts.onProgress?.(done, totalProg, `tc:${tcId}`);
      const t0 = Date.now();
      const durSec = suite.testcaseDurations?.[tcId] ?? defaultDur;
      try {
        const r = await fetch(`http://${ueOpts.host}/v2/testcases/${encodeURIComponent(tcId)}/executions${simQ}`, {
          method: 'POST', headers: H, body: '{}',
        });
        const j: any = await r.json().catch(() => ({}));
        const triggerOk = r.ok || r.status === 200 || r.status === 201;
        const execId: string | undefined = j?.executionId ?? j?.id;
        if (!triggerOk) {
          steps.push({
            testcaseId: `tc:${tcId}`, status: r.status, ok: false,
            executionId: execId,
            detail: typeof j === 'object' ? JSON.stringify(j).slice(0, 200) : 'no body',
            durationMs: Date.now() - t0,
          });
          failed += 1;
          if (suite.stopOnFail) break;
          done += 1;
          continue;
        }
        // Trigger worked — now poll until terminal state or duration hits.
        let finalState = await pollExecutionToTerminal(ueOpts.host, token, tcId, execId, durSec, opts.signal);
        let stoppedByUs = false;
        const naturallyDone = finalState?.status && TERMINAL_STATUSES.has(finalState.status);
        if (!naturallyDone && execId && !opts.signal?.aborted) {
          const settled = await stopAndFinalize(ueOpts.host, token, tcId, execId, opts.signal, simulatorId);
          if (settled) finalState = settled;
          stoppedByUs = true;
        }
        const verdict = deriveVerdict(finalState, !finalState);
        const passLike = verdict === 'PASS';
        steps.push({
          testcaseId: `tc:${tcId}`, status: r.status, ok: passLike,
          executionId: finalState?.executionId ?? execId,
          verdict, boxStatus: finalState?.status, stopped: stoppedByUs,
          detail: finalState
            ? `verdict=${verdict} status=${finalState.status ?? '?'} result=${finalState.result ?? '?'} dur=${finalState.durationSeconds ?? '?'}s${stoppedByUs ? ' (stopped by simqa)' : ''}`
            : `triggered but no terminal state within ${durSec}s`,
          durationMs: Date.now() - t0,
        });
        if (passLike) passed += 1; else { failed += 1; if (suite.stopOnFail) break; }
      } catch (e: any) {
        steps.push({ testcaseId: `tc:${tcId}`, status: 0, ok: false, detail: `threw: ${e?.message ?? e}`, durationMs: Date.now() - t0 });
        failed += 1;
        if (suite.stopOnFail) break;
      }
      done += 1;
    }
    buildVersion = await fetchBuildVersion(ueOpts.host, token);
  }
  const totalFinal = (cfg ? 3 : 0) + tcs.length;
  opts.onProgress?.(totalFinal, totalFinal);

  return {
    startedAt, finishedAt: new Date().toISOString(),
    suiteId: suite.id, suiteName: suite.name, kind: 'uesim+callbox',
    uesimHost: ueOpts.host,
    callboxHost: sys.host,
    total, passed, failed, steps,
    buildVersion,
  };
}

/** Pair-shaped flow: one item = one (Simnovator testcase + optional
 *  callbox cfg). Each item triggers its own eNB bring-up cycle BEFORE
 *  the testcase fires, so each row carries its own radio context.
 *
 *  Per-item sequence (uesim+callbox):
 *    1. cfg-push     scp upload OR verify picked file
 *    2. cfg-link     ln -sfn /root/enb/config/<name> /root/enb/config/enb.cfg
 *    3. cfg-restart  service lte restart + 15s settle
 *    4. tc-trigger   POST /v2/testcases/{id}/executions
 *    5. tc-poll      poll lastExecution until terminal or duration timeout
 *
 *  For uesim-only suites items just skip 1-3. */
async function runItems(suite: AutomationSuite, items: SuiteItem[], opts: RunOpts): Promise<SuiteRunResult & { buildVersion?: string }> {
  const startedAt = new Date().toISOString();
  const inv = loadInventory();
  const ueOpts = uesimApiOptsForSystem(inv, suite.uesimSystemId ?? '');
  if (!ueOpts) throw new Error(`suite uesimSystemId "${suite.uesimSystemId}" not testable`);
  const callboxSys = suite.kind === 'uesim+callbox' && suite.callboxSystemId
    ? getSystem(inv, suite.callboxSystemId)
    : undefined;
  if (suite.kind === 'uesim+callbox' && (!callboxSys || callboxSys.type !== 'CALLBOX')) {
    throw new Error(`suite callboxSystemId "${suite.callboxSystemId}" is not a CALLBOX`);
  }
  // The UE box holds the only real evidence of whether UEs attached. Absent a
  // topology profile binding it to this Simnovator we simply skip the check
  // rather than failing the run.
  const ueSys = ueSystemForSimnovator(inv, suite.uesimSystemId);

  const safe = (s: string) => s.replace(/[^\w.\-]/g, '_');
  const rawSteps: SuiteRunStep[] = [];
  /** Record a step AND report it, so the UI can colour a row the moment it
   *  settles instead of waiting for the whole suite. */
  const steps = {
    push(step: SuiteRunStep) {
      rawSteps.push(step);
      try { opts.onStep?.(step); } catch { /* reporting must never break a run */ }
      return rawSteps.length;
    },
    get length() { return rawSteps.length; },
  };
  let passed = 0, failed = 0;
  const total = items.length;
  let done = 0;

  // Cache of files currently on the callbox so we don't re-ls per item.
  let existing = new Set<string>();
  let existingCore = new Set<string>();
  if (callboxSys) {
    try {
      const raw = await readCommand(callboxSys, 'sudo -n ls -1 /root/enb/config 2>/dev/null || ls -1 /root/enb/config 2>/dev/null');
      existing = new Set(raw.split('\n').map(s => s.trim()).filter(Boolean));
    } catch { /* uploads still attempt */ }
    try {
      const raw = await readCommand(callboxSys, 'sudo -n ls -1 /root/mme/config 2>/dev/null || ls -1 /root/mme/config 2>/dev/null');
      existingCore = new Set(raw.split('\n').map(s => s.trim()).filter(Boolean));
    } catch { /* uploads still attempt */ }
  }

  const token = await login(ueOpts.host, ueOpts.username, ueOpts.password).catch(() => '');
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const simulatorId = token ? await fetchFirstSimulatorId(ueOpts.host, token) : undefined;
  const simQ = simulatorId ? `?simulatorId=${encodeURIComponent(simulatorId)}` : '';
  const defaultDur = suite.defaultDurationSec ?? 10;

  for (const item of items) {
    if (opts.signal?.aborted) break;
    opts.onProgress?.(done, total, item.name);
    const t0 = Date.now();
    const stepDetails: string[] = [];
    let itemOk = true;
    /** enb.cfg's target before this row re-pointed it — reported only, so the
     *  run log records what the callbox was bound to beforehand. */
    let prevEnbLink = '';
    let prevMmeLink = '';
    let prevImsLink = '';
    /** Set only when this row UPLOADED a cfg that wasn't already on the callbox;
     *  that file is the sole thing opt-in cleanup may remove. */
    let pushedCfg = '';

    // ── Phase 0: create the row's testcase on the Simnovator first, under the
    // display name and with the row's duration baked in — so the case exists in
    // the box's catalogue before the callbox is touched. If the box rejects it
    // (bad name, duplicate, bad config) we find out without having restarted
    // anything. The copy stays on the Simnovator afterwards.
    const durSec = item.durationSec ?? defaultDur;
    let runTcId = item.simnovatorTcId;
    /** The name the box actually gave the copy — the UE log is named after it. */
    let createdName = item.name;
    if (!token) {
      steps.push({ testcaseId: item.name, status: 0, ok: false, detail: 'simnovator login failed', durationMs: Date.now() - t0 });
      failed += 1; done += 1;
      if (suite.stopOnFail) break;
      continue;
    }
    try {
      const dup = await duplicateTestcase(ueOpts, item.simnovatorTcId, item.name, durSec);
      if (dup.error || !dup.testCaseId) {
        steps.push({
          testcaseId: item.name, status: 0, ok: false,
          detail: `duplicate failed at ${dup.failedStep ?? '?'}: ${dup.error ?? 'no testCaseId returned'}`,
          durationMs: Date.now() - t0,
        });
        failed += 1; done += 1;
        if (suite.stopOnFail) break;
        continue;
      }
      runTcId = dup.testCaseId;
      createdName = dup.name;
      // dup.name may differ from item.name — testcase names are unique on the
      // box, so a re-run of the same row gets "_2", "_3", …
      stepDetails.push(dup.reused
        ? `testcase: reusing existing "${dup.name}" on ${ueOpts.host}`
        : `testcase: "${dup.name}" (${durSec}s) created on ${ueOpts.host}`);
      if (dup.warning) stepDetails.push(`note: ${dup.warning}`);
    } catch (e: any) {
      steps.push({
        testcaseId: item.name, status: 0, ok: false,
        detail: `duplicate threw: ${e?.message ?? e}`,
        durationMs: Date.now() - t0,
      });
      failed += 1; done += 1;
      if (suite.stopOnFail) break;
      continue;
    }

    // ── Phase 1-3: callbox bring-up (only if cfg + callbox present)
    // enb.cfg links straight at the file the operator picked, by its own name —
    // `enb.cfg -> SA-1Cell.cfg_June2026`, so the binding is legible in the
    // callbox terminal. (This used to copy the pick to a sanitised
    // simqa-<id>.cfg and link at that instead, which hid which config was
    // actually running.) Names with commas/spaces are handled by quoting the
    // shell args, not by renaming the file. Uploads — configs not already on the
    // box — are pushed up under their own name first.
    if (callboxSys && item.callboxCfg) {
      const cfg = item.callboxCfg;
      const linkPath = `/root/enb/config/enb.cfg`;
      const blob = suite.uploadedConfigs?.[cfg];
      /** Single-quoted shell arg; embedded quotes escaped. */
      const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
      let target = '';

      try {
        if (existing.has(cfg)) {
          // Already on the callbox — link at it directly, nothing to copy.
          target = `/root/enb/config/${cfg}`;
          stepDetails.push(`cfg-source: existing "${cfg}"`);
        } else if (blob) {
          const buf = Buffer.from(blob, 'base64');
          target = `/root/enb/config/${cfg}`;
          await withSsh(callboxSys, async (ssh) => {
            const sftp = await ssh.requestSFTP();
            await new Promise<void>((resolve, reject) => {
              const ws = sftp.createWriteStream(target);
              ws.on('close', () => resolve());
              ws.on('error', reject);
              ws.end(buf);
            });
          });
          existing.add(cfg);
          pushedCfg = cfg;
          stepDetails.push(`cfg-push: scp ${buf.length}B → ${cfg}`);
        } else {
          throw new Error(`cfg "${cfg}" not in suite uploadedConfigs and missing on callbox /root/enb/config`);
        }

        // Linked from inside the directory with a bare basename, so the link is
        // relative — `enb.cfg -> SA-1Cell.cfg_June2026`, which is how the
        // operators write it by hand and how it reads in the callbox terminal.
        // An absolute target works identically but shows the full path.
        await withSsh(callboxSys, async (ssh) => {
          const prev = await ssh.execCommand(`readlink ${q(linkPath)} || true`);
          prevEnbLink = (prev.stdout ?? '').trim();
          const r = await ssh.execCommand(
            sudoLink('/root/enb/config', q(cfg), 'enb.cfg'));
          if (r.code !== 0) throw new Error(`ln: ${r.stderr || r.stdout || `exit ${r.code}`}`);
        });
        stepDetails.push(`cfg-link: ln -sfn ${cfg} enb.cfg`);

        // Core cfgs live in /root/mme/config and are picked from files already
        // on the box (no upload path), so we only ever re-point the symlink the
        // services read. A test needs the core up as well as the radio.
        const coreLinks: Array<[string, string | undefined]> = [
          ['mme.cfg', item.mmeCfg],
          ['ims.cfg', item.imsCfg],
        ];
        // Relative, same as enb.cfg above: `mme.cfg -> demo-mme.cfg`.
        for (const [linkName, pick] of coreLinks) {
          if (!pick) continue;
          // An uploaded core cfg isn't on the box yet — push it under its own
          // name first, so the link reads the same as the operator's pick.
          if (!existingCore.has(pick) && suite.uploadedConfigs?.[pick]) {
            const buf = Buffer.from(suite.uploadedConfigs[pick], 'base64');
            await withSsh(callboxSys, async (ssh) => {
              const sftp = await ssh.requestSFTP();
              await new Promise<void>((resolve, reject) => {
                const ws = sftp.createWriteStream(`/root/mme/config/${pick}`);
                ws.on('close', () => resolve());
                ws.on('error', reject);
                ws.end(buf);
              });
            });
            existingCore.add(pick);
            stepDetails.push(`cfg-push: scp ${buf.length}B → /root/mme/config/${pick}`);
          }
          await withSsh(callboxSys, async (ssh) => {
            const prev = await ssh.execCommand(`readlink /root/mme/config/${linkName} || true`);
            const prevTarget = (prev.stdout ?? '').trim();
            if (linkName === 'mme.cfg') prevMmeLink = prevTarget; else prevImsLink = prevTarget;
            const r = await ssh.execCommand(
              sudoLink('/root/mme/config', q(pick), linkName));
            if (r.code !== 0) throw new Error(`ln ${linkName}: ${r.stderr || r.stdout || `exit ${r.code}`}`);
          });
          stepDetails.push(`cfg-link: ln -sfn ${pick} ${linkName}`);
        }

        // One unit — lte.service runs /root/ots/ltestart.sh, which launches enb,
        // mme AND ims together (see ots.cfg's ENB/MME/IMS_CONFIG_FILE). There is
        // no separate ltemme unit, so this single restart picks up all three
        // symlinks. Going through sudo so the simqa SSH user needn't be root.
        await withSsh(callboxSys, async (ssh) => {
          const r = await ssh.execCommand(`sudo service lte restart`);
          if (r.code !== 0) throw new Error(`restart lte: ${r.stderr || r.stdout || `exit ${r.code}`}`);
        });
        await new Promise(r => setTimeout(r, 15_000));
        stepDetails.push(`cfg-restart: lte restarted (enb+mme+ims) + 15s settle`);
      } catch (e: any) {
        steps.push({
          testcaseId: item.name, status: 0, ok: false,
          detail: `bring-up failed: ${e?.message ?? e}`,
          durationMs: Date.now() - t0,
        });
        failed += 1; itemOk = false;
        if (suite.stopOnFail) { done += 1; break; }
        done += 1;
        continue;
      }
    }

    // ── Phase 4-5: trigger + poll the testcase created in phase 0
    //
    // Rows run strictly in order. The previous row's execution may still be
    // winding down, so wait for the simulator to go idle before triggering
    // rather than colliding with the box's one-at-a-time mutex.
    const stillBusy = await waitForSimulatorIdle(ueOpts.host, token, 120, opts.signal);
    if (stillBusy) {
      steps.push({
        testcaseId: item.name, status: 409, ok: false,
        detail: `${stepDetails.join(' · ')}${stepDetails.length ? ' · ' : ''}simulator still busy with "${stillBusy}" after 120s — not triggered`,
        durationMs: Date.now() - t0,
      });
      failed += 1; done += 1;
      if (suite.stopOnFail) break;
      continue;
    }

    const triggerBody = JSON.stringify(simulatorId ? { simulatorId } : {});
    try {
      // See runUesimOnly above for why this is fire-and-forget + abort.
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 3000);
      let r: { ok: boolean; status: number };
      try {
        const resp = await fetch(`http://${ueOpts.host}/v2/testcases/${encodeURIComponent(runTcId)}/executions`, {
          method: 'POST', headers: H, body: triggerBody, signal: ac.signal,
        });
        r = { ok: resp.ok, status: resp.status };
      } catch (e: any) {
        if (e?.name === 'AbortError') r = { ok: true, status: 202 };
        else throw e;
      } finally {
        clearTimeout(timer);
      }
      const triggerOk = r.ok || r.status === 200 || r.status === 201 || r.status === 202;
      if (!triggerOk) {
        steps.push({
          testcaseId: item.name, status: r.status, ok: false,
          // 409 is the box's one-testcase-at-a-time mutex, not a bad request —
          // calling it a missing simulatorId sent us chasing the wrong bug once.
          detail: `${stepDetails.join(' · ')}${stepDetails.length ? ' · ' : ''}trigger ${r.status} — ${r.status === 409
            ? 'a test case is already running on the simulator'
            : 'rejected by the box (check simulatorId in the trigger body)'}`,
          durationMs: Date.now() - t0,
        });
        failed += 1;
        if (suite.stopOnFail) { done += 1; break; }
        done += 1;
        continue;
      }
      // 1. Give the box ~1.5s to register the trigger then poll for
      //    terminal state up to durationSec. execId is read from the
      //    polled lastExecution (we aborted the trigger response).
      await new Promise(res => setTimeout(res, 1500));

      // Attach gate: once the UEs have had time to power on, check the UE
      // simulator's log. A run where nothing attached is a real failure that the
      // box would otherwise report as PASS, so cut it short instead of burning
      // the rest of the duration on a test that cannot do anything.
      if (ueSys) {
        const grace = Math.min(ATTACH_CHECK_DELAY_SEC, durSec + POLL_MARGIN_SEC);
        await new Promise(res => setTimeout(res, grace * 1000));
        const ev = await gatherAttachEvidence(ueSys, createdName);
        // Only a log that positively says the UE searched and found nothing is
        // treated as failure. Silence is NOT evidence — the logging profile may
        // simply not record the layer we looked at, and killing a healthy run
        // over that is far worse than letting it play out.
        const attached = ev ? ev.registered > 0 || ev.rrcConnected > 0 : false;
        const definitelyNotAttached = !!ev && ev.sawLog && !attached && ev.noCell > 0;

        if (definitelyNotAttached) {
          const st = await fetchLastExecution(ueOpts.host, token, runTcId);
          if (st?.executionId && !opts.signal?.aborted) {
            await stopAndFinalize(ueOpts.host, token, runTcId, st.executionId, opts.signal, simulatorId);
          }
          steps.push({
            testcaseId: item.name, status: r.status, ok: false, verdict: 'FAIL',
            executionId: st?.executionId,
            detail: `${stepDetails.join(' · ')}${stepDetails.length ? ' · ' : ''}no UE attached within ${grace}s `
              + `("No cell available" ×${ev!.noCell}) — stopped. The UE never found the cell; `
              + `check that the gnb cfg's band matches the testcase's band.`,
            durationMs: Date.now() - t0,
          });
          failed += 1; done += 1;
          if (suite.stopOnFail) break;
          continue;
        }

        stepDetails.push(
          !ev ? 'attach: UE log unreadable — not checked'
          : ev.registered > 0 ? `attach: ${ev.registered} UE(s) registered`
          : ev.rrcConnected > 0 ? `attach: ${ev.rrcConnected} UE(s) RRC-connected (profile logs no NAS)`
          : 'attach: inconclusive at this point — letting the test run',
        );
      }

      // The poll window has to outlast the test, not match it: durSec is the
      // user-plane session length, and the box spends powerOnTime (session +
      // ~50s) bringing UEs up around it. Waiting only durSec would stop a 5s
      // test while it was still attaching.
      let finalState = await pollExecutionToTerminal(ueOpts.host, token, runTcId, undefined, durSec + POLL_MARGIN_SEC, opts.signal);
      const execId = finalState?.executionId;
      let stoppedByUs = false;
      const naturallyDone = finalState?.status && TERMINAL_STATUSES.has(finalState.status);
      // 2. If the window expired before the test stopped on its own,
      //    POST stop and re-read the verdict from lastExecution.
      if (!naturallyDone && execId && !opts.signal?.aborted) {
        const settled = await stopAndFinalize(ueOpts.host, token, runTcId, execId, opts.signal, simulatorId);
        if (settled) finalState = settled;
        stoppedByUs = true;
      }
      const verdict = deriveVerdict(finalState, !finalState);
      const passLike = verdict === 'PASS';
      steps.push({
        testcaseId: item.name, status: r.status, ok: passLike,
        executionId: finalState?.executionId ?? execId,
        verdict, boxStatus: finalState?.status, stopped: stoppedByUs,
        detail: `${stepDetails.join(' · ')}${stepDetails.length ? ' · ' : ''}${finalState
          ? `verdict=${verdict} status=${finalState.status ?? '?'} result=${finalState.result ?? '?'} dur=${finalState.durationSeconds ?? '?'}s${stoppedByUs ? ' (stopped by simqa)' : ''}`
          : `triggered but no terminal state within ${durSec}s — stop attempted${stoppedByUs ? '; box never settled' : ''}`}`,
        durationMs: Date.now() - t0,
      });
      if (passLike) passed += 1; else { failed += 1; if (suite.stopOnFail) { done += 1; break; } }
    } catch (e: any) {
      steps.push({ testcaseId: item.name, status: 0, ok: false, detail: `threw: ${e?.message ?? e}`, durationMs: Date.now() - t0 });
      failed += 1;
      if (suite.stopOnFail) { done += 1; break; }
    } finally {
      // Phase 6: per-item cleanup — runs only once the execution has finished,
      // and only when the suite opted in.
      //
      // "Back to normal" means the symlinks point at whatever they pointed at
      // BEFORE this row ran, so the callbox is handed back as it was found. A
      // cfg we uploaded is removed too, but never while a link still points at
      // it (that would leave a dangling symlink). With the box left unchanged
      // by default, an operator can see which cfg a run used.
      if (suite.removeConfigAfterRun === true && callboxSys) {
        const sq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
        try {
          await withSsh(callboxSys, async (ssh) => {
            if (prevEnbLink) {
              await ssh.execCommand(`cd /root/enb/config && ln -sfn ${sq(prevEnbLink)} 'enb.cfg' && ls -la 'enb.cfg'`);
            }
            for (const [linkName, prev] of [['mme.cfg', prevMmeLink], ['ims.cfg', prevImsLink]] as const) {
              if (prev) await ssh.execCommand(`cd /root/mme/config && ln -sfn ${sq(prev)} ${sq(linkName)}`);
            }
            if (pushedCfg) {
              await ssh.execCommand(
                `cd /root/enb/config && [ "$(readlink enb.cfg)" != ${sq(pushedCfg)} ] && rm -f ${sq(pushedCfg)} || true`);
            }
          });
          stepDetails.push('cfg-restore: callbox symlinks put back');
        } catch { /* cleanup is best-effort — never changes the verdict */ }
      }
    }
    done += 1;
  }
  opts.onProgress?.(total, total);
  const buildVersion = token ? await fetchBuildVersion(ueOpts.host, token) : undefined;

  return {
    startedAt, finishedAt: new Date().toISOString(),
    suiteId: suite.id, suiteName: suite.name,
    kind: suite.kind ?? 'uesim-only',
    uesimHost: ueOpts.host,
    callboxHost: callboxSys?.host,
    total, passed, failed, steps: rawSteps,
    buildVersion,
  };
}

export async function runSuite(suite: AutomationSuite, opts: RunOpts = {}): Promise<RunRecord> {
  // Fire perf-qa BEFORE the run starts so its sample window covers both
  // the pre-state and the actual execution. perf-qa returns a job_id
  // synchronously; the collection itself continues in a background thread.
  let diagnostics: RunRecord['diagnostics'] | undefined;
  if (opts.collectDiagnostics) {
    const dg = await triggerPerfQaCollection({
      perfQaUrl: opts.perfQaUrl ?? DEFAULT_PERFQA_URL,
      testCaseName: suite.name,
      iterationId: newRunId(),
      profile: opts.perfQaProfile,
    });
    if (dg.ok && dg.jobId) {
      diagnostics = { perfQaUrl: dg.perfQaUrl, jobId: dg.jobId, triggeredAt: new Date().toISOString() };
    }
  }

  // Prefer the items[] flow when the suite has it — each row is a
  // self-contained (tc + cfg) pair with its own bring-up cycle. Fall
  // back to the legacy flat-list flow (one shared callbox cfg, N tcs)
  // for older suites saved before the items[] schema landed.
  const summary = (suite.items && suite.items.length > 0)
    ? await runItems(suite, suite.items, opts)
    : (suite.kind === 'uesim+callbox'
        ? await runCallbox(suite, opts)
        : await runUesimOnly(suite, opts));

  // Persist the run + return the full record (with runId).
  const rec: RunRecord = {
    ...summary,
    runId: newRunId(),
    buildVersion: (summary as any).buildVersion,
    submittedBy: opts.submittedBy,
    diagnostics,
  };
  saveRun(rec);
  // Cross-surface history row so /runs shows this suite-run alongside
  // every other surface's runs.
  try {
    const { appendHistoryEntry } = await import('../historyStore');
    appendHistoryEntry({
      surface: 'automation-suite',
      label: `Automation suite "${suite.name}" · ${rec.total} steps · ${rec.passed} pass / ${rec.failed} fail`,
      startedAt: rec.startedAt,
      finishedAt: rec.finishedAt,
      targetSystemId: suite.uesimSystemId,
      targetHost: rec.uesimHost,
      buildVersion: rec.buildVersion,
      total: rec.total,
      passed: rec.passed,
      failed: rec.failed,
      detailPath: `data/automation-runs/${suite.id}/${rec.runId}.json`,
      meta: {
        suiteId: suite.id,
        suiteName: suite.name,
        kind: rec.kind,
        callboxHost: rec.callboxHost,
        diagnostics: !!diagnostics,
        submittedBy: rec.submittedBy,
      },
    });
  } catch { /* history side-channel */ }
  return rec;
}

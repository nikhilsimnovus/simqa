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
import { saveRun, newRunId, type RunRecord } from './runStore';
import { triggerPerfQaCollection, DEFAULT_PERFQA_URL } from './diagnostics';

export interface SuiteRunStep {
  testcaseId: string;
  status: number;
  ok: boolean;
  executionId?: string;
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

async function login(host: string, username: string, password: string): Promise<string> {
  const r = await fetch(`http://${host}/v2/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!r.ok) throw new Error(`login ${r.status}`);
  const j: any = await r.json();
  return j.access_token ?? j.token;
}

async function runUesimOnly(suite: AutomationSuite, opts: RunOpts): Promise<SuiteRunResult> {
  const startedAt = new Date().toISOString();
  const inv = loadInventory();
  const ueOpts = uesimApiOptsForSystem(inv, suite.uesimSystemId ?? '');
  if (!ueOpts) throw new Error(`suite uesimSystemId "${suite.uesimSystemId}" not testable`);
  const token = await login(ueOpts.host, ueOpts.username, ueOpts.password);
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const steps: SuiteRunStep[] = [];
  let passed = 0, failed = 0;

  const defaultDur = suite.defaultDurationSec ?? 10;
  for (const tcId of suite.testcaseIds) {
    if (opts.signal?.aborted) break;
    opts.onProgress?.(steps.length, suite.testcaseIds.length, tcId);
    const t0 = Date.now();
    const durSec = suite.testcaseDurations?.[tcId] ?? defaultDur;
    try {
      const r = await fetch(`http://${ueOpts.host}/v2/testcases/${encodeURIComponent(tcId)}/executions`, {
        method: 'POST', headers: H, body: '{}',
      });
      const j: any = await r.json().catch(() => ({}));
      const triggerOk = r.ok || r.status === 200 || r.status === 201;
      const execId: string | undefined = j?.executionId ?? j?.id;
      if (!triggerOk) {
        steps.push({
          testcaseId: tcId, status: r.status, ok: false,
          executionId: execId,
          detail: typeof j === 'object' ? JSON.stringify(j).slice(0, 200) : 'no body',
          durationMs: Date.now() - t0,
        });
        failed += 1;
        if (suite.stopOnFail) break;
        continue;
      }
      const finalState = await pollExecutionToTerminal(ueOpts.host, token, tcId, execId, durSec, opts.signal);
      const verdict = (finalState?.result ?? '').toUpperCase();
      const passLike = verdict === 'PASS' || verdict === 'PASSED' || finalState?.status === 'Passed';
      steps.push({
        testcaseId: tcId, status: r.status, ok: passLike,
        executionId: finalState?.executionId ?? execId,
        detail: finalState
          ? `status=${finalState.status ?? '?'} result=${finalState.result ?? '?'} dur=${finalState.durationSeconds ?? '?'}s`
          : `triggered but no terminal state within ${durSec}s`,
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
    const raw = await readCommand(sys, 'ls -1 /root/enb/config 2>/dev/null');
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
          const r = await ssh.execCommand(`ln -sfn "${target}" "${linkPath}" && ls -la "${linkPath}"`);
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
        const r = await fetch(`http://${ueOpts.host}/v2/testcases/${encodeURIComponent(tcId)}/executions`, {
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
        const finalState = await pollExecutionToTerminal(ueOpts.host, token, tcId, execId, durSec, opts.signal);
        const verdict = (finalState?.result ?? '').toUpperCase();
        // Box uses several status/result combos. Treat anything in the
        // PASS family as ok; the rest (FAIL, ERROR, INCOMPLETE, ABORTED,
        // STOPPED, plus "no state" = timed out) as fail.
        const passLike = verdict === 'PASS' || verdict === 'PASSED' || finalState?.status === 'Passed';
        steps.push({
          testcaseId: `tc:${tcId}`, status: r.status, ok: passLike,
          executionId: finalState?.executionId ?? execId,
          detail: finalState
            ? `status=${finalState.status ?? '?'} result=${finalState.result ?? '?'} dur=${finalState.durationSeconds ?? '?'}s`
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

  const safe = (s: string) => s.replace(/[^\w.\-]/g, '_');
  const steps: SuiteRunStep[] = [];
  let passed = 0, failed = 0;
  const total = items.length;
  let done = 0;

  // Cache of files currently on the callbox so we don't re-ls per item.
  let existing = new Set<string>();
  if (callboxSys) {
    try {
      const raw = await readCommand(callboxSys, 'ls -1 /root/enb/config 2>/dev/null');
      existing = new Set(raw.split('\n').map(s => s.trim()).filter(Boolean));
    } catch { /* uploads still attempt */ }
  }

  const token = await login(ueOpts.host, ueOpts.username, ueOpts.password).catch(() => '');
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const defaultDur = suite.defaultDurationSec ?? 10;

  for (const item of items) {
    if (opts.signal?.aborted) break;
    opts.onProgress?.(done, total, item.name);
    const t0 = Date.now();
    const stepDetails: string[] = [];
    let itemOk = true;

    // ── Phase 1-3: callbox bring-up (only if cfg + callbox present)
    if (callboxSys && item.callboxCfg) {
      const cfg = item.callboxCfg;
      const safeName = safe(cfg);
      const target = `/root/enb/config/${safeName}`;
      const linkPath = `/root/enb/config/enb.cfg`;
      const isUpload = !!suite.uploadedConfigs?.[cfg];

      try {
        if (isUpload) {
          const b64 = suite.uploadedConfigs![cfg];
          const buf = Buffer.from(b64, 'base64');
          await withSsh(callboxSys, async (ssh) => {
            const sftp = await ssh.requestSFTP();
            await new Promise<void>((resolve, reject) => {
              const ws = sftp.createWriteStream(target);
              ws.on('close', () => resolve());
              ws.on('error', reject);
              ws.end(buf);
            });
          });
          existing.add(safeName);
          stepDetails.push(`cfg-push: uploaded ${buf.length}B`);
        } else if (!existing.has(cfg) && !existing.has(safeName)) {
          throw new Error(`cfg "${cfg}" missing on callbox /root/enb/config`);
        } else {
          stepDetails.push(`cfg-push: present`);
        }

        await withSsh(callboxSys, async (ssh) => {
          const r = await ssh.execCommand(`ln -sfn "${target}" "${linkPath}"`);
          if (r.code !== 0) throw new Error(`ln: ${r.stderr || r.stdout || `exit ${r.code}`}`);
        });
        stepDetails.push(`cfg-link: ${linkPath} → ${safeName}`);

        // The Simnovator callbox uses `service lte restart` — not systemd.
        // Going through sudo so the simqa SSH user doesn't need to be root.
        const restartCmd = `sudo service lte restart`;
        await withSsh(callboxSys, async (ssh) => {
          const r = await ssh.execCommand(restartCmd);
          if (r.code !== 0) throw new Error(`restart: ${r.stderr || r.stdout || `exit ${r.code}`}`);
        });
        await new Promise(r => setTimeout(r, 15_000));
        stepDetails.push(`cfg-restart: lte restarted + 15s settle`);
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

    // ── Phase 4-5: trigger + poll the Simnovator testcase
    if (!token) {
      steps.push({ testcaseId: item.name, status: 0, ok: false, detail: `${stepDetails.join(' · ')}${stepDetails.length ? ' · ' : ''}simnovator login failed`, durationMs: Date.now() - t0 });
      failed += 1; done += 1;
      if (suite.stopOnFail) break;
      continue;
    }
    const durSec = item.durationSec ?? defaultDur;
    try {
      const r = await fetch(`http://${ueOpts.host}/v2/testcases/${encodeURIComponent(item.simnovatorTcId)}/executions`, {
        method: 'POST', headers: H, body: '{}',
      });
      const j: any = await r.json().catch(() => ({}));
      const triggerOk = r.ok || r.status === 200 || r.status === 201;
      const execId: string | undefined = j?.executionId ?? j?.id;
      if (!triggerOk) {
        steps.push({
          testcaseId: item.name, status: r.status, ok: false,
          executionId: execId,
          detail: `${stepDetails.join(' · ')}${stepDetails.length ? ' · ' : ''}trigger ${r.status}: ${typeof j === 'object' ? JSON.stringify(j).slice(0, 160) : ''}`,
          durationMs: Date.now() - t0,
        });
        failed += 1;
        if (suite.stopOnFail) { done += 1; break; }
        done += 1;
        continue;
      }
      const finalState = await pollExecutionToTerminal(ueOpts.host, token, item.simnovatorTcId, execId, durSec, opts.signal);
      const verdict = (finalState?.result ?? '').toUpperCase();
      const passLike = verdict === 'PASS' || verdict === 'PASSED' || finalState?.status === 'Passed';
      steps.push({
        testcaseId: item.name, status: r.status, ok: passLike,
        executionId: finalState?.executionId ?? execId,
        detail: `${stepDetails.join(' · ')}${stepDetails.length ? ' · ' : ''}${finalState
          ? `status=${finalState.status ?? '?'} result=${finalState.result ?? '?'} dur=${finalState.durationSeconds ?? '?'}s`
          : `triggered but no terminal state within ${durSec}s`}`,
        durationMs: Date.now() - t0,
      });
      if (passLike) passed += 1; else { failed += 1; if (suite.stopOnFail) { done += 1; break; } }
    } catch (e: any) {
      steps.push({ testcaseId: item.name, status: 0, ok: false, detail: `threw: ${e?.message ?? e}`, durationMs: Date.now() - t0 });
      failed += 1;
      if (suite.stopOnFail) { done += 1; break; }
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
    total, passed, failed, steps,
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
    diagnostics,
  };
  saveRun(rec);
  return rec;
}

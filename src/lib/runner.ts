// Full-loop runner: pull testcase -> generate -> deploy -> trigger -> poll -> collect.
// Used by the web UI's POST /api/runs and the CLI's `simqa run` subcommand.

import {
  ensureToken, getTestcase, listSimulators,
  startExecution, getBoxVersion, type TestcaseSummary,
} from './uesimClient';
import { runRunVerification } from './verification';
import { generateConfigs, type UesimTestDefinition } from './cfgGenerator';
import { deployBundle } from './deploy';
import {
  type Inventory, type TopologyProfile, type InventorySystem,
  getProfile, getSystem, uesimApiOptsFromInventory,
} from './inventory';
import {
  type RunRecord, type RunStep,
  newRunId, newBatchId, ensureRunDir, writeRunFile, saveRun,
} from './runStore';

export interface RunRequest {
  testcaseId: string;
  topologyId?: string;
  dryRun?: boolean;
  /** Skip trigger + poll. Useful for cfg-only round-trips. */
  noTrigger?: boolean;
  /** Polling cap in seconds. Default 300. */
  pollTimeoutSec?: number;
  /** Polling interval in seconds. Default 5. */
  pollIntervalSec?: number;
  /** Group identifier for automation-suite batches. */
  batchId?: string;
  /** Suite id this run was spawned from. */
  suiteId?: string;
}

export interface BatchRunRequest {
  testcaseIds: string[];
  topologyId?: string;
  dryRun?: boolean;
  noTrigger?: boolean;
  /** Stop the batch as soon as one testcase fails. */
  stopOnFail?: boolean;
  suiteId?: string;
  pollTimeoutSec?: number;
  pollIntervalSec?: number;
}

function step(name: string, ok: boolean, detail?: string, ms?: number): RunStep {
  return { name, ok, detail, ms };
}

/** Pick the deploy targets from a topology profile, in deploy order. */
function planDeployTargets(inv: Inventory, profile: TopologyProfile): InventorySystem[] {
  const order: Array<keyof TopologyProfile> = ['mme', 'ims', 'callbox', 'enb', 'gnb', 'appserver'];
  const seen = new Set<string>();
  const out: InventorySystem[] = [];
  for (const role of order) {
    const sysId = profile[role] as string | undefined;
    if (!sysId || seen.has(sysId)) continue;
    const sys = getSystem(inv, sysId);
    if (!sys) continue;
    seen.add(sysId);
    out.push(sys);
  }
  return out;
}

/** Files relevant to a single target (callbox gets everything, MME-only gets mme/ims/ue_db). */
function filesForTarget(target: InventorySystem, files: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  const include = (...names: string[]) => names.forEach((n) => { if (files[n]) out[n] = files[n]; });
  switch (target.type) {
    case 'CALLBOX': include('mme.cfg', 'ims.cfg', 'enb.cfg', 'gnb.cfg', 'ue_db.cfg'); break;
    case 'ENB':
    case 'GNB':     include('enb.cfg', 'gnb.cfg'); break;
    case 'MME':     include('mme.cfg', 'ue_db.cfg'); break;
    case 'IMS':     include('ims.cfg'); break;
    default:        // APPSERVER / UESIM: nothing pushed yet.
                    break;
  }
  return out;
}

export async function executeRun(inv: Inventory, req: RunRequest): Promise<RunRecord> {
  const id = newRunId();
  const run: RunRecord = {
    id,
    testcaseId: req.testcaseId,
    topology: req.topologyId,
    startedAt: new Date().toISOString(),
    status: 'running',
    steps: [],
    dryRun: !!req.dryRun,
    evidenceFiles: [],
    batchId: req.batchId,
    suiteId: req.suiteId,
  };
  saveRun(run);

  // 1. Resolve UESIM API opts (from topology -> inventory, or inventory default).
  const profile = req.topologyId ? getProfile(inv, req.topologyId) : undefined;
  const uesimSys = profile ? getSystem(inv, profile.uesim) : undefined;
  const apiOpts =
    (uesimSys && {
      host: uesimSys.host,
      username: uesimSys.uesim?.username ?? 'admin',
      password: uesimSys.uesim?.password ?? 'admin',
    }) ||
    uesimApiOptsFromInventory(inv);
  if (!apiOpts) {
    run.steps.push(step('preflight', false, 'No UESIM system in inventory.yaml'));
    run.status = 'failed';
    run.finishedAt = new Date().toISOString();
    saveRun(run);
    return run;
  }

  // 2. Preflight: login + capture box version.
  try {
    const t0 = Date.now();
    await ensureToken(apiOpts.host, apiOpts.username, apiOpts.password);
    run.steps.push(step('preflight-login', true, `${apiOpts.host}`, Date.now() - t0));
  } catch (e: any) {
    run.steps.push(step('preflight-login', false, e?.message ?? String(e)));
    run.status = 'failed';
    run.finishedAt = new Date().toISOString();
    saveRun(run);
    return run;
  }
  // Best-effort version capture (the /version endpoint sometimes 401s; we
  // tolerate that and just record "unknown").
  try {
    const v = await getBoxVersion(apiOpts);
    if (v) {
      run.boxVersion = { version: v.version, build: v.build };
      run.steps.push(step('box-version', true, [v.version, v.build].filter(Boolean).join(' / ') || 'reported'));
    } else {
      run.steps.push(step('box-version', true, 'unknown (endpoint not exposing version to admin token)'));
    }
  } catch (e: any) {
    run.steps.push(step('box-version', true, `unavailable (${e?.message ?? e})`));
  }
  saveRun(run);

  // 3. Generate.
  let bundle: ReturnType<typeof generateConfigs>;
  let tc: TestcaseSummary & { testDefinition?: UesimTestDefinition };
  try {
    const t0 = Date.now();
    tc = await getTestcase(apiOpts, req.testcaseId);
    if (!tc.testDefinition) throw new Error('testcase has no testDefinition');
    bundle = generateConfigs(tc.testDefinition as UesimTestDefinition, req.testcaseId);
    ensureRunDir(id);
    for (const [name, content] of Object.entries(bundle.files)) {
      writeRunFile(id, name, content);
      run.evidenceFiles!.push(name);
    }
    writeRunFile(id, 'summary.json', JSON.stringify(bundle.summary, null, 2));
    run.evidenceFiles!.push('summary.json');
    run.generatorSummary = bundle.summary;
    run.steps.push(step(
      'generate',
      true,
      `${Object.keys(bundle.files).join(', ')} (${bundle.summary.cells}-cell ${bundle.summary.ratType}, ${bundle.summary.ueCount} UE${bundle.summary.ueCount === 1 ? '' : 's'})`,
      Date.now() - t0,
    ));
  } catch (e: any) {
    run.steps.push(step('generate', false, e?.message ?? String(e)));
    run.status = 'failed';
    run.finishedAt = new Date().toISOString();
    saveRun(run);
    return run;
  }
  saveRun(run);

  // 4. Deploy. If no topology given, just record "skipped".
  if (!profile) {
    run.steps.push(step('deploy', true, 'skipped (no topology profile)'));
  } else {
    const targets = planDeployTargets(inv, profile);
    if (targets.length === 0) {
      run.steps.push(step('deploy', true, 'skipped (topology has no deploy targets)'));
    } else {
      let allOk = true;
      for (const target of targets) {
        const files = filesForTarget(target, bundle.files);
        if (Object.keys(files).length === 0) {
          run.steps.push(step(`deploy:${target.id}`, true, 'no relevant files for this target'));
          continue;
        }
        const t0 = Date.now();
        const r = await deployBundle(target, files, { dryRun: !!req.dryRun });
        const detail = r.modules
          .map((m) => `${m.module}:${m.ok ? 'ok' : 'fail'}` + (m.error ? `(${m.error})` : ''))
          .join(' ');
        run.steps.push(step(`deploy:${target.id}`, r.ok, detail, Date.now() - t0));
        if (!r.ok) { allOk = false; break; }
      }
      if (!allOk) {
        run.status = 'failed';
        run.finishedAt = new Date().toISOString();
        saveRun(run);
        return run;
      }
    }
  }
  saveRun(run);

  // 5. Trigger + poll. Skipped on dry-run / no-trigger.
  if (req.dryRun || req.noTrigger) {
    run.steps.push(step('trigger', true, req.dryRun ? 'skipped (dry-run)' : 'skipped (--no-trigger)'));
  } else {
    try {
      const t0 = Date.now();
      const r = await startExecution(apiOpts, req.testcaseId, {});
      run.steps.push(step('trigger', true, JSON.stringify(r), Date.now() - t0));
    } catch (e: any) {
      run.steps.push(step('trigger', false, e?.message ?? String(e)));
      run.status = 'failed';
      run.finishedAt = new Date().toISOString();
      saveRun(run);
      return run;
    }

    const intervalSec = req.pollIntervalSec ?? 5;
    const timeoutSec  = req.pollTimeoutSec ?? 300;
    const maxPolls = Math.max(1, Math.ceil(timeoutSec / intervalSec));
    let terminal = false;
    let lastExecution: any;
    for (let i = 0; i < maxPolls; i++) {
      await new Promise((r) => setTimeout(r, intervalSec * 1000));
      try {
        const refreshed = await getTestcase(apiOpts, req.testcaseId);
        const last: any = (refreshed.metadata as any)?.lastExecution;
        const status = last?.status ?? '?';
        if (status === 'COMPLETED' || status === 'ABORTED' || status === 'STOPPED') {
          writeRunFile(id, 'execution.json', JSON.stringify(last, null, 2));
          run.evidenceFiles!.push('execution.json');
          run.steps.push(step('poll', last?.result === 'PASS', `status=${status} result=${last?.result ?? '?'}`));
          lastExecution = last;
          terminal = true;
          break;
        }
      } catch {
        // Transient; keep polling.
      }
    }
    if (!terminal) run.steps.push(step('poll', false, `timeout after ${timeoutSec}s`));

    // Verification: pull stats + simulator state and produce a structured
    // verdict report. Done even on FAIL/ABORTED so failures get diagnostic
    // context (suspicious-zero criteria, out-of-range counters, etc.).
    if (lastExecution) {
      try {
        const t0 = Date.now();
        const token = await ensureToken(apiOpts.host, apiOpts.username, apiOpts.password);
        const simulatorId = lastExecution.simulatorId ?? lastExecution.simulator_id;
        const report = await runRunVerification(apiOpts, token, lastExecution, simulatorId);
        run.verification = report;
        writeRunFile(id, 'verification.json', JSON.stringify(report, null, 2));
        run.evidenceFiles!.push('verification.json');
        const dimMsg = `${report.overall.toUpperCase()} (` +
          (Object.values(report.dimensions) as Array<{ name: string; ok: boolean; hasWarnings: boolean }>)
            .map((d) => `${d.name}=${d.ok ? 'ok' : 'fail'}${d.hasWarnings ? '!' : ''}`).join(' ') + ')';
        run.steps.push(step('verify', report.overall !== 'fail', dimMsg, Date.now() - t0));
      } catch (e: any) {
        run.steps.push(step('verify', false, `verification failed: ${e?.message ?? String(e)}`));
      }
    }
  }

  // 6. Final verdict.
  const failed = run.steps.some((s) => !s.ok);
  run.status = failed ? 'failed' : 'passed';
  run.finishedAt = new Date().toISOString();
  saveRun(run);
  return run;
}

export async function discoverSimulators(inv: Inventory) {
  const apiOpts = uesimApiOptsFromInventory(inv);
  if (!apiOpts) return { items: [] as any[] };
  return listSimulators(apiOpts);
}

/**
 * Run an entire automation suite. One RunRecord is created per testcase, all
 * sharing a freshly minted batchId. Returns the batchId immediately - the
 * actual loop runs in the background; callers poll GET /api/runs/batch/<id>.
 *
 * `stopOnFail` mirrors the suite's policy: skip remaining cases on first failure.
 */
export async function executeBatch(inv: Inventory, req: BatchRunRequest): Promise<{ batchId: string }> {
  const batchId = newBatchId();
  // Fire and forget. Each run is tagged with the batchId so the batch view
  // can list them. The HTTP handler returns the batchId immediately.
  void (async () => {
    for (const tcId of req.testcaseIds) {
      const result = await executeRun(inv, {
        testcaseId: tcId,
        topologyId: req.topologyId,
        dryRun: req.dryRun,
        noTrigger: req.noTrigger,
        batchId,
        suiteId: req.suiteId,
        pollTimeoutSec: req.pollTimeoutSec,
        pollIntervalSec: req.pollIntervalSec,
      });
      if (req.stopOnFail && result.status === 'failed') break;
    }
  })();

  return { batchId };
}

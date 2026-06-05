// Per-testcase executor for the bulk-tests pipeline.
//
// Drives, sequentially per box, this contract for each manifest entry:
//
//   1. trigger execution                 POST /v2/testcases/{boxId}/executions
//   2. wait for ue.cfg to land on the    (configFidelity/ueCfg flow — SSH read of
//      UE-sim with our log_filename       /root/ue/config/ue.cfg, gated on
//                                         log_filename to avoid stale cfgs)
//   3. always stop the execution        (system-wide mutex; otherwise next case
//                                         can't start)
//   4. export the testcase pack         POST /v2/testcases/export
//   5. on FAIL: capture diagnostic       SSH `screen -X -S lte hardcopy` +
//      evidence from the UE-sim          tail of /root/ue/logs/ots.log
//
// All evidence is written under
//
//   dist/build-reports/<build-slug>/testcase-evidence/<testcase-name>/
//     testcase.json    — export pack the box returned
//     ue.cfg           — raw UE config file pulled off the UE-sim
//     execution.json   — execution metadata captured during the run
//     error-trace.txt  — present only on failure: screen-log + ots.log tail
//
// We run sequentially because the box enforces a system-wide execution
// mutex. For large manifests, callers should pass a `sampleSize` so
// they don't kick off hours of runs.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Inventory, InventorySystem } from '../inventory';
import { getSystem, isUesimLike, uesimApiOptsForSystem } from '../inventory';
import { generateAndRetrieveUeCfg } from '../configFidelity/ueCfg';
import type { ApiOpts } from '../configFidelity/testCreator';
import { readCommand } from '../configFidelity/ssh';
import { buildReportsRoot, buildSlug } from './reportBuilder';
import type { CreatedTestcase } from './generator';

export interface ExecutionStepResult {
  step: 'trigger' | 'ue-cfg' | 'export' | 'evidence';
  ok: boolean;
  durationMs: number;
  detail?: string;
}

export interface ExecutionResult {
  /** Manifest id (qa-bulk-…). */
  id: string;
  /** Box-side testcase id. */
  boxId: string;
  /** Friendly name. */
  name: string;
  /** Per-step verdicts. */
  steps: ExecutionStepResult[];
  /** Final verdict — true iff every step passed. */
  ok: boolean;
  /** Total wall-clock duration. */
  durationMs: number;
  /** Box exec id, if captured. */
  executionId?: string;
  /** Where the evidence for this case was saved. Relative to the project root. */
  evidenceDir: string;
}

export interface ExecutionProgress {
  startedAt: string;
  finishedAt?: string;
  total: number;
  done: number;
  passed: number;
  failed: number;
  currentName?: string;
  aborted?: boolean;
}

export interface ExecutionSummary {
  startedAt: string;
  finishedAt: string;
  targetHost: string;
  buildVersion?: string;
  total: number;
  passed: number;
  failed: number;
  results: ExecutionResult[];
  /** Same evidence root all per-case folders sit under. */
  evidenceRoot: string;
}

interface ExecOptions {
  /** Inventory + the Simnovator system id (the "box"). */
  simnovatorSystemId: string;
  /** Inventory id of the UE-sim where /root/ue/config/ue.cfg gets written
   *  (usually sys-7 in the standard lab). */
  uesimSystemId: string;
  /** Manifest entries to execute, in order. */
  manifest: CreatedTestcase[];
  /** Cap how many of those to actually run — sequential execution + box's
   *  system-wide mutex make full-runs of >50 cases slow. */
  sampleSize?: number;
  /** Tracked-build version so evidence lands in the right per-build folder. */
  buildVersion?: string;
  /** Per-case timeout for the ue.cfg fetch + execution. Default 120s. */
  pollTimeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (p: ExecutionProgress) => void;
}

/** Login + JWT cache so we don't refresh per-case. */
async function login(api: ApiOpts): Promise<string> {
  const r = await fetch(`http://${api.host}/v2/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: api.username, password: api.password }),
  });
  if (!r.ok) throw new Error(`login: ${r.status}`);
  const d: any = await r.json();
  return d.access_token ?? d.token;
}

/** Run `cmd` over SSH and return stdout. Errors → empty string. */
async function safeSsh(sys: InventorySystem, cmd: string): Promise<string> {
  try { return await readCommand(sys, cmd); } catch { return ''; }
}

/** Best-effort multi-source diagnostic dump. We try a few likely targets:
 *   - `screen -X -S lte hardcopy /tmp/lte-screen.txt` (if a `lte` screen
 *     session exists, this dumps its buffer to disk)
 *   - cat /tmp/lte-screen.txt
 *   - tail -n 200 /root/ue/logs/ots.log
 *   - tail -n 80 /tmp/*.log
 * The combined output is written to error-trace.txt so a human can debug. */
async function captureErrorEvidence(uesimSys: InventorySystem): Promise<string> {
  const cmds: Array<{ label: string; cmd: string }> = [
    { label: 'uname',         cmd: 'uname -a; date' },
    { label: 'screen list',   cmd: 'screen -ls 2>&1 || true' },
    { label: 'screen lte buffer',
                              cmd: 'rm -f /tmp/lte-screen.txt; screen -S lte -X hardcopy /tmp/lte-screen.txt 2>/dev/null; sleep 1; cat /tmp/lte-screen.txt 2>/dev/null || echo "(no lte screen session)"' },
    { label: 'ots.log tail',  cmd: 'tail -n 200 /root/ue/logs/ots.log 2>/dev/null || tail -n 200 /tmp/ots.log 2>/dev/null || echo "(no ots.log found)"' },
    { label: 'tmp logs tail', cmd: 'for f in /tmp/*.log; do [ -f "$f" ] && echo "--- $f ---" && tail -n 80 "$f"; done 2>/dev/null || true' },
  ];
  const parts: string[] = [];
  for (const c of cmds) {
    const out = await safeSsh(uesimSys, c.cmd);
    parts.push(`==== ${c.label} ====\n${out.trim()}\n`);
  }
  return parts.join('\n');
}

async function exportTestcasePack(host: string, token: string, boxId: string): Promise<{ ok: boolean; status: number; body?: any }> {
  const r = await fetch(`http://${host}/v2/testcases/export`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ testCaseIds: [boxId] }),
  });
  if (!r.ok) return { ok: false, status: r.status };
  try {
    const body = await r.json();
    return { ok: true, status: r.status, body };
  } catch {
    return { ok: false, status: r.status };
  }
}

export async function executeBulkTestcases(
  inv: Inventory,
  opts: ExecOptions,
): Promise<ExecutionSummary> {
  const startedAt = new Date().toISOString();
  const sn = getSystem(inv, opts.simnovatorSystemId);
  const ue = getSystem(inv, opts.uesimSystemId);
  if (!sn || !ue) throw new Error(`missing system: sn=${!!sn} ue=${!!ue}`);

  const api = uesimApiOptsForSystem(inv, opts.simnovatorSystemId);
  if (!api) throw new Error(`system ${opts.simnovatorSystemId} not testable`);
  if (!isUesimLike(ue)) throw new Error(`ue-sim system ${opts.uesimSystemId} is not a UESIM-shaped node`);

  const evidenceRoot = path.join(
    buildReportsRoot(),
    buildSlug(opts.buildVersion),
    'testcase-evidence',
  );
  fs.mkdirSync(evidenceRoot, { recursive: true });

  const manifest = opts.sampleSize && opts.sampleSize > 0 ? opts.manifest.slice(0, opts.sampleSize) : opts.manifest;
  const progress: ExecutionProgress = { startedAt, total: manifest.length, done: 0, passed: 0, failed: 0 };
  const results: ExecutionResult[] = [];

  // We refresh the JWT once per case in case the run spans hours and the
  // Keycloak token (~24h on this build) eventually rolls.
  for (const m of manifest) {
    if (opts.signal?.aborted) { progress.aborted = true; break; }
    progress.currentName = m.name;
    opts.onProgress?.(progress);

    const caseDir = path.join(evidenceRoot, m.name);
    fs.mkdirSync(caseDir, { recursive: true });

    const t0 = Date.now();
    const steps: ExecutionStepResult[] = [];
    let failed = false;
    let executionId: string | undefined;

    // Step 1+2: trigger execution + retrieve ue.cfg. The configFidelity
    // helper handles both atomically (and stops the exec at the end so the
    // next case isn't blocked by the system-wide mutex).
    const t1 = Date.now();
    try {
      const cfg = await generateAndRetrieveUeCfg({
        api,
        ueSimSystem: ue,
        testCaseId: m.boxId,
        pollTimeoutMs: opts.pollTimeoutMs ?? 120_000,
        expectedName: m.name,
      });
      executionId = cfg.executionId;
      steps.push({ step: 'trigger', ok: !!cfg.executionId || cfg.signals.ueCfgPresent, durationMs: Date.now() - t1, detail: cfg.signals.executionStatus ? `status=${cfg.signals.executionStatus} result=${cfg.signals.executionResult ?? '?'}` : 'execution kicked off' });
      const ueCfgOk = cfg.signals.ueCfgPresent;
      steps.push({
        step: 'ue-cfg', ok: ueCfgOk, durationMs: Date.now() - t1,
        detail: ueCfgOk ? `ue.cfg pulled (${(cfg.rawUeCfg ?? '').length} bytes)` : (cfg.signals.executionDetail ?? 'no ue.cfg appeared within timeout'),
      });
      if (ueCfgOk && cfg.rawUeCfg) {
        fs.writeFileSync(path.join(caseDir, 'ue.cfg'), cfg.rawUeCfg);
      } else {
        failed = true;
      }
      // Always write the execution metadata so reviewers can pivot quickly.
      fs.writeFileSync(path.join(caseDir, 'execution.json'), JSON.stringify({
        testCaseId: m.boxId, testCaseName: m.name,
        executionId,
        status: cfg.signals.executionStatus,
        result: cfg.signals.executionResult,
        detail: cfg.signals.executionDetail,
      }, null, 2));
    } catch (e: any) {
      steps.push({ step: 'trigger', ok: false, durationMs: Date.now() - t1, detail: `threw: ${e?.message ?? e}` });
      steps.push({ step: 'ue-cfg', ok: false, durationMs: 0, detail: 'skipped — trigger threw' });
      failed = true;
    }

    // Step 3: export the testcase pack so QA has a portable artifact named
    // for the test. (Done even on failure — the pack lets a human re-run
    // the failing testcase elsewhere.)
    const t2 = Date.now();
    try {
      const token = await login(api);
      const pack = await exportTestcasePack(api.host, token, m.boxId);
      if (pack.ok && pack.body) {
        fs.writeFileSync(path.join(caseDir, 'testcase.json'), JSON.stringify(pack.body, null, 2));
        steps.push({ step: 'export', ok: true, durationMs: Date.now() - t2, detail: `${JSON.stringify(pack.body).length} bytes` });
      } else {
        steps.push({ step: 'export', ok: false, durationMs: Date.now() - t2, detail: `export returned ${pack.status}` });
        failed = true;
      }
    } catch (e: any) {
      steps.push({ step: 'export', ok: false, durationMs: Date.now() - t2, detail: `threw: ${e?.message ?? e}` });
      failed = true;
    }

    // Step 4: if anything failed, capture diagnostic evidence from the
    // UE-sim so QA can triage without re-running.
    if (failed) {
      const t3 = Date.now();
      try {
        const trace = await captureErrorEvidence(ue);
        fs.writeFileSync(path.join(caseDir, 'error-trace.txt'), trace);
        steps.push({ step: 'evidence', ok: true, durationMs: Date.now() - t3, detail: `error-trace.txt (${trace.length} bytes)` });
      } catch (e: any) {
        steps.push({ step: 'evidence', ok: false, durationMs: Date.now() - t3, detail: `capture failed: ${e?.message ?? e}` });
      }
    }

    results.push({
      id: m.id, boxId: m.boxId, name: m.name,
      steps, ok: !failed, durationMs: Date.now() - t0,
      executionId, evidenceDir: path.relative(process.cwd(), caseDir),
    });
    if (failed) progress.failed++; else progress.passed++;
    progress.done++;
    opts.onProgress?.(progress);
  }

  const finishedAt = new Date().toISOString();
  progress.finishedAt = finishedAt;
  opts.onProgress?.(progress);

  return {
    startedAt, finishedAt,
    targetHost: sn.host ?? opts.simnovatorSystemId,
    buildVersion: opts.buildVersion,
    total: manifest.length,
    passed: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok).length,
    results,
    evidenceRoot: path.relative(process.cwd(), evidenceRoot),
  };
}

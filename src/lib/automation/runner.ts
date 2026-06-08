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

import { loadInventory, getSystem, uesimApiOptsForSystem, type AutomationSuite } from '../inventory';
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

  for (const tcId of suite.testcaseIds) {
    if (opts.signal?.aborted) break;
    opts.onProgress?.(steps.length, suite.testcaseIds.length, tcId);
    const t0 = Date.now();
    try {
      const r = await fetch(`http://${ueOpts.host}/v2/testcases/${encodeURIComponent(tcId)}/executions`, {
        method: 'POST', headers: H, body: '{}',
      });
      const j: any = await r.json().catch(() => ({}));
      const ok = r.ok || r.status === 200 || r.status === 201;
      steps.push({
        testcaseId: tcId, status: r.status, ok,
        executionId: j?.executionId ?? j?.id,
        detail: ok ? 'execution kicked off' : (typeof j === 'object' ? JSON.stringify(j).slice(0, 200) : 'no body'),
        durationMs: Date.now() - t0,
      });
      if (ok) passed += 1; else failed += 1;
      if (!ok && suite.stopOnFail) break;
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

  // Total = callbox-config-push steps + Simnovator-trigger steps.
  // The page renders these as two prefixed sections (cfg:foo / tc:bar).
  const cfgs = suite.callboxConfigs ?? [];
  const tcs  = suite.testcaseIds;
  const total = cfgs.length + tcs.length;
  let done = 0;

  // ── Phase 1: push/verify callbox configs ─────────────────────────
  let existing = new Set<string>();
  try {
    const raw = await readCommand(sys, 'ls -1 /root/enb/config 2>/dev/null');
    existing = new Set(raw.split('\n').map(s => s.trim()).filter(Boolean));
  } catch { /* leave empty — uploads still attempt */ }

  for (const filename of cfgs) {
    if (opts.signal?.aborted) break;
    opts.onProgress?.(done, total, `cfg:${filename}`);
    const t0 = Date.now();
    const safeName = safe(filename);
    const target = `/root/enb/config/${safeName}`;
    const isUpload = !!suite.uploadedConfigs?.[filename];

    try {
      if (isUpload) {
        const b64 = suite.uploadedConfigs![filename];
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
          testcaseId: `cfg:${filename}`, status: 200, ok: true,
          detail: `uploaded ${buf.length}B → ${target} (overwrote=${existing.has(safeName)})`,
          durationMs: Date.now() - t0,
        });
        existing.add(safeName);
        passed += 1;
      } else {
        const ok = existing.has(filename) || existing.has(safeName);
        steps.push({
          testcaseId: `cfg:${filename}`, status: ok ? 200 : 404, ok,
          detail: ok ? `present at ${target}` : `missing on callbox /root/enb/config`,
          durationMs: Date.now() - t0,
        });
        if (ok) passed += 1; else { failed += 1; if (suite.stopOnFail) break; }
      }
    } catch (e: any) {
      steps.push({ testcaseId: `cfg:${filename}`, status: 0, ok: false, detail: `ssh: ${e?.message ?? e}`, durationMs: Date.now() - t0 });
      failed += 1;
      if (suite.stopOnFail) break;
    }
    done += 1;
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
    for (const tcId of tcs) {
      if (opts.signal?.aborted) break;
      opts.onProgress?.(done, total, `tc:${tcId}`);
      const t0 = Date.now();
      try {
        const r = await fetch(`http://${ueOpts.host}/v2/testcases/${encodeURIComponent(tcId)}/executions`, {
          method: 'POST', headers: H, body: '{}',
        });
        const j: any = await r.json().catch(() => ({}));
        const ok = r.ok || r.status === 200 || r.status === 201;
        steps.push({
          testcaseId: `tc:${tcId}`, status: r.status, ok,
          executionId: j?.executionId ?? j?.id,
          detail: ok ? 'execution kicked off' : (typeof j === 'object' ? JSON.stringify(j).slice(0, 200) : 'no body'),
          durationMs: Date.now() - t0,
        });
        if (ok) passed += 1; else { failed += 1; if (suite.stopOnFail) break; }
      } catch (e: any) {
        steps.push({ testcaseId: `tc:${tcId}`, status: 0, ok: false, detail: `threw: ${e?.message ?? e}`, durationMs: Date.now() - t0 });
        failed += 1;
        if (suite.stopOnFail) break;
      }
      done += 1;
    }
    buildVersion = await fetchBuildVersion(ueOpts.host, token);
  }
  opts.onProgress?.(total, total);

  return {
    startedAt, finishedAt: new Date().toISOString(),
    suiteId: suite.id, suiteName: suite.name, kind: 'uesim+callbox',
    uesimHost: ueOpts.host,
    callboxHost: sys.host,
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

  const summary = suite.kind === 'uesim+callbox'
    ? await runCallbox(suite, opts)
    : await runUesimOnly(suite, opts);

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

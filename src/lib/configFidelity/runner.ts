// Config-Fidelity matrix runner. Drives, per case:
//   create (testCreator) -> execute+retrieve ue.cfg (ueCfg) -> validate
//   (validate + mapping) -> persist. Sequential per target box (the product
//   enforces a system-wide execution mutex). Live status is parked on
//   globalThis so it survives Next.js dev HMR (same trick as endToEnd/runner).

import * as fs from 'fs';
import * as path from 'path';
import type { Inventory } from '../inventory';
import { uesimApiOptsForSystem, isUesimLike } from '../inventory';
import type { InventorySystem } from '../inventory';
import { listSimulators } from '../uesimClient';
import type { Case, CaseOutcome } from './types';
import { generateMatrix, type MatrixRequest } from './paramSpace';
import { createTestCase, deleteTestCase, CreateError, type ApiOpts } from './testCreator';
import { generateAndRetrieveUeCfg } from './ueCfg';
import { validateConfig, detectConfigErrors } from './validate';
import { buildCoverage, rollupCounts, compareToBaseline, type MatrixReport } from './report';

export interface CfRunRequest extends MatrixRequest {
  targetSystemId?: string;   // API target (Simnovator). Defaults to first UESIM-like.
  ueSimSystemId?: string;    // SSH host where ue.cfg is written. Defaults to target.
  keepOnFail?: boolean;      // leave failing testcases on the box for triage
  baselineRunId?: string;    // compare against a prior run
  pollTimeoutMs?: number;
}

interface ActiveRun { report: MatrixReport; cases: Case[]; canceled: boolean; }

const g = globalThis as any;
const runs: Map<string, ActiveRun> = (g.__cfRuns ??= new Map());

const ROOT = path.join(process.cwd(), 'data', 'config-fidelity');
const runDir = (id: string) => path.join(ROOT, id);
const reportPath = (id: string) => path.join(runDir(id), 'report.json');

function persist(report: MatrixReport): void {
  fs.mkdirSync(runDir(report.runId), { recursive: true });
  const tmp = reportPath(report.runId) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(report, null, 2), 'utf8');
  fs.renameSync(tmp, reportPath(report.runId));
}

function writeArtifact(runId: string, caseId: string, name: string, content: string): string {
  const d = path.join(runDir(runId), caseId.replace(/[^A-Za-z0-9_.-]/g, '_'));
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, name), content);
  return `${caseId}/${name}`;
}

function newRunId(): string {
  const d = new Date(); const p = (n: number) => String(n).padStart(2, '0');
  return `cf-${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

function resolveUeSim(inv: Inventory, req: CfRunRequest, apiSystemId: string): InventorySystem | undefined {
  const want = req.ueSimSystemId ?? apiSystemId;
  return inv.systems.find((s) => s.id === want && s.username)
    ?? inv.systems.find((s) => s.id === want)
    ?? inv.systems.find((s) => isUesimLike(s) && s.username);
}

export function startMatrixRun(inv: Inventory, req: CfRunRequest): { runId: string } | { error: string } {
  const api = uesimApiOptsForSystem(inv, req.targetSystemId);
  if (!api) return { error: 'no Simnovator/UESIM system in inventory (set targetSystemId)' };
  const ueSim = resolveUeSim(inv, req, api.systemId);
  if (!ueSim) return { error: 'no UE-sim system with SSH credentials found (needed to read ue.cfg)' };

  const cases = generateMatrix(req);
  if (cases.length === 0) return { error: 'matrix produced 0 cases (pick at least one RAT)' };

  const runId = newRunId();
  const report: MatrixReport = {
    runId, startedAt: new Date().toISOString(), status: 'running',
    targetSystemId: api.systemId, targetHost: api.host, ueSimSystemId: ueSim.id,
    mode: req.mode ?? 'pairwise',
    counts: { total: cases.length, passed: 0, failed: 0, error: 0, skipped: 0, done: 0 },
    coverage: { byFeature: {}, byCriticality: { critical: { pass: 0, fail: 0 }, normal: { pass: 0, fail: 0 }, 'non-critical': { pass: 0, fail: 0 } }, tagsCovered: [], paramsWithNoRule: [] },
    cases: [],
  };
  const active: ActiveRun = { report, cases, canceled: false };
  runs.set(runId, active);
  persist(report);

  // Fire-and-forget background loop.
  void runLoop(active, { host: api.host, username: api.username, password: api.password }, ueSim, req).catch((e) => {
    report.status = 'failed';
    report.finishedAt = new Date().toISOString();
    (report as any).fatal = e?.message ?? String(e);
    persist(report);
  });

  return { runId };
}

async function runLoop(active: ActiveRun, apiOpts: ApiOpts, ueSim: InventorySystem, req: CfRunRequest): Promise<void> {
  const { report, cases } = active;
  // One simulator id for stop() calls (best-effort).
  let simulatorId: string | undefined;
  try { simulatorId = (await listSimulators(apiOpts)).items?.[0]?.id; } catch { /* optional */ }

  for (const c of cases) {
    if (active.canceled) break;
    const outcome = await runOneCase(apiOpts, ueSim, simulatorId, c, report.runId, req);
    (outcome as any).tags = c.tags;
    report.cases.push(outcome);
    report.counts = rollupCounts(report.cases, cases.length);
    report.coverage = buildCoverage(report.cases);
    persist(report);
  }

  if (active.canceled) report.status = 'cancelled';
  else report.status = report.cases.every((c) => c.pass) ? 'passed' : 'failed';
  report.finishedAt = new Date().toISOString();

  if (req.baselineRunId) {
    const base = loadReport(req.baselineRunId);
    if (base) report.baseline = compareToBaseline(report.cases, base.cases, req.baselineRunId);
  }
  persist(report);
  // GC the in-memory entry after a grace period.
  setTimeout(() => runs.delete(report.runId), 60_000);
}

async function runOneCase(api: ApiOpts, ueSim: InventorySystem, simulatorId: string | undefined, c: Case, runId: string, req: CfRunRequest): Promise<CaseOutcome> {
  const started = Date.now();
  const outcome: CaseOutcome = { caseId: c.id, rat: c.rat, description: c.description, phase: 'creating', pass: false, configErrors: [], artifacts: [] };
  let testCaseId: string | undefined;
  try {
    // 1. Create.
    const created = await createTestCase(api, c);
    testCaseId = created.testCaseId;
    outcome.testCaseId = testCaseId;

    // 2. Execute + retrieve ue.cfg.
    outcome.phase = 'executing';
    const gen = await generateAndRetrieveUeCfg({ api, ueSimSystem: ueSim, testCaseId, simulatorId, pollTimeoutMs: req.pollTimeoutMs, expectedName: (c.settings as any)?.settings?.testCaseName });
    outcome.executionId = gen.executionId;

    // 3. Config errors + fidelity.
    outcome.phase = 'validating';
    outcome.configErrors = detectConfigErrors(gen.signals);
    if (gen.ueCfg) {
      outcome.validation = validateConfig(c.input, gen.ueCfg);
      outcome.artifacts!.push(writeArtifact(runId, c.id, 'ue.cfg', gen.rawUeCfg ?? JSON.stringify(gen.ueCfg, null, 2)));
      outcome.artifacts!.push(writeArtifact(runId, c.id, 'diff.json', JSON.stringify(outcome.validation, null, 2)));
    }
    outcome.artifacts!.push(writeArtifact(runId, c.id, 'input.json', JSON.stringify(c.input, null, 2)));

    const fidelityOk = outcome.validation?.ok ?? false;
    outcome.pass = outcome.configErrors.length === 0 && fidelityOk;
    outcome.phase = outcome.pass ? 'passed' : 'failed';
  } catch (e: any) {
    if (e instanceof CreateError) {
      // The box refused the config at creation — that IS a config error.
      outcome.configErrors.push({ source: 'execution', message: e.message });
      outcome.phase = 'failed';
    } else {
      outcome.error = e?.message ?? String(e);
      outcome.phase = 'error';
    }
  } finally {
    // 4. Cleanup unless asked to keep failures for triage.
    if (testCaseId && !(req.keepOnFail && !outcome.pass)) {
      await deleteTestCase(api, testCaseId).catch(() => {});
    }
    outcome.durationMs = Date.now() - started;
  }
  return outcome;
}

export function getMatrixStatus(runId: string): MatrixReport | undefined {
  return runs.get(runId)?.report ?? loadReport(runId);
}

export function abortMatrixRun(runId: string): boolean {
  const a = runs.get(runId);
  if (!a) return false;
  a.canceled = true;
  return true;
}

export function loadReport(runId: string): MatrixReport | undefined {
  try { return JSON.parse(fs.readFileSync(reportPath(runId), 'utf8')) as MatrixReport; }
  catch { return undefined; }
}

export function listMatrixRuns(limit = 50): Array<Pick<MatrixReport, 'runId' | 'startedAt' | 'finishedAt' | 'status' | 'counts'>> {
  try {
    const ids = fs.readdirSync(ROOT).filter((d) => d.startsWith('cf-'));
    const reports = ids.map(loadReport).filter(Boolean) as MatrixReport[];
    reports.sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
    return reports.slice(0, limit).map((r) => ({ runId: r.runId, startedAt: r.startedAt, finishedAt: r.finishedAt, status: r.status, counts: r.counts }));
  } catch { return []; }
}

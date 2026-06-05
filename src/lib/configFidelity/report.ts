// Config-Fidelity report model + aggregation/export helpers.

import type { CaseOutcome, Criticality } from './types';

export interface CoverageBucket { pass: number; fail: number; }

export interface MatrixReport {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'passed' | 'failed' | 'cancelled';
  targetSystemId: string;
  targetHost: string;
  ueSimSystemId: string;
  mode: string;
  counts: { total: number; passed: number; failed: number; error: number; skipped: number; done: number };
  coverage: {
    byFeature: Record<string, CoverageBucket>;
    byCriticality: Record<Criticality, CoverageBucket>;
    tagsCovered: string[];
    paramsWithNoRule: string[];   // input paths we have no mapping for yet
  };
  cases: CaseOutcome[];
  baseline?: BaselineDiff;
}

export interface BaselineDiff {
  baselineRunId: string;
  regressions: string[];   // caseId: pass→fail
  fixes: string[];         // caseId: fail→pass
  unchanged: number;
}

export function buildCoverage(cases: CaseOutcome[]): MatrixReport['coverage'] {
  const byFeature: Record<string, CoverageBucket> = {};
  const byCriticality: Record<Criticality, CoverageBucket> = {
    critical: { pass: 0, fail: 0 }, normal: { pass: 0, fail: 0 }, 'non-critical': { pass: 0, fail: 0 },
  };
  const tags = new Set<string>();
  const noRule = new Set<string>();

  for (const c of cases) {
    for (const p of c.validation?.params ?? []) {
      const f = (byFeature[p.feature] ??= { pass: 0, fail: 0 });
      const good = p.status === 'honoured';
      if (good) { f.pass++; byCriticality[p.criticality].pass++; }
      else { f.fail++; byCriticality[p.criticality].fail++; }
      if (p.status === 'no-rule') noRule.add(p.inputPath);
    }
  }
  // Tags come from the case specs; the runner attaches them on outcomes' meta.
  for (const c of cases) for (const t of (c as any).tags ?? []) tags.add(t);

  return { byFeature, byCriticality, tagsCovered: [...tags], paramsWithNoRule: [...noRule] };
}

export function rollupCounts(cases: CaseOutcome[], total: number): MatrixReport['counts'] {
  return {
    total,
    passed: cases.filter((c) => c.phase === 'passed').length,
    failed: cases.filter((c) => c.phase === 'failed').length,
    error: cases.filter((c) => c.phase === 'error').length,
    skipped: cases.filter((c) => c.phase === 'skipped').length,
    done: cases.length,
  };
}

export function compareToBaseline(current: CaseOutcome[], baseline: CaseOutcome[], baselineRunId: string): BaselineDiff {
  const prev = new Map(baseline.map((c) => [c.caseId, c.pass]));
  const regressions: string[] = []; const fixes: string[] = []; let unchanged = 0;
  for (const c of current) {
    if (!prev.has(c.caseId)) continue;
    const was = prev.get(c.caseId);
    if (was === c.pass) unchanged++;
    else if (was && !c.pass) regressions.push(c.caseId);
    else if (!was && c.pass) fixes.push(c.caseId);
  }
  return { baselineRunId, regressions, fixes, unchanged };
}

export function toCsv(cases: CaseOutcome[]): string {
  const rows = [['caseId', 'rat', 'pass', 'phase', 'configErrors', 'honoured', 'missing', 'mismatch', 'error']];
  for (const c of cases) {
    rows.push([
      c.caseId, c.rat, String(c.pass), c.phase, String(c.configErrors.length),
      String(c.validation?.counts.honoured ?? ''), String(c.validation?.counts.missing ?? ''),
      String(c.validation?.counts.mismatch ?? ''), (c.error ?? '').replace(/[\r\n,]+/g, ' '),
    ]);
  }
  return rows.map((r) => r.map((x) => /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x).join(',')).join('\n');
}

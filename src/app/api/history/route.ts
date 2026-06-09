// GET /api/history[?surface=&targetSystemId=&since=&limit=]
//
// Cross-surface run history — the single aggregator behind /runs. Reads
// data/history/ (the forward-written unified store) AND folds in runs
// from EVERY per-surface store that predates or bypasses the unified
// store, so no run ever silently vanishes:
//   - data/runs/*.json                       → 'end-to-end' (legacy runner)
//   - data/config-fidelity/cf-*/report.json  → 'config-fidelity' (never wired forward)
//   - data/bulk-tests/validation-*.json      → 'bulk-validate' (old runs predating wiring)
// Folded entries are deduped against forward-written data/history entries
// by (surface, startedAt) so wired runs aren't double-counted.
//
// Filter params:
//   surface  one of historyStore Surface; may be passed multiple times
//   targetSystemId  inventory id; lab-uesim / sys-2 / sys-6 / …
//   since    ISO timestamp lower bound (inclusive)
//   limit    cap on the newest-N (default 200)

import { NextResponse } from 'next/server';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { listHistoryEntries, type HistoryEntry, type Surface } from '@/lib/historyStore';

export const dynamic = 'force-dynamic';

const SURFACES: ReadonlySet<Surface> = new Set([
  'bulk-generate', 'bulk-validate', 'bulk-validate-ui', 'bulk-execute',
  'api-tests', 'ui-tests', 'config-fidelity', 'automation-suite',
  'end-to-end', 'build-check', 'perf-qa',
] as const);

function parseSurfaces(url: URL): Surface[] | undefined {
  const all = url.searchParams.getAll('surface').filter(s => SURFACES.has(s as Surface)) as Surface[];
  return all.length > 0 ? all : undefined;
}

/** Read every data/runs/<id>.json and project it as a HistoryEntry with
 *  surface='end-to-end'. The legacy runner pre-dates the history store,
 *  so without this folding the old runs would silently vanish from the
 *  unified page. */
function legacyRunsAsHistory(): HistoryEntry[] {
  const dir = path.join(process.cwd(), 'data', 'runs');
  const out: HistoryEntry[] = [];
  try {
    if (!fs.existsSync(dir)) return [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (!r?.id || !r?.startedAt) continue;
        const passed = r.status === 'passed' ? 1 : 0;
        const failed = r.status === 'failed' ? 1 : 0;
        out.push({
          id: r.id,
          surface: 'end-to-end',
          label: `end-to-end · ${r.testcaseId ?? '?'}`,
          startedAt: r.startedAt,
          finishedAt: r.finishedAt ?? r.startedAt,
          targetHost: r.steps?.find?.((s: any) => s.name === 'preflight-login')?.detail,
          buildVersion: r.boxVersion?.version,
          total: 1, passed, failed,
          detailPath: `data/runs/${r.id}.json`,
          meta: {
            testcaseId: r.testcaseId,
            topology: r.topology,
            dryRun: !!r.dryRun,
            stepCount: r.steps?.length ?? 0,
            failedStep: r.steps?.find?.((s: any) => !s.ok)?.name,
            batchId: r.batchId,
            suiteId: r.suiteId,
          },
        });
      } catch { /* skip malformed */ }
    }
  } catch { /* dir missing */ }
  return out;
}

/** Fold in config-fidelity runs from each data/config-fidelity/cf-<id>
 *  run dir's report.json. Config-fidelity never wrote to the unified
 *  store, so EVERY cf run is recovered here (past + future). No dedup. */
function configFidelityRunsAsHistory(): HistoryEntry[] {
  const dir = path.join(process.cwd(), 'data', 'config-fidelity');
  const out: HistoryEntry[] = [];
  try {
    if (!fs.existsSync(dir)) return [];
    for (const d of fs.readdirSync(dir)) {
      const reportPath = path.join(dir, d, 'report.json');
      if (!fs.existsSync(reportPath)) continue;
      try {
        const r = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
        if (!r?.runId || !r?.startedAt) continue;
        const c = r.counts ?? {};
        const total = c.total ?? 0;
        const passed = c.passed ?? 0;
        const failed = (c.failed ?? 0) + (c.error ?? 0);
        out.push({
          id: r.runId,
          surface: 'config-fidelity',
          label: `Config fidelity (${r.mode ?? 'matrix'}) · ${total} cases · ${passed} pass / ${failed} fail`,
          startedAt: r.startedAt,
          finishedAt: r.finishedAt ?? r.startedAt,
          targetSystemId: r.targetSystemId,
          targetHost: r.targetHost,
          total, passed, failed,
          skipped: c.skipped,
          detailPath: `data/config-fidelity/${r.runId}/report.json`,
          meta: { mode: r.mode, ueSimSystemId: r.ueSimSystemId, status: r.status, coverage: r.coverage },
        });
      } catch { /* skip malformed */ }
    }
  } catch { /* dir missing */ }
  return out;
}

/** Fold in bulk-tests validation summaries from
 *  data/bulk-tests/validation-*.json. Newer runs ALSO write a data/history
 *  entry, so the caller dedups these by (surface, startedAt). Recovers
 *  runs that predate the unified-history wiring. */
function bulkValidationsAsHistory(): HistoryEntry[] {
  const dir = path.join(process.cwd(), 'data', 'bulk-tests');
  const out: HistoryEntry[] = [];
  try {
    if (!fs.existsSync(dir)) return [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith('validation-') || !f.endsWith('.json')) continue;
      try {
        const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (!r?.startedAt) continue;
        const total = r.total ?? 0;
        out.push({
          id: `bulkval-${f.replace(/\.json$/, '')}`,
          surface: 'bulk-validate',
          label: `Bulk validate · ${total} testcases · ${r.passed ?? 0} pass / ${r.failed ?? 0} fail`,
          startedAt: r.startedAt,
          finishedAt: r.finishedAt ?? r.startedAt,
          targetHost: r.targetHost,
          total, passed: r.passed ?? 0, failed: r.failed ?? 0,
          detailPath: `data/bulk-tests/${f}`,
        });
      } catch { /* skip malformed */ }
    }
  } catch { /* dir missing */ }
  return out;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const surfaces = parseSurfaces(url);
  const targetSystemId = url.searchParams.get('targetSystemId') ?? undefined;
  const since = url.searchParams.get('since') ?? undefined;
  const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit') ?? 200)));

  const direct = listHistoryEntries({ surface: surfaces, targetSystemId, since, limit: 10_000 });

  // Dedup key for folded entries — wired surfaces write data/history AND
  // their per-surface file with the SAME run startedAt, so we key on
  // (surface, startedAt) to avoid double-counting.
  const seen = new Set(direct.map(e => `${e.surface}|${e.startedAt}`));
  const wants = (s: Surface) => !surfaces || surfaces.includes(s);
  const passesFilter = (e: HistoryEntry) => {
    if (targetSystemId && e.targetSystemId !== targetSystemId) return false;
    if (since && e.startedAt < since) return false;
    if (seen.has(`${e.surface}|${e.startedAt}`)) return false;
    return true;
  };

  let combined = direct;
  // Legacy end-to-end runner (data/runs/*.json).
  if (wants('end-to-end')) {
    combined = combined.concat(legacyRunsAsHistory().filter(passesFilter));
  }
  // Config-fidelity — never wired forward, recover every run.
  if (wants('config-fidelity')) {
    combined = combined.concat(configFidelityRunsAsHistory().filter(passesFilter));
  }
  // Old bulk-tests validation summaries (deduped against wired entries).
  if (wants('bulk-validate')) {
    combined = combined.concat(bulkValidationsAsHistory().filter(passesFilter));
  }

  // Sort once across all sources, then cap.
  combined.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const out = combined.slice(0, limit);

  // Stats roll-up — useful for the page header (no extra GET).
  const bySurface: Record<string, number> = {};
  for (const e of out) bySurface[e.surface] = (bySurface[e.surface] ?? 0) + 1;

  return NextResponse.json({
    ok: true,
    total: out.length,
    bySurface,
    entries: out,
  }, { headers: { 'Cache-Control': 'no-store' } });
}

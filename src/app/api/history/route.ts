// GET /api/history[?surface=&targetSystemId=&since=&limit=]
//
// Cross-surface run history. Reads from data/history/ (the new unified
// store) AND folds in entries synthesized from legacy data/runs/*.json
// (the original config-fidelity / end-to-end runner that pre-dated this
// store) so /runs surfaces every run that's ever fired against any lab.
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

export async function GET(req: Request) {
  const url = new URL(req.url);
  const surfaces = parseSurfaces(url);
  const targetSystemId = url.searchParams.get('targetSystemId') ?? undefined;
  const since = url.searchParams.get('since') ?? undefined;
  const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit') ?? 200)));

  const direct = listHistoryEntries({ surface: surfaces, targetSystemId, since, limit: 10_000 });

  // Fold in legacy E2E runs unless the caller filtered to surfaces that
  // exclude them.
  const wantsLegacy = !surfaces || surfaces.includes('end-to-end');
  let combined = direct;
  if (wantsLegacy) {
    const legacy = legacyRunsAsHistory().filter(e => {
      if (targetSystemId && e.targetSystemId !== targetSystemId) return false;
      if (since && e.startedAt < since) return false;
      return true;
    });
    combined = combined.concat(legacy);
  }

  // Sort once across both sources, then cap.
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

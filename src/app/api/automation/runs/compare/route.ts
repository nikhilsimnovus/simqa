// POST /api/automation/runs/compare
//   body: { runIds: [a, b] }
//
// Side-by-side diff of two runs. Joins their step arrays by testcaseId
// and classifies each row as:
//   matched-pass  both passed
//   matched-fail  both failed
//   regressed     a passed, b failed   (build got worse)
//   fixed         a failed, b passed   (build got better)
//   only-a / only-b  testcase exists in only one run
//
// The UI uses this to render a regression/fix delta when comparing
// runs across builds.

import { NextResponse } from 'next/server';
import { getRun, type RunRecord } from '@/lib/automation/runStore';

export const dynamic = 'force-dynamic';

type Verdict = 'matched-pass' | 'matched-fail' | 'regressed' | 'fixed' | 'only-a' | 'only-b';

interface CompareRow {
  testcaseId: string;
  a?: { status: number; ok: boolean; detail?: string };
  b?: { status: number; ok: boolean; detail?: string };
  verdict: Verdict;
}

function summarize(a: RunRecord | null, b: RunRecord | null) {
  if (!a || !b) return null;
  const byA = new Map(a.steps.map(s => [s.testcaseId, s]));
  const byB = new Map(b.steps.map(s => [s.testcaseId, s]));
  const ids = new Set<string>([...byA.keys(), ...byB.keys()]);
  const rows: CompareRow[] = [];
  let regressed = 0, fixed = 0, matchedPass = 0, matchedFail = 0;
  for (const id of ids) {
    const sa = byA.get(id);
    const sb = byB.get(id);
    let verdict: Verdict;
    if (sa && sb) {
      if (sa.ok && sb.ok)        { verdict = 'matched-pass'; matchedPass += 1; }
      else if (!sa.ok && !sb.ok) { verdict = 'matched-fail'; matchedFail += 1; }
      else if (sa.ok && !sb.ok)  { verdict = 'regressed';    regressed   += 1; }
      else                       { verdict = 'fixed';        fixed       += 1; }
    } else if (sa) {
      verdict = 'only-a';
    } else {
      verdict = 'only-b';
    }
    rows.push({
      testcaseId: id,
      a: sa ? { status: sa.status, ok: sa.ok, detail: sa.detail } : undefined,
      b: sb ? { status: sb.status, ok: sb.ok, detail: sb.detail } : undefined,
      verdict,
    });
  }
  // Surface regressions first, then fixes, then mismatches, then matched.
  const order: Record<Verdict, number> = {
    regressed: 0, fixed: 1, 'only-a': 2, 'only-b': 3, 'matched-fail': 4, 'matched-pass': 5,
  };
  rows.sort((x, y) => order[x.verdict] - order[y.verdict] || x.testcaseId.localeCompare(y.testcaseId));
  return {
    a: { runId: a.runId, suiteName: a.suiteName, buildVersion: a.buildVersion, finishedAt: a.finishedAt, passed: a.passed, failed: a.failed, total: a.total },
    b: { runId: b.runId, suiteName: b.suiteName, buildVersion: b.buildVersion, finishedAt: b.finishedAt, passed: b.passed, failed: b.failed, total: b.total },
    summary: { regressed, fixed, matchedPass, matchedFail, onlyA: rows.filter(r => r.verdict === 'only-a').length, onlyB: rows.filter(r => r.verdict === 'only-b').length, totalRows: rows.length },
    rows,
  };
}

export async function POST(req: Request) {
  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }
  const ids: string[] = Array.isArray(body.runIds) ? body.runIds : [];
  if (ids.length !== 2) return NextResponse.json({ ok: false, error: 'runIds must be a 2-element array' }, { status: 400 });
  const a = getRun(ids[0]);
  const b = getRun(ids[1]);
  if (!a || !b) return NextResponse.json({ ok: false, error: 'one or both runs not found' }, { status: 404 });
  return NextResponse.json({ ok: true, compare: summarize(a, b) });
}

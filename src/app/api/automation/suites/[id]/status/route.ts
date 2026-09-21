// GET /api/automation/suites/[id]/status
//
// Each testcase's MOST RECENT outcome, as { "<display name>": true|false }.
//
// The /runs listing deliberately returns summaries without steps, so the page
// cannot derive this from it. Walking the run records here keeps the response
// tiny (one boolean per row) instead of shipping every step to the browser.
//
// Newest run wins per row, not per run: executing a single testcase records
// only that one, and the other rows' earlier results are still the truth about
// them.

import { NextResponse } from 'next/server';
import { listRunsForSuite } from '@/lib/automation/runStore';
import type { SuiteRunStep } from '@/lib/automation/runner';

export const dynamic = 'force-dynamic';

/**
 * A one-line, human reason for a row's outcome — the thing shown on hover.
 *
 * It names the SOURCE, which is the actual question an operator has when a row
 * says "Failed": was it the Simnovator's own testcase verdict (the same PASS/
 * FAIL the box GUI shows), or did SimQA fail before the box ever judged it —
 * couldn't start the execution, couldn't reach/authenticate the box, or a
 * callbox cfg step failed. The runner already records all three shapes in the
 * step; this just words them.
 */
function reasonFor(step: SuiteRunStep): string {
  const d = (step.detail ?? '').trim();

  // The box ran it and returned its own verdict — same signal as the GUI.
  if (step.verdict) {
    const bits = [`Simnovator testcase verdict: ${step.verdict}`];
    if (step.boxStatus) bits.push(`box status ${step.boxStatus}`);
    if (step.stopped) bits.push('stopped by SimQA after the duration window');
    return bits.join(' · ');
  }

  // Failures on SimQA's side, before the box could judge the test.
  if (/^trigger\b/i.test(d)) return `SimQA could not start the execution on the box — ${d}`;
  if (/^threw:/i.test(d))    return `SimQA error while running the test — ${d.replace(/^threw:\s*/i, '')}`;
  if (/login/i.test(d))      return `SimQA could not reach or sign in to the box — ${d}`;
  if (/^cfg-/i.test(step.testcaseId)) return `Callbox configuration step failed — ${d}`;

  return d || (step.ok ? 'Passed' : 'Failed — no detail was recorded for this run');
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const runs = listRunsForSuite(id);          // newest first
    const statuses: Record<string, boolean> = {};
    const details: Record<string, string> = {};
    const lastRunAt: Record<string, string> = {};
    for (const run of runs) {
      for (const st of run?.steps ?? []) {
        if (!st?.testcaseId || st.testcaseId in statuses) continue;
        statuses[st.testcaseId] = !!st.ok;
        details[st.testcaseId] = reasonFor(st);
        if (run.finishedAt) lastRunAt[st.testcaseId] = run.finishedAt;
      }
    }
    return NextResponse.json({ ok: true, statuses, details, lastRunAt });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
  }
}

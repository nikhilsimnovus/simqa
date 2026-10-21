// GET    /api/jira-ui/runs/[runId] — one run, with every ticket's result
// DELETE /api/jira-ui/runs/[runId] — stop it
//
// Both verbs live in one file because Next routes by PATH: a second file at
// this path would replace this one's handlers rather than add to them.

import { NextResponse } from 'next/server';
import { readRun } from '@/lib/jiraUi/store';
import { jiraRunStatus, stopJiraRun } from '@/lib/jiraUi/execute';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ runId: string }> }) {
  const { runId } = await ctx.params;
  // The in-flight copy first: it is ahead of the file between two saves.
  const run = jiraRunStatus(runId) ?? readRun(runId);
  if (!run) return NextResponse.json({ ok: false, error: `no run "${runId}"` }, { status: 404 });
  return NextResponse.json({
    ok: true, run,
    counts: {
      total: run.requested.length,
      done: run.results.length,
      passed: run.results.filter((r) => r.status === 'PASS').length,
      failed: run.results.filter((r) => r.status === 'FAIL').length,
      blocked: run.results.filter((r) => r.status === 'BLOCKED').length,
      notExecuted: run.requested.length - run.results.length,
    },
  });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ runId: string }> }) {
  const { runId } = await ctx.params;
  return NextResponse.json({ ok: true, stopped: stopJiraRun(runId) });
}

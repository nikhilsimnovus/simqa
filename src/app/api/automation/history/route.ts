// GET /api/automation/history?limit=100
//
// Everything the Automation Suite has executed, newest first — the History
// tab's table. One row per RUN, not per suite: running three test cases out
// of ten is its own entry, and so is running one, because what was executed
// is part of what happened.
//
// A run still in flight is included, from the live progress registry, because
// the record in the run store is only written when it finishes and an
// operator wants to watch the thing they just started.
//
// Per-row status and verdict are the box's own words — see outcome.ts — so a
// row reads here exactly as it reads in the suite and on the Simnovator.

import { NextResponse } from 'next/server';
import { listAllRuns } from '@/lib/automation/runStore';
import { liveRuns } from '@/lib/automation/progress';
import { getSuite } from '@/lib/automation/store';
import { loadInventory, uesimApiOptsForSystem } from '@/lib/inventory';
import { statusLabel, verdictLabel } from '@/lib/automation/outcome';
import type { SuiteRunStep } from '@/lib/automation/runner';

export const dynamic = 'force-dynamic';

/** One test case within a run, as the table and the detail view show it. */
interface HistoryRow {
  name: string;
  status: string;
  verdict: string;
  /** Milliseconds this row took, when it has finished. */
  durationMs?: number;
  /** For the report link — the testcase the row actually executed. */
  boxTestcaseId?: string;
  executionId?: string;
  detail?: string;
}

/** How a whole run turned out, in one word, from the rows it ran. */
function overall(rows: HistoryRow[], live: boolean): string {
  if (live) return 'In Progress';
  if (!rows.length) return 'Not Executed';
  if (rows.some((r) => r.status === 'In Progress')) return 'In Progress';
  if (rows.every((r) => r.status === 'Completed')) return 'Completed';
  if (rows.some((r) => r.status === 'Aborted')) return 'Aborted';
  if (rows.every((r) => r.status === 'Not Executed')) return 'Not Executed';
  return 'Completed';
}

/** And its verdict: the worst thing any row came to. PASS only when they all
 *  did, because a run with one failure is not a run that passed. */
function overallVerdict(rows: HistoryRow[], live: boolean): string {
  if (live) return '';
  const said = rows.filter((r) => r.verdict);
  if (!said.length) return '';
  if (said.some((r) => r.verdict === 'FAIL')) return 'FAIL';
  if (said.some((r) => r.verdict === 'Error')) return 'Error';
  if (said.some((r) => r.verdict === 'Incomplete')) return 'Incomplete';
  if (said.every((r) => r.verdict === 'PASS')) return 'PASS';
  return said[0].verdict;
}

function rowOf(st: SuiteRunStep): HistoryRow {
  const o = { boxStatus: st.boxStatus, boxResult: st.boxResult, verdict: st.verdict, stopped: st.stopped };
  return {
    name: st.testcaseId,
    status: statusLabel(o),
    verdict: verdictLabel(o),
    durationMs: st.durationMs,
    boxTestcaseId: st.boxTestcaseId,
    executionId: st.executionId,
    detail: st.detail,
  };
}

/**
 * Every test case that was part of a run, in the order it was asked for.
 *
 * `steps` holds only what actually ran. A stopOnFail run that fails on row 1
 * of seven records one step — and the other six were part of that execution
 * too, they simply never got their turn. Listing the request and filling in
 * what happened is the difference between "this run did one thing" and "this
 * run was stopped after one of seven".
 *
 * A run recorded before `requested` existed has only its steps, which is the
 * honest answer: what was asked for was not written down.
 */
function rowsOf(r: { steps?: SuiteRunStep[]; requested?: string[] }): HistoryRow[] {
  // Run-level bookkeeping is not a test case. It stays in the record and
  // shows on the run detail; a table of test cases that listed
  // "licence-restore / Not Executed" among them would be describing a test
  // case that does not exist. Older records have no `kind`, so the one note
  // that predates it is named directly.
  const steps = (r.steps ?? []).filter((st) => st.kind !== 'note' && st.testcaseId !== 'licence-restore');
  if (!r.requested?.length) return steps.map(rowOf);

  // By name, and in step order within a name: a suite may legitimately hold
  // the same test case twice (User_Plane runs RTSP Upload and Download off
  // one source), and each occurrence gets its own result.
  const byName = new Map<string, SuiteRunStep[]>();
  for (const st of steps) {
    const list = byName.get(st.testcaseId) ?? [];
    list.push(st);
    byName.set(st.testcaseId, list);
  }

  const rows: HistoryRow[] = [];
  for (const name of r.requested) {
    const got = byName.get(name);
    const st = got?.shift();
    rows.push(st ? rowOf(st) : { name, status: 'Not Executed', verdict: '' });
  }
  // Anything that ran without having been asked for — a step the runner adds
  // for itself, like licence-restore. Kept rather than dropped: it is part of
  // what happened, and silently hiding steps is how a history starts lying.
  for (const [, left] of byName) for (const st of left) rows.push(rowOf(st));
  return rows;
}

export async function GET(req: Request) {
  const limit = Math.min(500, Math.max(1, Number(new URL(req.url).searchParams.get('limit') ?? 100)));

  // A live run has no record yet, so where it is executing has to come from
  // the suite it belongs to — the same resolution the runner itself does, so
  // the entry names the box and login it will be filed under.
  const inv = loadInventory();
  const live = liveRuns().map((p) => {
    const suite = getSuite(p.suiteId);
    const target = suite ? uesimApiOptsForSystem(inv, suite.uesimSystemId ?? '', suite.boxUserId) : undefined;
    const rows: HistoryRow[] = Object.entries(p.statuses ?? {}).map(([name, s]) => {
      const b = p.boxes?.[name];
      const o = { boxStatus: b?.status, boxResult: b?.result, verdict: b?.verdict, running: s === 'running' };
      return {
        name,
        status: s === 'running' ? 'In Progress' : statusLabel(o),
        verdict: s === 'running' ? '' : verdictLabel(o),
      };
    });
    return {
      // No runId yet — the record is written when the run finishes. The suite
      // is what a live entry can be opened by.
      runId: null as string | null,
      live: true,
      suiteId: p.suiteId,
      suiteName: p.suiteName,
      uesimHost: target?.host,
      boxUser: target?.boxUser,
      startedAt: p.startedAt,
      finishedAt: undefined as string | undefined,
      total: p.total,
      done: p.done,
      current: p.current,
      buildVersion: undefined as string | undefined,
      status: 'In Progress',
      verdict: '',
      rows,
    };
  });

  const saved = listAllRuns(limit).map((r) => {
    const rows = rowsOf(r);
    // Runs recorded before the login was kept on the record still have one —
    // the suite says which, and resolving it is what the runner did. Shown as
    // the suite's login rather than left blank, so the column is useful today
    // and not only for runs from here on. A suite since deleted, or since
    // pointed at a different login, simply has nothing to offer.
    const suite = r.boxUser ? undefined : getSuite(r.suiteId);
    const fallback = suite
      ? uesimApiOptsForSystem(inv, suite.uesimSystemId ?? '', suite.boxUserId)?.boxUser
      : undefined;
    return {
      runId: r.runId,
      live: false,
      suiteId: r.suiteId,
      suiteName: r.suiteName,
      uesimHost: r.uesimHost,
      boxUser: r.boxUser ?? fallback,
      callboxHost: r.callboxHost,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      total: r.total,
      done: rows.length,
      passed: r.passed,
      failed: r.failed,
      buildVersion: r.buildVersion,
      submittedBy: r.submittedBy,
      status: overall(rows, false),
      verdict: overallVerdict(rows, false),
      rows,
    };
  });

  // Live first: it is the thing being watched.
  return NextResponse.json({ ok: true, runs: [...live, ...saved] });
}

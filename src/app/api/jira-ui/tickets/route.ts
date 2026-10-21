// GET /api/jira-ui/tickets?category=<name>[&runnableOnly=1]
//
// The tickets in one category, each with everything the result row has to
// show before it has been run: the Jira id and link, the summary, what should
// happen and where that came from, what the reporter saw, the steps that will
// be walked, and — when it cannot be run — the reason.
//
// Descriptions are NOT returned. They are up to several kilobytes each and
// the row shows the parsed steps instead, so a 297-ticket category stays a
// response you can load rather than a megabyte of markdown.

import { NextResponse } from 'next/server';
import { readTickets } from '@/lib/jiraUi/store';
import { planTicket } from '@/lib/jiraUi/steps';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const db = readTickets();
  if (!db) return NextResponse.json({ ok: false, error: 'no Jira tickets stored yet' }, { status: 404 });

  const q = new URL(req.url).searchParams;
  const category = q.get('category') ?? '';
  const runnableOnly = q.get('runnableOnly') === '1';

  let rows = db.tickets;
  // No category means every ticket — what "Run all categories" lists.
  if (category && category !== '*') rows = rows.filter((t) => t.category === category);

  const out = rows.map((t) => {
    const p = planTicket(t);
    return {
      key: t.key,
      url: t.url,
      summary: t.summary,
      category: t.category,
      categoryWhy: t.categoryWhy,
      // Jira's own view of the ticket, kept separate from any automation
      // result: requirement 8 says the two must not be confused.
      jiraStatus: t.status,
      jiraResolution: t.resolution,
      type: t.type,
      priority: t.priority,
      testTypes: t.testTypes,
      reporter: t.reporter,
      updated: t.updated,
      expected: p.expected,
      expectedSource: p.expectedSource,
      observed: p.observed,
      pages: p.pages,
      steps: p.steps.map((s) => ({ n: s.n, text: s.text, page: s.page, isCheck: s.isCheck })),
      runnable: p.runnability.runnable,
      blockedReason: p.runnability.runnable ? undefined : p.runnability.reason,
    };
  });

  const filtered = runnableOnly ? out.filter((t) => t.runnable) : out;
  return NextResponse.json({
    ok: true,
    category: category || '*',
    total: filtered.length,
    runnable: out.filter((t) => t.runnable).length,
    blocked: out.filter((t) => !t.runnable).length,
    tickets: filtered,
  });
}

// GET /api/jira-ui/categories
//
// The Jira categories the UI Test Profile offers, with the counts that decide
// whether a category is worth running: how many tickets it holds, and how
// many of those can honestly be executed.
//
// The second number is the one that matters. A category with 297 tickets of
// which 83 are runnable is a different proposition from one with 16 of which
// 11 are, and showing only the total would invite a Run that mostly reports
// "cannot be tested".
//
// Derived on every request from the stored tickets rather than cached: the
// list has to follow a Jira refresh, and 996 tickets cost milliseconds.

import { NextResponse } from 'next/server';
import { readTickets, recordingAvailable } from '@/lib/jiraUi/store';
import { planTicket } from '@/lib/jiraUi/steps';
import { UNCLASSIFIED } from '@/lib/jiraUi/categorise';

export const dynamic = 'force-dynamic';

export async function GET() {
  const db = readTickets();
  if (!db) {
    return NextResponse.json(
      { ok: false, error: 'no Jira tickets stored yet — refresh from Jira, or check that seed/jira-ui/tickets.json shipped with this build' },
      { status: 404 },
    );
  }

  const byName = new Map<string, { total: number; runnable: number; blocked: number }>();
  for (const t of db.tickets) {
    const name = t.category || UNCLASSIFIED;
    if (!byName.has(name)) byName.set(name, { total: 0, runnable: 0, blocked: 0 });
    const c = byName.get(name) as { total: number; runnable: number; blocked: number };
    c.total += 1;
    if (planTicket(t).runnability.runnable) c.runnable += 1; else c.blocked += 1;
  }

  const categories = [...byName.entries()]
    .map(([name, c]) => ({ name, ...c }))
    // Most runnable first — that is the order you would pick one in.
    // Unclassified last whatever its size: it is a triage list.
    .sort((a, b) => (a.name === UNCLASSIFIED ? 1 : b.name === UNCLASSIFIED ? -1
      : b.runnable - a.runnable || b.total - a.total));

  return NextResponse.json({
    ok: true,
    project: db.project,
    projectName: db.projectName,
    reporters: db.reporters,
    fetchedAt: db.fetchedAt,
    categorisedAt: db.categorisedAt,
    total: db.total,
    runnable: categories.reduce((n, c) => n + c.runnable, 0),
    categories,
    // Said before anything is started, so "where are my videos" is answered
    // up front rather than after a run — see requirement 5.
    recordingAvailable: recordingAvailable(),
  });
}

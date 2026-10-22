'use client';

// The Jira half of the UI Test Profile.
//
// 996 SIM40 tickets from Jay, Mohanraj and Sruthi, grouped into the
// categories their own labels and wording imply. Pick a category, see its
// tickets, and run them — each one on its own, with its own evidence.
//
// Two things this panel refuses to do, both for the same reason: it never
// shows a ticket as runnable when its Jira ticket states no expected result
// and implies none, and it never implies a recording exists when ffmpeg is
// missing from the server. A testing tool that overstates what it verified
// is worse than no tool.

import React, { useCallback, useEffect, useMemo, useState } from 'react';

interface Category { name: string; total: number; runnable: number; blocked: number }
interface CategoriesResponse {
  ok: boolean; error?: string;
  project?: string; projectName?: string; reporters?: string[];
  fetchedAt?: string; total?: number; runnable?: number;
  categories?: Category[]; recordingAvailable?: boolean;
}
interface Step { n: number; text: string; page?: string; isCheck: boolean }
interface Ticket {
  key: string; url: string; summary: string; category: string; categoryWhy?: string[];
  jiraStatus: string; jiraResolution: string; type: string; priority: string;
  testTypes: string[]; reporter: string; updated: string;
  expected: string; expectedSource: 'stated' | 'derived' | 'none';
  observed: string; pages: string[]; steps: Step[];
  runnable: boolean; blockedReason?: string;
}

interface Result {
  key: string; summary: string; category: string; status: string;
  expected: string; actual: string; error?: string; failedStep?: string;
  recording?: string; recordingUnavailable?: string; screenshots: string[];
  startedAt: string; finishedAt?: string; durationMs: number;
}
interface RunCounts { total: number; done: number; passed: number; failed: number; blocked: number; notExecuted: number }

/**
 * A Jira ticket shaped like the page's own result rows.
 *
 * The results list, its All/Failed/Passed/Pending chips and its search box
 * already exist and already work. Building a second list beside them would
 * mean two places to look and two sets of filters to keep in step, so the
 * tickets are handed over in the shape that list already renders.
 */
export interface JiraRow {
  id: string;
  number: number;
  name: string;
  description: string;
  category: string;
  severity: 'critical' | 'normal' | 'optional';
  state: 'pass' | 'fail' | 'skip' | 'pending';
  detail?: string;
  expected?: string;
  durationMs?: number;
  /** The ticket's own evidence, for the expanded panel. */
  jiraKey: string;
  jiraUrl: string;
  recording?: string;
  recordingUnavailable?: string;
  screenshots?: string[];
  failedStep?: string;
}

export default function JiraCategories({ systemId, headless, onRows }: {
  systemId?: string;
  headless?: boolean;
  /** Hands the chosen category's tickets to the page's results list. */
  onRows?: (rows: JiraRow[]) => void;
}) {
  const [meta, setMeta] = useState<CategoriesResponse | null>(null);
  const [picked, setPicked] = useState<string>('');
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [runnableOnly, setRunnableOnly] = useState(false);
  const [runId, setRunId] = useState('');
  const [results, setResults] = useState<Record<string, Result>>({});
  const [counts, setCounts] = useState<RunCounts | null>(null);
  const [running, setRunning] = useState(false);
  const [max, setMax] = useState('10');
  /** Which status the list is filtered to. 'ALL' shows everything. */
  const [statusFilter, setStatusFilter] = useState<string>('ALL');

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/jira-ui/categories').then((x) => x.json());
      setMeta(r);
      if (!r.ok) setError(r.error ?? 'could not load the Jira categories');
    } catch (e: any) { setError(e?.message ?? String(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const pick = useCallback(async (name: string) => {
    setPicked(name); setTickets([]); setError(''); setStatusFilter('ALL');
    if (!name) return;
    setLoading(true);
    try {
      const r = await fetch(`/api/jira-ui/tickets?category=${encodeURIComponent(name)}`).then((x) => x.json());
      if (!r.ok) throw new Error(r.error ?? 'could not load the tickets');
      setTickets(r.tickets ?? []);
    } catch (e: any) { setError(e?.message ?? String(e)); }
    finally { setLoading(false); }
  }, []);

  // Poll the run while it goes. Results are written per ticket, so this
  // fills the rows in as each one finishes rather than at the end.
  useEffect(() => {
    if (!runId) return;
    let stop = false;
    const tick = async () => {
      try {
        const r = await fetch(`/api/jira-ui/runs/${runId}`).then((x) => x.json());
        if (stop || !r.ok) return;
        setCounts(r.counts);
        const map: Record<string, Result> = {};
        for (const res of r.run.results ?? []) map[res.key] = res;
        setResults(map);
        if (!r.run.live) { setRunning(false); stop = true; }
      } catch { /* transient */ }
    };
    void tick();
    const h = setInterval(tick, 2500);
    return () => { stop = true; clearInterval(h); };
  }, [runId]);

  const start = useCallback(async (body: Record<string, unknown>) => {
    if (!systemId) { setError('pick a System above first — the run signs in to it'); return; }
    setError(''); setRunning(true); setResults({}); setCounts(null);
    try {
      const r = await fetch('/api/jira-ui/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ systemId, headless: headless !== false, ...body }),
      }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error ?? 'the run could not be started');
      setRunId(r.runId);
    } catch (e: any) { setError(e?.message ?? String(e)); setRunning(false); }
  }, [systemId, headless]);

  const stopRun = useCallback(async () => {
    if (!runId) return;
    await fetch(`/api/jira-ui/runs/${runId}`, { method: 'DELETE' }).catch(() => {});
  }, [runId]);

  /** A ticket's status: the run's verdict once there is one, and before that
   *  BLOCKED for anything that cannot be tested at all. */
  const statusOf = useCallback(
    (t: Ticket) => results[t.key]?.status ?? (t.runnable ? 'NOT EXECUTED' : 'BLOCKED'),
    [results],
  );

  /** How many tickets sit under each chip. Counted over the whole category,
   *  not the filtered view, or the chips would change as you click them. */
  const tallies = useMemo(() => {
    const n: Record<string, number> = { ALL: tickets.length, PASS: 0, FAIL: 0, BLOCKED: 0, 'NOT EXECUTED': 0 };
    for (const t of tickets) n[statusOf(t)] = (n[statusOf(t)] ?? 0) + 1;
    return n;
  }, [tickets, statusOf]);

  // Hand the tickets to the page's results list, in its own row shape, so
  // they appear under the All/Failed/Passed/Pending chips that are already
  // there rather than in a second list with a second set of filters.
  useEffect(() => {
    if (!onRows) return;
    onRows(tickets.map((t, i) => {
      const res = results[t.key];
      const state: JiraRow['state'] = res?.status === 'PASS' ? 'pass'
        : res?.status === 'FAIL' ? 'fail'
        // BLOCKED is not a failure of the product — it is a ticket that could
        // not be asserted. 'skip' is the list's word for that.
        : res?.status === 'BLOCKED' || !t.runnable ? 'skip'
        : 'pending';
      return {
        id: `jira:${t.key}`,
        number: i + 1,
        name: `${t.key} — ${t.summary}`,
        description: t.runnable
          ? (t.expected || 'no expected result stated')
          : (t.blockedReason ?? 'cannot be tested'),
        category: t.category,
        severity: 'normal' as const,
        state,
        detail: res ? (res.error ? `${res.actual} · ${res.error}` : res.actual) : undefined,
        expected: t.expected || undefined,
        durationMs: res?.durationMs,
        jiraKey: t.key,
        jiraUrl: t.url,
        recording: res?.recording,
        recordingUnavailable: res?.recordingUnavailable,
        screenshots: res?.screenshots,
        failedStep: res?.failedStep,
      };
    }));
  }, [tickets, results, onRows]);
  const summary = useMemo(() => ({
    total: tickets.length,
    runnable: tickets.filter((t) => t.runnable).length,
    blocked: tickets.filter((t) => !t.runnable).length,
  }), [tickets]);

  if (!meta) return <p className="text-xs text-slate-500">Loading Jira categories…</p>;
  if (!meta.ok) {
    return (
      <div className="text-xs rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800">
        {meta.error}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[11px] text-slate-500">
        <span>
          <b className="text-slate-800">{meta.total}</b> tickets from {meta.project} ·{' '}
          <b className="text-slate-800">{meta.runnable}</b> runnable
        </span>
        <span>{meta.categories?.length} categories</span>
        {meta.fetchedAt && <span>fetched {new Date(meta.fetchedAt).toLocaleString()}</span>}
        {/* Said before anything runs, not after. */}
        <span className={meta.recordingAvailable ? 'text-emerald-700' : 'text-amber-700'}>
          {meta.recordingAvailable
            ? 'per-ticket recording available'
            : 'recording unavailable on this server (ffmpeg missing) — runs will say so rather than claim a video'}
        </span>
      </div>

      {error && (
        <div className="text-xs rounded-md border border-red-200 bg-red-50 px-3 py-2 text-red-700">{error}</div>
      )}

      {/* Categories on the left, the chosen one's tickets on the right.
          A category list that pushed 297 rows beneath it meant scrolling
          past the whole thing to reach the next category. */}
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(13rem,17rem)_1fr] gap-3 items-start">
        <div className="space-y-1 lg:max-h-[38rem] lg:overflow-y-auto lg:pr-1">
          {(meta.categories ?? []).map((c) => (
            <button key={c.name} type="button" onClick={() => void pick(c.name)}
              className={'w-full text-left rounded-md border px-2.5 py-2 transition-colors '
                + (picked === c.name
                  ? 'border-primary-400 bg-primary-50'
                  : 'border-line hover:bg-slate-50')}>
              <div className="text-xs font-medium text-slate-900 leading-snug">{c.name}</div>
              <div className="mt-0.5 text-[11px] text-slate-500 tabular-nums">
                <b className="text-slate-800">{c.total}</b> ·{' '}
                <span className={c.runnable > 0 ? 'text-emerald-700' : 'text-slate-400'}>
                  {c.runnable} runnable
                </span>
                {c.blocked > 0 && <> · <span className="text-amber-700">{c.blocked} blocked</span></>}
              </div>
            </button>
          ))}
        </div>

        {!picked ? (
          <div className="rounded-md border border-dashed border-line px-4 py-10 text-center">
            <p className="text-xs text-slate-500">Pick a category to see its tickets.</p>
          </div>
        ) : (
        <div className="rounded-md border border-line min-w-0">
          {/* Category summary — requirement 7. Real counts; the executed ones
              fill in once a run exists. */}
          <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-line bg-slate-50/60">
            <span className="text-xs font-semibold text-slate-900">{picked}</span>
            {/* Real counts, from the run as it goes — not placeholders. */}
            <span className="text-[11px] text-slate-600 tabular-nums">
              {summary.total} total · {summary.runnable} runnable ·{' '}
              <b className="text-emerald-700">{tallies.PASS ?? 0} passed</b> ·{' '}
              <b className="text-red-700">{tallies.FAIL ?? 0} failed</b> ·{' '}
              <b className="text-amber-700">{tallies.BLOCKED ?? 0} blocked</b> ·{' '}
              {tallies['NOT EXECUTED'] ?? 0} pending
              {counts && counts.total > 0 && (
                <> · {Math.round((counts.done / Math.max(1, counts.total)) * 100)}% complete</>
              )}
            </span>
            <label className="ml-auto flex items-center gap-1.5 text-[11px] text-slate-600">
              <input type="checkbox" checked={runnableOnly}
                onChange={(e) => setRunnableOnly(e.target.checked)} className="accent-primary-600" />
              runnable only
            </label>
          </div>

          {/* Requirement 7's actions. Bounded by default: a 297-ticket
              category is hours of browser time, and each ticket gets its own
              context and its own video. */}
          <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-line">
            <button type="button" disabled={running || summary.runnable === 0}
              onClick={() => void start({ category: picked, runnableOnly: true, max: Number(max) || 10 })}
              className="rounded-md bg-primary-600 hover:bg-primary-700 disabled:bg-slate-300 text-white text-[11px] font-semibold px-3 py-1.5">
              ▶ Run Category
            </button>
            <button type="button" disabled={running || Object.values(results).every((r) => r.status !== 'FAIL')}
              onClick={() => void start({
                category: picked,
                keys: Object.values(results).filter((r) => r.status === 'FAIL').map((r) => r.key),
              })}
              className="rounded-md border border-slate-300 hover:bg-slate-50 disabled:text-slate-400 text-[11px] px-3 py-1.5">
              Rerun Failed
            </button>
            {running && (
              <button type="button" onClick={() => void stopRun()}
                className="rounded-md bg-red-600 hover:bg-red-700 text-white text-[11px] font-semibold px-3 py-1.5">
                ⏹ Stop
              </button>
            )}
            <label className="flex items-center gap-1 text-[11px] text-slate-600">
              max
              <input value={max} onChange={(e) => setMax(e.target.value)}
                className="w-14 border border-slate-300 rounded px-1 py-0.5 text-[11px]" />
            </label>
            {counts && (
              <span className="text-[11px] tabular-nums text-slate-700">
                {counts.done}/{counts.total} ·{' '}
                <b className="text-emerald-700">{counts.passed} passed</b> ·{' '}
                <b className="text-red-700">{counts.failed} failed</b> ·{' '}
                <b className="text-amber-700">{counts.blocked} blocked</b> ·{' '}
                {counts.notExecuted} not executed ·{' '}
                {Math.round((counts.done / Math.max(1, counts.total)) * 100)}%
              </span>
            )}
            {!systemId && (
              <span className="text-[11px] text-amber-700">pick a System above — the run signs in to it</span>
            )}
          </div>

          {/* The tickets themselves are rendered by the page's results
              list below, under its own All/Failed/Passed/Pending chips and
              its search box. One list, one set of filters -- two would have
              meant two places to look and two things to keep in step. */}
          <p className="px-3 py-2 text-[11px] text-slate-500">
            {loading
              ? 'Loading tickets…'
              : `${summary.total} ticket${summary.total === 1 ? '' : 's'} listed below — `
                + 'filter them with All / Failed / Passed / Pending, search them, and press '
                + '▶ on any row to run that one on its own.'}
          </p>
        </div>
        )}
      </div>
    </div>
  );
}

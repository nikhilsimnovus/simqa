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

/** PASS green, FAIL red, BLOCKED amber, NOT EXECUTED grey — requirement 6. */
const STATUS_STYLE: Record<string, string> = {
  'PASS': 'bg-emerald-50 text-emerald-800 border-emerald-200',
  'FAIL': 'bg-red-50 text-red-700 border-red-200',
  'BLOCKED': 'bg-amber-50 text-amber-800 border-amber-200',
  'NOT EXECUTED': 'bg-slate-50 text-slate-500 border-slate-200',
};

export default function JiraCategories() {
  const [meta, setMeta] = useState<CategoriesResponse | null>(null);
  const [picked, setPicked] = useState<string>('');
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string>('');
  const [runnableOnly, setRunnableOnly] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/jira-ui/categories').then((x) => x.json());
      setMeta(r);
      if (!r.ok) setError(r.error ?? 'could not load the Jira categories');
    } catch (e: any) { setError(e?.message ?? String(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const pick = useCallback(async (name: string) => {
    setPicked(name); setTickets([]); setError(''); setOpen('');
    if (!name) return;
    setLoading(true);
    try {
      const r = await fetch(`/api/jira-ui/tickets?category=${encodeURIComponent(name)}`).then((x) => x.json());
      if (!r.ok) throw new Error(r.error ?? 'could not load the tickets');
      setTickets(r.tickets ?? []);
    } catch (e: any) { setError(e?.message ?? String(e)); }
    finally { setLoading(false); }
  }, []);

  const shown = useMemo(
    () => (runnableOnly ? tickets.filter((t) => t.runnable) : tickets),
    [tickets, runnableOnly],
  );
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

      {/* Categories. The runnable count is shown beside the total because it
          is what decides whether running the category is worth it. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1.5">
        {(meta.categories ?? []).map((c) => (
          <button key={c.name} type="button" onClick={() => void pick(c.name)}
            className={'text-left rounded-md border px-2.5 py-2 transition-colors '
              + (picked === c.name
                ? 'border-primary-400 bg-primary-50'
                : 'border-line hover:bg-slate-50')}>
            <div className="text-xs font-medium text-slate-900 leading-snug">{c.name}</div>
            <div className="mt-0.5 text-[11px] text-slate-500 tabular-nums">
              <b className="text-slate-800">{c.total}</b> tickets ·{' '}
              <span className={c.runnable > 0 ? 'text-emerald-700' : 'text-slate-400'}>
                {c.runnable} runnable
              </span>
              {c.blocked > 0 && <> · <span className="text-amber-700">{c.blocked} blocked</span></>}
            </div>
          </button>
        ))}
      </div>

      {error && (
        <div className="text-xs rounded-md border border-red-200 bg-red-50 px-3 py-2 text-red-700">{error}</div>
      )}

      {picked && (
        <div className="rounded-md border border-line">
          {/* Category summary — requirement 7. Real counts; the executed ones
              fill in once a run exists. */}
          <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-line bg-slate-50/60">
            <span className="text-xs font-semibold text-slate-900">{picked}</span>
            <span className="text-[11px] text-slate-600 tabular-nums">
              {summary.total} total · {summary.runnable} runnable · {summary.blocked} blocked ·
              {' '}0 passed · 0 failed · {summary.total} not executed
            </span>
            <label className="ml-auto flex items-center gap-1.5 text-[11px] text-slate-600">
              <input type="checkbox" checked={runnableOnly}
                onChange={(e) => setRunnableOnly(e.target.checked)} className="accent-primary-600" />
              runnable only
            </label>
          </div>

          {loading ? (
            <p className="px-3 py-3 text-xs text-slate-500">Loading tickets…</p>
          ) : shown.length === 0 ? (
            <p className="px-3 py-3 text-xs text-slate-500">No tickets to show.</p>
          ) : (
            <div className="max-h-[32rem] overflow-y-auto divide-y divide-slate-100">
              {shown.map((t) => {
                const status = t.runnable ? 'NOT EXECUTED' : 'BLOCKED';
                return (
                  <div key={t.key} className="px-3 py-2">
                    <div className="flex items-start gap-2">
                      <span className={'shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-semibold ' + STATUS_STYLE[status]}>
                        {status}
                      </span>
                      <a href={t.url} target="_blank" rel="noreferrer"
                        className="shrink-0 font-mono text-[11px] text-primary-700 hover:underline">{t.key}</a>
                      <span className="min-w-0 flex-1 text-xs text-slate-800">{t.summary}</span>
                      <button type="button" onClick={() => setOpen(open === t.key ? '' : t.key)}
                        className="shrink-0 text-[11px] text-slate-500 hover:text-slate-900 hover:underline">
                        {open === t.key ? 'hide' : 'details'}
                      </button>
                    </div>
                    <div className="mt-0.5 ml-[4.2rem] flex flex-wrap gap-x-3 text-[10px] text-slate-500">
                      <span>{t.type}</span>
                      {/* Jira's own resolution, kept distinct from any result
                          this tool produces — requirement 8. */}
                      <span>Jira: {t.jiraStatus}{t.jiraResolution ? ` / ${t.jiraResolution}` : ''}</span>
                      {t.pages.length > 0 && <span>pages: {t.pages.join(' → ')}</span>}
                      {t.steps.length > 0 && <span>{t.steps.length} steps</span>}
                      {t.testTypes.length > 0 && <span>{t.testTypes.join(', ')}</span>}
                    </div>

                    {open === t.key && (
                      <div className="mt-2 ml-[4.2rem] space-y-2 text-[11px]">
                        {!t.runnable && (
                          <p className="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-amber-800">
                            <b>Cannot be tested:</b> {t.blockedReason}
                          </p>
                        )}
                        {t.expected && (
                          <p>
                            <b className="text-slate-700">Expected:</b> {t.expected}{' '}
                            <span className={'rounded border px-1 ' + (t.expectedSource === 'stated'
                              ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                              : 'border-sky-200 bg-sky-50 text-sky-800')}>
                              {t.expectedSource === 'stated'
                                ? 'stated in the ticket'
                                : 'derived from the defect summary'}
                            </span>
                          </p>
                        )}
                        {t.observed && (
                          <p><b className="text-slate-700">Reported behaviour:</b> {t.observed}</p>
                        )}
                        {t.steps.length > 0 && (
                          <ol className="space-y-0.5">
                            {t.steps.map((s) => (
                              <li key={s.n} className="flex gap-2">
                                <span className="shrink-0 text-slate-400 tabular-nums">{s.n}.</span>
                                <span className={s.isCheck ? 'text-slate-900' : 'text-slate-600'}>
                                  {s.text}
                                  {s.page && <span className="ml-1 text-[10px] text-primary-700">[{s.page}]</span>}
                                  {s.isCheck && <span className="ml-1 text-[10px] text-amber-700">check</span>}
                                </span>
                              </li>
                            ))}
                          </ol>
                        )}
                        <p className="text-slate-400">
                          categorised because {t.categoryWhy?.join('; ') || 'no signal'}
                        </p>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

'use client';

// The Automation Suite's History table.
//
// One row per RUN, newest first: running three test cases out of ten is its
// own entry, and so is running one, because what was executed is part of what
// happened. Modelled on the Job Tracker's history, which answers the same
// question for builds and playlists.
//
// Polls while something is in flight and stops when nothing is — a table of
// finished runs has no reason to keep asking.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { FileText, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/cn';
import { statusStyle, verdictClass, type StatusLabel, type VerdictLabel } from '@/lib/automation/outcome';

export interface HistoryRow {
  name: string;
  status: string;
  verdict: string;
  durationMs?: number;
}
export interface HistoryRun {
  runId: string | null;
  live: boolean;
  suiteId: string;
  suiteName: string;
  uesimHost?: string;
  boxUser?: string;
  startedAt: string;
  finishedAt?: string;
  total: number;
  done: number;
  current?: string;
  buildVersion?: string;
  status: string;
  verdict: string;
  rows: HistoryRow[];
}

/** "11m 04s" — how long it took, in the units a person reads. */
export function elapsed(from?: string, to?: string): string {
  if (!from) return '–';
  const a = Date.parse(from);
  const b = to ? Date.parse(to) : Date.now();
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return '–';
  const s = Math.round((b - a) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m ${String(sec).padStart(2, '0')}s`;
}

const clock = (iso?: string) =>
  iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
const day = (iso?: string) =>
  iso ? new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) : '';

/** What was run: the whole suite, a few rows, or one test case. */
function scopeOf(run: HistoryRun): string {
  const n = run.rows.length || run.total;
  if (n === 1) return run.rows[0]?.name ?? '1 test case';
  if (run.total && n >= run.total) return `all ${n} test cases`;
  return `${n} of ${run.total} test cases`;
}

export function SuiteHistory() {
  const [runs, setRuns] = useState<HistoryRun[] | null>(null);
  const [err, setErr] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [openRun, setOpenRun] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/automation/history', { cache: 'no-store' }).then(x => x.json());
      if (!r?.ok) throw new Error(r?.error ?? 'could not read the history');
      setRuns(r.runs ?? []);
      setErr('');
    } catch (e: unknown) {
      setErr((e as Error)?.message ?? String(e));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const anyLive = (runs ?? []).some(r => r.live);
  useEffect(() => {
    if (!anyLive) return;
    const t = setInterval(() => { void load(); }, 5_000);
    return () => clearInterval(t);
  }, [anyLive, load]);

  if (runs === null) {
    return <div className="px-5 py-8 text-center text-sm text-slate-500">Reading the run history…</div>;
  }
  if (!runs.length) {
    return (
      <div className="px-5 py-10 text-center">
        <div className="text-sm text-slate-600">Nothing has run yet.</div>
        <div className="text-xs text-slate-400 mt-1">
          Every suite, selection and single test case you run appears here, with what the Simnovator made of it.
        </div>
      </div>
    );
  }

  return (
    <div className="bg-surface border border-line rounded-xl overflow-hidden">
      <div className="flex items-center justify-between px-5 py-2.5 border-b border-line">
        <span className="text-xs text-slate-500">
          {runs.length} run{runs.length === 1 ? '' : 's'}
          {anyLive ? <span className="text-amber-700"> · live updating</span> : null}
        </span>
        <div className="flex items-center gap-3">
          {err ? <span className="text-xs text-red-600">{err}</span> : null}
          <button
            onClick={async () => { setRefreshing(true); await load(); setRefreshing(false); }}
            className="inline-flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-800">
            <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
            Refresh
          </button>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="text-left px-4 py-2.5 font-medium whitespace-nowrap">Suite</th>
              <th className="text-left px-4 py-2.5 font-medium whitespace-nowrap">Simnovator</th>
              <th className="text-left px-4 py-2.5 font-medium whitespace-nowrap">User</th>
              <th className="text-left px-4 py-2.5 font-medium">Test cases</th>
              <th className="text-left px-4 py-2.5 font-medium whitespace-nowrap">Status</th>
              <th className="text-left px-4 py-2.5 font-medium whitespace-nowrap">Verdict</th>
              <th className="text-left px-4 py-2.5 font-medium whitespace-nowrap">Executed</th>
              <th className="text-left px-4 py-2.5 font-medium whitespace-nowrap"> </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {runs.map((run, i) => {
              const key = run.runId ?? `live-${run.suiteId}-${i}`;
              const st = statusStyle(run.status as StatusLabel);
              const expanded = openRun === key;
              return (
                <tr key={key} className="hover:bg-slate-50 align-top">
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-900">{run.suiteName}</div>
                    {run.buildVersion
                      ? <div className="text-[11px] text-slate-400">{run.buildVersion}</div>
                      : null}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap font-mono text-[12px] text-slate-700">
                    {run.uesimHost ?? '–'}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-slate-700">{run.boxUser ?? '–'}</td>

                  {/* What ran. One test case is named; more than one is counted
                      and opens on click, because the Simnovator's verdict is
                      per test case and a run of ten has ten of them. */}
                  <td className="px-4 py-3 min-w-[16rem]">
                    <button type="button"
                      onClick={() => setOpenRun(expanded ? null : key)}
                      className="text-left text-slate-800 hover:underline">
                      {scopeOf(run)}
                      {run.live && run.current ? <span className="text-amber-700"> · {run.current}</span> : null}
                      <span className="ml-1 text-[10px] text-slate-400">{expanded ? '▲' : '▼'}</span>
                    </button>
                    {expanded && (
                      <ul className="mt-1.5 space-y-0.5">
                        {run.rows.map((r, n) => (
                          <li key={`${r.name}-${n}`} className="text-[11px] flex items-baseline gap-1.5">
                            <span className="text-slate-700 truncate max-w-[18rem]">{r.name}</span>
                            <span className="text-slate-400">{r.status}</span>
                            {r.verdict
                              ? <span className={verdictClass(r.verdict as VerdictLabel)}>{r.verdict}</span>
                              : null}
                            {r.durationMs
                              ? <span className="text-slate-400">{Math.round(r.durationMs / 1000)}s</span>
                              : null}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>

                  <td className={cn('px-4 py-3 whitespace-nowrap', st.cls)}>{st.dot} {run.status}</td>
                  <td className={cn('px-4 py-3 whitespace-nowrap', verdictClass(run.verdict as VerdictLabel))}>
                    {run.verdict || '–'}
                  </td>

                  <td className="px-4 py-3 whitespace-nowrap text-xs">
                    <div className="text-slate-700">{elapsed(run.startedAt, run.finishedAt)}</div>
                    <div className="text-[11px] text-slate-400">
                      {clock(run.startedAt)}
                      {run.finishedAt ? ` – ${clock(run.finishedAt)}` : <span className="text-amber-700"> – running</span>}
                      {' · '}{day(run.startedAt)}
                    </div>
                  </td>

                  <td className="px-4 py-3 whitespace-nowrap">
                    {run.runId
                      ? (
                        <Link href={`/automation-suite/runs/${run.runId}`}
                          className="inline-flex items-center gap-1.5 text-xs text-primary-700 hover:underline">
                          <FileText className="h-3.5 w-3.5" />
                          Open
                        </Link>
                      )
                      : <span className="text-xs text-slate-400" title="This run is still going — it can be opened once it is filed">Open</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

'use client';

// One test case's Statistics and Logs, read from the Simnovator.
//
// Everything here is the box's own data for the execution THAT RUN produced —
// nothing is computed, averaged or filled in. The tables are whatever rows the
// box returns, with the columns taken from the rows themselves, so a build
// that adds a field shows it without this file changing.
//
// Live while a row is running: the box serves both statistics and logs for an
// execution in flight, so the panel polls until it is told to stop.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { Download, RefreshCw, Search } from 'lucide-react';

type StatKind = 'global' | 'cells' | 'ues' | 'ue-summary';

const STAT_TABS: Array<{ key: StatKind; label: string }> = [
  { key: 'global',     label: 'Global Statistics' },
  { key: 'cells',      label: 'Cell Statistics' },
  { key: 'ues',        label: 'UE Statistics' },
  { key: 'ue-summary', label: 'UE Summary' },
];

/** The box wraps every statistics reply as {code, message, data}, and the rows
 *  sit under one of a few names depending on which statistic it is. */
function rowsOf(payload: unknown): Record<string, unknown>[] {
  const outer = payload as Record<string, unknown> | undefined;
  const data = (outer?.data ?? outer) as Record<string, unknown> | undefined;
  if (!data || typeof data !== 'object') return [];
  for (const key of ['cells', 'ue_data', 'ues', 'rows', 'items']) {
    const v = (data as Record<string, unknown>)[key];
    if (Array.isArray(v)) return v.filter((r) => r && typeof r === 'object') as Record<string, unknown>[];
  }
  return Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
}

/** Columns from the rows themselves, in first-seen order. */
function columnsOf(rows: Record<string, unknown>[]): string[] {
  const seen: string[] = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!seen.includes(k)) seen.push(k);
  return seen;
}

const cell = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};

/** A CSV of exactly what is on screen. */
function toCsv(cols: string[], rows: Record<string, unknown>[]): string {
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return [cols.map(esc).join(','), ...rows.map((r) => cols.map((c) => esc(cell(r[c]))).join(','))].join('\n');
}

function download(name: string, text: string, type = 'text/plain') {
  try {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch { /* a failed download is not worth breaking the panel for */ }
}

export interface ExecutionPanelProps {
  runId: string;
  /** The test case, by the name the run recorded it under. */
  testcase: string;
  section: 'stats' | 'logs';
  /** Poll while the row is still executing. */
  live?: boolean;
}

export function ExecutionPanel({ runId, testcase, section, live }: ExecutionPanelProps) {
  const [tab, setTab] = useState<StatKind>('global');
  const [payload, setPayload] = useState<unknown>(undefined);
  const [lines, setLines] = useState<string[] | null>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(500);
  /** Ignore a reply that arrives after the user has moved on. */
  const want = useRef('');

  const load = useCallback(async () => {
    const what = section === 'logs' ? 'logs' : tab;
    const key = `${runId}|${testcase}|${what}|${limit}`;
    want.current = key;
    setLoading(true);
    setErr('');
    try {
      const qs = new URLSearchParams({ tc: testcase, what });
      if (what === 'logs') qs.set('limit', String(limit));
      const r = await fetch(`/api/automation/runs/${encodeURIComponent(runId)}/execution?${qs}`,
        { cache: 'no-store' }).then((x) => x.json());
      if (want.current !== key) return;
      if (!r?.ok) { setErr(String(r?.error ?? 'the Simnovator did not answer')); setPayload(undefined); setLines(null); return; }
      if (what === 'logs') { setLines(r.lines ?? []); setPayload(undefined); }
      else { setPayload(r.data); setLines(null); }
    } catch (e: unknown) {
      if (want.current !== key) return;
      setErr((e as Error)?.message ?? String(e));
    } finally {
      if (want.current === key) setLoading(false);
    }
  }, [runId, testcase, section, tab, limit]);

  useEffect(() => { void load(); }, [load]);

  // While the row is executing the box keeps adding to both.
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => { void load(); }, 10_000);
    return () => clearInterval(t);
  }, [live, load]);

  const rows = useMemo(() => rowsOf(payload), [payload]);
  const cols = useMemo(() => columnsOf(rows), [rows]);
  const shownLines = useMemo(() => {
    if (!lines) return [];
    if (!q.trim()) return lines;
    const needle = q.toLowerCase();
    return lines.filter((l) => l.toLowerCase().includes(needle));
  }, [lines, q]);

  const toolbar = (
    <div className="flex items-center gap-2 shrink-0">
      {live ? <span className="text-[11px] text-amber-700">live · every 10s</span> : null}
      <button onClick={() => void load()}
        className="inline-flex items-center gap-1 text-[11px] text-slate-500 hover:text-slate-800">
        <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} />
        Refresh
      </button>
    </div>
  );

  if (section === 'logs') {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2 px-5 py-2 border-b border-line">
          <label className="relative flex-1 min-w-[12rem]">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
            <input value={q} onChange={(e) => setQ(e.target.value)}
              placeholder="Search the log…"
              className="w-full border border-slate-300 rounded-md pl-7 pr-2 py-1 text-xs" />
          </label>
          <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}
            className="border border-slate-300 rounded-md px-1.5 py-1 text-xs">
            {[200, 500, 1000, 5000].map((n) => <option key={n} value={n}>last {n}</option>)}
          </select>
          <button
            onClick={() => download(`${testcase}-logs.txt`, (lines ?? []).join('\n'))}
            disabled={!lines?.length}
            className="inline-flex items-center gap-1 text-[11px] text-slate-500 hover:text-slate-800 disabled:text-slate-300">
            <Download className="h-3 w-3" /> Export
          </button>
          {toolbar}
        </div>
        <div className="px-5 py-1.5 text-[11px] text-slate-500 border-b border-line shrink-0">
          {err ? <span className="text-amber-700">{err}</span>
            : lines === null ? 'Reading the log…'
            : `${shownLines.length}${q.trim() ? ` of ${lines.length}` : ''} line${shownLines.length === 1 ? '' : 's'}`}
        </div>
        <pre className="flex-1 overflow-auto px-5 py-3 text-[11px] font-mono text-slate-700 whitespace-pre-wrap break-words">
          {shownLines.length ? shownLines.join('\n')
            : (!err && lines !== null ? 'The Simnovator has no log lines for this execution.' : '')}
        </pre>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-1 px-5 py-2 border-b border-line">
        {STAT_TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={cn('rounded-md px-2 py-1 text-xs',
              tab === t.key ? 'bg-primary-50 text-primary-800 font-medium' : 'text-slate-600 hover:bg-slate-100')}>
            {t.label}
          </button>
        ))}
        <span className="ml-auto flex items-center gap-2">
          <button
            onClick={() => download(`${testcase}-${tab}.csv`, toCsv(cols, rows), 'text/csv')}
            disabled={!rows.length}
            className="inline-flex items-center gap-1 text-[11px] text-slate-500 hover:text-slate-800 disabled:text-slate-300">
            <Download className="h-3 w-3" /> Export CSV
          </button>
          {toolbar}
        </span>
      </div>

      <div className="px-5 py-1.5 text-[11px] text-slate-500 border-b border-line shrink-0">
        {err ? <span className="text-amber-700">{err}</span>
          : payload === undefined ? 'Asking the Simnovator…'
          : `${rows.length} row${rows.length === 1 ? '' : 's'}`}
      </div>

      <div className="flex-1 overflow-auto">
        {rows.length === 0 && !err && payload !== undefined ? (
          <p className="px-5 py-4 text-xs text-slate-500">
            The Simnovator recorded no {STAT_TABS.find((t) => t.key === tab)?.label.toLowerCase()} for this execution.
          </p>
        ) : (
          <table className="min-w-full text-[11px]">
            <thead className="bg-slate-50 text-slate-600 sticky top-0">
              <tr>
                {cols.map((c) => (
                  <th key={c} className="text-left px-3 py-1.5 font-medium whitespace-nowrap font-mono">{c}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r, i) => (
                <tr key={i} className="hover:bg-slate-50">
                  {cols.map((c) => (
                    <td key={c} className="px-3 py-1 font-mono text-slate-700 whitespace-nowrap max-w-[22rem] truncate"
                      title={cell(r[c])}>
                      {cell(r[c])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

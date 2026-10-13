'use client';

// The Automation Suite's History table.
//
// One row per TEST CASE, grouped by the run it belonged to, newest first. The
// suite name is a merged cell spanning its group — written once, the way a
// spreadsheet writes it — so the eye reads "Userplane: these five test cases"
// rather than the same word repeated down the page.
//
// A group is a RUN, not a suite. Running the same suite again is a new group
// with its own results, because each execution is its own fact: the whole
// point of a history is that last Tuesday's run is still there after today's.
// Running three rows out of ten is its own group too.
//
// The columns are draggable and the table cannot scroll sideways: widths are
// fractions that always sum to 1, so a drag moves space between neighbours
// instead of making the table wider. See columnWidths.ts.
//
// Polls while something is in flight and stops when nothing is — a table of
// finished runs has no reason to keep asking.

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Eye, RefreshCw, Columns3 } from 'lucide-react';
import { cn } from '@/lib/cn';
import { statusStyle, verdictClass, type StatusLabel, type VerdictLabel } from '@/lib/automation/outcome';
import {
  evenWidths, resizeColumns, normaliseWidths, asPercents,
} from '@/lib/automation/columnWidths';

export interface HistoryRow {
  name: string;
  status: string;
  verdict: string;
  durationMs?: number;
  executionId?: string;
  /** The box's own spelling, for the hover. */
  boxStatus?: string;
  boxResult?: string;
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
  status: string;
  verdict: string;
  rows: HistoryRow[];
}

/** "11m 04s" — how long it took, in the units a person reads.
 *  Exported: the run detail page shows the same figure. */
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

/** One test case's own duration: "42s", "2m 05s". */
function took(ms?: number): string {
  if (!ms || ms < 0) return '–';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, '0')}s`;
}

const when = (iso?: string) => (iso
  ? new Date(iso).toLocaleString([], {
      day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
    })
  : '');

/** What was asked for, in a few words, under the suite name. */
function scopeOf(run: HistoryRun): string {
  const n = run.rows.length;
  if (run.total && n > 0 && n < run.total) return `${n} of ${run.total} test cases`;
  if (n === 1) return '1 test case';
  return `${n || run.total} test cases`;
}

const COLUMNS = [
  { key: 'suite',   label: 'Suite Name' },
  { key: 'tc',      label: 'Test Case Name' },
  { key: 'status',  label: 'Status' },
  { key: 'verdict', label: 'Verdict' },
  { key: 'time',    label: 'Executed Time' },
  { key: 'preview', label: 'Preview' },
] as const;

/** Room where it is needed: the two name columns are wide, the verdict is one
 *  word, Preview is a link. Sums to 1. */
const DEFAULT_WIDTHS = [0.21, 0.33, 0.13, 0.11, 0.12, 0.10];
const WIDTHS_KEY = 'simqa.automation.history.columnWidths.v1';

export function SuiteHistory({ suiteId, suiteName, onShowAll }: {
  /** Show only this suite's runs. Set when the page was opened from Run
   *  History's Preview, which is about one suite and not the whole lab. */
  suiteId?: string;
  /** Its name, for the banner — known before the runs have loaded. */
  suiteName?: string;
  /** Clear the filter. Absent = no way out is offered, so the caller owns it. */
  onShowAll?: () => void;
} = {}) {
  const [runs, setRuns] = useState<HistoryRun[] | null>(null);
  const [err, setErr] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [widths, setWidths] = useState<number[]>(DEFAULT_WIDTHS);
  const tableRef = useRef<HTMLTableElement | null>(null);
  /** Which handle is being dragged, and where the pointer started. */
  const drag = useRef<{ handle: number; startX: number; from: number[] } | null>(null);

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

  // Widths are a per-browser preference. Read once, and normalised — a set
  // saved when this table had a Build column must not paint six columns of
  // data under seven widths.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(WIDTHS_KEY);
      if (raw) setWidths(normaliseWidths(JSON.parse(raw), COLUMNS.length));
    } catch { /* a stored preference is never worth an error */ }
  }, []);

  const saveWidths = useCallback((next: number[]) => {
    setWidths(next);
    try { window.localStorage.setItem(WIDTHS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  }, []);

  const anyLive = (runs ?? []).some(r => r.live);
  useEffect(() => {
    if (!anyLive) return;
    const t = setInterval(() => { void load(); }, 5_000);
    return () => clearInterval(t);
  }, [anyLive, load]);

  // Dragging is tracked on the window, so the pointer may leave the 4px
  // handle — which it always does — without the drag stopping.
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const d = drag.current;
      const w = tableRef.current?.clientWidth;
      if (!d || !w) return;
      e.preventDefault();
      setWidths(resizeColumns(d.from, d.handle, (e.clientX - d.startX) / w));
    };
    const up = () => {
      if (!drag.current) return;
      drag.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setWidths((w) => { saveWidths(w); return w; });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [saveWidths]);

  const startDrag = (handle: number) => (e: React.PointerEvent) => {
    e.preventDefault();
    drag.current = { handle, startX: e.clientX, from: widths };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  // One suite's runs, when the page was opened for one suite.
  const all = runs ?? [];
  const shown = suiteId ? all.filter(r => r.suiteId === suiteId) : all;
  const hidden = all.length - shown.length;

  if (runs === null) {
    return <div className="px-5 py-8 text-center text-sm text-slate-500">Reading the run history…</div>;
  }
  if (!shown.length) {
    return (
      <div className="px-5 py-10 text-center">
        <div className="text-sm text-slate-600">
          {suiteId ? `${suiteName ?? 'That suite'} has not been run yet.` : 'Nothing has run yet.'}
        </div>
        <div className="text-xs text-slate-400 mt-1">
          {suiteId && hidden > 0
            ? `${hidden} run${hidden === 1 ? '' : 's'} of other suites ${hidden === 1 ? 'is' : 'are'} hidden.`
            : 'Every suite, selection and single test case you run appears here, with what the Simnovator made of it.'}
        </div>
        {suiteId && onShowAll ? (
          <button onClick={onShowAll} className="mt-2 text-xs text-primary-700 hover:underline">
            Show all runs
          </button>
        ) : null}
      </div>
    );
  }

  const pct = asPercents(widths);
  const cases = shown.reduce((t, r) => t + Math.max(1, r.rows.length), 0);

  return (
    <div className="bg-surface border border-line rounded-xl overflow-hidden">
      <div className="flex items-center justify-between px-5 py-2.5 border-b border-line">
        <span className="text-xs text-slate-500">
          {/* Say plainly that this is one suite's history, and offer the way
              out — a filtered table that does not admit it is filtered reads
              as a table missing rows. */}
          {suiteId ? (
            <>
              <span className="font-medium text-slate-700">{suiteName ?? shown[0]?.suiteName ?? 'this suite'}</span>
              {' · '}
            </>
          ) : null}
          {shown.length} run{shown.length === 1 ? '' : 's'} · {cases} test case{cases === 1 ? '' : 's'}
          {suiteId && hidden > 0 ? (
            <>
              {' · '}
              {onShowAll
                ? <button onClick={onShowAll} className="text-primary-700 hover:underline">
                    show all {hidden} other run{hidden === 1 ? '' : 's'}
                  </button>
                : <span>{hidden} other run{hidden === 1 ? '' : 's'} hidden</span>}
            </>
          ) : null}
          {anyLive ? <span className="text-amber-700"> · live updating</span> : null}
        </span>
        <div className="flex items-center gap-3">
          {err ? <span className="text-xs text-red-600">{err}</span> : null}
          <button
            onClick={() => saveWidths(DEFAULT_WIDTHS)}
            title="Put the column widths back"
            className="inline-flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-800">
            <Columns3 className="h-3.5 w-3.5" />
            Reset columns
          </button>
          <button
            onClick={async () => { setRefreshing(true); await load(); setRefreshing(false); }}
            className="inline-flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-800">
            <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
            Refresh
          </button>
        </div>
      </div>

      {/* No overflow-x wrapper on purpose: the widths are fractions of this
          element, so the table is always exactly as wide as the page allows
          and there is nothing to scroll to. */}
      <table ref={tableRef} className="w-full text-sm table-fixed">
        <colgroup>
          {COLUMNS.map((c, i) => <col key={c.key} style={{ width: pct[i] }} />)}
        </colgroup>
        <thead className="bg-slate-50 text-slate-600">
          <tr>
            {COLUMNS.map((c, i) => (
              <th key={c.key}
                className={cn(
                  'relative text-left px-3 py-2.5 font-medium select-none',
                  'border-r border-slate-200 last:border-r-0',
                )}>
                <span className="block truncate" title={c.label}>{c.label}</span>
                {/* Every column but the last gets a handle: a drag takes
                    space from the column on its right. */}
                {i < COLUMNS.length - 1 && (
                  <span
                    role="separator"
                    aria-orientation="vertical"
                    aria-label={`Resize ${c.label}`}
                    onPointerDown={startDrag(i)}
                    onDoubleClick={() => saveWidths(DEFAULT_WIDTHS)}
                    className="absolute top-0 right-0 h-full w-[7px] translate-x-[3px] cursor-col-resize
                               hover:bg-primary-300/60 active:bg-primary-400/70 z-10"
                  />
                )}
              </th>
            ))}
          </tr>
        </thead>

        <tbody>
          {shown.map((run, i) => {
            const key = run.runId ?? `live-${run.suiteId}-${i}`;
            // A group always has at least one line, so a run that executed
            // nothing is still visible as the run it was.
            const rows: HistoryRow[] = run.rows.length
              ? run.rows
              : [{ name: '–', status: run.status, verdict: run.verdict }];

            return rows.map((row, n) => {
              const st = statusStyle(row.status as StatusLabel);
              const first = n === 0;
              return (
                <tr key={`${key}-${row.name}-${n}`}
                  className={cn(
                    'align-top hover:bg-slate-50/70',
                    // The group's own top edge, so suites read apart at a glance.
                    first && i > 0 && 'border-t-2 border-slate-300',
                    !first && 'border-t border-slate-100',
                  )}>
                  {/* The suite name once per group, as a merged cell. */}
                  {first && (
                    <td rowSpan={rows.length}
                      className="px-3 py-2.5 border-r border-slate-200 bg-slate-50/40 align-top">
                      <div className="font-medium text-slate-900 break-words" title={run.suiteName}>
                        {run.suiteName}
                      </div>
                      <div className="text-[11px] text-slate-500 mt-0.5">{scopeOf(run)}</div>
                      <div className="text-[11px] text-slate-400 mt-0.5 break-words">
                        {run.uesimHost ?? '–'}{run.boxUser ? ` · ${run.boxUser}` : ''}
                      </div>
                      <div className="text-[11px] text-slate-400">
                        {when(run.startedAt)}
                        {run.live ? <span className="text-amber-700"> · running</span> : null}
                      </div>
                    </td>
                  )}

                  {/* Long names wrap rather than widen the table. */}
                  <td className="px-3 py-2.5 border-r border-slate-200">
                    <span className="block text-slate-800 break-words leading-snug" title={row.name}>
                      {row.name}
                    </span>
                    {run.live && run.current === row.name
                      ? <span className="text-[11px] text-amber-700">executing now</span>
                      : null}
                  </td>

                  {/* These two are the Simnovator's own words, run through
                      the box's own label maps — the only difference is
                      capitalisation. The hover shows the raw pair off the
                      execution record so it can be checked against the
                      Simnovator without taking our word for it. A row the run
                      never executed has no execution to quote, and says that
                      rather than borrowing the box's older verdict for the
                      same test case. */}
                  <td className={cn('px-3 py-2.5 border-r border-slate-200 whitespace-nowrap truncate', st.cls)}
                    title={row.boxStatus
                      ? `the Simnovator says: ${row.boxStatus}`
                      : row.executionId ? row.status : 'this run produced no execution for this test case'}>
                    {st.dot} {row.status}
                  </td>

                  <td className={cn('px-3 py-2.5 border-r border-slate-200 whitespace-nowrap truncate',
                    verdictClass(row.verdict as VerdictLabel))}
                    title={row.boxResult
                      ? `the Simnovator says: ${row.boxResult}`
                      : row.executionId ? (row.verdict || undefined) : 'this run produced no execution for this test case'}>
                    {row.verdict || '–'}
                  </td>

                  {/* A row that never executed has no execution time. The
                      runner does record how long it spent before giving up —
                      347s of waiting on one refused trigger — but printing
                      that under "Executed Time" claims the test ran for 347
                      seconds, which it did not. The run detail has the real
                      story. */}
                  <td className="px-3 py-2.5 border-r border-slate-200 whitespace-nowrap text-slate-700">
                    {row.status === 'Not Executed' ? '–' : took(row.durationMs)}
                  </td>

                  <td className="px-3 py-2.5 whitespace-nowrap">
                    {run.runId
                      ? (
                        <Link
                          href={`/automation-suite/runs/${run.runId}?tc=${encodeURIComponent(row.name)}`}
                          className="inline-flex items-center gap-1.5 text-xs text-primary-700 hover:underline">
                          <Eye className="h-3.5 w-3.5" />
                          View
                        </Link>
                      )
                      : (
                        <span className="text-xs text-slate-400"
                          title="This run is still going — it can be opened once it is filed">
                          View
                        </span>
                      )}
                  </td>
                </tr>
              );
            });
          })}
        </tbody>
      </table>
    </div>
  );
}

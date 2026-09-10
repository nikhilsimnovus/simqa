'use client';

// Live captures — the passive half of Config Fidelity.
//
// The Matrix tab next to this one drives the box: it creates a testcase, runs
// it, and proves the generated ue.cfg honours what was asked for. This tab
// watches instead. Somebody runs a testcase from the Simnovator's own GUI, and
// SimQA collects the testcase export and the ue.cfg the UE-sim generated for
// that execution, diffs them, and keeps both files.
//
// Three levels, because that is how the question is actually asked: which box,
// then which run, then which parameter.
//
//   Simnovators  ->  the executions captured for one  ->  the parameter table
//
// Nothing here deletes. Starting another testcase must never cost you the
// evidence from the last one, so the list only ever grows and both files stay
// downloadable for every capture.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Card, CardBody, CardHeader, CardTitle, Button, Badge } from '@/components/ui';
import {
  Radar, Loader2, AlertTriangle, CheckCircle2, XCircle, HelpCircle, Download, RefreshCw,
  ChevronLeft, Server, Search, FileJson, FileCode2,
} from 'lucide-react';

type Verdict = 'passed' | 'failed' | 'unattributed' | 'error';
type RowStatus = 'honoured' | 'mismatch' | 'not-honoured' | 'not-emitted' | 'no-rule' | 'cfg-only';

interface SystemRow {
  id: string; name: string; host: string; type: string;
  topology?: string;
  ueSim?: { id: string; name: string; host: string };
  watchable: boolean; reason?: string;
  captures: number; passed: number; failed: number; lastCaptureAt?: string;
}

interface CaptureSummary {
  captureId: string;
  simnovatorIp: string; simnovatorName?: string;
  ueSimIp?: string; ueSimName?: string;
  testcaseId?: string; testcaseName?: string;
  executionId?: string; simulatorName?: string;
  startedAt: string; capturedAt: string;
  verdict: Verdict;
  compared: number; differences: number;
  reason?: string;
  hasTestcase: boolean; hasUeCfg: boolean;
  ueCfgPath?: string;
}

interface CompareRow {
  /** The testcase parameter — the first column, and the row's identity. */
  testcasePath: string;
  testcaseValue?: unknown;
  ueCfgPath?: string;
  ueCfgValue?: unknown;
  status: RowStatus; section: string; note?: string;
}

interface Comparison {
  rows: CompareRow[]; compared: number; differences: number; ok: boolean; notes: string[];
  counts?: Record<RowStatus, number>;
  /** Present when the server filtered: how many rows exist in total, and how
   *  many of them matched and were therefore not sent. */
  totalRows?: number; matched?: number; truncated?: boolean;
}

const VERDICT: Record<Verdict, { label: string; cls: string; Icon: typeof CheckCircle2 }> = {
  passed:       { label: 'Config match',   cls: 'bg-emerald-100 text-emerald-800 border-emerald-300', Icon: CheckCircle2 },
  failed:       { label: 'Mismatch',       cls: 'bg-red-100 text-red-800 border-red-300',             Icon: XCircle },
  unattributed: { label: 'Not attributed', cls: 'bg-amber-100 text-amber-900 border-amber-300',       Icon: HelpCircle },
  error:        { label: 'Capture failed', cls: 'bg-slate-100 text-slate-700 border-slate-300',       Icon: AlertTriangle },
};

export function LiveCaptures() {
  const [systems, setSystems] = useState<SystemRow[] | null>(null);
  const [watcher, setWatcher] = useState<any>(null);
  const [ip, setIp] = useState('');
  const [captures, setCaptures] = useState<CaptureSummary[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ summary: CaptureSummary; comparison: Comparison | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  /**
   * Which statuses the table shows. Empty = every status.
   *
   * Replaces a single "only what is not honoured" checkbox, which could not
   * express "show me the ones with no counterpart" — the largest group on most
   * captures — without also showing all 2,000+ matching rows.
   *
   * Opens on Mismatch + Not found, which is what the checkbox defaulted to and
   * is exactly the set the server sends without a second fetch.
   */
  const [statusFilter, setStatusFilter] = useState<Set<DisplayStatus>>(new Set(['mismatch', 'not-found']));

  const loadSystems = useCallback(async () => {
    try {
      const r = await fetch('/api/config-fidelity/live/systems', { cache: 'no-store' });
      const j = await r.json();
      setSystems(j.systems ?? []);
      setWatcher(j.watcher ?? null);
      return j.systems as SystemRow[];
    } catch (e: any) { setErr(e?.message ?? String(e)); return []; }
  }, []);

  // Loading this tab is also what starts the watcher after a server restart.
  useEffect(() => { loadSystems(); }, [loadSystems]);

  useEffect(() => {
    if (!systems?.length || ip) return;
    setIp(systems.find((s) => s.captures > 0)?.host ?? systems[0].host);
  }, [systems, ip]);

  const loadCaptures = useCallback(async (theIp: string) => {
    if (!theIp) { setCaptures(null); return; }
    try {
      const r = await fetch(`/api/config-fidelity/live/captures?ip=${encodeURIComponent(theIp)}`, { cache: 'no-store' });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setCaptures(j.captures ?? []);
    } catch (e: any) { setErr(e?.message ?? String(e)); setCaptures([]); }
  }, []);

  useEffect(() => { setOpenId(null); setDetail(null); loadCaptures(ip); }, [ip, loadCaptures]);

  async function openCapture(id: string, rows: 'notable' | 'all' = 'notable') {
    setOpenId(id); setDetail(null); setErr(null);
    if (rows === 'notable') setQuery('');
    try {
      // Matching rows are left on the server by default — a 512-UE testcase has
      // 16k of them and only the differences are worth opening on.
      const r = await fetch(`/api/config-fidelity/live/capture?ip=${encodeURIComponent(ip)}&id=${encodeURIComponent(id)}&rows=${rows}`, { cache: 'no-store' });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setDetail({ summary: j.summary, comparison: j.comparison });
    } catch (e: any) { setErr(e?.message ?? String(e)); }
  }

  async function checkNow() {
    setBusy(true); setErr(null);
    try {
      const r = await fetch('/api/config-fidelity/live/scan', { method: 'POST' });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setWatcher(j.watcher);
      await loadSystems();
      await loadCaptures(ip);
    } catch (e: any) { setErr(e?.message ?? String(e)); }
    finally { setBusy(false); }
  }

  function fileUrl(id: string, name: string) {
    return `/api/config-fidelity/live/file?ip=${encodeURIComponent(ip)}&id=${encodeURIComponent(id)}&name=${encodeURIComponent(name)}`;
  }

  const selected = systems?.find((s) => s.host === ip);

  const visibleRows = useMemo(() => {
    const rows = detail?.comparison?.rows ?? [];
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (statusFilter.size && !statusFilter.has(DISPLAY_OF[r.status])) return false;
      if (!q) return true;
      return r.testcasePath.toLowerCase().includes(q) || (r.ueCfgPath ?? '').toLowerCase().includes(q);
    });
  }, [detail, query, statusFilter]);

  /**
   * How many rows carry each status — counted over the WHOLE comparison, not
   * just the rows currently loaded.
   *
   * The capture endpoint withholds the matching rows by default (a 512-UE
   * testcase is 16k rows / 3.7 MB), so counting what arrived reported "Match 0"
   * and greyed the box out on every capture — the one status you could never
   * tick. Every non-matching row is always sent, so only Match needs the
   * server's own tally.
   */
  const statusCounts = useMemo(() => {
    const c = detail?.comparison;
    const counts = { mismatch: 0, 'not-found': 0, match: 0 } as Record<DisplayStatus, number>;
    for (const r of c?.rows ?? []) {
      const d = DISPLAY_OF[r.status];
      counts[d] = (counts[d] ?? 0) + 1;
    }
    if (c?.truncated) counts.match = c.matched ?? counts.match;
    return counts;
  }, [detail]);

  /** Rows in the whole comparison, not just the ones loaded. */
  const totalRows = detail?.comparison?.totalRows ?? detail?.comparison?.rows.length ?? 0;

  /**
   * Apply a status selection, fetching the rows the server withheld if the new
   * selection needs them.
   *
   * The capture endpoint returns only the "notable" rows by default — a full
   * comparison is thousands of rows. Selecting anything beyond mismatch /
   * not-honoured (or clearing the filter entirely) therefore has to go back for
   * the rest, or the chips would show a count they cannot display.
   */
  const NOTABLE: DisplayStatus[] = ['mismatch', 'not-found'];
  const applyStatusFilter = useCallback(async (next: Set<DisplayStatus>) => {
    setStatusFilter(next);
    const needsAll = next.size === 0 || [...next].some((s) => !NOTABLE.includes(s));
    if (needsAll && openId && detail?.comparison?.truncated) await openCapture(openId, 'all');
  }, [openId, detail]);

  const toggleStatus = useCallback((s: DisplayStatus) => {
    const next = new Set(statusFilter);
    if (next.has(s)) next.delete(s); else next.add(s);
    void applyStatusFilter(next);
  }, [statusFilter, applyStatusFilter]);

  return (
    <div className="space-y-4">
      {/* ── Watcher status ─────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
        <span className="flex items-center gap-1.5 text-slate-700">
          <Radar className={'h-3.5 w-3.5 ' + (watcher?.running ? 'text-emerald-600' : 'text-slate-400')} />
          {watcher?.running
            ? <>Watching {systems?.filter((s) => s.watchable).length ?? 0} Simnovator(s) every {watcher.pollSec}s</>
            : <>Watcher not started</>}
        </span>
        {watcher?.capturing > 0 ? (
          <span className="flex items-center gap-1.5 text-primary-700">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> capturing {watcher.capturing} execution(s)
          </span>
        ) : null}
        {watcher?.lastTick ? (
          <span className="text-slate-500">
            last check {new Date(watcher.lastTick.at).toLocaleTimeString()}
            {watcher.lastTick.error ? <span className="text-amber-800"> · {watcher.lastTick.error}</span> : null}
          </span>
        ) : null}
        <div className="ml-auto">
          <Button onClick={checkNow} disabled={busy} className="h-8 bg-surface text-slate-700 border border-slate-300 hover:bg-slate-50">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            <span className="ml-1.5">Check now</span>
          </Button>
        </div>
      </div>

      <p className="text-xs text-slate-600 leading-relaxed">
        When a testcase is started from a Simnovator&apos;s own GUI, SimQA exports that testcase and reads the{' '}
        <code className="font-mono text-[11px] bg-slate-100 px-1 rounded">/root/ue/config/ue.cfg</code> its paired
        UE-sim generated for the run, then compares them parameter by parameter. Both files are kept for every
        execution — running the next testcase never overwrites what the last one produced.
      </p>

      {err ? (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700 flex gap-2">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 flex-none" /><div>{err}</div>
        </div>
      ) : null}

      <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-4">
        {/* ── Simnovators ──────────────────────────────────────────── */}
        <Card className="h-fit">
          <CardHeader><CardTitle className="text-sm flex items-center gap-2"><Server className="h-4 w-4 text-primary-600" />Simnovators</CardTitle></CardHeader>
          <CardBody className="p-0">
            {systems === null ? (
              <div className="p-4 text-xs text-slate-500 flex items-center gap-1.5"><Loader2 className="h-3 w-3 animate-spin" /> loading…</div>
            ) : systems.length === 0 ? (
              <div className="p-4 text-xs text-slate-500">No Simnovator in Systems Management.</div>
            ) : (
              <div className="divide-y divide-slate-100">
                {systems.map((s) => (
                  <button
                    key={s.host}
                    onClick={() => setIp(s.host)}
                    className={'w-full text-left px-3 py-2.5 hover:bg-slate-50 ' + (s.host === ip ? 'bg-primary-50 border-l-2 border-primary-600' : 'border-l-2 border-transparent')}
                  >
                    <div className="text-xs font-medium text-slate-800">{s.name}</div>
                    <div className="text-[11px] text-slate-500 font-mono">{s.host}</div>
                    <div className="mt-1 flex items-center gap-1.5 flex-wrap">
                      {s.captures > 0 ? (
                        <>
                          <span className="text-[10px] text-slate-600">{s.captures} capture{s.captures === 1 ? '' : 's'}</span>
                          {s.passed > 0 ? <span className="text-[10px] px-1 rounded bg-emerald-100 text-emerald-800">{s.passed} ok</span> : null}
                          {s.failed > 0 ? <span className="text-[10px] px-1 rounded bg-red-100 text-red-800">{s.failed} mismatch</span> : null}
                        </>
                      ) : (
                        <span className="text-[10px] text-slate-400">no captures yet</span>
                      )}
                    </div>
                    {!s.watchable ? (
                      <div className="mt-1 text-[10px] text-amber-800 leading-snug">{s.reason}</div>
                    ) : null}
                  </button>
                ))}
              </div>
            )}
          </CardBody>
        </Card>

        {/* ── Executions, or one comparison ────────────────────────── */}
        <div className="min-w-0">
          {openId && detail ? (
            <CaptureDetail
              detail={detail}
              rows={visibleRows}
              total={totalRows}
              query={query} setQuery={setQuery}
              statusFilter={statusFilter}
              statusCounts={statusCounts}
              onToggleStatus={toggleStatus}
              onToggleAll={(all: boolean) => { void applyStatusFilter(all ? new Set() : new Set<DisplayStatus>(['mismatch', 'not-found'])); }}
              onBack={() => { setOpenId(null); setDetail(null); }}
              fileUrl={fileUrl}
            />
          ) : openId ? (
            <Card><CardBody><div className="text-xs text-slate-500 flex items-center gap-1.5 py-8 justify-center"><Loader2 className="h-3 w-3 animate-spin" /> loading comparison…</div></CardBody></Card>
          ) : (
            <CaptureList
              system={selected}
              captures={captures}
              onOpen={openCapture}
              fileUrl={fileUrl}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ── the executions captured for one Simnovator ───────────────────────────────

function CaptureList({ system, captures, onOpen, fileUrl }: {
  system?: SystemRow;
  captures: CaptureSummary[] | null;
  onOpen: (id: string) => void;
  fileUrl: (id: string, name: string) => string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">
          Executions captured{system ? <> — {system.name} <span className="font-mono text-xs text-slate-500">({system.host})</span></> : null}
        </CardTitle>
      </CardHeader>
      <CardBody className="p-0">
        {captures === null ? (
          <div className="p-4 text-xs text-slate-500 flex items-center gap-1.5"><Loader2 className="h-3 w-3 animate-spin" /> loading…</div>
        ) : captures.length === 0 ? (
          <div className="p-6 text-xs text-slate-600 leading-relaxed">
            Nothing captured for this Simnovator yet. Start a testcase from its GUI and it will appear here
            {system?.ueSim ? <> once the <span className="font-mono">{system.ueSim.name}</span> UE-sim has written its ue.cfg</> : null}.
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {captures.map((c) => {
              const v = VERDICT[c.verdict] ?? VERDICT.error;
              return (
                <div key={c.captureId} className="px-3 py-2.5 hover:bg-slate-50 flex items-center gap-3">
                  <button className="flex-1 min-w-0 text-left" onClick={() => onOpen(c.captureId)}>
                    <div className="flex items-center gap-2">
                      <span className={'inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded border ' + v.cls}>
                        <v.Icon className="h-3 w-3" />{v.label}
                      </span>
                      <span className="text-xs font-medium text-slate-800 truncate">{c.testcaseName ?? c.captureId}</span>
                      {c.differences > 0 ? (
                        <span className="text-[10px] font-semibold text-red-700">
                          {c.differences} parameter{c.differences === 1 ? '' : 's'} not matching
                        </span>
                      ) : c.verdict === 'passed' ? (
                        <span className="text-[10px] text-slate-500">{c.compared} parameters honoured</span>
                      ) : null}
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      started {new Date(c.startedAt).toLocaleString()}
                      {c.simulatorName ? <> · {c.simulatorName}</> : null}
                      {c.ueSimIp ? <> · ue.cfg from {c.ueSimIp}</> : null}
                    </div>
                    {c.reason ? <div className="text-[11px] text-amber-800 mt-0.5 leading-snug">{c.reason}</div> : null}
                  </button>
                  <div className="flex items-center gap-1 flex-none">
                    {c.hasTestcase ? (
                      <a href={fileUrl(c.captureId, 'testcase.json')} title="Download the testcase JSON"
                        className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-slate-300 text-slate-700 hover:bg-slate-100">
                        <FileJson className="h-3 w-3" />testcase
                      </a>
                    ) : null}
                    {c.hasUeCfg ? (
                      <a href={fileUrl(c.captureId, 'ue.cfg')} title="Download the ue.cfg"
                        className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-slate-300 text-slate-700 hover:bg-slate-100">
                        <FileCode2 className="h-3 w-3" />ue.cfg
                      </a>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

// ── one capture: the parameter table ─────────────────────────────────────────

function cell(v: unknown): string {
  if (v === undefined) return '—';
  if (v === null) return 'null';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/**
 * The three buckets the table reports, and how the comparison's internal
 * statuses collapse onto them.
 *
 * compare.ts keeps six — it needs the distinction to decide what fails a
 * capture — but six, then four, was still too many to read.
 *
 *   Match      the cfg carries the authored value
 *   Mismatch   it reached the cfg with a DIFFERENT value
 *   Not found  no counterpart in the cfg, for any reason
 *
 * Not found deliberately merges a real defect (a parameter with a known cfg
 * field that the cfg dropped) with two benign cases (no cfg destination by
 * design, and no mapping known yet). Only the first fails a capture, so the
 * verdict is unchanged — but so the signal is not lost inside a group of
 * thousands, rows that genuinely failed keep the amber row and red badge while
 * the benign ones render neutral, and every row's note says which it is.
 */
type DisplayStatus = 'match' | 'mismatch' | 'not-found';

const DISPLAY_OF: Record<RowStatus, DisplayStatus> = {
  honoured: 'match',
  mismatch: 'mismatch',
  'not-honoured': 'not-found',
  'no-rule': 'not-found',
  'not-emitted': 'not-found',
  'cfg-only': 'not-found',
};

/** The underlying statuses that actually fail a capture. */
const FAILING: ReadonlySet<RowStatus> = new Set<RowStatus>(['mismatch', 'not-honoured']);

const STATUS_STYLE: Record<DisplayStatus, { row: string; label: string; cls: string; hint: string }> = {
  mismatch:    { row: 'bg-amber-50', label: 'Mismatch',  cls: 'bg-red-100 text-red-800 border-red-300',
                 hint: 'the parameter reached the cfg with a different value' },
  'not-found': { row: '',            label: 'Not found', cls: 'bg-slate-100 text-slate-600 border-slate-300',
                 hint: 'no counterpart in the cfg — either the cfg dropped it, it has no cfg destination by design, or SimQA has no mapping for it yet. The row note says which; only a dropped parameter fails the capture' },
  match:       { row: '',            label: 'Match',     cls: 'bg-emerald-50 text-emerald-700 border-emerald-200',
                 hint: 'the cfg carries the authored value' },
};

/** Filter chips, worst first: what failed, then the coverage gaps, then passes. */
const STATUS_FILTER_ORDER: DisplayStatus[] = ['mismatch', 'not-found', 'match'];

function CaptureDetail({
  detail, rows, total, query, setQuery,
  statusFilter, statusCounts, onToggleStatus, onToggleAll,
  onBack, fileUrl,
}: {
  detail: { summary: CaptureSummary; comparison: Comparison | null };
  rows: CompareRow[];
  total: number;
  query: string; setQuery: (s: string) => void;
  statusFilter: Set<DisplayStatus>;
  statusCounts: Record<DisplayStatus, number>;
  onToggleStatus: (s: DisplayStatus) => void;
  onToggleAll: (all: boolean) => void;
  onBack: () => void;
  fileUrl: (id: string, name: string) => string;
}) {
  const { summary, comparison } = detail;
  const v = VERDICT[summary.verdict] ?? VERDICT.error;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start gap-3">
          <button onClick={onBack} className="text-xs text-slate-600 hover:text-slate-900 inline-flex items-center gap-1 mt-0.5">
            <ChevronLeft className="h-3.5 w-3.5" />Back
          </button>
          <div className="min-w-0 flex-1">
            <CardTitle className="text-sm truncate">{summary.testcaseName ?? summary.captureId}</CardTitle>
            <div className="text-[11px] text-slate-500 mt-0.5">
              started {new Date(summary.startedAt).toLocaleString()}
              {summary.ueSimIp ? <> · ue.cfg from {summary.ueSimName ?? summary.ueSimIp} ({summary.ueCfgPath})</> : null}
            </div>
          </div>
          <span className={'inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded border flex-none ' + v.cls}>
            <v.Icon className="h-3 w-3" />{v.label}
          </span>
        </div>
      </CardHeader>
      <CardBody className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {summary.hasTestcase ? (
            <a href={fileUrl(summary.captureId, 'testcase.json')}
              className="inline-flex items-center gap-1.5 text-xs px-3 h-8 rounded-md bg-primary-600 hover:bg-primary-700 text-on-accent font-medium">
              <Download className="h-3.5 w-3.5" />Testcase JSON
            </a>
          ) : null}
          {summary.hasUeCfg ? (
            <a href={fileUrl(summary.captureId, 'ue.cfg')}
              className="inline-flex items-center gap-1.5 text-xs px-3 h-8 rounded-md bg-accent-600 hover:bg-accent-700 text-white font-medium">
              <Download className="h-3.5 w-3.5" />ue.cfg
            </a>
          ) : null}
          {/* Worded in the same four buckets as the filters below, so the
              headline and the checkboxes can't disagree. */}
          {comparison ? (
            <span className="text-xs text-slate-600 ml-1">
              {comparison.differences > 0
                ? <><span className="font-semibold text-red-700">{comparison.differences} not matching</span> of {comparison.compared} checked</>
                : <>all {comparison.compared} checked parameters match</>}
              {(comparison.counts?.['no-rule'] ?? 0) + (comparison.counts?.['not-emitted'] ?? 0) > 0
                ? <span className="text-slate-500"> · {(comparison.counts?.['no-rule'] ?? 0) + (comparison.counts?.['not-emitted'] ?? 0)} not found in the cfg</span>
                : null}
            </span>
          ) : null}
        </div>

        {summary.reason ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 flex gap-2">
            <HelpCircle className="h-3.5 w-3.5 mt-0.5 flex-none" /><div>{summary.reason}</div>
          </div>
        ) : null}

        {comparison?.notes?.length ? (
          <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-[11px] text-slate-700 space-y-1">
            {comparison.notes.map((n, i) => <div key={i}>· {n}</div>)}
          </div>
        ) : null}

        {!comparison ? (
          <div className="text-xs text-slate-500 py-6 text-center">
            No comparison was produced for this capture.
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <div className="relative flex-1 min-w-[160px] max-w-[300px]">
                <Search className="h-3 w-3 text-slate-400 absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="search" value={query} onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search parameters…"
                  className="w-full border border-slate-300 rounded pl-7 pr-2 py-1 text-xs bg-surface text-slate-700"
                />
              </div>
              <span className="text-[11px] text-slate-500 ml-auto">{rows.length} of {total} rows</span>
            </div>

            {/* One checkbox per status, each with its own count. Ordered worst
                first: what differs, then what has no counterpart, then what
                matched. Tick any combination; with none ticked the
                table shows everything. A status with no rows in this capture is
                still listed and still tickable, so its absence is a stated
                fact you can confirm rather than a dead control. */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
              <span className="text-[11px] font-medium text-slate-500">Show</span>

              {/* All: ticked whenever nothing specific is selected, which is
                  how "no filter" already behaved. Unticking it returns to the
                  two statuses that fail a capture rather than leaving an empty
                  selection that would look like a filter showing everything. */}
              <label className="flex items-center gap-1.5 text-xs text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={statusFilter.size === 0}
                  onChange={(e) => onToggleAll(e.target.checked)}
                />
                <span className="rounded border border-slate-700 bg-slate-800 px-1.5 py-0.5 text-[10px] font-semibold text-white">All</span>
                <span className="tabular-nums text-[11px] text-slate-500">{total}</span>
              </label>

              <span className="h-4 w-px bg-slate-300" aria-hidden />

              {/* Always enabled, including at a count of zero. A disabled box
                  reads as "this filter is unavailable" when it actually means
                  "this capture has none of these" — and it took away the one
                  way to confirm that by ticking it. A zero selection simply
                  shows the empty state naming the status. */}
              {STATUS_FILTER_ORDER.map((s) => {
                const meta = STATUS_STYLE[s];
                const n = statusCounts[s] ?? 0;
                return (
                  <label key={s} title={meta.hint} className="flex items-center gap-1.5 text-xs text-slate-700 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={statusFilter.has(s)}
                      onChange={() => onToggleStatus(s)}
                    />
                    <span className={'rounded border px-1.5 py-0.5 text-[10px] font-semibold ' + meta.cls}>
                      {meta.label}
                    </span>
                    <span className={'tabular-nums text-[11px] ' + (n === 0 ? 'text-slate-400' : 'text-slate-500')}>{n}</span>
                  </label>
                );
              })}
            </div>

            <div className="rounded-md border border-slate-200 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-xs" style={{ minWidth: 760 }}>
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200 text-left">
                      <th className="px-3 py-2 font-medium text-slate-600 w-[27%] min-w-[210px]">Testcase parameter</th>
                      <th className="px-3 py-2 font-medium text-slate-600 w-[16%]">Testcase value</th>
                      <th className="px-3 py-2 font-medium text-slate-600 w-[27%]">ue.cfg parameter</th>
                      <th className="px-3 py-2 font-medium text-slate-600 w-[16%]">ue.cfg value</th>
                      <th className="px-3 py-2 font-medium text-slate-600">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {rows.length === 0 ? (
                      <tr><td colSpan={5} className="px-3 py-6 text-center text-slate-500">
                        {statusFilter.size > 0 && total > 0
                          ? `No rows with ${[...statusFilter].map((s) => STATUS_STYLE[s].label).join(' or ')}${query.trim() ? ' matching that search' : ''} — pick another status above, or All.`
                          : 'No rows.'}
                      </td></tr>
                    ) : rows.map((r) => {
                      const display = DISPLAY_OF[r.status] ?? 'not-found';
                      const st = STATUS_STYLE[display];
                      // Emphasis follows the UNDERLYING status: a dropped
                      // parameter inside Not found still reads as a failure,
                      // the by-design absences beside it do not.
                      const bad = FAILING.has(r.status);
                      return (
                        <tr key={r.testcasePath} className={st.row}>
                          <td className="px-3 py-1.5 align-top">
                            <span className="font-mono text-[11px] text-slate-800 break-words">{r.testcasePath}</span>
                            {r.note ? <div className="text-[10px] text-slate-500 mt-0.5 leading-snug">{r.note}</div> : null}
                          </td>
                          <td className={'px-3 py-1.5 align-top font-mono text-[11px] break-all ' + (bad ? 'text-red-700 font-bold' : 'text-slate-700')}>
                            <div className="max-h-24 overflow-y-auto">{cell(r.testcaseValue)}</div>
                          </td>
                          <td className="px-3 py-1.5 align-top font-mono text-[11px] text-slate-500 break-words">{r.ueCfgPath ?? '—'}</td>
                          <td className={'px-3 py-1.5 align-top font-mono text-[11px] break-all ' + (bad ? 'text-red-700 font-bold' : 'text-slate-700')}>
                            <div className="max-h-24 overflow-y-auto">{cell(r.ueCfgValue)}</div>
                          </td>
                          <td className="px-3 py-1.5 align-top">
                            <span title={st.hint} className={'text-[10px] px-1.5 py-0.5 rounded border whitespace-nowrap ' + st.cls}>{st.label}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </CardBody>
    </Card>
  );
}

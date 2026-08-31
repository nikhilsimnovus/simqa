'use client';

// Rendering for end-to-end validation results, used by the embedded
// Validation section on the individual Test Case page. Lives under
// src/app/run-validate/ because that's where it was first built (a since-
// removed standalone "Run & Validate" page used to share it too) — the path
// stuck as the module's home even though it's no longer page-adjacent.
//
// Presentation follows the actual flow of a test execution rather than a
// flat technical list: every check already carries a `phase` (preflight /
// trigger / during / completion / post) that maps 1:1 onto five plain-
// language stages (Before Test / Starting Test / During Test / Test
// Completion / After Test) — see STAGE_META / CHECK_DISPLAY_NAMES below.
// This is a display-only mapping: it does not change which checks run or
// how pass/fail/skip is decided (that's all still src/lib/endToEnd/checks.ts
// and runner.ts). Raw ids, technical descriptions, timings and severities
// are still there for anyone who needs them, just behind a per-check
// "View technical details" toggle instead of shown inline for every row.

import { useState } from 'react';
import { Card, CardBody, CardHeader, CardTitle, Button } from '@/components/ui';
import {
  Loader2, CheckCircle2, XCircle, Circle, MinusCircle, AlertTriangle,
  History, ChevronDown, ChevronRight, RefreshCw,
} from 'lucide-react';

export type CheckStatus = 'pending' | 'running' | 'pass' | 'fail' | 'skip';
export type Phase = 'preflight' | 'trigger' | 'during' | 'completion' | 'post';

export interface CheckRowData {
  id: string;
  name: string;
  phase: Phase;
  severity: 'critical' | 'normal' | 'optional';
  description: string;
  status: CheckStatus;
  detail?: string;
  skippedReason?: string;
  durationMs?: number;
}

export interface RunStatus {
  running: boolean;
  runId?: string;
  systemId?: string;
  systemHost?: string;
  testcaseId?: string;
  testcaseName?: string;
  executionId?: string;
  startedAt?: string;
  phase?: Phase;
  configuredDurationSec?: number;
  checks?: CheckRowData[];
  counts?: { total: number; passed: number; failed: number; skipped: number; pending: number };
  ok?: boolean;
  finishedAt?: string;
  finalDetail?: string;
}

export interface PastRunSummary {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  ok?: boolean;
  systemHost?: string;
  testcaseName?: string;
  systemId: string;
  testcaseId: string;
  counts?: { total: number; passed: number; failed: number; skipped: number };
}

export interface FullReport extends PastRunSummary {
  systemHost: string;
  systemName?: string;
  testcaseName?: string;
  executionId?: string;
  finalDetail?: string;
  configuredDurationSec?: number;
  observedDurationSec?: number;
  results: CheckRowData[];
}

/** "5m 55s" — the run's actual (observed) duration, not the configured target.
 *  Whole seconds only; a validation run's wall clock isn't precise enough for
 *  the .1s a raw toFixed(1) implied. */
export function fmtDuration(totalSec: number): string {
  const s = Math.round(totalSec);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return m > 0 ? `${m}m ${rem}s` : `${rem}s`;
}

/** "13/8/2026, 4:03:04 PM" — matches the stamp format used elsewhere in the
 *  app (dashboard recent-runs list) rather than a raw ISO string. */
export function stamp(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    day: 'numeric', month: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true,
  });
}

// ───────────── Plain-language stage + check names ─────────────

const STAGE_META: Record<Phase, { title: string; description: string }> = {
  preflight:  { title: 'Before Test',    description: 'Confirms everything is ready before starting the test.' },
  trigger:    { title: 'Starting Test',  description: 'Confirms the test started correctly.' },
  during:     { title: 'During Test',    description: 'Monitors the test while it is running.' },
  completion: { title: 'Test Completion', description: 'Confirms the execution finished correctly.' },
  post:       { title: 'After Test',     description: 'Confirms everything wrapped up cleanly after the run.' },
};
const STAGE_ORDER: Phase[] = ['preflight', 'trigger', 'during', 'completion', 'post'];

/** Technical check id -> plain-language name shown as the row title. The
 *  underlying id/name/description are untouched (still available under
 *  "View technical details") — this only changes what's shown by default.
 *  A check id not listed here just falls back to its real `name`, so a
 *  newly added check degrades gracefully instead of disappearing. */
const CHECK_DISPLAY_NAMES: Record<string, string> = {
  'preflight-login': 'Simnovator Login',
  'preflight-testcase-exists': 'Test Case Available',
  'preflight-api-responsive': 'System/API Connection',
  'preflight-simulators-available': 'Required Simulator Ready',
  'preflight-cfg-bring-up': 'Callbox Configuration Ready',
  'preflight-ftp-anon-locked': 'Connectivity Check',
  'trigger-start-execution': 'Test Started Successfully',
  'trigger-execution-id-discovered': 'Execution Created',
  'during-status-running': 'Test Started Running',
  'during-ue-attach': 'UE Connection Check',
  'during-all-ues-attach': 'All UEs Attached',
  'during-ue-count-stable': 'UEs Stayed Connected',
  'during-throughput-flowing': 'Download Throughput',
  'during-ul-throughput-flowing': 'Upload Throughput',
  'during-bler-zero': 'BLER Check',
  'during-throughput-stability': 'Throughput Stability',
  'during-per-cell-traffic': 'Cell Traffic Validation',
  'during-stats-consistency': 'UE Status Consistency',
  'during-zombie-execution': 'Execution Progress Check',
  'completion-status-terminal': 'Test Completed',
  'completion-duration-sane': 'Test Duration Valid',
  'completion-verdict-present': 'Test Result Available',
  'post-logs-exportable': 'Logs Exported Successfully',
  'post-all-ues-power-off': 'UE Shutdown Check',
  'post-per-ue-stats-sane': 'Per-UE Statistics Validation',
  'ui-during-no-5xx': 'No Server Errors During Test',
  'ui-during-no-console-errors': 'No Browser Errors',
  'ui-during-notification-consistency': 'Status Notifications Accurate',
  'ui-during-stop-affordance': 'Stop Button Available',
  'ui-during-export-buttons': 'Export Buttons Work',
  'ui-post-deep-link-shareable': 'Statistics Link Shareable',
};

function friendlyName(row: Pick<CheckRowData, 'id' | 'name'>): string {
  return CHECK_DISPLAY_NAMES[row.id] ?? row.name;
}

/** "64/64" from whichever UE-attach check has reported a count so far —
 *  reuses the figure the check itself already computed rather than
 *  re-deriving it from raw stats on the client. */
function ueSummaryFrom(checks: CheckRowData[]): string | undefined {
  const c = checks.find((x) => x.id === 'during-all-ues-attach')
    ?? checks.find((x) => x.id === 'during-ue-attach');
  const m = c?.detail?.match(/(\d+)\s*\/\s*(\d+)/);
  return m ? `${m[1]}/${m[2]}` : undefined;
}

// ───────────── Single check row ─────────────

export function CheckRow({ row }: { row: CheckRowData }) {
  const [showDetails, setShowDetails] = useState(false);
  const icon =
    row.status === 'running' ? <Loader2 className="h-4 w-4 text-primary-600 animate-spin" /> :
    row.status === 'pending' ? <Circle   className="h-4 w-4 text-slate-300" /> :
    row.status === 'pass'    ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> :
    row.status === 'skip'    ? <MinusCircle className="h-4 w-4 text-slate-400" /> :
                                <XCircle className="h-4 w-4 text-red-600" />;
  // Only surface a reason inline for fail/skip — a passed check reads as
  // "name — Passed" with nothing further needed, matching what a passed
  // check should look like at a glance.
  const shortReason = row.status === 'fail' ? row.detail : row.status === 'skip' ? row.skippedReason : undefined;
  const canShowDetails = row.status === 'pass' || row.status === 'fail' || row.status === 'skip';

  return (
    <li className={
      'px-3 py-2 ' +
      (row.status === 'fail'    ? 'bg-red-50/30' :
       row.status === 'pass'    ? 'bg-emerald-50/30' :
       row.status === 'running' ? 'bg-primary-50/40' : '')
    }>
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5">{icon}</span>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-1.5 text-sm">
            <span className="font-medium text-slate-900">{friendlyName(row)}</span>
            {row.status === 'pass' ? <span className="text-[10px] px-1.5 rounded bg-emerald-600 text-white font-semibold">PASSED</span> : null}
            {row.status === 'fail' ? <span className="text-[10px] px-1.5 rounded bg-red-600 text-white font-semibold">FAILED</span> : null}
            {row.status === 'skip' ? <span className="text-[10px] px-1.5 rounded bg-slate-400 text-white font-semibold">SKIPPED</span> : null}
            {row.status === 'running' ? <span className="text-[10px] px-1.5 rounded bg-primary-600 text-white font-semibold animate-pulse">RUNNING</span> : null}
            {row.status === 'pending' ? <span className="text-[10px] px-1.5 rounded bg-slate-100 text-slate-500 font-semibold">WAITING</span> : null}
          </div>
          {shortReason ? <div className="text-[11px] text-slate-600 mt-0.5 leading-relaxed">{shortReason}</div> : null}
          {canShowDetails ? (
            <button
              onClick={() => setShowDetails((v) => !v)}
              className="text-[10px] text-primary-700 hover:underline mt-1"
            >
              {showDetails ? 'Hide technical details' : 'View technical details'}
            </button>
          ) : null}
          {showDetails ? (
            <div className="mt-1.5 space-y-1 text-[11px] text-slate-500 border-l-2 border-slate-200 pl-2">
              <div className="text-slate-600 leading-relaxed">{row.description}</div>
              {row.detail ? <div className="break-all">↳ {row.detail}</div> : null}
              <div className="flex flex-wrap gap-x-3 text-slate-400">
                <span className="font-mono">{row.id}</span>
                <span>{row.severity} severity</span>
                {row.durationMs !== undefined ? <span>{row.durationMs}ms</span> : null}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </li>
  );
}

export function ChecksList({ checks }: { checks: CheckRowData[] }) {
  return (
    <ul className="divide-y divide-slate-100 border border-slate-200 rounded-lg overflow-hidden bg-white">
      {checks.map((c) => <CheckRow key={c.id} row={c} />)}
    </ul>
  );
}

// ───────────── One stage (Before Test / During Test / …) ─────────────

type StageTone = 'pass' | 'fail' | 'warn' | 'pending';

function StageSection({ phase, checks, autoExpand }: { phase: Phase; checks: CheckRowData[]; autoExpand: boolean }) {
  // null = "user hasn't clicked" -> follow autoExpand live. Once clicked,
  // the user's choice sticks even as the run's live phase moves on.
  const [userOverride, setUserOverride] = useState<boolean | null>(null);
  const expanded = userOverride ?? autoExpand;
  if (checks.length === 0) return null;

  const meta = STAGE_META[phase];
  const passed = checks.filter((c) => c.status === 'pass').length;
  const failed = checks.filter((c) => c.status === 'fail').length;
  const skipped = checks.filter((c) => c.status === 'skip').length;
  const resolved = passed + failed + skipped;
  const total = checks.length;
  const criticalFail = checks.some((c) => c.status === 'fail' && c.severity === 'critical');

  const tone: StageTone =
    resolved === 0 ? 'pending' :
    criticalFail ? 'fail' :
    failed > 0 ? 'warn' :
    'pass';

  const toneCls: Record<StageTone, string> = {
    pass:    'border-emerald-200 bg-emerald-50',
    fail:    'border-red-200 bg-red-50',
    warn:    'border-amber-200 bg-amber-50',
    pending: 'border-slate-200 bg-slate-50',
  };
  const iconCls: Record<StageTone, string> = {
    pass: 'text-emerald-600', fail: 'text-red-600', warn: 'text-amber-600', pending: 'text-slate-400',
  };
  const StatusIcon = tone === 'pass' ? CheckCircle2 : tone === 'fail' ? XCircle : tone === 'warn' ? AlertTriangle : Loader2;

  return (
    <div className={`rounded-lg border ${toneCls[tone]}`}>
      <button
        onClick={() => setUserOverride(!expanded)}
        className="w-full text-left px-4 py-3 flex items-center gap-3"
      >
        {expanded ? <ChevronDown className="h-4 w-4 text-slate-400 flex-none" /> : <ChevronRight className="h-4 w-4 text-slate-400 flex-none" />}
        <StatusIcon className={`h-5 w-5 flex-none ${iconCls[tone]} ${tone === 'pending' ? 'animate-spin' : ''}`} />
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-sm text-slate-900">{meta.title}</div>
          <div className="text-[11px] text-slate-500">{meta.description}</div>
        </div>
        <div className="text-right flex-none">
          <div className="text-xs font-semibold text-slate-900">{passed}/{total} Passed</div>
          {failed > 0 || skipped > 0 ? (
            <div className="text-[10px] text-slate-500">
              {failed > 0 ? `${failed} failed` : ''}{failed > 0 && skipped > 0 ? ' · ' : ''}{skipped > 0 ? `${skipped} skipped` : ''}
            </div>
          ) : null}
        </div>
      </button>
      {expanded ? (
        <div className="px-2 pb-2">
          <ChecksList checks={checks} />
        </div>
      ) : null}
    </div>
  );
}

/** The five-stage vertical flow: Before Test -> Starting Test -> During Test
 *  -> Test Completion -> After Test. A stage with zero checks in it (e.g. UI
 *  checks weren't enabled for this run) is skipped rather than shown empty. */
function StageFlow({ checks, currentPhase }: { checks: CheckRowData[]; currentPhase?: Phase }) {
  const groups = STAGE_ORDER
    .map((phase) => ({ phase, checks: checks.filter((c) => c.phase === phase) }))
    .filter((g) => g.checks.length > 0);

  return (
    <div>
      {groups.map((g, i) => (
        <div key={g.phase}>
          <StageSection
            phase={g.phase}
            checks={g.checks}
            autoExpand={g.checks.some((c) => c.status === 'fail') || g.phase === currentPhase}
          />
          {i < groups.length - 1 ? (
            <div className="flex justify-center py-1">
              <ChevronDown className="h-3.5 w-3.5 text-slate-300" />
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

// ───────────── Run overview (top summary block) ─────────────

interface RunOverviewData {
  testcaseName?: string;
  testcaseId?: string;
  systemHost?: string;
  currentStatus: string;
  overallResult: 'pass' | 'fail' | 'running' | 'unknown';
  startedAt?: string;
  configuredDurationSec?: number;
  ueSummary?: string;
}

function OverviewField({ label, value }: { label: string; value?: React.ReactNode }) {
  if (value == null || value === '') return null;
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className="text-sm font-medium text-slate-900 truncate">{value}</div>
    </div>
  );
}

function RunOverview({ data }: { data: RunOverviewData }) {
  const resultBadge: Record<RunOverviewData['overallResult'], React.ReactNode> = {
    pass:    <span className="text-[11px] px-2 py-0.5 rounded bg-emerald-600 text-white font-semibold">PASSED</span>,
    fail:    <span className="text-[11px] px-2 py-0.5 rounded bg-red-600 text-white font-semibold">FAILED</span>,
    running: <span className="text-[11px] px-2 py-0.5 rounded bg-primary-600 text-white font-semibold animate-pulse">IN PROGRESS</span>,
    unknown: <span className="text-sm text-slate-400">—</span>,
  };

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-3">
      <OverviewField label="Test Case" value={data.testcaseName ?? data.testcaseId} />
      <OverviewField label="Simnovator IP" value={data.systemHost ? <span className="font-mono text-xs">{data.systemHost}</span> : undefined} />
      <OverviewField label="Status" value={data.currentStatus} />
      <div>
        <div className="text-[10px] uppercase tracking-wider text-slate-500">Result</div>
        <div className="mt-0.5">{resultBadge[data.overallResult]}</div>
      </div>
      <OverviewField label="Execution Date & Time" value={data.startedAt ? stamp(data.startedAt) : undefined} />
      <OverviewField label="Duration" value={data.configuredDurationSec != null ? fmtDuration(data.configuredDurationSec) : undefined} />
      <OverviewField label="UEs Connected" value={data.ueSummary} />
    </div>
  );
}

/** Overview + five-stage flow for one run — live or historical. The single
 *  place that normalises a RunStatus / LiveEntry / FullReport into the same
 *  presentation, so the three call sites below don't each re-derive it. */
function RunProgress({
  testcaseName, testcaseId, systemHost, running, ok, finalDetail,
  startedAt, configuredDurationSec, checks, currentPhase,
}: {
  testcaseName?: string; testcaseId?: string; systemHost?: string;
  running: boolean; ok?: boolean; finalDetail?: string;
  startedAt?: string; configuredDurationSec?: number;
  checks: CheckRowData[]; currentPhase?: Phase;
}) {
  const currentStatus = running ? 'Running' : finalDetail === 'aborted' ? 'Stopped' : 'Completed';
  const overallResult: RunOverviewData['overallResult'] = running ? 'running' : ok === undefined ? 'unknown' : ok ? 'pass' : 'fail';

  return (
    <div className="space-y-3">
      <RunOverview data={{
        testcaseName, testcaseId, systemHost, currentStatus, overallResult,
        startedAt, configuredDurationSec, ueSummary: ueSummaryFrom(checks),
      }} />
      {finalDetail ? (
        <div className={
          'rounded-md border px-3 py-2 text-xs leading-relaxed ' +
          (running ? 'border-primary-200 bg-primary-50 text-primary-900'
            : ok ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
            : 'border-red-200 bg-red-50 text-red-700')
        }>
          {finalDetail}
        </div>
      ) : null}
      <StageFlow checks={checks} currentPhase={currentPhase} />
    </div>
  );
}

/** An in-progress run to show as the newest entry, above the completed
 *  history — same click-to-expand row, live checks instead of a fetched
 *  report. Disappears once the run finishes; the completed entry that
 *  replaces it comes from the caller's own next `runs` refresh. */
export interface LiveEntry {
  runId: string;
  testcaseId: string;
  testcaseName?: string;
  systemId?: string;
  systemHost?: string;
  startedAt: string;
  executionId?: string;
  configuredDurationSec?: number;
  currentPhase?: Phase;
  checks: CheckRowData[];
  counts?: { total: number; passed: number; failed: number; skipped: number; pending: number };
}

/** Fetches and expands a single past run's full report on demand. Owns its
 *  own expand/collapse state so callers only need to hand it the summary
 *  list — used by both the standalone Run & Validate page (unfiltered) and
 *  the embedded Validation section on a testcase page (pre-filtered to that
 *  testcase's own runs, and optionally passing `liveEntry` for the run
 *  currently in flight so there's one list, not a separate live card). */
export function PastRunsPanel({
  runs, onRefresh, title = 'Past runs', limit = 20, emptyMessage, liveEntry,
}: {
  runs: PastRunSummary[] | null;
  onRefresh?: () => void;
  title?: string;
  limit?: number;
  emptyMessage?: React.ReactNode;
  liveEntry?: LiveEntry;
}) {
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [expandedReport, setExpandedReport] = useState<FullReport | null>(null);

  async function expandRun(runId: string) {
    if (expandedRunId === runId) { setExpandedRunId(null); setExpandedReport(null); return; }
    setExpandedRunId(runId); setExpandedReport(null);
    // The live entry's checks come straight from props (see below) — there's
    // no report.json to fetch until the run finishes.
    if (liveEntry && runId === liveEntry.runId) return;
    try {
      const r = await fetch(`/api/end-to-end/runs/${encodeURIComponent(runId)}`, { cache: 'no-store' });
      const j = await r.json();
      if (r.ok) setExpandedReport({ ...j, results: j.results ?? [] });
    } catch { /* swallow */ }
  }

  const hasAny = !!liveEntry || (runs?.length ?? 0) > 0;

  return (
    <Card>
      <CardHeader className="py-3">
        <CardTitle className="flex items-center gap-2">
          <History className="h-4 w-4 text-primary-600" />
          {title}
          {onRefresh ? (
            <Button onClick={onRefresh} variant="ghost" size="sm" className="ml-auto">
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardBody className="space-y-2 py-4">
        {!hasAny && runs === null ? (
          <div className="text-xs text-slate-500 flex items-center gap-1.5"><Loader2 className="h-3 w-3 animate-spin" /> loading…</div>
        ) : !hasAny ? (
          <div className="text-xs text-slate-500">{emptyMessage ?? "No past validation runs yet. They'll appear here once a run finishes."}</div>
        ) : (
          <ul className="divide-y divide-slate-100 border border-slate-200 rounded-lg overflow-hidden bg-white">
            {liveEntry ? (
              <li key={liveEntry.runId}>
                <button
                  onClick={() => expandRun(liveEntry.runId)}
                  className="block w-full text-left px-3 py-2 text-xs hover:bg-slate-50 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    {expandedRunId === liveEntry.runId ? <ChevronDown className="h-3 w-3 text-slate-400" /> : <ChevronRight className="h-3 w-3 text-slate-400" />}
                    <Loader2 className="h-3.5 w-3.5 text-primary-600 animate-spin" />
                    <span className="font-medium text-slate-900" title={liveEntry.testcaseId}>{liveEntry.testcaseName || liveEntry.testcaseId}</span>
                    <span className="text-slate-400">·</span>
                    <span className="text-slate-500 font-mono text-[11px]">{liveEntry.systemHost || liveEntry.systemId}</span>
                    <span className="ml-auto text-[10px] tabular-nums text-primary-700 font-medium">
                      Running{liveEntry.counts ? ` · ${liveEntry.counts.passed} Passed · ${liveEntry.counts.failed} Failed · ${liveEntry.counts.pending} Pending` : ''}
                    </span>
                  </div>
                  <div className="text-[10px] text-slate-400 mt-0.5">{stamp(liveEntry.startedAt)} – running…</div>
                </button>
                {expandedRunId === liveEntry.runId ? (
                  <div className="px-3 pb-3 pt-2 bg-slate-50 border-t border-slate-100">
                    <RunProgress
                      testcaseName={liveEntry.testcaseName}
                      testcaseId={liveEntry.testcaseId}
                      systemHost={liveEntry.systemHost}
                      running
                      startedAt={liveEntry.startedAt}
                      configuredDurationSec={liveEntry.configuredDurationSec}
                      checks={liveEntry.checks}
                      currentPhase={liveEntry.currentPhase}
                    />
                  </div>
                ) : null}
              </li>
            ) : null}
            {(runs ?? []).slice(0, limit).map((r) => (
              <li key={r.runId}>
                <button
                  onClick={() => expandRun(r.runId)}
                  className="block w-full text-left px-3 py-2 text-xs hover:bg-slate-50 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    {expandedRunId === r.runId ? <ChevronDown className="h-3 w-3 text-slate-400" /> : <ChevronRight className="h-3 w-3 text-slate-400" />}
                    {r.ok ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> : <XCircle className="h-3.5 w-3.5 text-red-600" />}
                    <span className="font-medium text-slate-900" title={r.testcaseId}>{r.testcaseName || r.testcaseId}</span>
                    <span className="text-slate-400">·</span>
                    <span className="text-slate-500 font-mono text-[11px]">{r.systemHost || r.systemId}</span>
                    {r.counts ? (
                      <span className="ml-auto text-[10px] tabular-nums text-slate-500">
                        {r.counts.passed} Passed · {r.counts.failed} Failed · {r.counts.skipped} Skipped
                      </span>
                    ) : null}
                  </div>
                  <div className="text-[10px] text-slate-400 mt-0.5">
                    {stamp(r.startedAt)}{r.finishedAt ? ` – ${stamp(r.finishedAt)}` : ' – running…'}
                  </div>
                </button>
                {expandedRunId === r.runId ? (
                  <div className="px-3 pb-3 pt-2 bg-slate-50 border-t border-slate-100">
                    {!expandedReport ? (
                      <div className="text-xs text-slate-500 flex items-center gap-1.5"><Loader2 className="h-3 w-3 animate-spin" /> loading report…</div>
                    ) : (
                      <RunProgress
                        testcaseName={expandedReport.testcaseName}
                        testcaseId={expandedReport.testcaseId}
                        systemHost={expandedReport.systemHost}
                        running={false}
                        ok={expandedReport.ok}
                        finalDetail={expandedReport.finalDetail}
                        startedAt={expandedReport.startedAt}
                        configuredDurationSec={expandedReport.configuredDurationSec}
                        checks={expandedReport.results ?? []}
                      />
                    )}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

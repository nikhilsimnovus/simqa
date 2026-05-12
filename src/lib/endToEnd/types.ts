// End-to-End validation — public types shared between the runner, the API
// routes, and the /end-to-end "Run & validate" page.
//
// Lifecycle vocabulary (mapped 1:1 to UI sections):
//
//   PREFLIGHT  — read-only sanity checks. Never mutate the target box.
//   TRIGGER    — POST /executions and confirm the new execution registers.
//                FIRST state-mutating step. Gated behind preflight passing.
//   DURING     — checks that depend on the execution being live (KPI polling,
//                UI scraping, log scraping).
//   COMPLETION — wait for the execution to finish; verify duration + final
//                verdict are sane.
//   POST       — once stopped, verify post-run artifacts (logs export,
//                statistics deep-link works in a fresh context, etc.).

export type Phase = 'preflight' | 'trigger' | 'during' | 'completion' | 'post';
export type Severity = 'critical' | 'normal' | 'optional';
export type CheckStatus = 'pending' | 'running' | 'pass' | 'fail' | 'skip';

/** Per-check verdict the runner produces. */
export interface CheckResult {
  id: string;
  name: string;
  phase: Phase;
  severity: Severity;
  description: string;
  status: Exclude<CheckStatus, 'pending' | 'running'>;
  /** Short one-line description of what was observed. */
  detail?: string;
  /** Longer expected/observed pair for the UI to render under the row. */
  expected?: string;
  /** When skipped, why. */
  skippedReason?: string;
  /** Relative paths under data/end-to-end/<runId>/<check.id>/ */
  evidence?: {
    screenshotFile?: string;
    responseFile?: string;
    logFile?: string;
    downloadFile?: string;
  };
  durationMs?: number;
  ranAt?: string;
}

/** Snapshot returned by GET /api/end-to-end/status while a run is in flight.
 *  Same wire format the page polls every ~1.5s. */
export interface RunStatusSnapshot {
  running: boolean;
  runId?: string;
  systemId?: string;
  systemHost?: string;
  testcaseId?: string;
  executionId?: string;
  startedAt?: string;
  phase?: Phase;
  /** Catalog-order checks with their current verdict. Includes pending +
   *  running flavours for the UI to render spinners on in-flight rows. */
  checks?: (CheckResult | { id: string; name: string; phase: Phase; severity: Severity; description: string; status: 'pending' | 'running' })[];
  /** Counts derived from `checks` for the top-of-page stat cards. */
  counts?: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    pending: number;
  };
  /** Set only after the run completes (running goes false). */
  ok?: boolean;
  finishedAt?: string;
  finalDetail?: string;
}

/** Full report saved to disk under data/end-to-end/<runId>/report.json after
 *  a run completes. Same shape /api/end-to-end/runs/[id] returns. */
export interface FinalReport {
  runId: string;
  systemId: string;
  systemHost: string;
  systemName?: string;
  testcaseId: string;
  testcaseName?: string;
  executionId?: string;
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  finalDetail?: string;
  /** Configured test duration (from the testcase metadata if available). */
  configuredDurationSec?: number;
  /** Wall-clock duration of the execution as observed by the runner. */
  observedDurationSec?: number;
  options: RunOptions;
  counts: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
  };
  results: CheckResult[];
}

/** Request body to POST /api/end-to-end/run. */
export interface RunRequest {
  systemId: string;
  /** Testcase to execute. Required unless `useLastExecution` is set. */
  testcaseId?: string;
  /** If set, the runner finds the most recent /v2/executions entry on the
   *  system and re-runs its testcase. Mutually exclusive with testcaseId. */
  useLastExecution?: boolean;
  options?: RunOptions;
  /** When re-running just specific checks, pass the ids — others are skipped. */
  onlyCheckIds?: string[];
}

export interface RunOptions {
  /** Run API-only checks (cheap, no browser). Default: true. */
  apiChecks?: boolean;
  /** Run Playwright-driven UI checks. Default: false (Phase 2). Requires a
   *  working browser on the simqa host. */
  uiChecks?: boolean;
  /** Save screenshots / log excerpts / downloaded artifacts under
   *  data/end-to-end/<runId>/. Default: true. */
  saveEvidence?: boolean;
  /** Polling cadence while waiting for execution state changes (ms). Default 5000. */
  pollIntervalMs?: number;
  /** Maximum wall-clock the runner will wait for the execution to finish
   *  (in addition to the configured testcase duration). Default 300000 (5 min). */
  completionGraceMs?: number;
}

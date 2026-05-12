// RunCtx — per-run shared state passed to every check function.
//
// Each check is a pure function `(ctx) => Promise<CheckResult>`. Shared
// discovery (auth token, executionId, testcase metadata) goes onto the ctx
// so later checks don't have to re-fetch what earlier ones already learned.

import type { Page, Browser } from 'playwright';

export interface RunCtx {
  /** Generated id for this run — also the dirname under data/end-to-end/. */
  runId: string;

  // ── Target (resolved from RunRequest.systemId) ──
  systemId: string;
  systemHost: string;
  systemName: string;
  /** UESIM API credentials. */
  apiUser: string;
  apiPass: string;

  // ── Testcase being validated ──
  testcaseId: string;
  testcaseName?: string;
  testcaseMetadata?: any;

  // ── Mutable state that checks fill in as the run progresses ──
  /** JWT bearer token. Populated by the very first preflight check. */
  token?: string;
  /** Execution kicked off by the TRIGGER phase. Discovered by polling
   *  testcase metadata after the POST returns (the start endpoint itself
   *  doesn't return an executionId — see uesimClient.ts comment). */
  executionId?: string;
  /** Configured run duration in seconds, parsed from testcase metadata.
   *  Used by the COMPLETION-phase wait to know how long to wait. */
  configuredDurationSec?: number;
  /** Wall-clock when TRIGGER fired — for measuring observed duration. */
  triggeredAt?: number;
  /** Wall-clock when COMPLETION saw a terminal status. */
  finishedAt?: number;

  // ── Optional Playwright browser (Phase 2). Lazy. ──
  browser?: Browser;
  page?: Page;
  /** Where evidence files get written (data/end-to-end/<runId>/). */
  evidenceDir: string;

  // ── Abort signalling. The poll loops + Playwright actions check this. ──
  isCanceled(): boolean;

  // ── Live progress emit. The runner attaches a closure that updates the
  //    activeRunsByRunId map so /api/end-to-end/status can stream. ──
  emit: (partial: { id?: string; status?: 'running' | 'pass' | 'fail' | 'skip'; result?: any; phase?: string }) => void;
}

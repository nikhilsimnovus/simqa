// Shared types for per-field test packs.
//
// Per-field test files (under src/lib/ui-tests/tests/) import from here
// instead of the monolithic uiTester.ts so they stay decoupled from the
// framework's internals. New test packs only need: UiTestDef + the args
// shape passed to run().

import type { UiTestCategory, UiTestSeverity, UiTestEvidence } from '../uiTester';
import type { Browser, BrowserContext, Page, Request as PwRequest } from 'playwright';

export interface UiRequestRecord {
  method: string;
  url: string;
  status?: number;
  resourceType?: string;
  durationMs?: number;
}

export interface UiCtxLike {
  browser: Browser;
  host: string;
  username: string;
  password: string;
  authStorageStatePath?: string;
  evidenceRootDir: string;
  headless: boolean;
}

export interface PageBundleLike {
  context: BrowserContext;
  page: Page;
  getRequests: () => UiRequestRecord[];
  getConsoleErrors: () => string[];
  close: () => Promise<void>;
}

export interface UiTestDef {
  id: string;
  name: string;
  description: string;
  category: UiTestCategory;
  severity: UiTestSeverity;
  needsAuth?: boolean;
  longRunning?: boolean;
  destructive?: boolean;
  run: (args: { ctx: UiCtxLike; bundle: PageBundleLike; testDir: string }) => Promise<{
    ok: boolean;
    detail: string;
    expected?: string;
    extraEvidence?: UiTestEvidence;
  }>;
}

export type { UiTestCategory, UiTestSeverity, UiTestEvidence };

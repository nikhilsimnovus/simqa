// Executing Jira tickets as UI tests, one at a time, each on its own.
//
// A browser CONTEXT per ticket, not per run. That is what makes requirement 5
// work: Playwright writes one video per context, so a context per ticket is
// one video per ticket, and ticket evidence cannot bleed together. It also
// means each ticket starts from a clean session, which matches how the
// tickets are written ("**Step 1:** Log in to Simnovator...").
//
// The verdict rules, which are the point of this module:
//
//   FAIL     a page the ticket names would not load, the app showed an error,
//            or the ticket's own expected result was put to the page and did
//            not hold.
//   PASS     the expected result was put to the page and held.
//   BLOCKED  the ticket could not be turned into a test, or its expectation
//            is not something reading a page can settle. Evidence is still
//            captured, for a person.
//
// What is NOT a pass: a page that loaded. 170 of the 394 runnable tickets
// have an expectation no page read can settle ("the layout should be
// proper"), and those are BLOCKED with their recording kept — never PASS.
// Claiming to have verified the unverifiable is the one failure mode worse
// than finding nothing.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import { launchUiBrowser, login, detectFfmpeg } from '../uiTester';
import { planTicket } from './steps';
import { checkableFrom, runCheck } from './checks';
import {
  type JiraRun, type JiraTicket, type TicketResult, type TicketStatus,
  newRunId, saveRun, ticketDir, safeKey, readTickets,
} from './store';

/** Runs in flight, by runId, so progress and Stop can reach them. */
const live = new Map<string, { run: JiraRun; abort: AbortController }>();

export function jiraRunStatus(runId: string): JiraRun | undefined {
  return live.get(runId)?.run;
}
export function liveJiraRuns(): JiraRun[] {
  return [...live.values()].map((v) => v.run);
}
/** Stop after the ticket now executing. Unfinished tickets stay NOT EXECUTED
 *  — an interrupted run must never look like a completed one. */
export function stopJiraRun(runId: string): boolean {
  const v = live.get(runId);
  if (!v) return false;
  v.abort.abort();
  v.run.stopped = true;
  return true;
}

export interface JiraRunRequest {
  host: string;
  username: string;
  password: string;
  /** A category name, or '*' for every category. */
  category: string;
  /** Specific tickets, when running one or a chosen few. Wins over category. */
  keys?: string[];
  /** Skip the ones that cannot be tested, so a run is all signal. */
  runnableOnly?: boolean;
  headless?: boolean;
  /** Safety valve: a category of 297 is hours of browser time. */
  max?: number;
}

/** Everything this executor knows how to do on a page, in step order. */
async function visitPage(page: Page, host: string, label: string): Promise<{ ok: boolean; detail: string }> {
  // The Simnovator's shell has no nav anchors — the sidebar is bare <li>
  // rows — so a page is reached by clicking the row that carries its name,
  // the same way the crawler does it.
  const tries = [
    () => page.getByRole('menuitem', { name: new RegExp(label, 'i') }).first().click({ timeout: 6000 }),
    () => page.getByRole('link', { name: new RegExp(label, 'i') }).first().click({ timeout: 6000 }),
    () => page.getByRole('button', { name: new RegExp(label, 'i') }).first().click({ timeout: 6000 }),
    () => page.locator(`li:has-text("${label}")`).first().click({ timeout: 6000 }),
    () => page.locator(`[class*="cursor-pointer"]:has-text("${label}")`).first().click({ timeout: 6000 }),
  ];
  for (const t of tries) {
    const clicked = await t().then(() => true).catch(() => false);
    if (!clicked) continue;
    // The SPA swaps the view without a load event, so settle on the network
    // going quiet rather than on navigation.
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    return { ok: true, detail: `opened "${label}"` };
  }
  return { ok: false, detail: `could not find a way to open "${label}" from this page` };
}

/** An application error on the page — not a test failure we invented, the
 *  app's own words. */
async function appError(page: Page): Promise<string | undefined> {
  const probes = [
    '[class*="error"]:visible', '[role="alert"]:visible',
    'text=/internal server error/i', 'text=/something went wrong/i',
  ];
  for (const p of probes) {
    const el = page.locator(p).first();
    const has = await el.count().then((n) => n > 0).catch(() => false);
    if (!has) continue;
    const txt = await el.innerText().catch(() => '');
    const t = String(txt).replace(/\s+/g, ' ').trim();
    if (t && t.length < 300) return t;
  }
  return undefined;
}

/** Where a ticket's evidence file is served from, relative to data/jira-ui. */
const rel = (runId: string, key: string, file: string) => `runs/${runId}/${safeKey(key)}/${file}`;

async function executeTicket(
  browser: Browser,
  req: JiraRunRequest,
  t: JiraTicket,
  runId: string,
  canRecord: boolean,
  signal: AbortSignal,
): Promise<TicketResult> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const dir = ticketDir(runId, t.key);
  fs.mkdirSync(dir, { recursive: true });
  const plan = planTicket(t);
  const screenshots: string[] = [];
  const consoleErrors: string[] = [];

  const base: TicketResult = {
    key: t.key, summary: t.summary, category: t.category,
    status: 'NOT EXECUTED',
    expected: plan.expected, actual: '', screenshots,
    startedAt, durationMs: 0,
  };

  // A ticket that cannot be tested is reported, not run — and not recorded,
  // because there is nothing to film.
  if (!plan.runnability.runnable) {
    return {
      ...base, status: 'BLOCKED',
      actual: 'not executed',
      error: plan.runnability.reason,
      recordingUnavailable: 'the ticket was not executed, so there is nothing to record',
      finishedAt: new Date().toISOString(), durationMs: Date.now() - t0,
    };
  }

  const videoDir = path.join(dir, 'video');
  if (canRecord) fs.mkdirSync(videoDir, { recursive: true });
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  try {
    context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1500, height: 950 },
      recordVideo: canRecord ? { dir: videoDir, size: { width: 1500, height: 950 } } : undefined,
    });
    page = await context.newPage();
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });

    const shot = async (name: string) => {
      const file = `${String(screenshots.length + 1).padStart(2, '0')}-${name}.png`;
      await (page as Page).screenshot({ path: path.join(dir, file), fullPage: false }).catch(() => {});
      screenshots.push(rel(runId, t.key, file));
    };

    // Step 1 of every one of these tickets: sign in.
    const signedIn = await login({ host: req.host, username: req.username, password: req.password }, page);
    await shot('after-login');
    if (!signedIn.ok) {
      return {
        ...base, status: 'BLOCKED',
        actual: `could not sign in to ${req.host}: ${signedIn.detail}`,
        error: signedIn.detail,
        finishedAt: new Date().toISOString(), durationMs: Date.now() - t0,
      };
    }

    // Walk the pages the ticket's steps name, in order.
    const walked: string[] = [];
    let failedStep: string | undefined;
    let navError: string | undefined;
    for (const step of plan.steps) {
      if (signal.aborted) break;
      if (!step.page || step.page === 'Login') continue;
      const v = await visitPage(page, req.host, step.page);
      await shot(`step${step.n}-${step.page.replace(/\s+/g, '-').toLowerCase()}`);
      if (!v.ok) { navError = v.detail; failedStep = `Step ${step.n}: ${step.text}`; break; }
      walked.push(step.page);
      const err = await appError(page);
      if (err) { navError = `the application showed an error: ${err}`; failedStep = `Step ${step.n}: ${step.text}`; break; }
    }

    const pageText = await page.innerText('body').catch(() => '');
    await shot('final');

    // A page the ticket names that would not open, or an app error, is a
    // failure of the ticket's own steps.
    if (navError) {
      return {
        ...base, status: 'FAIL',
        actual: navError, error: navError, failedStep,
        finishedAt: new Date().toISOString(), durationMs: Date.now() - t0,
      };
    }

    // Now the ticket's own expected result — the only thing that can make
    // this a pass.
    const checkable = checkableFrom(plan.expected);
    const outcome = runCheck(checkable, pageText);
    if (outcome.pass === undefined) {
      return {
        ...base, status: 'BLOCKED',
        actual: `walked ${walked.length ? walked.join(' → ') : 'the ticket\'s pages'} with no error, `
          + 'and captured a recording and screenshots — but the result was not asserted',
        error: outcome.detail,
        finishedAt: new Date().toISOString(), durationMs: Date.now() - t0,
      };
    }
    const status: TicketStatus = outcome.pass ? 'PASS' : 'FAIL';
    return {
      ...base, status,
      actual: outcome.detail,
      ...(outcome.pass ? {} : { error: outcome.detail, failedStep: lastCheckStep(plan) }),
      ...(consoleErrors.length ? { error: `${outcome.detail} · console: ${consoleErrors[0]}` } : {}),
      finishedAt: new Date().toISOString(), durationMs: Date.now() - t0,
    };
  } catch (e: any) {
    return {
      ...base, status: 'BLOCKED',
      actual: 'the test could not be completed',
      error: e?.message ?? String(e),
      finishedAt: new Date().toISOString(), durationMs: Date.now() - t0,
    };
  } finally {
    // Closing the context is what flushes the video to disk.
    const vp = page ? page.video() : undefined;
    await context?.close().catch(() => {});
    if (canRecord && vp) {
      try {
        const saved = await vp.path();
        base.recording = rel(runId, t.key, `video/${path.basename(saved)}`);
      } catch { /* reported as unavailable below */ }
    }
  }
}

/** The step a failed check belongs to: the last observation step, which is
 *  where the ticket itself puts the expectation. */
function lastCheckStep(plan: ReturnType<typeof planTicket>): string | undefined {
  const checks = plan.steps.filter((s) => s.isCheck);
  const s = checks[checks.length - 1] ?? plan.steps[plan.steps.length - 1];
  return s ? `Step ${s.n}: ${s.text}` : undefined;
}

/**
 * Run a category, or a chosen few tickets.
 *
 * The run is saved after every ticket, so progress is real and an
 * interrupted run keeps the results and recordings it already has — which is
 * requirement 7's "if execution is interrupted, preserve completed results".
 */
export async function runJiraTickets(req: JiraRunRequest): Promise<JiraRun> {
  const db = readTickets();
  if (!db) throw new Error('no Jira tickets stored — refresh from Jira first');

  let chosen = req.keys?.length
    ? db.tickets.filter((t) => (req.keys as string[]).includes(t.key))
    : req.category === '*' ? db.tickets : db.tickets.filter((t) => t.category === req.category);
  if (req.runnableOnly) chosen = chosen.filter((t) => planTicket(t).runnability.runnable);
  if (req.max && req.max > 0) chosen = chosen.slice(0, req.max);
  if (chosen.length === 0) throw new Error('nothing to run for that selection');

  const canRecord = detectFfmpeg();
  const runId = newRunId();
  const abort = new AbortController();
  const run: JiraRun = {
    runId, category: req.keys?.length ? 'selection' : req.category,
    requested: chosen.map((t) => t.key),
    host: req.host, boxUser: req.username,
    startedAt: new Date().toISOString(), live: true,
    recordingAvailable: canRecord,
    results: [],
  };
  live.set(runId, { run, abort });
  saveRun(run);

  const launched = await launchUiBrowser({ headless: req.headless !== false });
  if (!launched.browser) {
    run.live = false;
    run.finishedAt = new Date().toISOString();
    saveRun(run);
    live.delete(runId);
    throw new Error(`no browser available: ${launched.lastErr?.message ?? launched.tried.join(', ')}`);
  }

  try {
    for (const t of chosen) {
      if (abort.signal.aborted) break;
      const r = await executeTicket(launched.browser, req, t, runId, canRecord, abort.signal);
      if (canRecord && !r.recording && r.status !== 'BLOCKED') {
        r.recordingUnavailable = 'the recording could not be written for this ticket';
      }
      run.results.push(r);
      saveRun(run);                   // after every ticket, not at the end
    }
  } finally {
    await launched.browser.close().catch(() => {});
    run.live = false;
    run.finishedAt = new Date().toISOString();
    saveRun(run);
    live.delete(runId);
  }
  return run;
}

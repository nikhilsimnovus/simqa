// Login → detect build → discover UI → plan → execute → report.
//
// The whole flow for one setup, in one place. Everything specific to a
// Simnovator's shape comes from the crawl; everything specific to a build
// comes from the diff against the map kept from the last one. Nothing here
// names a page.
//
// A run reports progress through the module-level registry below (one at a
// time per host — a box cannot be driven by two browsers at once) so the page
// can show the tree filling in and the checks ticking over, and can stop it.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import { launchUiBrowser, login, detectFfmpeg } from '../uiTester';
import { uesimApiOptsForSystem, type Inventory } from '../inventory';
import { resolveBoxBuild } from '../buildVersion';
import { crawlUi } from './crawl.ts';
import { checksFromMap, planSummary, type PlanOptions } from './plan.ts';
import { executeNodeChecks, type CheckOutcome, type ExecContext } from './execute.ts';
import { diffMaps, describeDiff } from './diff.ts';
import { saveMap, readMap, previousBuildMap, discoveryRunDir } from './store.ts';
import type { GeneratedCheck, UiMap, UiMapDiff } from './types.ts';

export interface DiscoveryRequest {
  targetSystemId?: string;
  /** Which of the setup's box logins to read the UI as. The Simnovator scopes
   *  its pages per account, so this decides what gets discovered. */
  boxUserId?: string;
  headless?: boolean;
  /** 'discover' maps the UI and stops. 'run' uses the stored map. Default is
   *  both: map it, then run against what was just found. */
  mode?: 'discover' | 'run' | 'discover+run';
  maxPages?: number;
  budgetMs?: number;
  openDialogs?: boolean;
  plan?: PlanOptions;
  /** Record the whole session to video. On where ffmpeg is installed. */
  record?: boolean;
  /** Limit a run to these sections (top-level menus) or check ids. */
  onlySections?: string[];
  onlyCheckIds?: string[];
}

export interface DiscoveryCounts {
  total: number; passed: number; failed: number;
  skipped: number; notAvailable: number; errors: number;
}

export interface DiscoveryRunResult {
  ok: boolean;
  startedAt: string;
  finishedAt: string;
  runDir: string;
  systemId?: string;
  host: string;
  username?: string;
  build?: string;
  map?: UiMap;
  diff?: UiMapDiff;
  diffSummary?: string;
  plan?: ReturnType<typeof planSummary>;
  counts: DiscoveryCounts;
  outcomes: CheckOutcome[];
  notes: string[];
  /** Recording of the whole session, relative to runDir. */
  videoFile?: string;
  error?: string;
}

// ------------------------------------------------------------- progress ----

export interface DiscoveryProgress {
  host: string;
  systemId?: string;
  username?: string;
  startedAt: string;
  phase: 'launching' | 'login' | 'discovering' | 'planning' | 'running' | 'done';
  current?: string;
  pagesFound: number;
  completed: number;
  total: number;
  counts: DiscoveryCounts;
  liveOutcomes: CheckOutcome[];
  stopping?: boolean;
}

interface ActiveDiscovery extends DiscoveryProgress {
  abort: AbortController;
}

const active = new Map<string, ActiveDiscovery>();

export function discoveryStatus(host?: string): DiscoveryProgress | undefined {
  if (host) {
    const a = active.get(host);
    return a ? strip(a) : undefined;
  }
  const first = active.values().next().value;
  return first ? strip(first) : undefined;
}

export function listDiscoveries(): DiscoveryProgress[] {
  return [...active.values()].map(strip);
}

export function stopDiscovery(host?: string): boolean {
  const targets = host ? [active.get(host)].filter(Boolean) as ActiveDiscovery[] : [...active.values()];
  if (targets.length === 0) return false;
  for (const t of targets) { t.abort.abort(); t.stopping = true; }
  return true;
}

function strip(a: ActiveDiscovery): DiscoveryProgress {
  const { abort, ...rest } = a;
  return { ...rest, liveOutcomes: rest.liveOutcomes.slice(-200) };
}

const zero = (): DiscoveryCounts => ({ total: 0, passed: 0, failed: 0, skipped: 0, notAvailable: 0, errors: 0 });

function tally(counts: DiscoveryCounts, o: CheckOutcome) {
  counts.total += 1;
  if (o.status === 'pass') counts.passed += 1;
  else if (o.status === 'fail') counts.failed += 1;
  else if (o.status === 'skip') counts.skipped += 1;
  else if (o.status === 'not-available') counts.notAvailable += 1;
  else counts.errors += 1;
}

// ------------------------------------------------------------------ run ----

/** Console errors and API calls, captured per page and reset between them, so
 *  a check can say what THIS page logged rather than what the run has logged
 *  since it started. */
function attachCapture(page: Page) {
  let errs: string[] = [];
  let calls: Array<{ method: string; url: string; status?: number }> = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 500)); });
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`.slice(0, 500)));
  page.on('request', (r) => { calls.push({ method: r.method(), url: r.url() }); });
  page.on('response', (r) => {
    for (let i = calls.length - 1; i >= 0; i--) {
      if (calls[i].url === r.url() && calls[i].status === undefined) { calls[i].status = r.status(); break; }
    }
  });
  return {
    consoleErrorsSince: () => [...errs],
    apiCallsSince: () => [...calls],
    resetCapture: () => { errs = []; calls = []; },
  };
}

export async function runDiscovery(inv: Inventory, req: DiscoveryRequest): Promise<DiscoveryRunResult> {
  const startedAt = new Date().toISOString();
  const mode = req.mode ?? 'discover+run';
  const notes: string[] = [];

  const target = uesimApiOptsForSystem(inv, req.targetSystemId, req.boxUserId);
  if (!target) {
    return {
      ok: false, startedAt, finishedAt: new Date().toISOString(), runDir: '',
      host: '', counts: zero(), outcomes: [], notes,
      error: `No system in inventory.yaml matched "${req.targetSystemId ?? '(default Simnovator)'}". Pick a setup from the list.`,
    };
  }
  if (active.has(target.host)) {
    const a = active.get(target.host)!;
    return {
      ok: false, startedAt, finishedAt: new Date().toISOString(), runDir: '',
      host: target.host, counts: zero(), outcomes: [], notes,
      error: `A UI discovery is already in flight against ${target.host} (started ${a.startedAt}, ${a.completed}/${a.total}). One browser per box — stop it or wait.`,
    };
  }

  const runDir = discoveryRunDir(target.host);
  const shotDir = path.join(runDir, 'shots');
  fs.mkdirSync(shotDir, { recursive: true });

  const abort = new AbortController();
  const state: ActiveDiscovery = {
    host: target.host, systemId: target.systemId, username: target.username,
    startedAt, phase: 'launching', pagesFound: 0, completed: 0, total: 0,
    counts: zero(), liveOutcomes: [], abort,
  };
  active.set(target.host, state);

  let browser: Browser | undefined;
  try {
    const launched = await launchUiBrowser({ headless: req.headless !== false });
    browser = launched.browser;
    if (!browser) {
      return {
        ok: false, startedAt, finishedAt: new Date().toISOString(), runDir,
        host: target.host, systemId: target.systemId, counts: zero(), outcomes: [], notes,
        error: `Could not launch a browser (tried ${launched.tried.join(', ')}). ${String(launched.lastErr?.message ?? '').slice(0, 200)}`,
      };
    }

    // Record the session when the box can. One video of the whole visit is
    // the strongest proof there is — it shows the sign-in, the pages opening
    // and every click in order — and it costs nothing per check.
    //
    // Gated on ffmpeg actually being installed: Playwright's recordVideo
    // throws out of newContext() when its ffmpeg binary is missing, which
    // would take the whole run down for the sake of a nice-to-have.
    const canRecord = req.record !== false && detectFfmpeg();
    const videoDir = path.join(runDir, 'video');
    if (canRecord) fs.mkdirSync(videoDir, { recursive: true });
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1500, height: 950 },
      recordVideo: canRecord ? { dir: videoDir, size: { width: 1500, height: 950 } } : undefined,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    page.setDefaultNavigationTimeout(60000);
    const capture = attachCapture(page);

    // 1 — sign in as the chosen box login.
    state.phase = 'login';
    const auth = await login({ host: target.host, username: target.username, password: target.password }, page);
    if (!auth.ok) {
      return {
        ok: false, startedAt, finishedAt: new Date().toISOString(), runDir,
        host: target.host, systemId: target.systemId, username: target.username, counts: zero(), outcomes: [], notes,
        error: `Could not sign in to ${target.host} as ${target.username}: ${auth.detail}`,
      };
    }
    const statePath = path.join(runDir, 'auth.json');
    await context.storageState({ path: statePath }).catch(() => null);

    // 2 — which build is on the box. Part of every report, and the thing the
    // diff is keyed on.
    const build = await resolveBoxBuild(target.host, target.username, target.password)
      .then(b => b?.version)
      .catch(() => undefined);

    // 3 — read the UI, or reuse the map we already have.
    let map: UiMap | undefined;
    if (mode === 'run') {
      map = readMap(target.host, target.username);
      if (!map) {
        return {
          ok: false, startedAt, finishedAt: new Date().toISOString(), runDir,
          host: target.host, systemId: target.systemId, username: target.username, build,
          counts: zero(), outcomes: [], notes,
          error: `No UI has been discovered for ${target.host} as ${target.username} yet. Run Discover first.`,
        };
      }
      notes.push(`ran against the map discovered at ${map.discoveredAt}${map.build ? ` on build ${map.build}` : ''}`);
    } else {
      state.phase = 'discovering';
      const crawled = await crawlUi(page, {
        host: target.host,
        systemId: target.systemId,
        username: target.username,
        build,
        maxPages: req.maxPages ?? 40,
        budgetMs: req.budgetMs ?? 6 * 60_000,
        openDialogs: req.openDialogs !== false,
        screenshotDir: shotDir,
        signal: abort.signal,
        onProgress: (label, pages) => { state.current = label; state.pagesFound = pages; },
        ...capture,
      });
      map = crawled.map;
      notes.push(...(map.notes ?? []));
    }

    // 4 — what changed since the map taken on the previous build.
    const previous = mode === 'run' ? undefined : previousBuildMap(target.host, target.username, build) ?? readMap(target.host, target.username);
    const diff = diffMaps(previous, map);
    if (mode !== 'run') saveMap(map);

    // 5 — plan. Generated from the map that was just read, so a page this
    // build added is in scope without anyone writing a test for it.
    state.phase = 'planning';
    let checks = checksFromMap(map, req.plan ?? {});
    if (req.onlySections?.length) {
      const want = new Set(req.onlySections);
      checks = checks.filter(c => want.has(c.section));
    }
    if (req.onlyCheckIds?.length) {
      const want = new Set(req.onlyCheckIds);
      checks = checks.filter(c => want.has(c.id));
    }
    const summary = planSummary(checks);

    const result: DiscoveryRunResult = {
      ok: true, startedAt, finishedAt: new Date().toISOString(), runDir,
      systemId: target.systemId, host: target.host, username: target.username, build,
      map, diff, diffSummary: describeDiff(diff), plan: summary,
      counts: zero(), outcomes: [], notes,
    };

    if (mode === 'discover') {
      state.phase = 'done';
      result.videoFile = await finishRecording(context, page, runDir);
      writeReport(runDir, result);
      return result;
    }

    // 6 — execute, one navigation per page.
    state.phase = 'running';
    state.total = checks.length;
    const byNode = new Map<string, GeneratedCheck[]>();
    for (const c of checks) {
      const arr = byNode.get(c.nodeId + '|' + (c.section === 'Application' ? 'app' : 'page'));
      if (arr) arr.push(c); else byNode.set(c.nodeId + '|' + (c.section === 'Application' ? 'app' : 'page'), [c]);
    }
    // Application-level checks navigate themselves and must not share a group.
    const groups: GeneratedCheck[][] = [];
    for (const [, arr] of byNode) {
      const app = arr.filter(c => c.section === 'Application');
      const rest = arr.filter(c => c.section !== 'Application');
      if (rest.length) groups.push(rest);
      for (const a of app) groups.push([a]);
    }

    const ctx: ExecContext = {
      page,
      host: target.host,
      ...capture,
      probeRequiredFields: req.plan?.probeRequiredFields,
      signal: abort.signal,
      newAnonPage: async () => {
        const anon = await browser!.newContext({ ignoreHTTPSErrors: true });
        return anon.newPage();
      },
      shot: async (name: string) => {
        const file = `${name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)}.png`;
        const ok = await page.screenshot({ path: path.join(shotDir, file), fullPage: true })
          .then(() => true).catch(() => false);
        return ok ? `shots/${file}` : undefined;
      },
    };

    for (const group of groups) {
      if (abort.signal.aborted) { notes.push('the run was stopped by the operator'); break; }
      state.current = group[0].page;
      const outcomes = await executeNodeChecks(ctx, group);
      for (const o of outcomes) {
        tally(result.counts, o);
        tally(state.counts, o);
        result.outcomes.push(o);
        state.liveOutcomes.push(o);
        state.completed += 1;
      }
    }

    result.finishedAt = new Date().toISOString();
    result.ok = result.counts.failed === 0 && result.counts.errors === 0;
    state.phase = 'done';
    // The recording is only written out when the context closes, so it is
    // collected here rather than left for the browser teardown in finally.
    result.videoFile = await finishRecording(context, page, runDir);
    writeReport(runDir, result);
    return result;
  } catch (e: any) {
    return {
      ok: false, startedAt, finishedAt: new Date().toISOString(), runDir,
      host: target.host, systemId: target.systemId, username: target.username,
      counts: zero(), outcomes: [], notes,
      error: `discovery threw: ${String(e?.stack ?? e?.message ?? e).slice(0, 600)}`,
    };
  } finally {
    active.delete(target.host);
    await browser?.close().catch(() => null);
  }
}

/** Close the context so Playwright finalises the recording, then report the
 *  file by the name the evidence route serves it under. Best-effort: a run
 *  whose video cannot be written is still a run with all its screenshots. */
async function finishRecording(context: BrowserContext, page: Page, runDir: string): Promise<string | undefined> {
  try {
    const video = page.video();
    if (!video) { await context.close().catch(() => null); return undefined; }
    await context.close();
    const full = await video.path();
    const rel = path.relative(runDir, full).split(path.sep).join('/');
    return rel.startsWith('..') ? undefined : rel;
  } catch {
    return undefined;
  }
}

/** The run's own copy of everything, next to its screenshots — so a report
 *  can be reopened, attached to a ticket, or diffed by hand later. */
function writeReport(runDir: string, result: DiscoveryRunResult): void {
  try {
    fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify(result, null, 2));
  } catch { /* the response still carries it */ }
}

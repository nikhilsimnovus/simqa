// Where the Jira tickets, their categories and every execution live.
//
//   seed/jira-ui/tickets.json            shipped with the build, 996 tickets
//   data/jira-ui/tickets.json            the working copy, refreshable
//   data/jira-ui/runs/<runId>/run.json   one execution of a category
//   data/jira-ui/runs/<runId>/<KEY>/     that ticket's own evidence
//       video/*.webm                     its own recording
//       *.png                            screenshots at each checkpoint
//
// Two rules shape this. Every ticket's evidence is in its own directory, so
// one ticket can be inspected without watching a whole category — that is
// requirement 5, and a directory per ticket is the simplest thing that
// guarantees it. And a run is never rewritten: a second execution of the same
// category is a new runId, so previous reports and recordings survive, which
// is requirement 8.
//
// data/ is preserved across deploys by the installer, so evidence outlives a
// restart. The seed is copied in only when the working copy is absent, so a
// refresh from Jira is never undone by a deploy.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { detectFfmpeg } from '../uiTester';

export type TicketStatus = 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT EXECUTED';

export interface JiraTicket {
  key: string;
  url: string;
  summary: string;
  description: string;
  type: string;
  status: string;
  resolution: string;
  priority: string;
  labels: string[];
  components: string[];
  reporter: string;
  created: string;
  updated: string;
  /** Assigned by categorise.ts, with the reason kept so it can be queried. */
  category: string;
  categoryWhy: string[];
  testTypes: string[];
  /** Whether the ticket carries numbered reproduction steps, and whether it
   *  states an expected result. Both decide how far a test can honestly go. */
  hasSteps: boolean;
  statesExpected: boolean;
}

export interface TicketDb {
  project: string;
  projectName: string;
  reporters: string[];
  fetchedAt: string;
  categorisedAt?: string;
  total: number;
  tickets: JiraTicket[];
  categories: Array<{ name: string; total: number; withSteps: number }>;
}

const DATA = () => path.join(process.cwd(), 'data', 'jira-ui');
const SEED = () => path.join(process.cwd(), 'seed', 'jira-ui', 'tickets.json');
const DB = () => path.join(DATA(), 'tickets.json');
export const runsDir = () => path.join(DATA(), 'runs');

/**
 * The ticket database, seeded on first use.
 *
 * The seed is only copied when there is no working copy: once a refresh has
 * written real Jira data, a later deploy must not put the shipped snapshot
 * back over it.
 */
export function readTickets(): TicketDb | undefined {
  try {
    fs.mkdirSync(DATA(), { recursive: true });
    if (!fs.existsSync(DB()) && fs.existsSync(SEED())) {
      fs.copyFileSync(SEED(), DB());
    }
    if (!fs.existsSync(DB())) return undefined;
    return JSON.parse(fs.readFileSync(DB(), 'utf8')) as TicketDb;
  } catch {
    return undefined;
  }
}

/** Replace the working copy, atomically, after a Jira refresh. */
export function writeTickets(db: TicketDb): void {
  fs.mkdirSync(DATA(), { recursive: true });
  const tmp = `${DB()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 1), 'utf8');
  fs.renameSync(tmp, DB());
}

export interface TicketResult {
  key: string;
  summary: string;
  category: string;
  status: TicketStatus;
  /** What the ticket says should happen. Empty when it does not say — and
   *  then the ticket is BLOCKED rather than guessed at. */
  expected: string;
  /** What actually happened, in the executor's words. */
  actual: string;
  /** The exact assertion or error, when there was one. */
  error?: string;
  /** The failed step's text, so a failure points at a line of the ticket. */
  failedStep?: string;
  /** Evidence paths, relative to data/jira-ui — served by the evidence route.
   *  `recording` is absent when recording was not possible, and `why` says so
   *  rather than the UI implying a video exists. */
  recording?: string;
  recordingUnavailable?: string;
  screenshots: string[];
  startedAt: string;
  finishedAt?: string;
  durationMs: number;
}

export interface JiraRun {
  runId: string;
  /** The category this run was started for, or '*' for every category. */
  category: string;
  /** Keys requested, in order. */
  requested: string[];
  host: string;
  boxUser?: string;
  startedAt: string;
  finishedAt?: string;
  /** False once the run has ended, however it ended. */
  live: boolean;
  /** True when a person stopped it — unfinished tickets stay NOT EXECUTED
   *  rather than being marked anything else. */
  stopped?: boolean;
  recordingAvailable: boolean;
  results: TicketResult[];
}

const runDir = (runId: string) => path.join(runsDir(), runId);
export const ticketDir = (runId: string, key: string) => path.join(runDir(runId), safeKey(key));

/** A Jira key is already safe, but it arrives over HTTP, so it is checked. */
export function safeKey(key: string): string {
  return String(key).replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 40) || 'ticket';
}

export function newRunId(): string {
  const t = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `jira-${t}-${Math.random().toString(36).slice(2, 8)}`;
}

export function saveRun(run: JiraRun): void {
  try {
    fs.mkdirSync(runDir(run.runId), { recursive: true });
    const p = path.join(runDir(run.runId), 'run.json');
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(run, null, 1), 'utf8');
    fs.renameSync(tmp, p);
  } catch { /* a run that cannot be written is still a run in progress */ }
}

export function readRun(runId: string): JiraRun | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(runDir(runId), 'run.json'), 'utf8')) as JiraRun;
  } catch {
    return undefined;
  }
}

/** Every run, newest first. Previous runs are never overwritten, so this is
 *  the history the Reports view lists. */
export function listRuns(limit = 50): JiraRun[] {
  try {
    return fs.readdirSync(runsDir())
      .filter((d) => d.startsWith('jira-'))
      .sort().reverse().slice(0, limit)
      .map((d) => readRun(d))
      .filter((r): r is JiraRun => !!r);
  } catch {
    return [];
  }
}

/**
 * Whether a per-ticket recording can be made at all.
 *
 * Playwright's recordVideo throws out of newContext() when its ffmpeg is
 * missing, and requirement 5 says to report a recording as unavailable rather
 * than claim one was saved. So this is asked once per run, stored on the run,
 * and shown in the UI before anything is started.
 */
export function recordingAvailable(): boolean {
  return detectFfmpeg();
}

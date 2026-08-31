// Job Tracker data model.
//
// A "job" is one pass through the wizard: install a build, pick a playlist,
// check the resources are healthy, then execute the playlist and record what
// happened. The record is created as soon as the build install starts — that is
// a real, consequential action on lab hardware, so it belongs in the history
// whether or not the user ever reaches Submit.

/** Status values, in roughly the order a healthy job moves through them. */
export type JobStatus =
  | 'pending'            // created, nothing started
  | 'build_installing'   // Step 1 running
  | 'build_failed'       // Step 1 failed — the workflow stops here
  | 'resource_checking'  // Step 3 running
  | 'resource_failed'    // Step 3 found a blocker
  | 'ready'              // steps 1-3 done, not yet submitted
  | 'queued'             // submitted while the station was busy — waiting for it
  | 'in_progress'        // submitted, playlist executing
  | 'passed'             // every testcase passed
  | 'failed';            // at least one testcase failed, or execution errored

export const JOB_STATUS_LABEL: Record<JobStatus, string> = {
  pending:           'Pending',
  build_installing:  'Build Installing',
  build_failed:      'Build Failed',
  resource_checking: 'Resource Checking',
  resource_failed:   'Resource Check Failed',
  ready:             'Ready',
  queued:            'Queued — waiting for the station',
  in_progress:       'In Progress',
  passed:            'Passed',
  failed:            'Failed',
};

/** Statuses that mean the job is finished, one way or another. */
export const TERMINAL_STATUSES: JobStatus[] = ['build_failed', 'passed', 'failed'];

export type JobStepName = 'build' | 'playlist' | 'resources' | 'execution';
export type JobStepStatus = 'idle' | 'running' | 'ok' | 'failed';

export interface JobStepState {
  status: JobStepStatus;
  startedAt?: string;
  finishedAt?: string;
  detail?: string;
}

/** One line in a job's log. Kept flat so it appends cheaply to NDJSON. */
export interface JobLogEntry {
  ts: number;
  /** Which phase produced it — lets the log view filter. */
  phase: JobStepName;
  level: 'info' | 'stdout' | 'error' | 'step';
  line: string;
}

export interface BuildDetails {
  /** What the user typed. Empty when the install was skipped. */
  buildUrl: string;
  /** True once the job has been submitted and the install has NOT run yet.
   *
   *  Step 1 used to drive the install from the browser and block the wizard
   *  until it finished — so closing the tab killed a live lab install, and the
   *  user sat watching a progress log instead of finishing the job they came to
   *  create. Now Step 1 only records WHICH build to install; the executor
   *  performs it as the first phase after Submit. */
  installPending?: boolean;
  /** True when the user chose to skip installation and run against whatever
   *  build is already on the station. Recorded so the review page, history and
   *  logs say "skipped" rather than implying this job installed anything. */
  skipped?: boolean;
  /** Derived from the URL, e.g. "Simnovator-4.0.0_2608181819". */
  buildName?: string;
  /** The exact ./install line that was run — the audit trail for "which UE and
   *  app server did this actually use". */
  installCommand?: string;
  /** data/builds/<buildId> — where the installer's screenshots and raw log go. */
  buildId?: string;
  installedAt?: string;
}

export interface ResourceCheckItem {
  name: string;
  status: 'ready' | 'checking' | 'warning' | 'failed';
  detail?: string;
  /** False for advisory checks — a warning here must not block the job. */
  blocking: boolean;
}

export interface ResourceCheckResult {
  setupHost: string;
  checkedAt: string;
  items: ResourceCheckItem[];
  /** True when no BLOCKING check failed — this is what gates Submit. */
  ok: boolean;
  /** Station is healthy but occupied: the job is accepted and waits its turn.
   *  Distinct from !ok, which means it cannot run at all. */
  willQueue?: boolean;
  /** Names of the blocking checks that failed, for the submit-time message. */
  blockers?: string[];
  /** One sentence for the operator at the Submit button. */
  verdict?: string;
}

export interface TestcaseResult {
  name: string;
  status: 'queued' | 'running' | 'passed' | 'failed' | 'skipped';
  detail?: string;
  startedAt?: string;
  finishedAt?: string;
  /** Execution id on the box, when we got one. */
  executionId?: string;
}

export interface Job {
  /** Display id — JOB-001, JOB-002, … */
  id: string;
  /** Filesystem-safe unique key; same as id today, kept separate so a future
   *  id-format change cannot orphan existing directories. */
  key: string;
  status: JobStatus;

  /** Signed-in user who created the job. Undefined when created outside a
   *  browser session — recorded as absent rather than guessed. */
  user?: string;

  /** Simnovator station this job targets, e.g. "192.168.1.102". */
  setupHost: string;
  setupSystemId?: string;
  setupName?: string;

  build: BuildDetails;

  playlistId?: string;
  playlistName?: string;
  /** The testcases this job will actually run.
   *
   *  This is the SELECTED subset, not the playlist's full contents. A playlist
   *  of ten cases where the user ticked two produces two entries here — the
   *  job record must say what ran, not what could have. `playlistTestcases`
   *  keeps the full list for context so the detail view can show "2 of 10". */
  testcases: TestcaseResult[];
  /** Every testcase the chosen playlist contains, for "2 of 10" context.
   *  Absent on jobs created before subset selection existed, and on jobs run
   *  from individually-picked test cases (no playlist involved). */
  playlistTestcases?: string[];
  /** Which file was chosen out of the build for each component
   *  (ue / enb / mme / app / …). Recorded so the job says what was actually
   *  installed, not just which tarball it came from. */
  componentFiles?: Record<string, string>;

  resourceCheck?: ResourceCheckResult;

  steps: Record<JobStepName, JobStepState>;

  createdAt: string;
  /** When the playlist execution began — i.e. when Submit was pressed. */
  startedAt?: string;
  finishedAt?: string;
  /** Set once the user presses Submit Job. Distinguishes an abandoned wizard
   *  from a real job. */
  submittedAt?: string;
}

/** Blank step map for a new job. */
export function emptySteps(): Record<JobStepName, JobStepState> {
  return {
    build:     { status: 'idle' },
    playlist:  { status: 'idle' },
    resources: { status: 'idle' },
    execution: { status: 'idle' },
  };
}

/** Pull a human build name out of a build URL.
 *  "https://host/path/Simnovator-4.0.0_2608181819.tar.gz" → "Simnovator-4.0.0_2608181819" */
export function buildNameFromUrl(url: string): string | undefined {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop();
    if (!last) return undefined;
    return last.replace(/\.tar\.gz$|\.tgz$|\.zip$/i, '');
  } catch {
    return undefined;
  }
}

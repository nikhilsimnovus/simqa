// Per-suite runner. Branches on suite.kind:
//
//   kind == 'uesim-only'
//     testcaseIds are Simnovator REST testcase ids — for each one fire
//     POST /v2/testcases/{id}/executions and capture the execution id.
//
//   kind == 'uesim+callbox'
//     testcaseIds are filenames under /root/enb/config on the callbox.
//     For each filename:
//       - If the file is in suite.uploadedConfigs, scp it onto the
//         callbox at /root/enb/config/<filename> (sftp createWriteStream
//         — atomic, handles binary).
//       - Else: the file is already on the box (the user picked it from
//         the live `ls`), so we just verify it's still there.
//     We don't restart the eNB service (too lab-specific). The run
//     result tells the operator exactly which files are now staged so
//     they can activate manually.
//
// Sequential in both modes (the Simnovator box has a system-wide
// execution mutex anyway; sequential SFTP keeps callbox load sane).

import { loadInventory, getSystem, uesimApiOptsForSystem, type AutomationSuite, type SuiteItem, type InventorySystem } from '../inventory';
import { withSsh, readCommand } from '../configFidelity/ssh';
import { sudoLink } from '../labCfgLink';
import { bringUpDecision, callboxUsage } from '../callboxUsage';
import { findDefinition } from '../testcaseForUser';
import { describeOthers, describeCfg } from '../callboxShare';
import { saveRun, newRunId, saveRunConfigs, type RunRecord } from './runStore';
import { triggerPerfQaCollection, DEFAULT_PERFQA_URL } from './diagnostics';
import { duplicateTestcase } from './duplicateTestcase';
// Which statuses mean "the box is done with it". Case-insensitive, because the
// box replies in capitals — see isTerminalStatus.
import { isTerminalStatus } from './outcome';
import { saveRowConfigs } from '../suiteConfigStore';
import { preflightRows } from './preflightConfigs';
// Read a saved test.json the same way an uploaded one is read — tolerating
// the comments and trailing commas a hand edit leaves in it.
import { definitionFromText } from './importPack';
import { expectedRunSeconds } from './durationFit';
import { withLicenceTag, licenceTagOf } from './licenceTag';
// Which config gets which of the two entered licences.
import { tagForRole } from './licenceChoice';
// The box answers a refused trigger with HTTP 200 and a body that says so.
import { readTriggerAnswer, refusalDetail, type TriggerAnswer } from './triggerAnswer';
// A cell runs on a radio card, and the simulator has to own it.
import { cardsOf, fitCards, applyCardFit } from './rfCards';
import { isOurExecution, mayReport } from './ownExecution';
// Checksums, so an unchanged subscriber database is not sent again each run.
import { createHash } from 'node:crypto';
import { validateCfg, withDbInclude, ROLE_LABEL, type CfgRole } from '../cfgValidate';
import { readTestCaseFile, readAllTestCaseFiles, testCaseDir } from './serverConfigs';
import { syncRowToServer } from './syncServerConfigs';

/** How long to give the box before asking whether any UE attached. The UEs are
 *  powered on over the first ~30-40s (attachRate-dependent), so checking sooner
 *  reports a false "nothing attached". */
const ATTACH_CHECK_DELAY_SEC = 55;

interface AttachEvidence {
  /** Distinct UEs seen in NAS state 5GMM-REGISTERED. */
  registered: number;
  /** Distinct UEs that exchanged a DCCH message — that channel only exists once
   *  RRC is established, so it proves the UE found the cell and connected. */
  rrcConnected: number;
  /** "No cell available" lines: the UE searched and found nothing. */
  noCell: number;
  /** Whether any log file for this testcase was found at all. */
  sawLog: boolean;
}

/**
 * Gather evidence of whether UEs attached, from the UE simulator's log.
 *
 * The box's own verdict is useless for this — its only criterion is
 * Avg_DL_BLER <= 5%, which 0 attached UEs satisfies trivially.
 *
 * Deliberately reads SEVERAL signals rather than one. `5GMM-REGISTERED` is a
 * NAS message, and a testcase whose logging profile is e.g. "rrc_debug" logs no
 * NAS at all — counting only that reported "nothing attached" for a run that was
 * attaching fine. DCCH traffic is visible under any profile that logs RRC, and
 * "No cell available" is the positive signal of the failure we actually care
 * about (gnb cfg on a different band from the testcase).
 *
 * The log rotates at 5 MB (a 10s 64-UE test wrote ~926 MB across five segments),
 * so the live file AND every rotated segment are read. Counting happens on the
 * UE box — only the numbers cross the wire.
 */
async function gatherAttachEvidence(ueSys: any, tcName: string): Promise<AttachEvidence | null> {
  const q = tcName.replace(/'/g, "'\\''");
  const files = `/tmp/'${q}'.log /var/log/lte/'${q}'.log.*`;
  const cmd = [
    `F=$(ls ${files} 2>/dev/null | wc -l)`,
    `R=$(cat ${files} 2>/dev/null | grep -h '5GMM-REGISTERED' | awk '{print $5}' | sort -u | wc -l)`,
    `C=$(cat ${files} 2>/dev/null | grep -h 'DCCH-NR' | awk '{print $5}' | sort -u | wc -l)`,
    `N=$(cat ${files} 2>/dev/null | grep -hc 'No cell available' || true)`,
    `echo "$R $C $N $F"`,
  ].join('; ');
  try {
    const out = String(await readCommand(ueSys, cmd)).trim().split(/\s+/).map(Number);
    if (out.length < 4 || out.some(n => !Number.isFinite(n))) return null;
    return { registered: out[0], rrcConnected: out[1], noCell: out[2], sawLog: out[3] > 0 };
  } catch {
    return null;
  }
}

/** The UE simulator bound to a Simnovator by a topology profile — that's the box
 *  whose log carries the attach evidence. */
export function ueSystemForSimnovator(inv: ReturnType<typeof loadInventory>, simnovatorId?: string, chosenId?: string) {
  // What the suite says, when it says anything — the topology is the fallback
  // for suites saved before the Setup step offered the choice.
  const chosen = chosenId ? getSystem(inv, chosenId) : undefined;
  if (chosen) return chosen;
  if (!simnovatorId) return undefined;
  const profile = (inv.profiles ?? []).find(p => p.simnovator === simnovatorId);
  return profile?.uesim ? getSystem(inv, profile.uesim) : undefined;
}

/** Two cfg names that mean the same file: a link may hold an absolute target
 *  (/root/enb/config/x.cfg) or a bare one (x.cfg). */
function sameCfg(a?: string, b?: string): boolean {
  const base = (p?: string) => (p ?? '').split('/').filter(Boolean).pop() ?? '';
  return !!base(a) && base(a) === base(b);
}

/** Slack added to the poll window on top of the requested duration, to cover the
 *  box's power-on/attach/teardown phases (powerOnTime is roughly session + 50s,
 *  and a looped power-cycle profile runs it twice). */
const POLL_MARGIN_SEC = 180;

export interface SuiteRunStep {
  /** The testcase on the box this row actually executed — the COPY the runner
   *  creates, not the source it was copied from. Without it a report opened
   *  from a suite row would show the source's executions, which are somebody
   *  else's runs. */
  boxTestcaseId?: string;
  testcaseId: string;
  status: number;
  ok: boolean;
  executionId?: string;
  /**
   * `'note'` for a step that is not a test case: run-level bookkeeping the
   * record should keep, like putting the callbox's licence back.
   *
   * It belongs in the record — it is part of what the run did, and a run that
   * quietly stopped reporting its own housekeeping would be harder to trust,
   * not easier. But the History's table is a table of TEST CASES, and
   * "licence-restore / Not Executed" sitting among them reads as a test case
   * that did not run. So the table leaves notes out and the run detail shows
   * them.
   */
  kind?: 'note';
  /** Final verdict pulled from the box AFTER the test stops. Populated
   *  for tc rows that reached a terminal state (whether by the test
   *  finishing naturally or by us stopping it after the duration
   *  window). One of: PASS, FAIL, INCOMPLETE, ABORTED, STOPPED,
   *  TIMEOUT, ERROR — or '' if we never got a status back. */
  verdict?: string;
  /** Box's last reported execution status text, in its own spelling. One of
   *  the two fields the Status and Verdict columns show, so it is stored raw
   *  and mapped only at render time. */
  boxStatus?: string;
  /** Box's last reported execution RESULT, in its own spelling (PASS, FAIL,
   *  INCOMPLETE, ERROR, NOT_EXECUTED). Kept separate from `verdict`, which
   *  folds the status in and so could not be shown beside it without the two
   *  columns contradicting the Simnovator's own screen. */
  boxResult?: string;
  /** Whether the test was stopped explicitly by simqa (vs. finished
   *  on its own within the duration window). */
  stopped?: boolean;
  detail?: string;
  durationMs: number;
}

export interface SuiteRunResult {
  startedAt: string;
  finishedAt: string;
  suiteId: string;
  suiteName: string;
  kind: 'uesim-only' | 'uesim+callbox';
  uesimHost?: string;
  /** The Simnovator LOGIN the run executed as. A box serves each login only
   *  its own testcases and its own simulator, so the host alone does not say
   *  where a result came from. */
  boxUser?: string;
  callboxHost?: string;
  /** The UE simulator this run used — the machine ue.cfg was generated on and
   *  the attach check read. Recorded because a suite can be pointed at a
   *  different UE between runs, so "which UE" is a fact about the execution
   *  and not about the suite as it stands today. */
  ueHost?: string;
  /**
   * The licences this run actually executed with, by config role.
   *
   * What the Run dialog chose, or — where it chose nothing — the tag the
   * config already carried. Recorded per run because the configs on the
   * automation server go on changing afterwards: reading them later tells you
   * what they ask for NOW, which is a different question from what this
   * execution ran with.
   */
  licences?: { enb?: string; mme?: string; ims?: string };
  /** The configs each row deployed, kept with the run that deployed them.
   *  Stripped from the saved record once written to disk — see saveRun. */
  configSnapshots?: Record<string, Record<string, string>>;
  total: number;
  passed: number;
  failed: number;
  steps: SuiteRunStep[];
  /**
   * The rows this run was ASKED to execute, in suite order.
   *
   * `steps` only holds what actually ran, which is not the same thing: a
   * stopOnFail run that fails on row 1 of seven records one step, and the
   * other six — real rows of that execution, which simply never got their
   * turn — were invisible in the history. Keeping the request separately is
   * also what tells "Run Suite" from "Run Selected" after the fact: the
   * former asks for every row, the latter for the ones that were ticked.
   *
   * Absent on runs recorded before this existed, where the honest answer is
   * that we do not know what was asked for.
   */
  requested?: string[];
}

export interface RunOpts {
  /**
   * The licence each config should ask the licence server for, chosen in the
   * Run dialog and applied as the config is pushed.
   *
   * Per RUN, not saved on the suite: which licence is free, and which setup
   * the run is pointed at, are facts about today rather than about the
   * playlist. A role left out keeps whatever its config already names.
   */
  licenceTags?: { enb?: string; mme?: string; ims?: string };
  /** Box logins to run this suite for, in order. Omitted = just the one the
   *  suite is saved with. Each pass creates or reuses that user's own copies
   *  and executes on their own simulator, so the passes cannot collide. */
  asUsers?: string[];
  signal?: AbortSignal;
  onProgress?: (done: number, total: number, currentId?: string) => void;
  /** Fired as each row settles, so a caller can surface per-testcase status
   *  while the run is still going rather than only in the final record. */
  onStep?: (step: SuiteRunStep) => void;
  /** Signed-in user who submitted this job, for attribution on the saved
   *  record. Absent when triggered outside a browser session. */
  submittedBy?: string;
  /** When true, fire a perf-qa collection job alongside the run + stash
   *  the job id on the run record. Off by default — the customer may not
   *  have perf-qa deployed. */
  collectDiagnostics?: boolean;
  /** Override the perf-qa URL (otherwise SIMQA_PERFQA_URL / default). */
  perfQaUrl?: string;
  /** perf-qa profile name to load before collecting. */
  perfQaProfile?: string;
}

/** Best-effort capture of the box build version — used to stamp the run
 *  record so QA can compare runs across builds. */
async function fetchBuildVersion(host: string, token: string): Promise<string | undefined> {
  try {
    const r = await fetch(`http://${host}/v2/version`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000) });
    if (!r.ok) return undefined;
    const j: any = await r.json();
    const v = j?.simnovator?.version;
    const b = j?.simnovator?.build;
    return v && b ? `${v} (${b})` : (v ?? undefined);
  } catch { return undefined; }
}

interface ExecutionState {
  status?: string;
  result?: string;
  executionId?: string;
  durationSeconds?: number;
}

async function fetchLastExecution(host: string, token: string, tcId: string): Promise<ExecutionState | null> {
  try {
    const r = await fetch(`http://${host}/v2/testcases/${encodeURIComponent(tcId)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!r.ok) return null;
    const j: any = await r.json();
    const le = j?.metadata?.lastExecution;
    if (!le) return null;
    return {
      status: le.status, result: le.result,
      executionId: le.executionId, durationSeconds: le.durationSeconds,
    };
  } catch { return null; }
}

/** Poll a testcase's lastExecution.status until we see a terminal state
 *  or hit the per-testcase duration budget (seconds). Returns the
 *  final state captured, or null if the box never reported. */
async function pollExecutionToTerminal(
  host: string, token: string, tcId: string,
  triggerExecId: string | undefined, maxWaitSec: number, signal?: AbortSignal,
  /** The execution lastExecution held BEFORE this run triggered. Anything
   *  still wearing that id is the previous run's, not ours. */
  priorExecId?: string,
): Promise<ExecutionState | null> {
  const deadline = Date.now() + Math.max(5, maxWaitSec) * 1000;
  let last: ExecutionState | null = null;
  while (Date.now() < deadline && !signal?.aborted) {
    const s = await fetchLastExecution(host, token, tcId);
    if (s) {
      last = s;
      // Whose execution is this?
      //
      // "Any terminal status will do" was a false pass waiting to happen, and
      // it happened: NSA_3cell_Mobility_UDP_1UEs_automation was reported
      // COMPLETED/PASS twice on 13 Oct from the execution it ran on 9 Oct —
      // same executionId, same 105s duration, and the testcase's
      // lastModifiedOn never moved. The box takes tens of seconds to start an
      // execution and this polls 1.5s after triggering, so the first read is
      // the PREVIOUS run's record, already terminal.
      //
      // So: the id our POST returned when we have it, and otherwise anything
      // that is not the id that was already there. A run whose execution never
      // appears now times out and says so, which is the honest answer — far
      // better than inheriting a verdict from four days ago.
      if (isOurExecution(s, triggerExecId, priorExecId) && isTerminalStatus(s.status)) return s;
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  // Never hand back the previous run's record as this run's outcome.
  return mayReport(last, triggerExecId, priorExecId) ? last : null;
}

/**
 * How long the testcase on the box will actually take, by the box's own sum.
 *
 * Needed by the paths that run a testcase AS IT IS rather than making a copy
 * with a new duration: the row's figure says nothing about those, and they
 * used to be polled for exactly that figure with no margin at all — so a
 * testcase authored to run for 605s was stopped after the row's 100s and
 * recorded as aborted while the Simnovator completed it.
 *
 * 0 when the testcase cannot be read, which leaves the caller on the row's
 * duration — no worse than before.
 */
async function fetchExpectedRun(host: string, token: string, tcId: string): Promise<number> {
  try {
    const r = await fetch(`http://${host}/v2/testcases/${encodeURIComponent(tcId)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!r.ok) return 0;
    const j: any = await r.json();
    return expectedRunSeconds(j?.testDefinition ?? {});
  } catch { return 0; }
}

/**
 * Wait for an execution to reach a terminal state, and stop it only if it
 * really has not got there.
 *
 * One implementation for all three trigger paths, because they had three
 * different windows — two of them the row's duration with no margin — and the
 * difference was invisible until a row that passed on the box showed as
 * aborted in the suite.
 *
 * The last look before stopping matters: lastExecution is polled every two
 * seconds, so a test that finished inside the final gap would otherwise be
 * stopped after the fact and recorded as though SimQA had cut it short.
 */
async function settleExecution(
  host: string, token: string, tcId: string,
  triggerExecId: string | undefined, windowSec: number,
  signal?: AbortSignal, simulatorId?: string,
  /** What lastExecution held before this run triggered — see
   *  pollExecutionToTerminal. */
  priorExecId?: string,
): Promise<{ finalState: ExecutionState | null; stoppedByUs: boolean; execId?: string; lateFinish: boolean }> {
  let finalState = await pollExecutionToTerminal(host, token, tcId, triggerExecId, windowSec, signal, priorExecId);
  let naturallyDone = isTerminalStatus(finalState?.status);
  let lateFinish = false;
  if (!naturallyDone && !signal?.aborted) {
    const late = await fetchLastExecution(host, token, tcId);
    // The last look has the same rule: a terminal record belonging to the
    // previous run is not this run finishing in the final gap.
    if (isOurExecution(late, triggerExecId, priorExecId) && isTerminalStatus(late?.status)) {
      finalState = late;
      naturallyDone = true;
      lateFinish = true;
    }
  }
  const execId = finalState?.executionId ?? triggerExecId;
  let stoppedByUs = false;
  if (!naturallyDone && execId && !signal?.aborted) {
    const settled = await stopAndFinalize(host, token, tcId, execId, signal, simulatorId);
    if (settled) finalState = settled;
    stoppedByUs = true;
  }
  return { finalState, stoppedByUs, execId, lateFinish };
}

/** Stop an in-flight execution then settle into a terminal verdict.
 *
 *  Used when the duration window expires before the test stopped on its
 *  own — we explicitly POST /v2/testcases/executions/{eid}/stop, wait a
 *  few seconds for the box to settle to a terminal state, then GET the
 *  testcase one last time so the verdict surfaced to the user reflects
 *  the FINAL state (Stopped/Aborted/etc). Without this, a long test
 *  would just show "no terminal state within Ns" with no result.
 *
 *  Best-effort — every failure mode (stop returns 4xx, GET 404s, …)
 *  falls through to whatever lastExecution we captured before. */
async function stopAndFinalize(host: string, token: string, tcId: string, execId: string | undefined, signal?: AbortSignal, simulatorId?: string): Promise<ExecutionState | null> {
  if (!execId) return null;
  try {
    const simQ = simulatorId ? `?simulatorId=${encodeURIComponent(simulatorId)}` : '';
    await fetch(`http://${host}/v2/testcases/executions/${encodeURIComponent(execId)}/stop${simQ}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(10_000),
    });
  } catch { /* ignore — we'll still poll for the settle */ }
  // Give the box a moment to write the final status. Poll briefly.
  const settleDeadline = Date.now() + 10_000;
  let last: ExecutionState | null = null;
  while (Date.now() < settleDeadline && !signal?.aborted) {
    const s = await fetchLastExecution(host, token, tcId);
    if (s) {
      last = s;
      if (isTerminalStatus(s.status)) return s;
    }
    await new Promise(r => setTimeout(r, 1500));
  }
  return last;
}

/** Map the box's (status, result) pair to a single uppercase verdict the
 *  result table can show in one column. */
function deriveVerdict(state: ExecutionState | null, timedOut: boolean): string {
  if (!state && !timedOut) return '';
  if (!state) return 'TIMEOUT';
  const result = (state.result ?? '').toUpperCase();
  const status = (state.status ?? '').toUpperCase();
  if (result === 'PASS' || result === 'PASSED' || status === 'PASSED') return 'PASS';
  if (result === 'FAIL' || result === 'FAILED' || status === 'FAILED') return 'FAIL';
  if (result === 'INCOMPLETE') return 'INCOMPLETE';
  if (status === 'ABORTED') return 'ABORTED';
  if (status === 'STOPPED') return 'STOPPED';
  if (status === 'COMPLETED' && result === 'ERROR') return 'ERROR';
  return result || status || 'UNKNOWN';
}

async function login(host: string, username: string, password: string): Promise<string> {
  const r = await fetch(`http://${host}/v2/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
    // Bounded — an unreachable box would otherwise hang the whole suite run.
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`login ${r.status}`);
  const j: any = await r.json();
  return j.access_token ?? j.token;
}

/**
 * Put back every callbox config whose licence tag this run rewrote.
 *
 * `backups` maps the file's path on the callbox to the copy taken before the
 * tag was changed. Each is moved back — `mv`, so the backup is consumed and a
 * later run cannot mistake it for an untouched original.
 *
 * Best-effort per file, and never throws: a failed restore is reported, but a
 * run's verdict is about the test, and raising here would replace a real
 * result with a housekeeping error. A backup that survives is picked up by the
 * next run's `cp -n`, which refuses to overwrite it.
 */
async function restoreLicences(
  callboxSys: InventorySystem | undefined,
  backups: Map<string, string>,
  note: (msg: string) => void,
): Promise<void> {
  if (!callboxSys || backups.size === 0) return;
  const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  const restored: string[] = [];
  const stuck: string[] = [];
  try {
    await withSsh(callboxSys, async (ssh) => {
      for (const [dest, bk] of backups) {
        const r = await ssh.execCommand(
          `test -e ${q(bk)} && (sudo -n mv -f ${q(bk)} ${q(dest)} 2>/dev/null || mv -f ${q(bk)} ${q(dest)})`);
        const name = dest.split('/').pop() ?? dest;
        if (r.code === 0) restored.push(name); else stuck.push(name);
      }
    });
  } catch (e: any) {
    note(`licence-restore: could not reach the callbox to put ${[...backups.keys()].length} config(s) back `
      + `(${String(e?.message ?? e).slice(0, 120)}) — the backups are still there as *.simqa-licence-backup`);
    return;
  }
  if (restored.length) note(`licence-restore: ${restored.join(', ')} back to the licence the callbox had`);
  if (stuck.length) {
    note(`licence-restore: could NOT put ${stuck.join(', ')} back — the original is still on the callbox `
      + 'as the matching *.simqa-licence-backup file');
  }
}

/**
 * Start a test case and wait for the box to say what it did.
 *
 * This used to abort after 3 seconds and treat the AbortError as a 202,
 * because a start answers slowly and the box runs the test whether or not
 * anyone is still listening. The cost of that shortcut was never seeing the
 * answer: a refusal — HTTP 200 with `{"status":"Failure"}` — was recorded as
 * a successful trigger, and the row then sat out its entire poll window
 * before reporting a timeout for an execution that had never started.
 *
 * ~20s is what a real start takes to answer; the window below is generous
 * enough to cover a slow one and still bounded, and the run sleeps longer
 * than that before its attach check anyway. If it does time out, that is
 * reported as started-but-unconfirmed, because the box may well be running
 * the test — the poll then decides, as before.
 */
async function postTrigger(
  host: string,
  headers: Record<string, string>,
  tcId: string,
  body: string,
): Promise<{ status: number; answer: TriggerAnswer }> {
  try {
    const resp = await fetch(`http://${host}/v2/testcases/${encodeURIComponent(tcId)}/executions`, {
      method: 'POST', headers, body, signal: AbortSignal.timeout(TRIGGER_ANSWER_TIMEOUT_MS),
    });
    const text = await resp.text().catch(() => '');
    return { status: resp.status, answer: readTriggerAnswer(resp.status, text) };
  } catch (e: any) {
    // A timeout is not a refusal: the box holds the connection while it brings
    // the test up, so assume it started and let the poll find out.
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      return { status: 202, answer: { started: true, assumed: true } };
    }
    throw e;
  }
}

/** How long to wait for the trigger's answer. A start answered in 20.3s on
 *  192.168.1.95; a refusal comes back at once. */
const TRIGGER_ANSWER_TIMEOUT_MS = 90_000;

/** Fetch the first available simulator's id. The box's POST
 *  /v2/testcases/{id}/executions now rejects with 500 "No default
 *  simulator found" when no ?simulatorId=… is passed (regression
 *  introduced ~4.0.0_260605); pin every trigger to the first sim. */
async function fetchFirstSimulatorId(host: string, token: string): Promise<string | undefined> {
  return (await fetchSimulator(host, token))?.id;
}

/** The simulator a trigger will name, with the radio cards it owns.
 *
 *  The cards matter before a test case is built, not after: the box refuses to
 *  start one whose cells name a card this simulator does not own, and it
 *  refuses to save one that puts two cells on the same card. See rfCards.ts. */
async function fetchSimulator(
  host: string, token: string,
): Promise<{ id: string; name?: string; cards: number[] } | undefined> {
  try {
    const r = await fetch(`http://${host}/v2/simulators`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!r.ok) return undefined;
    const j: any = await r.json();
    const sims: any[] = j?.items ?? j?.data ?? [];
    const read = (s: any) => ({
      id: String(s.id),
      name: s.name ? String(s.name) : undefined,
      cards: (s?.nodes?.rfCards ?? [])
        .map((c: unknown) => Number(c))
        .filter((c: number) => Number.isFinite(c)) as number[],
      free: String(s.availability ?? '').toUpperCase() !== 'BUSY',
    });
    // Most logins can use exactly one simulator and the choice is moot. An
    // admin token sees several, and taking whichever came back first meant
    // taking one that may be busy, or one with fewer radio cards than the
    // suite's cells need — so prefer free, then the most cards. (A box with
    // six cards splits them across its simulators; a 3-cell test case needs
    // one simulator owning three.)
    const best = sims
      .filter((s) => s?.id)
      .map(read)
      .sort((a, b) => Number(b.free) - Number(a.free) || b.cards.length - a.cards.length)[0];
    if (!best) return undefined;
    return { id: best.id, name: best.name, cards: best.cards };
  } catch { return undefined; }
}

/**
 * Block until the simulator is free, or `maxSec` elapses.
 *
 * Suite rows run one after another, but the box doesn't drop `availability:
 * BUSY` the instant an execution stops — so triggering row 2 straight after row
 * 1 finished can 409. Waiting here is what makes "second one executes
 * automatically when the first stops" actually hold.
 *
 * Returns the name of whatever is still running if it never went idle.
 */
async function waitForSimulatorIdle(host: string, token: string, maxSec: number, signal?: AbortSignal): Promise<string | null> {
  const deadline = Date.now() + maxSec * 1000;
  let last: string | null = null;
  while (Date.now() < deadline && !signal?.aborted) {
    try {
      const r = await fetch(`http://${host}/v2/simulators`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (r.ok) {
        const j: any = await r.json();
        const sims: any[] = j?.items ?? j?.data ?? [];
        const busy = sims.find(s => String(s?.availability ?? '').toUpperCase() === 'BUSY');
        if (!busy) return null;
        last = busy.name ?? busy.id ?? 'a test case';
      }
    } catch { /* transient — keep waiting */ }
    await new Promise(res => setTimeout(res, 3_000));
  }
  return last;
}

async function runUesimOnly(suite: AutomationSuite, opts: RunOpts): Promise<SuiteRunResult> {
  const startedAt = new Date().toISOString();
  const inv = loadInventory();
  const ueOpts = uesimApiOptsForSystem(inv, suite.uesimSystemId ?? '', suite.boxUserId);
  if (!ueOpts) throw new Error(`suite uesimSystemId "${suite.uesimSystemId}" not testable`);
  const token = await login(ueOpts.host, ueOpts.username, ueOpts.password);
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const simulatorId = await fetchFirstSimulatorId(ueOpts.host, token);
  const triggerBody = JSON.stringify(simulatorId ? { simulatorId } : {});
  const steps: SuiteRunStep[] = [];
  let passed = 0, failed = 0;

  const defaultDur = suite.defaultDurationSec ?? 10;
  for (const tcId of suite.testcaseIds) {
    if (opts.signal?.aborted) break;
    opts.onProgress?.(steps.length, suite.testcaseIds.length, tcId);
    const t0 = Date.now();
    const durSec = suite.testcaseDurations?.[tcId] ?? defaultDur;
    try {
      // The box's POST .../executions needs `{simulatorId}` in the BODY
      // (returns 500 "No default simulator found" without it) and takes
      // ~20s to answer a start. Its answer is worth that wait: it says
      // whether the test actually started, and names the execution.
      //
      // The id already on record is noted first all the same — a trigger
      // that answers unreadably leaves ownership to be decided by
      // elimination, and a terminal record left by the PREVIOUS run is
      // otherwise indistinguishable from this one finishing.
      const priorExec = (await fetchLastExecution(ueOpts.host, token, tcId))?.executionId;
      const r = await postTrigger(ueOpts.host, H, tcId, triggerBody);
      if (!r.answer.started) {
        steps.push({
          testcaseId: tcId, status: r.status, ok: false,
          detail: refusalDetail(r.answer, r.status),
          durationMs: Date.now() - t0,
        });
        failed += 1;
        if (suite.stopOnFail) break;
        continue;
      }
      // Give the box a tick to register the execution before the first poll.
      await new Promise(res => setTimeout(res, 1500));
      // This path runs the testcase as it stands, so how long it takes is the
      // testcase's business, not the row's figure.
      const window1 = Math.max(durSec, await fetchExpectedRun(ueOpts.host, token, tcId)) + POLL_MARGIN_SEC;
      const { finalState, stoppedByUs, execId, lateFinish } =
        await settleExecution(ueOpts.host, token, tcId, r.answer.executionId, window1, opts.signal, simulatorId, priorExec);
      const verdict = deriveVerdict(finalState, !finalState);
      const passLike = verdict === 'PASS';
      steps.push({
        testcaseId: tcId, status: r.status, ok: passLike,
        executionId: finalState?.executionId ?? execId,
        verdict, boxStatus: finalState?.status, boxResult: finalState?.result, stopped: stoppedByUs,
        detail: finalState
          ? `verdict=${verdict} status=${finalState.status ?? '?'} result=${finalState.result ?? '?'} dur=${finalState.durationSeconds ?? '?'}s`
            + `${lateFinish ? ' (the box finished while the last poll was in flight)' : ''}${stoppedByUs ? ' (stopped by simqa)' : ''}`
          : `triggered but no terminal state within ${window1}s — stop attempted${stoppedByUs ? '; box never settled' : ''}`,
        durationMs: Date.now() - t0,
      });
      if (passLike) passed += 1; else { failed += 1; if (suite.stopOnFail) break; }
    } catch (e: any) {
      steps.push({ testcaseId: tcId, status: 0, ok: false, detail: `threw: ${e?.message ?? e}`, durationMs: Date.now() - t0 });
      failed += 1;
      if (suite.stopOnFail) break;
    }
  }
  opts.onProgress?.(steps.length, suite.testcaseIds.length);
  const buildVersion = await fetchBuildVersion(ueOpts.host, token);
  return {
    startedAt, finishedAt: new Date().toISOString(),
    suiteId: suite.id, suiteName: suite.name, kind: 'uesim-only',
    uesimHost: ueOpts.host, boxUser: ueOpts.boxUser,
    total: suite.testcaseIds.length, passed, failed, steps,
    buildVersion,
  } as SuiteRunResult & { buildVersion?: string };
}

async function runCallbox(suite: AutomationSuite, opts: RunOpts): Promise<SuiteRunResult & { buildVersion?: string }> {
  const startedAt = new Date().toISOString();
  const inv = loadInventory();
  const sys = suite.callboxSystemId ? getSystem(inv, suite.callboxSystemId) : undefined;
  if (!sys || sys.type !== 'CALLBOX') throw new Error(`suite callboxSystemId "${suite.callboxSystemId}" is not a CALLBOX`);
  const ueOpts = uesimApiOptsForSystem(inv, suite.uesimSystemId ?? '', suite.boxUserId);
  if (!ueOpts) throw new Error(`suite uesimSystemId "${suite.uesimSystemId}" not testable`);

  const safe = (s: string) => s.replace(/[^\w.\-]/g, '_');
  const steps: SuiteRunStep[] = [];
  let passed = 0, failed = 0;

  // Total = (1 callbox-config-push step if configured) + Simnovator-trigger steps.
  // The page renders these as prefixed step ids (cfg:foo / tc:bar).
  const cfg = suite.callboxConfig;
  const tcs = suite.testcaseIds;
  const total = (cfg ? 1 : 0) + tcs.length;
  let done = 0;

  // ── Phase 1: push/verify the single callbox config (if set) ─────
  let existing = new Set<string>();
  try {
    const raw = await readCommand(sys, 'sudo -n ls -1 /root/enb/config 2>/dev/null || ls -1 /root/enb/config 2>/dev/null');
    existing = new Set(raw.split('\n').map(s => s.trim()).filter(Boolean));
  } catch { /* leave empty — upload still attempts */ }

  // The callbox phase is now 3 steps when a config is set:
  //   1. cfg-push    scp the upload (or verify the picked file exists)
  //   2. cfg-link    ln -sf /root/enb/config/<name> /root/enb/config/enb.cfg
  //   3. cfg-restart `sudo service lte restart`
  //                  then wait ~15s for the eNB process to bind sockets
  // The total bumps by 3 instead of 1 to reflect the multi-step bring-up.
  const totalWithBringUp = (cfg ? 3 : 0) + tcs.length;

  // The callbox is shared by every user of the Simnovator, and the restart
  // below drops the radio under all of them. Nobody is here to answer a prompt,
  // so take the safe answer: if someone else is executing, run on the config
  // already linked. If the pick is already linked, there is nothing to restart.
  let sharedSkip: string | null = null;
  if (cfg && !opts.signal?.aborted && suite.uploadedConfigs?.[cfg]) {
    // An upload is new file content, so the name alone says nothing about
    // whether it changed — it is always applied, but never under someone else.
    try {
      const u = await callboxUsage(inv, sys, { me: ueOpts.boxUser });
      if (u.others.length) {
        sharedSkip = `${describeOthers(u.others)} is executing on this callbox — the uploaded ${cfg} was not applied; ran on the current config (${describeCfg(u.current)}), no lte restart`;
      }
    } catch { /* could not check — the normal bring-up runs */ }
  } else if (cfg && !opts.signal?.aborted) {
    try {
      const d = await bringUpDecision(inv, sys, ueOpts.boxUser, { enb: safe(cfg) });
      if (d.action === 'blocked') {
        sharedSkip = `${describeOthers(d.others)} is executing on this callbox — ran on its current config (${describeCfg(d.current)}); no link and no lte restart`;
      } else if (d.action === 'unchanged') {
        sharedSkip = `already linked (${describeCfg(d.current)}) — no lte restart needed`;
      }
    } catch { /* could not check — the normal bring-up runs */ }
  }
  if (sharedSkip) {
    steps.push({ testcaseId: `cfg-link:${cfg}`, status: 200, ok: true, detail: sharedSkip, durationMs: 0 });
    passed += 1;
    done += 3;
  }

  if (cfg && !opts.signal?.aborted && !sharedSkip) {
    const safeName = safe(cfg);
    const target = `/root/enb/config/${safeName}`;
    const linkPath = `/root/enb/config/enb.cfg`;
    const isUpload = !!suite.uploadedConfigs?.[cfg];

    // Step 1: cfg push
    opts.onProgress?.(done, totalWithBringUp, `cfg-push:${cfg}`);
    const t0 = Date.now();
    let cfgPushed = false;
    try {
      if (isUpload) {
        const b64 = suite.uploadedConfigs![cfg];
        const buf = Buffer.from(b64, 'base64');
        await withSsh(sys, async (ssh) => {
          const sftp = await ssh.requestSFTP();
          await new Promise<void>((resolve, reject) => {
            const ws = sftp.createWriteStream(target);
            ws.on('close', () => resolve());
            ws.on('error', reject);
            ws.end(buf);
          });
        });
        steps.push({
          testcaseId: `cfg-push:${cfg}`, status: 200, ok: true,
          detail: `uploaded ${buf.length}B → ${target} (overwrote=${existing.has(safeName)})`,
          durationMs: Date.now() - t0,
        });
        cfgPushed = true; passed += 1;
      } else {
        const present = existing.has(cfg) || existing.has(safeName);
        steps.push({
          testcaseId: `cfg-push:${cfg}`, status: present ? 200 : 404, ok: present,
          detail: present ? `present at ${target}` : `missing on callbox /root/enb/config`,
          durationMs: Date.now() - t0,
        });
        if (present) { cfgPushed = true; passed += 1; } else failed += 1;
      }
    } catch (e: any) {
      steps.push({ testcaseId: `cfg-push:${cfg}`, status: 0, ok: false, detail: `ssh: ${e?.message ?? e}`, durationMs: Date.now() - t0 });
      failed += 1;
    }
    done += 1;

    // Step 2: symlink enb.cfg → picked config
    if (cfgPushed) {
      opts.onProgress?.(done, totalWithBringUp, `cfg-link:${cfg}`);
      const t1 = Date.now();
      try {
        await withSsh(sys, async (ssh) => {
          const r = await ssh.execCommand(`sudo -n ln -sfn "${target}" "${linkPath}" 2>/dev/null || ln -sfn "${target}" "${linkPath}"; sudo -n ls -la "${linkPath}" 2>/dev/null || ls -la "${linkPath}"`);
          if (r.code !== 0) throw new Error(r.stderr || r.stdout || `ln exit ${r.code}`);
          return r.stdout;
        });
        steps.push({ testcaseId: `cfg-link:${cfg}`, status: 200, ok: true, detail: `${linkPath} → ${target}`, durationMs: Date.now() - t1 });
        passed += 1;
      } catch (e: any) {
        steps.push({ testcaseId: `cfg-link:${cfg}`, status: 0, ok: false, detail: `ln failed: ${e?.message ?? e}`, durationMs: Date.now() - t1 });
        failed += 1;
        cfgPushed = false;
      }
      done += 1;
    } else {
      // Skip link if push failed.
      done += 1;
    }

    // Step 3: restart the lte service + give it 15s to stabilise
    if (cfgPushed) {
      opts.onProgress?.(done, totalWithBringUp, `cfg-restart:${cfg}`);
      const t2 = Date.now();
      try {
        // The Simnovator callbox uses `service lte restart` — not systemd.
        const restartCmd = `sudo service lte restart`;
        await withSsh(sys, async (ssh) => {
          const r = await ssh.execCommand(restartCmd);
          if (r.code !== 0) throw new Error(r.stderr || r.stdout || `restart exit ${r.code}`);
        });
        // Give the eNB ~15s to bind sockets + come back. The actual
        // UE-attach attempts won't fire until after this sleep.
        await new Promise(r => setTimeout(r, 15_000));
        steps.push({ testcaseId: `cfg-restart:${cfg}`, status: 200, ok: true, detail: `lte service restarted + 15s settle`, durationMs: Date.now() - t2 });
        passed += 1;
      } catch (e: any) {
        steps.push({ testcaseId: `cfg-restart:${cfg}`, status: 0, ok: false, detail: `restart failed: ${e?.message ?? e}`, durationMs: Date.now() - t2 });
        failed += 1;
      }
      done += 1;
    } else {
      done += 1;
    }

    // If the bring-up failed and stopOnFail is set, skip testcases.
    if (suite.stopOnFail && failed > 0) {
      opts.onProgress?.(totalWithBringUp, totalWithBringUp);
      return {
        startedAt, finishedAt: new Date().toISOString(),
        suiteId: suite.id, suiteName: suite.name, kind: 'uesim+callbox',
        callboxHost: sys.host,
        total: totalWithBringUp, passed, failed, steps,
      };
    }
  }

  // ── Phase 2: trigger Simnovator testcases ─────────────────────────
  let token = '';
  let buildVersion: string | undefined;
  if (tcs.length > 0 && !opts.signal?.aborted) {
    try { token = await login(ueOpts.host, ueOpts.username, ueOpts.password); }
    catch (e: any) {
      // Can't even log in — mark all testcase steps failed in a single batch.
      for (const tcId of tcs) {
        steps.push({ testcaseId: `tc:${tcId}`, status: 0, ok: false, detail: `simnovator login: ${e?.message ?? e}`, durationMs: 0 });
        failed += 1;
      }
      done = total;
    }
  }
  if (token) {
    const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const simulatorId = await fetchFirstSimulatorId(ueOpts.host, token);
    const simQ = simulatorId ? `?simulatorId=${encodeURIComponent(simulatorId)}` : '';
    // total may have been bumped by the callbox bring-up steps — use it
    // for progress reporting in both branches.
    const totalProg = (cfg ? 3 : 0) + tcs.length;
    const defaultDur = suite.defaultDurationSec ?? 10;
    for (const tcId of tcs) {
      if (opts.signal?.aborted) break;
      opts.onProgress?.(done, totalProg, `tc:${tcId}`);
      const t0 = Date.now();
      const durSec = suite.testcaseDurations?.[tcId] ?? defaultDur;
      // This path reads the trigger's own execution id, so it normally knows
      // which execution is its own. Noted anyway for the case where the box
      // returns no id and the match falls back to "not the one already there".
      const priorExec2 = (await fetchLastExecution(ueOpts.host, token, tcId))?.executionId;
      try {
        const r = await fetch(`http://${ueOpts.host}/v2/testcases/${encodeURIComponent(tcId)}/executions${simQ}`, {
          method: 'POST', headers: H, body: '{}',
        });
        // The status line says 200 whether it started or refused, so the
        // body decides. See triggerAnswer.ts.
        const answer = readTriggerAnswer(r.status, await r.text().catch(() => ''));
        const execId = answer.executionId;
        if (!answer.started) {
          steps.push({
            testcaseId: `tc:${tcId}`, status: r.status, ok: false,
            executionId: execId,
            detail: refusalDetail(answer, r.status),
            durationMs: Date.now() - t0,
          });
          failed += 1;
          if (suite.stopOnFail) break;
          done += 1;
          continue;
        }
        // Trigger worked — now wait for the testcase's own run to finish, not
        // for the row's figure to elapse.
        const window2 = Math.max(durSec, await fetchExpectedRun(ueOpts.host, token, tcId)) + POLL_MARGIN_SEC;
        const settledRun = await settleExecution(ueOpts.host, token, tcId, execId, window2, opts.signal, simulatorId, priorExec2);
        const finalState = settledRun.finalState;
        const stoppedByUs = settledRun.stoppedByUs;
        const verdict = deriveVerdict(finalState, !finalState);
        const passLike = verdict === 'PASS';
        steps.push({
          testcaseId: `tc:${tcId}`, status: r.status, ok: passLike,
          executionId: finalState?.executionId ?? execId,
          verdict, boxStatus: finalState?.status, boxResult: finalState?.result, stopped: stoppedByUs,
          detail: finalState
            ? `verdict=${verdict} status=${finalState.status ?? '?'} result=${finalState.result ?? '?'} dur=${finalState.durationSeconds ?? '?'}s`
              + `${settledRun.lateFinish ? ' (the box finished while the last poll was in flight)' : ''}${stoppedByUs ? ' (stopped by simqa)' : ''}`
            : `triggered but no terminal state within ${window2}s`,
          durationMs: Date.now() - t0,
        });
        if (passLike) passed += 1; else { failed += 1; if (suite.stopOnFail) break; }
      } catch (e: any) {
        steps.push({ testcaseId: `tc:${tcId}`, status: 0, ok: false, detail: `threw: ${e?.message ?? e}`, durationMs: Date.now() - t0 });
        failed += 1;
        if (suite.stopOnFail) break;
      }
      done += 1;
    }
    buildVersion = await fetchBuildVersion(ueOpts.host, token);
  }
  const totalFinal = (cfg ? 3 : 0) + tcs.length;
  opts.onProgress?.(totalFinal, totalFinal);

  return {
    startedAt, finishedAt: new Date().toISOString(),
    suiteId: suite.id, suiteName: suite.name, kind: 'uesim+callbox',
    uesimHost: ueOpts.host, boxUser: ueOpts.boxUser,
    callboxHost: sys.host,
    total, passed, failed, steps,
    requested: tcs.map(String),
    buildVersion,
  };
}

/** Pair-shaped flow: one item = one (Simnovator testcase + optional
 *  callbox cfg). Each item triggers its own eNB bring-up cycle BEFORE
 *  the testcase fires, so each row carries its own radio context.
 *
 *  Per-item sequence (uesim+callbox):
 *    1. cfg-push     scp upload OR verify picked file
 *    2. cfg-link     ln -sfn /root/enb/config/<name> /root/enb/config/enb.cfg
 *    3. cfg-restart  service lte restart + 15s settle
 *    4. tc-trigger   POST /v2/testcases/{id}/executions
 *    5. tc-poll      poll lastExecution until terminal or duration timeout
 *
 *  For uesim-only suites items just skip 1-3. */
async function runItems(suite: AutomationSuite, items: SuiteItem[], opts: RunOpts): Promise<SuiteRunResult & { buildVersion?: string }> {
  const startedAt = new Date().toISOString();
  const inv = loadInventory();
  const ueOpts = uesimApiOptsForSystem(inv, suite.uesimSystemId ?? '', suite.boxUserId);
  if (!ueOpts) throw new Error(`suite uesimSystemId "${suite.uesimSystemId}" not testable`);
  const callboxSys = suite.kind === 'uesim+callbox' && suite.callboxSystemId
    ? getSystem(inv, suite.callboxSystemId)
    : undefined;
  if (suite.kind === 'uesim+callbox' && (!callboxSys || callboxSys.type !== 'CALLBOX')) {
    throw new Error(`suite callboxSystemId "${suite.callboxSystemId}" is not a CALLBOX`);
  }
  // The UE box holds the only real evidence of whether UEs attached. Absent a
  // topology profile binding it to this Simnovator we simply skip the check
  // rather than failing the run.
  const ueSys = ueSystemForSimnovator(inv, suite.uesimSystemId, suite.ueSystemId);

  const safe = (s: string) => s.replace(/[^\w.\-]/g, '_');
  const rawSteps: SuiteRunStep[] = [];
  /** Record a step AND report it, so the UI can colour a row the moment it
   *  settles instead of waiting for the whole suite. */
  const steps = {
    push(step: SuiteRunStep) {
      rawSteps.push(step);
      try { opts.onStep?.(step); } catch { /* reporting must never break a run */ }
      return rawSteps.length;
    },
    get length() { return rawSteps.length; },
  };
  let passed = 0, failed = 0;
  const total = items.length;
  let done = 0;

  /**
   * Callbox configs whose licence tag this run rewrote, and where their
   * original bytes are kept.
   *
   * Run-level, not per-row, and restored in a `finally` — because the licence
   * has to go back whether the run finished, failed, or was stopped halfway.
   *
   * This is deliberately separate from the symlink restore and the
   * added-this-run cleanup below, which cannot cover it: both of those keep a
   * config that was ALREADY on the callbox, on the correct grounds that the
   * box still depends on it. A licence rewritten into such a file therefore
   * used to stay on the callbox for good — a suite run once with oran-enb left
   * every later run, and every other operator, on oran-enb.
   *
   * Maps the file's path on the callbox to its backup path.
   */
  const licenceBackups = new Map<string, string>();

  /**
   * The licence each config role actually went to the callbox carrying.
   *
   * Read off the bytes that were written, not from the choice that was made:
   * a role the Run dialog left alone keeps whatever its config already asked
   * for, and that is what executed. First write wins, because every row of a
   * run pushes the same three roles and the first is as true as the last.
   */
  const licencesUsed: { enb?: string; mme?: string; ims?: string } = {};

  /** Each row's deployed configs, as they were when it ran. The run has no
   *  id until it finishes, so they are held here and written with it. */
  const configSnapshots: Record<string, Record<string, string>> = {};

  // Cache of files currently on the callbox so we don't re-ls per item.
  let existing = new Set<string>();
  let existingCore = new Set<string>();
  let existingOts = new Set<string>();
  if (callboxSys) {
    try {
      const raw = await readCommand(callboxSys, 'sudo -n ls -1 /root/enb/config 2>/dev/null || ls -1 /root/enb/config 2>/dev/null');
      existing = new Set(raw.split('\n').map(s => s.trim()).filter(Boolean));
    } catch { /* uploads still attempt */ }
    try {
      const raw = await readCommand(callboxSys, 'sudo -n ls -1 /root/mme/config 2>/dev/null || ls -1 /root/mme/config 2>/dev/null');
      existingCore = new Set(raw.split('\n').map(s => s.trim()).filter(Boolean));
    } catch { /* uploads still attempt */ }
    try {
      const raw = await readCommand(callboxSys, 'sudo -n ls -1 /root/ots/config 2>/dev/null || ls -1 /root/ots/config 2>/dev/null');
      existingOts = new Set(raw.split('\n').map(s => s.trim()).filter(Boolean));
    } catch { /* uploads still attempt */ }
  }

  // Can every row actually be prepared here, from what the server holds?
  //
  // Decided once, up front, now that the target's own files are known: a row
  // whose cfg exists neither in /root/automation_configs nor on this callbox
  // cannot be made to run, and discovering that row by row means finding out
  // several minutes apart, after a core that never started reports itself as
  // "no UEs attached". Rows that CAN run are unaffected and still run.
  const blockedRows = new Map<string, string[]>();
  {
    const folder: Record<string, Record<string, string>> = {};
    for (const it of items) {
      folder[it.name] = readAllTestCaseFiles(it.configSuite ?? suite.name, it.name);
    }
    for (const bad of preflightRows({
      rows: items.map(it => ({
        name: it.name, callboxCfg: it.callboxCfg, mmeCfg: it.mmeCfg, imsCfg: it.imsCfg,
        dbCfg: it.dbCfg, otsCfg: it.otsCfg,
      })),
      folder,
      uploads: new Set(Object.keys(suite.uploadedConfigs ?? {})),
      onCallboxRadio: existing,
      onCallboxCore: existingCore,
      onCallboxOts: existingOts,
      withCallbox: !!callboxSys,
    })) {
      blockedRows.set(bad.row, bad.missing);
    }
  }

  const token = await login(ueOpts.host, ueOpts.username, ueOpts.password).catch(() => '');
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const sim = token ? await fetchSimulator(ueOpts.host, token) : undefined;
  const simulatorId = sim?.id;
  const simQ = simulatorId ? `?simulatorId=${encodeURIComponent(simulatorId)}` : '';
  const defaultDur = suite.defaultDurationSec ?? 10;

  // try/finally only so the licence restore below cannot be skipped — by a
  // throw from any row, or by the run being stopped. Nothing is caught here;
  // the row loop keeps handling its own failures exactly as before.
  try {
  for (const item of items) {
    if (opts.signal?.aborted) break;
    opts.onProgress?.(done, total, item.name);
    const t0 = Date.now();
    const stepDetails: string[] = [];
    let itemOk = true;

    // Refused before anything is touched, naming the row and the files. The
    // box is left exactly as it was: no half-prepared callbox, no testcase
    // created for a row that could never have run.
    const blocked = blockedRows.get(item.name);
    if (blocked) {
      const step = {
        testcaseId: item.name, status: 0, ok: false,
        detail: `cannot prepare this row: ${blocked.join(', ')} — not in `
          + `${testCaseDir(item.configSuite ?? suite.name, item.name)} and not on `
          + `${callboxSys?.host ?? 'the callbox'}. Run the suite once on the setup it was built on to capture them, or upload the file.`,
        durationMs: Date.now() - t0,
      };
      steps.push(step);
      failed += 1; done += 1;
      opts.onStep?.(step);
      if (suite.stopOnFail) break;
      continue;
    }
    // Which folder under /root/automation_configs holds this row's configs. A
    // campaign row's live under the suite it was taken from — the campaign is
    // a running order, the suite is where the files were captured — while a
    // suite's own rows read their own. Needed from phase 0 (rebuilding a
    // deleted testcase from test.json) through to the cleanup message.
    const cfgFrom = item.configSuite ?? suite.name;
    /** enb.cfg's target before this row re-pointed it — reported only, so the
     *  run log records what the callbox was bound to beforehand. */
    let prevEnbLink = '';
    let prevMmeLink = '';
    let prevImsLink = '';
    /** What ots.cfg pointed at before this row, and whether it was a plain file
     *  rather than a link — the two callboxes differ, and putting it back
     *  afterwards means something different in each case. */
    let prevOtsLink = '';
    let otsWasPlain = false;
    /** What mme.cfg was actually linked at. Differs from item.mmeCfg when the
     *  row overrode the subscriber database, in which case it is the generated
     *  copy that includes it — and cleanup has to know that name to take it
     *  away again. */
    let mmePick = item.mmeCfg;
    /** Set only when this row UPLOADED a cfg that wasn't already on the callbox;
     *  that file is the sole thing opt-in cleanup may remove. */
    let pushedCfg = '';
    /** Set when a file came from the Automation Server's folder. The name on
     *  the callbox is unchanged, so the symlink can look right while the
     *  contents underneath have moved — which means relink and restart. */
    let servedFromFolder = false;
    /** Files this run actually created on the callbox — the only ones cleanup
     *  may take away again. */
    const addedThisRun = new Set<string>();
    /** What licence this row's SAVED configs ask for, read before the run
     *  changed anything. Phase 3a pins these back into the folder. */
    let folderLicence: { enb?: string; mme?: string; ims?: string } = {};

    // ── Phase 0: create the row's testcase on the Simnovator first, under the
    // display name and with the row's duration baked in — so the case exists in
    // the box's catalogue before the callbox is touched. If the box rejects it
    // (bad name, duplicate, bad config) we find out without having restarted
    // anything. The copy stays on the Simnovator afterwards.
    const durSec = item.durationSec ?? defaultDur;
    let runTcId = item.simnovatorTcId;
    /** The name the box actually gave the copy — the UE log is named after it. */
    let createdName = item.name;
    /** How long the testcase on the box will actually take, by the box's own
     *  sum. 0 until the copy exists; the poll window is built on it. */
    let expectedRun = 0;
    if (!token) {
      steps.push({ testcaseId: item.name, status: 0, ok: false, detail: 'simnovator login failed', durationMs: Date.now() - t0 });
      failed += 1; done += 1;
      if (suite.stopOnFail) break;
      continue;
    }
    try {
      // A testcase belongs to ONE login. If this row's source is another
      // user's, read the definition through whoever owns it and create the
      // row's copy from that — the same "fetch it from the available user"
      // step the testcase page does. Only pays a lookup when it is needed:
      // an existing copy of this row's name is reused before any of this.
      let sourceTd: any;
      // A row whose test case came from a file has no source on any box: the
      // definition travels with the suite and is created here, under the row's
      // display name, as this run's login. The folder copy is preferred when
      // it exists — it is what /root/automation_configs holds for this row,
      // and keeping the box in step with the folder is the whole point of it.
      const uploadKey = item.uploadedTestcase;
      if (uploadKey) {
        const fromFolder = readTestCaseFile(cfgFrom, item.name, 'test.json');
        const raw = fromFolder ?? suite.uploadedTestcases?.[uploadKey];
        if (!raw) {
          steps.push({
            testcaseId: item.name, status: 0, ok: false,
            detail: `uploaded test case "${uploadKey}" is missing from the suite and from ${testCaseDir(cfgFrom, item.name)}/test.json`,
            durationMs: Date.now() - t0,
          });
          failed += 1; done += 1;
          if (suite.stopOnFail) break;
          continue;
        }
        // Read, not just parsed. The wizard checks an upload as it is picked,
        // but suites carry definitions saved before it did — four rows of the
        // Subscriber suite hold a ue.cfg, which is valid JSON, so a bare parse
        // handed the box an object with no cellConfig and the row failed on
        // the hardware with "CellConfig: Section is required but missing".
        const pack = definitionFromText(raw);
        if (!pack.definition) {
          steps.push({
            testcaseId: item.name, status: 0, ok: false,
            detail: `the test case uploaded as "${uploadKey}" cannot be used: ${pack.error}`,
            durationMs: Date.now() - t0,
          });
          failed += 1; done += 1;
          if (suite.stopOnFail) break;
          continue;
        }
        sourceTd = pack.definition;
        stepDetails.push(fromFolder
          ? `testcase: built from ${testCaseDir(cfgFrom, item.name)}/test.json (uploaded)`
          : `testcase: built from the file uploaded as "${uploadKey}"`);
        if (pack.repaired) stepDetails.push(`note: that file has ${pack.repaired} in it — read anyway, but it is not valid JSON`);
      }
      // Where this row's definition comes from, in order:
      //
      //   1. the selected Simnovator's own copy, when the row still names one
      //      that is there;
      //   2. another login's copy of that same testcase on the same box — a
      //      testcase belongs to one operator and is invisible to the others;
      //   3. the copy saved on the automation server, which is the whole point
      //      of saving them.
      //
      // (3) is what makes a row survive its source being deleted, or being
      // carried to a box that never had it: the saved definition is created on
      // the SELECTED Simnovator under the row's own name, fitted to the row's
      // power-on duration, and executed. An uploaded row already holds its
      // definition and skips all of this.
      // THE SERVER COPY FIRST.
      //
      // A run creates the test case on the Simnovator from
      // /root/automation_configs/<suite>/<row>/test.json and executes that —
      // it does not execute whatever is already in the box's catalogue. The
      // folder is the suite's own record of the row and the only copy that
      // travels with it, so a box's copy being older, edited or belonging to
      // a different setup cannot change what runs. (duplicateTestcase still
      // reuses the testcase on the box when it already matches, so an
      // unchanged row costs nothing; it rebuilds when it does not.)
      if (!sourceTd) {
        const saved = readTestCaseFile(cfgFrom, item.name, 'test.json');
        if (saved !== undefined) {
          const where = `${testCaseDir(cfgFrom, item.name)}/test.json`;
          const pack = definitionFromText(saved);
          if (pack.definition) {
            sourceTd = pack.definition;
            stepDetails.push(`testcase: from the automation server (${where})`);
            if (pack.repaired) stepDetails.push(`note: that copy has ${pack.repaired} in it — read anyway, but it is not valid JSON`);
          } else {
            steps.push({
              testcaseId: item.name, status: 0, ok: false,
              detail: `the copy saved at ${where} cannot be used to build this test case: ${pack.error}`,
              durationMs: Date.now() - t0,
            });
            failed += 1; done += 1;
            if (suite.stopOnFail) break;
            continue;
          }
        }
      }

      // Only when the server has nothing: the box's own copy, or another
      // login's. A suite that has never been synced, or a row added and run
      // before the folder caught up, still runs.
      if (!sourceTd) {
        // A row with no id has nothing to look up — and asking the box for an
        // empty one is a 404 that reads like a missing testcase rather than a
        // row that never named one.
        let onBox = false;
        if (item.simnovatorTcId) {
          try {
            const { getTestcase } = await import('../uesimClient');
            await getTestcase(ueOpts, item.simnovatorTcId);
            onBox = true;
          } catch { /* not this login's, or not there at all */ }
        }
        if (!onBox) {
          const sys = getSystem(inv, suite.uesimSystemId ?? '');
          const found = item.simnovatorTcId && sys
            ? await findDefinition(sys, item.simnovatorTcId, ueOpts.username)
            : null;
          if (found) {
            sourceTd = found.td;
            stepDetails.push(`source testcase belongs to ${found.owner} — created it for ${ueOpts.username}`);
          } else if (item.simnovatorTcId) {
            // The box had it once — the row names an id — and nobody has it
            // now. The folder was already asked, above, and had nothing.
            stepDetails.push(`testcase: "${item.simnovatorTcId}" is on no login of ${ueOpts.host}, and the automation server has no copy`);
          }
        }
      }

      // Nothing on the box, nothing on the server, nothing uploaded. Say that,
      // rather than handing the box an empty definition and letting it answer
      // "CellConfig: Section is required but missing" — which is true, and
      // tells the operator nothing about what to do.
      if (!sourceTd && !item.simnovatorTcId) {
        steps.push({
          testcaseId: item.name, status: 0, ok: false,
          detail: `this row has no test case to run: it names none on ${ueOpts.host}, and `
            + `${testCaseDir(cfgFrom, item.name)}/test.json does not exist. Sync the suite while the `
            + `test case is still on a box, upload its JSON, or pick the test case again.`,
          durationMs: Date.now() - t0,
        });
        failed += 1; done += 1;
        if (suite.stopOnFail) break;
        continue;
      }
      // The radio cards, before anything is built.
      //
      // A definition saved in /root/automation_configs was captured wherever
      // it came from, and names the cards THAT simulator owned. The box
      // refuses to start one naming a card this simulator does not own —
      // HTTP 200, {"status":"Failure","message":"The test uses sdr4, which is
      // not assigned to this simulator"} — so the cards are remapped onto the
      // ones it does own. That is what lets a row carry its test case between
      // logins and boxes at all.
      //
      // When there are more cells than cards it cannot be fixed by
      // remapping: two cells may not share a card, so the test case simply
      // cannot run on this simulator, and saying that is far better than
      // building it, triggering it and timing out 280 seconds later.
      if (sourceTd) {
        const fit = fitCards(cardsOf(sourceTd), sim?.cards ?? [], sim?.name ?? ueOpts.username);
        if (!fit.ok) {
          steps.push({
            testcaseId: item.name, status: 0, ok: false,
            detail: `${stepDetails.join(' · ')}${stepDetails.length ? ' · ' : ''}${fit.reason}`,
            durationMs: Date.now() - t0,
          });
          failed += 1; done += 1;
          if (suite.stopOnFail) break;
          continue;
        }
        if (fit.remap.length) {
          applyCardFit(sourceTd, fit);
          stepDetails.push(fit.note!);
        }
      }

      const dup = await duplicateTestcase(ueOpts, item.simnovatorTcId, item.name, durSec, sourceTd);
      if (dup.error || !dup.testCaseId) {
        steps.push({
          testcaseId: item.name, status: 0, ok: false,
          detail: `duplicate failed at ${dup.failedStep ?? '?'}: ${dup.error ?? 'no testCaseId returned'}`,
          durationMs: Date.now() - t0,
        });
        failed += 1; done += 1;
        if (suite.stopOnFail) break;
        continue;
      }
      runTcId = dup.testCaseId;
      createdName = dup.name;
      expectedRun = dup.expectedRunSec ?? 0;
      // A row owns ONE testcase on the box, named after the row, and every
      // run executes that same one — reused when it still matches the copy on
      // the automation server, rebuilt under the same name when it does not.
      stepDetails.push(dup.reused
        ? `testcase: reusing existing "${dup.name}" on ${ueOpts.host}`
        : `testcase: "${dup.name}" (${durSec}s) created on ${ueOpts.host}`);
      if (dup.warning) stepDetails.push(`note: ${dup.warning}`);
    } catch (e: any) {
      steps.push({
        testcaseId: item.name, status: 0, ok: false,
        detail: `duplicate threw: ${e?.message ?? e}`,
        durationMs: Date.now() - t0,
      });
      failed += 1; done += 1;
      if (suite.stopOnFail) break;
      continue;
    }

    // ── Phase 1-3: callbox bring-up (only if cfg + callbox present)
    // enb.cfg links straight at the file the operator picked, by its own name —
    // `enb.cfg -> SA-1Cell.cfg_June2026`, so the binding is legible in the
    // callbox terminal. (This used to copy the pick to a sanitised
    // simqa-<id>.cfg and link at that instead, which hid which config was
    // actually running.) Names with commas/spaces are handled by quoting the
    // shell args, not by renaming the file. Uploads — configs not already on the
    // box — are pushed up under their own name first.
    // Same rule per row: never restart LTE under another user's execution.
    let rowSharedSkip: string | null = null;
    const rowHasUpload = !!(item.callboxCfg && suite.uploadedConfigs?.[item.callboxCfg])
      || !!(item.mmeCfg && suite.uploadedConfigs?.[item.mmeCfg])
      || !!(item.imsCfg && suite.uploadedConfigs?.[item.imsCfg]);
    if (callboxSys && item.callboxCfg && rowHasUpload) {
      // Uploads are new content — applied, but never under someone else.
      try {
        const u = await callboxUsage(inv, callboxSys, { me: ueOpts.boxUser });
        if (u.others.length) {
          rowSharedSkip = `cfg: ${describeOthers(u.others)} is executing on this callbox — uploaded config not applied; ran on the current config (${describeCfg(u.current)}), no lte restart`;
        }
      } catch { /* could not check — the normal bring-up runs */ }
    } else if (callboxSys && item.callboxCfg) {
      try {
        const d = await bringUpDecision(inv, callboxSys, ueOpts.boxUser,
          { enb: item.callboxCfg, mme: item.mmeCfg, ims: item.imsCfg });
        if (d.action === 'blocked') {
          rowSharedSkip = `cfg: ${describeOthers(d.others)} is executing on this callbox — ran on its current config (${describeCfg(d.current)}); no link and no lte restart`;
        } else if (d.action === 'unchanged') {
          rowSharedSkip = `cfg: already linked (${describeCfg(d.current)}) — no lte restart needed`;
        }
      } catch { /* could not check — the normal bring-up runs */ }
    }
    if (rowSharedSkip) stepDetails.push(rowSharedSkip);

    if (callboxSys && item.callboxCfg && !rowSharedSkip) {
      const cfg = item.callboxCfg;
      const linkPath = `/root/enb/config/enb.cfg`;
      const blob = suite.uploadedConfigs?.[cfg];
      /** Single-quoted shell arg; embedded quotes escaped. */
      const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
      let target = '';

      // What this row runs with lives on the Automation Server, in
      // /root/automation_configs/<suite>/<test case>/. Push those files to the
      // callbox under the names the row picked, so the execution uses the
      // folder rather than whatever the callbox happens to hold under that
      // name. A file the folder does not have falls through to the old
      // behaviour — an empty folder must not silently blank a working config.
      const fromServer: Record<string, string | undefined> = {
        [cfg]: readTestCaseFile(cfgFrom, item.name, 'enb.cfg'),
        ...(item.mmeCfg ? { [item.mmeCfg]: readTestCaseFile(cfgFrom, item.name, 'mme.cfg') } : {}),
        ...(item.imsCfg ? { [item.imsCfg]: readTestCaseFile(cfgFrom, item.name, 'ims.cfg') } : {}),
        ...(item.otsCfg ? { [item.otsCfg]: readTestCaseFile(cfgFrom, item.name, 'ots.cfg') } : {}),
        // Under its own name: the folder saves everything the MME config
        // includes by the name it is included as, so that is what to look for.
        ...(item.dbCfg ? { [item.dbCfg]: readTestCaseFile(cfgFrom, item.name, item.dbCfg) } : {}),
      };
      // The licence each of this row's saved configs asks for, read BEFORE the
      // run touches anything. Phase 3a pins these back into the folder so the
      // licence chosen for today's run is not recorded as the row's own.
      folderLicence = {
        enb: licenceTagOf(fromServer[cfg] ?? ''),
        mme: item.mmeCfg ? licenceTagOf(fromServer[item.mmeCfg] ?? '') : undefined,
        ims: item.imsCfg ? licenceTagOf(fromServer[item.imsCfg] ?? '') : undefined,
      };

      /** A file the suite carries as an upload, as text. */
      const uploaded = (nm?: string) => (nm && suite.uploadedConfigs?.[nm]
        ? Buffer.from(suite.uploadedConfigs[nm], 'base64').toString('utf8')
        : undefined);

      try {
        // One connection for the whole phase. Every step here used to open an
        // SSH session of its own — four or five handshakes per row against the
        // same callbox, paid again on every row, most of them only to read a
        // symlink that had not moved.
        await withSsh(callboxSys, async (ssh) => {
          /**
           * Put a file into a callbox config directory.
           *
           * Those live under /root and belong to root, while the SSH login
           * does not — a straight SFTP write answers "Permission denied", which
           * is what the first run from the server folder did. So: SFTP into
           * /tmp, which anyone may write, then install it across with the same
           * passwordless sudo every other step here uses. Staged through a
           * temp file rather than echoed through the shell because a
           * subscriber DB is a third of a megabyte.
           */
          const push = async (name: string, textIn: string, where: string, role?: CfgRole) => {
            // The licence this run asked for, written in on the way past.
            //
            // The tag decides which licence the component takes out, and two
            // setups sharing a licence server are told apart by it — so a
            // config captured from one box and pushed to another needs a
            // different one. Applied here, at the single point every config
            // goes through, so the file on the callbox and the file that was
            // validated are the same bytes.
            //
            // Only the quoted tag changes; a config naming no licence server
            // is left alone rather than given one, which would mean inventing
            // a server address.
            let text = textIn;
            const wantTag = tagForRole(opts.licenceTags, role);
            if (wantTag) {
              const lic = withLicenceTag(text, wantTag);
              if (lic.changed) {
                text = lic.text;
                stepDetails.push(`licence: ${name} ${lic.from || '(empty)'} → ${wantTag}`);
              }
            }

            const dest = `${where}/${name}`;

            // What this role is executing with, for the run record.
            if (role === 'enb' || role === 'gnb') licencesUsed.enb ??= licenceTagOf(text);
            else if (role === 'mme') licencesUsed.mme ??= licenceTagOf(text);
            else if (role === 'ims') licencesUsed.ims ??= licenceTagOf(text);

            // Keep the callbox's own copy if its licence is about to change.
            //
            // The comparison is between the tag the FILE ON THE CALLBOX has
            // and the tag in the bytes about to be written -- not between the
            // bytes we started with and the bytes we end up with. Those are
            // different questions, and only the first one is about the
            // callbox. SA-1cell.cfg caught this: the row's copy on the
            // automation server already asked for oran-enb, so applying
            // oran-enb "changed nothing", while the file on the callbox said
            // rnd-enb and was overwritten anyway -- permanently, because
            // cleanup keeps a config the box already had.
            //
            // Backed up once per file per run: a later row pushing the same
            // config must not back up a copy this run already rewrote, or the
            // restore would put OUR licence back instead of the operator's.
            if (role && !licenceBackups.has(dest)) {
              const cur = await ssh.execCommand(`sudo -n cat ${q(dest)} 2>/dev/null || cat ${q(dest)} 2>/dev/null`);
              // No readable copy there = nothing to preserve. A file the
              // callbox does not have yet is removed by cleanup afterwards,
              // licence and all.
              if (cur.code === 0 && cur.stdout) {
                const had = licenceTagOf(cur.stdout);
                const willHave = licenceTagOf(text);
                if (had !== willHave) {
                  const bk = `${dest}.simqa-licence-backup`;
                  // -n so a backup left behind by an interrupted run wins:
                  // it is closer to the operator's original than ours is.
                  await ssh.execCommand(
                    `sudo -n cp -n -p ${q(dest)} ${q(bk)} 2>/dev/null || cp -n -p ${q(dest)} ${q(bk)}`);
                  const there = await ssh.execCommand(`test -e ${q(bk)} && echo yes || echo no`);
                  if ((there.stdout ?? '').trim() !== 'yes') {
                    // Changing a licence we cannot put back would leave the
                    // callbox on our tag for good. Refuse instead.
                    throw new Error(
                      `could not back up ${dest} before changing its licence from `
                      + `"${had ?? 'none'}" to "${willHave ?? 'none'}" — refusing, because the `
                      + 'original could not then be restored');
                  }
                  licenceBackups.set(dest, bk);
                  if (!wantTag) {
                    // Worth saying: this one moved because the row's own copy
                    // asks for a different licence, not because anybody chose
                    // one in the dialog.
                    stepDetails.push(
                      `licence: ${name} ${had || '(empty)'} → ${willHave || '(empty)'} (from the row's own copy)`);
                  }
                }
              }
            }
            // Check the bytes before they land on the hardware.
            //
            // The wizard refuses a bad upload at the point it is picked, but a
            // suite saved months ago, a file edited in the server folder by
            // hand, or a row carried onto a different setup can all arrive
            // here with a config that cannot work. Writing it anyway costs a
            // bring-up and then fails the row as "no UEs attached", which
            // sends the investigation to the radio. Saying it here names the
            // file and the reason.
            if (role) {
              const v = validateCfg(role, name, text);
              if (!v.ok) {
                const why = v.issues.filter((i) => i.severity === 'error').map((i) => i.message);
                throw new Error(`${name} is not a usable ${ROLE_LABEL[role]}: ${why.join('; ')}`);
              }
            }
            const tmp = `/tmp/.simqa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
            const sftp = await ssh.requestSFTP();
            await new Promise<void>((resolve, reject) => {
              const ws = sftp.createWriteStream(tmp);
              ws.on('close', () => resolve());
              ws.on('error', reject);
              ws.end(Buffer.from(text, 'utf8'));
            });
            const r = await ssh.execCommand(
              `sudo -n install -m 0644 ${q(tmp)} ${q(dest)} 2>&1 || install -m 0644 ${q(tmp)} ${q(dest)} 2>&1`);
            await ssh.execCommand(`rm -f ${q(tmp)}`);
            if (r.code !== 0) throw new Error(`could not write ${dest}: ${(r.stdout || r.stderr || '').trim().slice(0, 120)}`);
          };

          /**
           * Put the chosen licence into a config this row did NOT push.
           *
           * A config already on the callbox, with no copy in the row's folder
           * and nothing uploaded, is linked where it lies — nothing is
           * written, so `push` never sees it and the licence chosen in the Run
           * dialog would quietly not apply. Which is the worst outcome of the
           * three: the run looks right and uses the wrong licence.
           *
           * So read the callbox's own copy, and if its tag is not the one
           * asked for, push it back with the tag changed. That goes through
           * `push`, so it is backed up and restored like any other.
           */
          const ensureLicence = async (name: string, where: string, role: CfgRole) => {
            const wantTag = tagForRole(opts.licenceTags, role);
            if (!wantTag) return;
            const dest = `${where}/${name}`;
            const got = await ssh.execCommand(`sudo -n cat ${q(dest)} 2>/dev/null || cat ${q(dest)}`);
            if (got.code !== 0 || !got.stdout) {
              stepDetails.push(`licence: could not read ${name} on the callbox — left as it is`);
              return;
            }
            if (licenceTagOf(got.stdout) === wantTag) return;     // already right
            await push(name, got.stdout, where, role);
          };

          const serverEnb = fromServer[cfg];
          if (serverEnb) {
            target = `/root/enb/config/${cfg}`;
            const isNew = !existing.has(cfg);
            await push(cfg, serverEnb, '/root/enb/config', 'enb');
            if (isNew) addedThisRun.add(cfg);
            existing.add(cfg);
            // Only a file the callbox did not have is ours to clean up later.
            if (isNew) pushedCfg = cfg;
            servedFromFolder = true;
            stepDetails.push(`cfg-source: ${testCaseDir(cfgFrom, item.name)}/enb.cfg → ${cfg}`);
          } else if (existing.has(cfg)) {
            // Already on the callbox — link at it directly, nothing to copy.
            // Except the licence: if one was chosen, it has to go in, or the
            // run would use whatever tag this box happened to be left on.
            target = `/root/enb/config/${cfg}`;
            stepDetails.push(`cfg-source: existing "${cfg}"`);
            await ensureLicence(cfg, '/root/enb/config', 'enb');
          } else if (blob) {
            const buf = Buffer.from(blob, 'base64');
            target = `/root/enb/config/${cfg}`;
            await push(cfg, buf.toString('utf8'), '/root/enb/config', 'enb');
            existing.add(cfg);
            pushedCfg = cfg;
            stepDetails.push(`cfg-push: scp ${buf.length}B → ${cfg}`);
          } else {
            throw new Error(`cfg "${cfg}" not in suite uploadedConfigs and missing on callbox /root/enb/config`);
          }

          // Only re-link what is not already linked. Consecutive rows often
          // share a radio cfg and differ only in the core one; re-pointing a
          // link at the file it already names changes nothing, and it is what
          // forces the lte restart below — which costs every row a bring-up.
          //
          // An UPLOAD always relinks: the file's CONTENT changed under the same
          // name, so the link being equal says nothing.
          let relinked = pushedCfg === cfg || servedFromFolder;
          {
            const prev = await ssh.execCommand(`readlink ${q(linkPath)} || true`);
            prevEnbLink = (prev.stdout ?? '').trim();
            if (relinked || !sameCfg(prevEnbLink, cfg)) {
              // Linked from inside the directory with a bare basename, so the
              // link is relative — `enb.cfg -> SA-1Cell.cfg_June2026`, which is
              // how the operators write it by hand and how it reads in the
              // callbox terminal.
              const r = await ssh.execCommand(
                sudoLink('/root/enb/config', q(cfg), 'enb.cfg'));
              if (r.code !== 0) throw new Error(`ln: ${r.stderr || r.stdout || `exit ${r.code}`}`);
              relinked = true;
              stepDetails.push(`cfg-link: ln -sfn ${cfg} enb.cfg`);
            } else {
              stepDetails.push(`cfg-link: enb.cfg already → ${cfg}`);
            }
          }

          // ── The row's subscriber database ──────────────────────────────
          //
          // A DB choice cannot be a symlink like the other slots: the
          // callboxes have no ue_db.cfg convention — every MME config names
          // its database in an `include` line, and /root/mme/config holds a
          // dozen different ones. So the row binds a COPY of its MME config
          // with that line pointing at the chosen database, and mme.cfg is
          // linked at the copy. The shared original is never edited, because
          // other setups are using it.
          //
          // Absent dbCfg = the database travels with the MME config, exactly
          // as it always has.
          if (item.mmeCfg && item.dbCfg) {
            const db = item.dbCfg;
            // The database file itself has to be on the box to be included.
            if (!existingCore.has(db)) {
              const dbText = fromServer[db] ?? uploaded(db);
              if (!dbText) {
                throw new Error(
                  `database "${db}" is not on ${callboxSys.host}, is not in `
                  + `${testCaseDir(cfgFrom, item.name)}, and is not uploaded with this suite`,
                );
              }
              await push(db, dbText, '/root/mme/config', 'db');
              existingCore.add(db);
              addedThisRun.add(db);
              stepDetails.push(`cfg-push: ${db} → /root/mme/config`);
            }
            // The MME config's text, from wherever this row gets it.
            const base = fromServer[item.mmeCfg] ?? uploaded(item.mmeCfg)
              ?? await (async () => {
                const r = await ssh.execCommand(
                  `sudo -n cat ${q(`/root/mme/config/${item.mmeCfg}`)} 2>/dev/null `
                  + `|| cat ${q(`/root/mme/config/${item.mmeCfg}`)} 2>/dev/null || true`);
                return (r.stdout ?? '').trim() ? r.stdout : undefined;
              })();
            if (!base) {
              throw new Error(`cannot read "${item.mmeCfg}" to point it at database "${db}"`);
            }
            const bound = withDbInclude(base, db);
            if (!bound.changed) {
              stepDetails.push(`cfg-db: ${item.mmeCfg} already includes ${db}`);
            } else {
              // A name that says what it is and which database it carries, so
              // an operator reading /root/mme/config can tell at a glance.
              const derived = `${item.mmeCfg.replace(/\.cfg$/, '')}.simqa-${db.replace(/\.(cfg|json)$/, '').replace(/[^A-Za-z0-9_-]+/g, '_')}.cfg`;
              // Pushed by the loop below, which already handles "the server's
              // copy wins" and the relink that changed content requires.
              fromServer[derived] = bound.text;
              mmePick = derived;
              stepDetails.push(
                `cfg-db: mme.cfg → ${derived}, a copy of ${item.mmeCfg} including ${db}`
                + `${bound.replaced.length ? ` instead of ${bound.replaced.join(', ')}` : ''} — ${item.mmeCfg} itself is untouched`,
              );
            }
          }

          // Core cfgs live in /root/mme/config. A test needs the core up as
          // well as the radio, so both links are re-pointed per row.
          const coreLinks: Array<[string, string | undefined]> = [
            ['mme.cfg', mmePick],
            ['ims.cfg', item.imsCfg],
          ];
          // Relative, same as enb.cfg above: `mme.cfg -> demo-mme.cfg`.
          for (const [linkName, pick] of coreLinks) {
            if (!pick) continue;
            let justUploaded = false;
            // The server's copy wins for the core cfgs too.
            const fromFolder = fromServer[pick];
            if (fromFolder) {
              if (!existingCore.has(pick)) addedThisRun.add(pick);
              await push(pick, fromFolder, '/root/mme/config', linkName === 'mme.cfg' ? 'mme' : 'ims');
              existingCore.add(pick);
              justUploaded = true;
              stepDetails.push(`cfg-source: ${linkName} from ${testCaseDir(cfgFrom, item.name)}`);
            }
            // An uploaded core cfg isn't on the box yet — push it under its own
            // name first, so the link reads the same as the operator's pick.
            if (!existingCore.has(pick) && suite.uploadedConfigs?.[pick]) {
              const buf = Buffer.from(suite.uploadedConfigs[pick], 'base64');
              await push(pick, buf.toString('utf8'), '/root/mme/config', linkName === 'mme.cfg' ? 'mme' : 'ims');
              existingCore.add(pick);
              justUploaded = true;
              stepDetails.push(`cfg-push: scp ${buf.length}B → /root/mme/config/${pick}`);
            }
            // Nothing to link to.
            //
            // The folder did not have it, the suite did not upload it, and this
            // callbox does not hold it — which is what running a suite on a
            // setup other than the one it was built on looks like when its
            // folder is incomplete. Linking anyway leaves mme.cfg pointing at a
            // file that is not there, the core refuses to start, and the row
            // fails later as "no UEs attached", which sends people looking at
            // the radio. Say it here, naming the file and where it should have
            // come from.
            if (!existingCore.has(pick)) {
              throw new Error(
                `${linkName}: "${pick}" is not on ${callboxSys.host} and is not in `
                + `${testCaseDir(cfgFrom, item.name)} — run this suite once on the setup it was built on, `
                + `or upload the file, before running it here`,
              );
            }
            // Linked where it lies, so nothing was written — but the licence
            // still has to be the one that was chosen.
            if (!justUploaded) {
              await ensureLicence(pick, '/root/mme/config', linkName === 'mme.cfg' ? 'mme' : 'ims');
            }

            const prev = await ssh.execCommand(`readlink /root/mme/config/${linkName} || true`);
            const prevTarget = (prev.stdout ?? '').trim();
            if (linkName === 'mme.cfg') prevMmeLink = prevTarget; else prevImsLink = prevTarget;
            if (!justUploaded && sameCfg(prevTarget, pick)) {
              stepDetails.push(`cfg-link: ${linkName} already → ${pick}`);
              continue;
            }
            const r = await ssh.execCommand(
              sudoLink('/root/mme/config', q(pick), linkName));
            if (r.code !== 0) throw new Error(`ln ${linkName}: ${r.stderr || r.stdout || `exit ${r.code}`}`);
            relinked = true;
            stepDetails.push(`cfg-link: ln -sfn ${pick} ${linkName}`);
          }

          // ── ots.cfg ────────────────────────────────────────────────────
          //
          // /root/ots/config/ots.cfg decides which component configs the stack
          // loads at all, and the box's own ots.default.cfg tells operators to
          // point the symlink at their own file. It is NOT a symlink
          // everywhere though — on .107 it is a plain file while .106 has
          // ots.cfg -> ots.default.cfg — so a plain file is kept once under
          // .simqa-backup before being replaced, and put back by cleanup.
          if (item.otsCfg) {
            const pick = item.otsCfg;
            // The link can never be its own target. The picker drops the slot
            // names, but a suite saved by hand or carried from a box where
            // ots.cfg was a plain file could still name it, and `ln -sfn
            // ots.cfg ots.cfg` leaves the stack with no config at all.
            if (pick === 'ots.cfg') {
              throw new Error('ots.cfg cannot be bound to itself — pick the file it should point at');
            }
            // The folder's copy wins, as it does for every other slot: an
            // ots.cfg edited in /root/automation_configs has to reach the box
            // or the edit does nothing. Only when the folder has nothing does
            // the box's own file stand.
            const text = fromServer[pick] ?? uploaded(pick);
            if (!existingOts.has(pick) && !text) {
              throw new Error(
                `ots.cfg: "${pick}" is not on ${callboxSys.host}, is not in `
                + `${testCaseDir(cfgFrom, item.name)}, and is not uploaded with this suite`,
              );
            }
            if (text !== undefined) {
              const dest = `/root/ots/config/${pick}`;
              const want = createHash('md5').update(text, 'utf8').digest('hex');
              const got = await ssh.execCommand(
                `sudo -n md5sum ${q(dest)} 2>/dev/null || md5sum ${q(dest)} 2>/dev/null || true`);
              if ((got.stdout ?? '').trim().split(/\s+/)[0] !== want) {
                const isNew = !existingOts.has(pick);
                await push(pick, text, '/root/ots/config', 'ots');
                if (isNew) addedThisRun.add(pick);
                existingOts.add(pick);
                relinked = true;
                stepDetails.push(`cfg-push: ${pick} → /root/ots/config, from ${testCaseDir(cfgFrom, item.name)}`);
              }
            }
            const prev = await ssh.execCommand(`readlink /root/ots/config/ots.cfg || true`);
            prevOtsLink = (prev.stdout ?? '').trim().split('/').filter(Boolean).pop() ?? '';
            if (!prevOtsLink) {
              const there = await ssh.execCommand(`test -e /root/ots/config/ots.cfg && echo yes || echo no`);
              if ((there.stdout ?? '').trim() === 'yes') {
                otsWasPlain = true;
                // Once: a second row must not back up the link this run made.
                const bk = `/root/ots/config/ots.cfg.simqa-backup`;
                await ssh.execCommand(
                  `test -e ${q(bk)} || sudo -n cp -a /root/ots/config/ots.cfg ${q(bk)} 2>/dev/null `
                  + `|| test -e ${q(bk)} || cp -a /root/ots/config/ots.cfg ${q(bk)}`);
                stepDetails.push('cfg-ots: the callbox had ots.cfg as a plain file — kept as ots.cfg.simqa-backup');
              }
            }
            if (otsWasPlain || !sameCfg(prevOtsLink, pick)) {
              const r = await ssh.execCommand(sudoLink('/root/ots/config', q(pick), 'ots.cfg'));
              if (r.code !== 0) throw new Error(`ln ots.cfg: ${r.stderr || r.stdout || `exit ${r.code}`}`);
              relinked = true;
              stepDetails.push(`cfg-link: ln -sfn ${pick} ots.cfg`);
            } else {
              stepDetails.push(`cfg-link: ots.cfg already → ${pick}`);
            }
          }

          // Everything else the row's configs depend on: the files the MME
          // config includes — subscriber DBs and fragments, by their own
          // names. The MME will not start with one of them missing, and there
          // is rarely just one: a working config here includes five.
          //
          // The FOLDER is the authority, as it is for enb/mme/ims above. These
          // used to be restored only when the callbox had lost them, which
          // meant a subscriber database edited in /root/automation_configs
          // never reached the box — the edit simply did nothing, silently,
          // because a file of that name was already there.
          //
          // Compared by checksum first so an unchanged database is not sent
          // again every run: the lab's are a third of a megabyte each.
          //
          // ots.cfg is NOT in here. The folder keeps it under the role name,
          // and /root/ots/config/ots.cfg is the symlink itself — writing the
          // folder's copy there would replace the link with a plain file. It
          // is pushed under the name the row picked, in the ots block above.
          const folder = readAllTestCaseFiles(cfgFrom, item.name);
          const sent: string[] = [];
          for (const [name, text] of Object.entries(folder)) {
            // The role files are pushed above; test.json is not a callbox file.
            if (['enb.cfg', 'mme.cfg', 'ims.cfg', 'ue.cfg', 'test.json', 'ots.cfg'].includes(name)) continue;
            const dest = `/root/mme/config/${name}`;
            const want = createHash('md5').update(text, 'utf8').digest('hex');
            const got = await ssh.execCommand(
              `sudo -n md5sum ${q(dest)} 2>/dev/null || md5sum ${q(dest)} 2>/dev/null || true`);
            if ((got.stdout ?? '').trim().split(/\s+/)[0] === want) continue;
            await push(name, text, '/root/mme/config');
            relinked = true;
            sent.push(name);
          }
          if (sent.length) {
            stepDetails.push(`cfg-push: ${sent.join(', ')} → /root/mme/config, from ${testCaseDir(cfgFrom, item.name)}`);
          }

          // Nothing moved — the stack is already running the configs this row
          // asks for, so restarting would drop the radio for no reason and cost
          // the row its bring-up time.
          if (!relinked) {
            // Nothing moved — the stack is already running the configs this row
            // asks for. Restarting would drop the radio for no reason and cost
            // the row a bring-up it does not need.
            stepDetails.push('cfg-restart: skipped — the callbox already runs these configs');
          } else {
            // One unit — lte.service runs /root/ots/ltestart.sh, which launches
            // enb, mme AND ims together (see ots.cfg ENB/MME/IMS_CONFIG_FILE).
            // There is no separate ltemme unit, so this single restart picks up
            // all three symlinks. Through sudo, so the simqa SSH user needn't be
            // root.
            const r = await ssh.execCommand(`sudo service lte restart`);
            if (r.code !== 0) throw new Error(`restart lte: ${r.stderr || r.stdout || `exit ${r.code}`}`);
            await new Promise(res => setTimeout(res, 15_000));
            stepDetails.push(`cfg-restart: lte restarted (enb+mme+ims) + 15s settle`);
          }
        });
      } catch (e: any) {
        steps.push({
          testcaseId: item.name, status: 0, ok: false,
          detail: `bring-up failed: ${e?.message ?? e}`,
          durationMs: Date.now() - t0,
        });
        failed += 1; itemOk = false;
        if (suite.stopOnFail) { done += 1; break; }
        done += 1;
        continue;
      }
    }

    // ── Phase 3a: refresh this row's folder on the Automation Server, so the
    // files an execution reads are the current ones. Runs AFTER bring-up, when
    // the callbox is serving what this row asked for, and before the trigger.
    try {
      // The licence this run chose must not be recorded as the row's own.
      //
      // This sync reads the callbox, which is now serving configs with that
      // licence in them. `fromServer` holds the folder's copies as they were
      // BEFORE the run touched anything, so their tags are what the folder
      // should keep. Only roles the run actually overrode are pinned; without
      // an override the sync records the callbox faithfully, as it should.
      const keepLicenceTags = opts.licenceTags
        ? {
            enb: opts.licenceTags.enb ? folderLicence.enb : undefined,
            mme: opts.licenceTags.mme ? folderLicence.mme : undefined,
            ims: opts.licenceTags.ims ? folderLicence.ims : undefined,
          }
        : undefined;
      const sync = await syncRowToServer(inv, suite, item, callboxSys, ueSys, suite.boxUserId, keepLicenceTags);
      if (sync.written.length) {
        stepDetails.push(`server-configs: ${sync.written.join(', ')} → ${sync.dir}`);
      } else if (sync.error) {
        stepDetails.push(`server-configs: not updated — ${sync.error}`);
      }
      // Said out loud: a file edited in the folder is the one this row runs,
      // and it was deliberately NOT refreshed from the box. Silence here
      // would read as "the sync did nothing", which is the opposite.
      if (sync.handEdited?.length) {
        stepDetails.push(
          `server-configs: kept your edited ${sync.handEdited.join(', ')} — `
          + `delete the file in ${sync.dir} to let SimQA write it again`,
        );
      }
      // The copy that belongs to THIS run. Taken here, just after the
      // folder has been brought up to date and while it still holds what
      // this row deployed — the next run rewrites it.
      const snap = readAllTestCaseFiles(cfgFrom, item.name);
      if (Object.keys(snap).length) configSnapshots[item.name] = snap;
    } catch { /* the folder is a mirror; a run never fails over it */ }

    // ── Phase 3b: keep the configuration this row is about to run with.
    //
    // Taken AFTER bring-up and BEFORE the trigger, so it is the configuration
    // the execution actually sees — and before the optional restore below
    // puts the links back. A new version folder appears only when something
    // differs from the last run, which is what makes a version mean "someone
    // changed the configs". Best-effort: a box we cannot read must not cost
    // the row its execution.
    try {
      const snap = await saveRowConfigs({
        suiteId: suite.id, suiteName: suite.name,
        rowId: item.id ?? item.name, rowName: item.name,
        callbox: callboxSys, ueSystem: ueSys, capturedBy: ueOpts.username,
        uesimHost: ueOpts.host,
      });
      if (snap) {
        stepDetails.push(snap.changed
          ? `configs: saved as ${snap.version} — they changed since the last run`
          : `configs: unchanged since ${snap.version}`);
      }
    } catch { /* keeping a copy never decides a run */ }

    // ── Phase 4-5: trigger + poll the testcase created in phase 0
    //
    // Rows run strictly in order. The previous row's execution may still be
    // winding down, so wait for the simulator to go idle before triggering
    // rather than colliding with the box's one-at-a-time mutex.
    const stillBusy = await waitForSimulatorIdle(ueOpts.host, token, 120, opts.signal);
    if (stillBusy) {
      steps.push({
        testcaseId: item.name, status: 409, ok: false,
        detail: `${stepDetails.join(' · ')}${stepDetails.length ? ' · ' : ''}simulator still busy with "${stillBusy}" after 120s — not triggered`,
        durationMs: Date.now() - t0,
      });
      failed += 1; done += 1;
      if (suite.stopOnFail) break;
      continue;
    }

    const triggerBody = JSON.stringify(simulatorId ? { simulatorId } : {});
    // What lastExecution says BEFORE we trigger.
    //
    // The row owns one testcase and runs it again and again, so the record
    // sitting there is this row's own previous execution — terminal, and
    // indistinguishable from a finished run unless its id is remembered.
    // NSA_3cell_Mobility_UDP_1UEs_automation was reported PASS twice on
    // 13 October from the execution it ran on 9 October because of this.
    const priorExec = (await fetchLastExecution(ueOpts.host, token, runTcId))?.executionId;
    try {
      // Wait for the box to say what it did. See triggerAnswer.ts: the HTTP
      // status is 200 either way, a start takes ~20s to answer and carries
      // the execution id, and a refusal comes back at once with the reason.
      const r = await postTrigger(ueOpts.host, H, runTcId, triggerBody);
      if (!r.answer.started) {
        steps.push({
          testcaseId: item.name, status: r.status, ok: false,
          detail: `${stepDetails.join(' · ')}${stepDetails.length ? ' · ' : ''}${refusalDetail(r.answer, r.status)}`,
          durationMs: Date.now() - t0,
        });
        failed += 1;
        if (suite.stopOnFail) { done += 1; break; }
        done += 1;
        continue;
      }
      // The id the box minted for THIS start, when it gave one. It is the
      // only unambiguous way to tell our execution from the row's previous
      // one — see ownExecution.ts.
      const triggerExecId = r.answer.executionId;
      // 1. Give the box a moment to register the trigger, then poll for
      //    terminal state up to durationSec.
      await new Promise(res => setTimeout(res, 1500));

      // Attach gate: once the UEs have had time to power on, check the UE
      // simulator's log. A run where nothing attached is a real failure that the
      // box would otherwise report as PASS, so cut it short instead of burning
      // the rest of the duration on a test that cannot do anything.
      if (ueSys) {
        const grace = Math.min(ATTACH_CHECK_DELAY_SEC, durSec + POLL_MARGIN_SEC);
        await new Promise(res => setTimeout(res, grace * 1000));
        const ev = await gatherAttachEvidence(ueSys, createdName);
        // Only a log that positively says the UE searched and found nothing is
        // treated as failure. Silence is NOT evidence — the logging profile may
        // simply not record the layer we looked at, and killing a healthy run
        // over that is far worse than letting it play out.
        const attached = ev ? ev.registered > 0 || ev.rrcConnected > 0 : false;
        const definitelyNotAttached = !!ev && ev.sawLog && !attached && ev.noCell > 0;

        if (definitelyNotAttached) {
          const st = await fetchLastExecution(ueOpts.host, token, runTcId);
          if (st?.executionId && !opts.signal?.aborted) {
            await stopAndFinalize(ueOpts.host, token, runTcId, st.executionId, opts.signal, simulatorId);
          }
          steps.push({
            testcaseId: item.name, status: r.status, ok: false, verdict: 'FAIL',
            executionId: st?.executionId,
            detail: `${stepDetails.join(' · ')}${stepDetails.length ? ' · ' : ''}no UE attached within ${grace}s `
              + `("No cell available" ×${ev!.noCell}) — stopped. The UE never found the cell; `
              + `check that the gnb cfg's band matches the testcase's band.`,
            durationMs: Date.now() - t0,
          });
          failed += 1; done += 1;
          if (suite.stopOnFail) break;
          continue;
        }

        stepDetails.push(
          !ev ? 'attach: UE log unreadable — not checked'
          : ev.registered > 0 ? `attach: ${ev.registered} UE(s) registered`
          : ev.rrcConnected > 0 ? `attach: ${ev.rrcConnected} UE(s) RRC-connected (profile logs no NAS)`
          : 'attach: inconclusive at this point — letting the test run',
        );
      }

      // The poll window has to outlast the TEST, not the figure the row asked
      // for. Those are different numbers: a profile whose traffic cannot be
      // shortened raises the power-on window, and a looped power-cycle profile
      // multiplies it, so expectedRunSec is the box's own sum for the testcase
      // that is actually running. Listening for durSec instead is what made a
      // finished test look unfinished — the runner gave up, stopped an
      // execution the Simnovator went on to complete, and the suite recorded
      // ABORTED against a row the box reported COMPLETED.
      const expectRun = Math.max(durSec, expectedRun || 0);
      const pollWindow = expectRun + POLL_MARGIN_SEC;
      if (expectRun > durSec) {
        stepDetails.push(`waiting up to ${pollWindow}s — this testcase runs for ${expectRun}s, not the ${durSec}s asked for`);
      }
      // 2. Wait it out, and stop it only if it really has not finished.
      const settledRun = await settleExecution(
        ueOpts.host, token, runTcId, triggerExecId, pollWindow, opts.signal, simulatorId, priorExec);
      const finalState = settledRun.finalState;
      const execId = settledRun.execId;
      const stoppedByUs = settledRun.stoppedByUs;
      if (settledRun.lateFinish) stepDetails.push('the box finished while the last poll was in flight');
      const verdict = deriveVerdict(finalState, !finalState);
      const passLike = verdict === 'PASS';
      steps.push({
        testcaseId: item.name, status: r.status, ok: passLike,
        boxTestcaseId: runTcId,
        executionId: finalState?.executionId ?? execId,
        verdict, boxStatus: finalState?.status, boxResult: finalState?.result, stopped: stoppedByUs,
        detail: `${stepDetails.join(' · ')}${stepDetails.length ? ' · ' : ''}${finalState
          ? `verdict=${verdict} status=${finalState.status ?? '?'} result=${finalState.result ?? '?'} dur=${finalState.durationSeconds ?? '?'}s${stoppedByUs ? ' (stopped by simqa)' : ''}`
          : `triggered but no terminal state within ${pollWindow}s — stop attempted${stoppedByUs ? '; box never settled' : ''}`}`,
        durationMs: Date.now() - t0,
      });
      if (passLike) passed += 1; else { failed += 1; if (suite.stopOnFail) { done += 1; break; } }
    } catch (e: any) {
      steps.push({ testcaseId: item.name, status: 0, ok: false, detail: `threw: ${e?.message ?? e}`, durationMs: Date.now() - t0 });
      failed += 1;
      if (suite.stopOnFail) { done += 1; break; }
    } finally {
      // Phase 6: per-item cleanup — once the execution has finished.
      //
      // /root/automation_configs holds this row's configs, and a run puts them
      // on the callbox because that is where the radio reads them from. The
      // copies are taken off again afterwards, so a shared callbox does not
      // fill up with files nobody can date and the folder stays the lasting
      // copy.
      //
      // What it will NOT remove, learned by breaking a live callbox with it:
      //
      //   * a file a live symlink points at. enb.cfg/mme.cfg/ims.cfg are what
      //     the stack reads at startup, and deleting their target leaves a
      //     dangling link — the running stack survives on the open file and
      //     the next restart fails, which is the worst possible time to find
      //     out.
      //   * a file the MME config includes. Same reason, one level down.
      //   * anything, while somebody else is executing on that callbox.
      //   * anything this row did not name.
      if (callboxSys) {
        const sq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
        try {
          let othersRunning = false;
          try {
            const u = await callboxUsage(inv, callboxSys, { me: ueOpts.boxUser });
            othersRunning = u.others.length > 0;
          } catch { /* cannot tell — assume the box is ours, as the run did */ }

          if (othersRunning) {
            stepDetails.push('cfg-cleanup: skipped — another user is executing on this callbox');
          } else {
            const removed: string[] = [];
            const kept: string[] = [];
            await withSsh(callboxSys, async (ssh) => {
              // Links first, so nothing points at a file that is about to go.
              if (prevEnbLink) {
                await ssh.execCommand(`cd /root/enb/config && sudo -n ln -sfn ${sq(prevEnbLink)} 'enb.cfg' 2>/dev/null || ln -sfn ${sq(prevEnbLink)} 'enb.cfg'`);
              }
              for (const [linkName, prev] of [['mme.cfg', prevMmeLink], ['ims.cfg', prevImsLink]] as const) {
                if (prev) await ssh.execCommand(`cd /root/mme/config && sudo -n ln -sfn ${sq(prev)} ${sq(linkName)} 2>/dev/null || ln -sfn ${sq(prev)} ${sq(linkName)}`);
              }
              // ots.cfg: a link goes back to where it pointed; a plain file
              // that this row replaced with a link is restored from the backup,
              // because re-pointing a link it never had would leave the callbox
              // in a shape its operators did not set up.
              if (otsWasPlain) {
                const bk = '/root/ots/config/ots.cfg.simqa-backup';
                await ssh.execCommand(
                  `test -e ${sq(bk)} && (sudo -n mv -f ${sq(bk)} /root/ots/config/ots.cfg 2>/dev/null `
                  + `|| mv -f ${sq(bk)} /root/ots/config/ots.cfg) || true`);
              } else if (prevOtsLink) {
                await ssh.execCommand(`cd /root/ots/config && sudo -n ln -sfn ${sq(prevOtsLink)} 'ots.cfg' 2>/dev/null || ln -sfn ${sq(prevOtsLink)} 'ots.cfg'`);
              }
              // What the box still depends on: the targets of the live links,
              // and every file the live MME config includes.
              const needed = new Set<string>();
              for (const [dir, link] of [['/root/enb/config', 'enb.cfg'], ['/root/mme/config', 'mme.cfg'], ['/root/mme/config', 'ims.cfg']] as const) {
                const t = await ssh.execCommand(`cd ${dir} && readlink ${link} 2>/dev/null || true`);
                const target = (t.stdout ?? '').trim().split('/').filter(Boolean).pop();
                if (target) needed.add(target);
              }
              const inc = await ssh.execCommand(
                `sudo -n grep -oP '(?<=include ")[^"]*(?=")' /root/mme/config/mme.cfg 2>/dev/null || true`);
              for (const n of String(inc.stdout ?? '').split('\n').map(x => x.trim()).filter(Boolean)) needed.add(n);

              for (const [name, dir] of [
                [item.callboxCfg, '/root/enb/config'],
                [item.mmeCfg, '/root/mme/config'],
                [item.imsCfg, '/root/mme/config'],
                // The DB and the mme copy that includes it, and the ots pick.
                // Without these the derived copy stayed behind every run,
                // unreferenced, accumulating in /root/mme/config.
                [item.dbCfg, '/root/mme/config'],
                [mmePick !== item.mmeCfg ? mmePick : undefined, '/root/mme/config'],
                [item.otsCfg, '/root/ots/config'],
              ] as const) {
                if (!name) continue;
                // Never the live links themselves — only what they point at.
                if (['enb.cfg', 'mme.cfg', 'ims.cfg', 'ots.cfg'].includes(name)) continue;
                if (needed.has(name)) { kept.push(name); continue; }
                // Only what THIS run put on the box. Removing configs that were
                // already there took them out of the pickers and emptied the
                // Database column, because both read the callbox: a file the
                // box no longer has cannot be offered, and an mme cfg that is
                // gone has no include line to name a DB. The folder keeps its
                // own copy either way.
                if (!addedThisRun.has(name)) { kept.push(name); continue; }
                const p = `${dir}/${name}`;
                const r = await ssh.execCommand(`sudo -n rm -f ${sq(p)} 2>/dev/null || rm -f ${sq(p)}`);
                if (r.code === 0) removed.push(name);
              }
            });
            if (removed.length) {
              stepDetails.push(`cfg-cleanup: removed ${removed.join(', ')} from the callbox — kept in ${testCaseDir(cfgFrom, item.name)}`);
            }
            if (kept.length) {
              stepDetails.push(`cfg-cleanup: left ${kept.join(', ')} in place — the callbox still points at it`);
            }
          }
        } catch { /* cleanup is best-effort — never changes the verdict */ }
      }
    }
    done += 1;
  }
  } finally {
    // The licence goes back, whatever happened: a clean finish, a row that
    // threw, or a stopped run.
    //
    // Unlike the file cleanup above, this is NOT skipped while another
    // operator is executing on the callbox. The file whose licence this run
    // rewrote is the one they are running on, and the bytes they expect are
    // the ones in the backup.
    await restoreLicences(callboxSys, licenceBackups, (m) => rawSteps.push({
      testcaseId: 'licence-restore', kind: 'note', status: 0, ok: true, detail: m, durationMs: 0,
    }));
  }

  opts.onProgress?.(total, total);
  const buildVersion = token ? await fetchBuildVersion(ueOpts.host, token) : undefined;

  return {
    startedAt, finishedAt: new Date().toISOString(),
    suiteId: suite.id, suiteName: suite.name,
    kind: suite.kind ?? 'uesim-only',
    uesimHost: ueOpts.host, boxUser: ueOpts.boxUser,
    callboxHost: callboxSys?.host,
    ueHost: ueSys?.host,
    licences: Object.values(licencesUsed).some(Boolean) ? licencesUsed : undefined,
    configSnapshots: Object.keys(configSnapshots).length ? configSnapshots : undefined,
    total, passed, failed, steps: rawSteps,
    // What this run was asked for, so the history can show a row that never
    // got its turn as well as the ones that ran. See SuiteRunResult.
    requested: items.map((i) => i.name),
    buildVersion,
  };
}

export async function runSuite(suite: AutomationSuite, opts: RunOpts = {}): Promise<RunRecord> {
  // Fire perf-qa BEFORE the run starts so its sample window covers both
  // the pre-state and the actual execution. perf-qa returns a job_id
  // synchronously; the collection itself continues in a background thread.
  let diagnostics: RunRecord['diagnostics'] | undefined;
  if (opts.collectDiagnostics) {
    const dg = await triggerPerfQaCollection({
      perfQaUrl: opts.perfQaUrl ?? DEFAULT_PERFQA_URL,
      testCaseName: suite.name,
      iterationId: newRunId(),
      profile: opts.perfQaProfile,
    });
    if (dg.ok && dg.jobId) {
      diagnostics = { perfQaUrl: dg.perfQaUrl, jobId: dg.jobId, triggeredAt: new Date().toISOString() };
    }
  }

  // Prefer the items[] flow when the suite has it — each row is a
  // self-contained (tc + cfg) pair with its own bring-up cycle. Fall
  // back to the legacy flat-list flow (one shared callbox cfg, N tcs)
  // for older suites saved before the items[] schema landed.
  const runFor = async (s: AutomationSuite) => (s.items && s.items.length > 0)
    ? await runItems(s, s.items, opts)
    : (s.kind === 'uesim+callbox'
        ? await runCallbox(s, opts)
        : await runUesimOnly(s, opts));

  // One pass per login, in order. Sequential on purpose: each pass drives the
  // shared callbox (link + lte restart), so two at once would restart the
  // radio under each other. Every step is labelled with the user it ran as.
  const users = (opts.asUsers ?? []).filter(Boolean);
  let summary;
  if (users.length > 1) {
    const passes = [];
    for (const u of users) {
      if (opts.signal?.aborted) break;
      const r = await runFor({ ...suite, boxUserId: u });
      passes.push({ user: u, r });
    }
    const first = passes[0]?.r;
    summary = {
      ...(first ?? await runFor(suite)),
      startedAt: passes[0]?.r.startedAt ?? new Date().toISOString(),
      finishedAt: passes[passes.length - 1]?.r.finishedAt ?? new Date().toISOString(),
      total: passes.reduce((a, p) => a + p.r.total, 0),
      passed: passes.reduce((a, p) => a + p.r.passed, 0),
      failed: passes.reduce((a, p) => a + p.r.failed, 0),
      steps: passes.flatMap((p) => p.r.steps.map((st: any) => ({ ...st, testcaseId: `${st.testcaseId} · ${p.user}` }))),
    } as typeof first;
  } else {
    summary = await runFor(users.length === 1 ? { ...suite, boxUserId: users[0] } : suite);
  }

  // Persist the run + return the full record (with runId).
  const runId = newRunId();

  // The configs this run deployed, filed beside it.
  //
  // Written to their own directory rather than into the record, which would
  // put several hundred kilobytes of cfg text inside a JSON file that the
  // history reads on every page load. Stripped from the record for the same
  // reason. Best-effort: a run's result does not depend on keeping a copy of
  // its inputs.
  const { configSnapshots, ...rest } = summary as typeof summary & {
    configSnapshots?: Record<string, Record<string, string>>;
  };
  if (configSnapshots) {
    for (const [row, files] of Object.entries(configSnapshots)) {
      saveRunConfigs(runId, row, files);
    }
  }

  const rec: RunRecord = {
    ...rest,
    runId,
    buildVersion: (summary as any).buildVersion,
    submittedBy: opts.submittedBy,
    diagnostics,
  };
  saveRun(rec);
  // Cross-surface history row so /runs shows this suite-run alongside
  // every other surface's runs.
  try {
    const { appendHistoryEntry } = await import('../historyStore');
    appendHistoryEntry({
      surface: 'automation-suite',
      label: `Automation suite "${suite.name}" · ${rec.total} steps · ${rec.passed} pass / ${rec.failed} fail`,
      startedAt: rec.startedAt,
      finishedAt: rec.finishedAt,
      // The box account this suite executed as, and the SimQA account that
      // started it — resolved the same way the execution itself was.
      user: opts.submittedBy,
      boxUser: uesimApiOptsForSystem(loadInventory(), suite.uesimSystemId ?? '', suite.boxUserId)?.boxUser,
      targetSystemId: suite.uesimSystemId,
      targetHost: rec.uesimHost,
      buildVersion: rec.buildVersion,
      total: rec.total,
      passed: rec.passed,
      failed: rec.failed,
      detailPath: `data/automation-runs/${suite.id}/${rec.runId}.json`,
      meta: {
        suiteId: suite.id,
        // WHICH run this row is. Without it /runs could only offer the suite,
        // and its Preview landed on the suite list with nothing selected —
        // the one thing it was not meant to do is make you go looking for the
        // run you just clicked.
        runId: rec.runId,
        suiteName: suite.name,
        kind: rec.kind,
        callboxHost: rec.callboxHost,
        diagnostics: !!diagnostics,
        submittedBy: rec.submittedBy,
      },
    });
  } catch { /* history side-channel */ }
  return rec;
}

// Duplicate a Simnovator testcase under a new name, with a new duration.
//
// The Automation Suite's per-row "Display name" creates a REAL testcase on the
// box: the source case is copied, renamed, its duration rewritten, and the copy
// is what gets executed. Copies are left in place afterwards so they show up in
// the Simnovator's own catalogue.
//
// Creation follows the box's 6-step lifecycle (cells -> subscribers ->
// user-plane -> power-cycle -> mobility -> settings). The order is mandatory:
// each section is gated on the previous, mobility needs power-cycle, and
// settings finalises the case.

import { ensureToken, getTestcase, listTestcases, type ApiOpts } from '../uesimClient';
import { diffSections, reconcileCellArrays, type SectionName } from '../testcaseSections';
// The duration arithmetic lives in durationFit.ts so it can be unit-tested;
// re-exported here because this module is where callers already look for it.
import { applyDuration, sessionFloorFromError, totalDurationFromError, applyTotalTestDuration, expectedRunSeconds, MIN_POWER_ON_SEC } from './durationFit';
export { applyDuration, sessionFloorFromError, MIN_POWER_ON_SEC } from './durationFit';


/**
 * The box rejects any testcase name outside [A-Za-z0-9_-] ("only letters,
 * numbers, underscores, and hyphens are allowed"), so a display name typed with
 * spaces or punctuation has to be folded before it's sent.
 */
export function sanitizeTestcaseName(raw: string): string {
  const s = (raw ?? '')
    .replace(/[^A-Za-z0-9_-]+/g, '_')  // any run of illegal chars -> one _
    .replace(/^_+|_+$/g, '');          // no leading/trailing separators
  return s || 'simqa_testcase';
}

/**
 * Every testcase currently on the box, by name.
 *
 * /v2/testcases has no server-side name filter (search/name/filter/q are all
 * silently ignored), so the full list has to be paged.
 *
 * CAREFUL — `offset` is a PAGE INDEX, not a row offset. Verified live:
 *   limit=200&offset=0 -> 200 items      limit=200&offset=1 -> 5 items
 *   limit=200&offset=2 -> 400 "requested page 3 out of range"
 *   limit=100&offset=1 -> rows 100-199   limit=100&offset=2 -> rows 200-204
 * Advancing it by the row count (offset += items.length) asks for page 201 and
 * the box 400s — which is exactly what broke every suite run with a catalogue
 * over 200 testcases.
 */
async function testcasesByName(opts: ApiOpts): Promise<Map<string, string>> {
  const byName = new Map<string, string>();
  // 1000 is the box's per-request cap ("Invalid 'pageSize' query parameter"
  // above it), so one page covers any realistic catalogue and the loop below
  // is the safety net rather than the normal path.
  const PAGE = 1000;
  for (let pageIndex = 0; pageIndex < 50; pageIndex++) {
    const page = await listTestcases(opts, PAGE, pageIndex);
    const items = page.items ?? [];
    if (items.length === 0) break;
    // First wins: the list is newest-first, and if a name somehow repeats the
    // newest is the one the operator means.
    for (const t of items) if (t?.name && !byName.has(t.name)) byName.set(t.name, t.id);
    // A short page is the last page; the box 400s on the one after it.
    if (items.length < PAGE) break;
    if (typeof page.total === 'number' && (pageIndex + 1) * PAGE >= page.total) break;
  }
  return byName;
}

/** Profiles to try when a source testcase names a logging profile the box no
 *  longer has. The box exposes no endpoint to list them (every plausible path
 *  404s), so these are the names observed in use on working testcases, tried in
 *  order until one is accepted. */
const LOG_PROFILE_FALLBACKS = ['debug', 'default', 'enable_all'];


/** Name the copy in every place the box reads a name from. */
function applyName(td: any, name: string): void {
  td.settings = td.settings ?? {};
  td.settings.test_name = name;
  td.settings.testCaseName = name;
}

async function post(opts: ApiOpts, token: string, path: string, body: unknown) {
  return send(opts, token, 'POST', path, body);
}

async function send(opts: ApiOpts, token: string, method: 'POST' | 'PUT', path: string, body: unknown) {
  const r = await fetch(`http://${opts.host}/v2${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json: any = {};
  try { json = text ? JSON.parse(text) : {}; } catch { /* non-JSON error body */ }
  return { status: r.status, ok: r.ok, json, text };
}

/** powerOnTime of every power-cycle profile — the figure a row's duration sets,
 *  and so the thing to compare when deciding whether a testcase is stale. */
function powerOnTimesOf(td: any): number[] {
  return (td?.powerCycleConfig?.profiles ?? []).map((p: any) => Number(p?.powerOnTime));
}

async function del(opts: ApiOpts, token: string, path: string) {
  const r = await fetch(`http://${opts.host}/v2${path}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  return { ok: r.ok, status: r.status, text: await r.text().catch(() => '') };
}

export interface DuplicateResult {
  testCaseId: string;
  name: string;
  /** Section that failed, when the copy could not be created. */
  failedStep?: string;
  error?: string;
  /** Something was changed to make the copy acceptable to the box — reported so
   *  the operator knows the copy is not byte-identical to its source. */
  warning?: string;
  /** True when an existing testcase of that name was executed rather than a new
   *  one being created. */
  reused?: boolean;
  /**
   * How long the testcase that will actually run keeps the box busy, by the
   * box's own sum — see expectedRunSeconds.
   *
   * The caller needs this to know how long to listen for. It is not the
   * duration the row asked for: a profile whose traffic cannot be shortened
   * raises the window, and a looped power-cycle profile multiplies it. Waiting
   * on the row's figure instead made the runner stop executions the box went
   * on to complete, which surfaced as a suite row that never updated.
   */
  expectedRunSec?: number;
}

/**
 * Ensure a testcase called `name` exists on the box, and return its id.
 *
 * If one already exists it is REUSED — re-running a suite row executes the same
 * testcase rather than accumulating `_2`, `_3`, … copies on the box. Otherwise
 * `sourceId` is copied under that name with `durationSec` applied.
 *
 * Creation follows the box's 6-step lifecycle; see the module header.
 */
export async function duplicateTestcase(
  opts: ApiOpts,
  sourceId: string,
  name: string,
  durationSec?: number,
  /** The source definition, when the caller already has it — used when the
   *  source belongs to ANOTHER login, which cannot be read through this one. */
  sourceTd?: any,
): Promise<DuplicateResult> {
  const token = await ensureToken(opts.host, opts.username, opts.password);
  const finalName = sanitizeTestcaseName(name);

  // Reuse before create. Names are unique on the box, so an exact match is
  // unambiguous — it is the testcase this row created on an earlier run.
  const existing = await testcasesByName(opts);
  const already = existing.get(finalName);
  /** Set when an out-of-date testcase had to be torn down and rebuilt. */
  let rebuiltNote = '';

  if (already) {
    // Reuse the SAME testcase — but reusing must not mean ignoring the row. A
    // duration typed into the suite has to take effect, and the box refuses to
    // re-cut a finished testcase ("testcase creation has already completed"),
    // so the only way to keep one name AND honour a changed duration is to
    // delete and rebuild it. Done ONLY when the duration actually differs, so
    // an unchanged row never destroys anything.
    let staleDesc = '';
    if (typeof durationSec === 'number') {
      try {
        const cur: any = await getTestcase(opts, already);
        const probe: any = JSON.parse(JSON.stringify(cur?.testDefinition ?? {}));
        const before = powerOnTimesOf(probe);
        applyDuration(probe, durationSec);
        const after = powerOnTimesOf(probe);
        if (String(before) !== String(after)) staleDesc = `${before.join('/')}s → ${after.join('/')}s`;
      } catch { /* unreadable: leave it alone and just run it */ }
    }

    if (!staleDesc) {
      // Reusing means running what is already on the box, so how long THAT
      // takes is what the caller has to wait for — not the row's figure.
      let expectedRunSec: number | undefined;
      try {
        const cur: any = await getTestcase(opts, already);
        expectedRunSec = expectedRunSeconds(cur?.testDefinition ?? {}) || undefined;
      } catch { /* unreadable: the caller falls back to the row's duration */ }
      return { testCaseId: already, name: finalName, reused: true, expectedRunSec };
    }

    const gone = await del(opts, token, `/testcases/${encodeURIComponent(already)}`);
    if (!gone.ok) {
      return {
        testCaseId: already, name: finalName, reused: true,
        warning: `"${finalName}" on the box is out of date (power-on ${staleDesc}) and could not be `
          + `deleted for rebuild: ${gone.text.slice(0, 160)} — it ran with its old duration`,
      };
    }
    rebuiltNote = `rebuilt "${finalName}" at the row's duration (power-on ${staleDesc}) — `
      + `the box cannot re-cut a finished testcase, so the old one was replaced`;
  }

  let definition = sourceTd;
  if (!definition) {
    const src = await getTestcase(opts, sourceId);
    if (!src?.testDefinition) {
      return { testCaseId: '', name: finalName, failedStep: 'fetch', error: `testcase ${sourceId} has no testDefinition` };
    }
    definition = src.testDefinition;
  }

  // Deep clone: we mutate duration/name, and the source object is also used by
  // the caller for reporting.
  const td: any = JSON.parse(JSON.stringify(definition));
  applyName(td, finalName);
  const notes = typeof durationSec === 'number' ? applyDuration(td, durationSec) : [];

  // Radio cards belong to the simulator, not the testcase: every simulator on
  // a multi-user box owns its own (.95: 0,1 / 2,3 / 4,5) and a cell names the
  // one it runs on. A copy made for another login has to move onto theirs, or
  // the box refuses to start it — "The test uses sdr2, which is not assigned
  // to this simulator". A no-op when the source is already theirs.
  try {
    const { listSimulators } = await import('../uesimClient');
    const { pickUserSimulator } = await import('../simulatorScope');
    const { remapRfCards } = await import('../testcaseSections');
    const sims = await listSimulators(opts);
    const mine = pickUserSimulator((sims.items ?? []) as any, opts.username);
    const entry = (sims.items ?? []).find((s: any) => String(s.id) === mine?.id) as any;
    const cards = (entry?.nodes?.rfCards ?? []).map(Number).filter((n: number) => Number.isFinite(n));
    if (td.cellConfig && cards.length) {
      const moved = remapRfCards(td.cellConfig, cards);
      if (moved.length) notes.push(`moved onto ${opts.username}'s radio cards (${moved.join(', ')})`);
    }
  } catch { /* leave the cards alone; the box reports what it cannot run */ }
  if (rebuiltNote) notes.unshift(rebuiltNote);

  const result = await createFromDefinition(opts, token, td, finalName, notes);
  if (result.failedStep) return result;
  // td is the definition that was just built on the box, including anything
  // the create lifecycle had to grow — so this is the real timeline.
  return { ...result, reused: !!rebuiltNote, expectedRunSec: expectedRunSeconds(td) || undefined };
}

/**
 * The box's 6-step create lifecycle (cells -> subscribers -> user-plane ->
 * power-cycle -> [mobility] -> settings), used by duplicateTestcase() so there
 * is one implementation of "POST a testDefinition onto the box". Editing an
 * existing testcase does not come through here — see updateTestcaseInPlace().
 */
/** Build a testcase on a box from a full testDefinition, via the box's 6-step
 *  create lifecycle. Exported so e2eTestcases.ts can replay a captured
 *  definition on a different station without duplicating the lifecycle. */
export async function createFromDefinition(
  opts: ApiOpts,
  token: string,
  td: any,
  finalName: string,
  extraWarnings: string[] = [],
): Promise<DuplicateResult> {
  const cells = await post(opts, token, '/tests/cells', { cellConfig: td.cellConfig });
  const id: string | undefined = cells.json?.testCaseId;
  if (!cells.ok || !id) {
    return { testCaseId: '', name: finalName, failedStep: 'cells', error: cells.text.slice(0, 300) };
  }

  const sections: Array<[string, string, unknown]> = [
    ['subscribers', `/tests/${encodeURIComponent(id)}/subscribers`, { subsConfig: td.subsConfig }],
    ['user-plane',  `/tests/${encodeURIComponent(id)}/user-plane`,  { userPlaneConfig: td.userPlaneConfig }],
    ['power-cycle', `/tests/${encodeURIComponent(id)}/power-cycle`, { powerCycleConfig: td.powerCycleConfig }],
  ];
  if (td.mobilityConfig) {
    sections.push(['mobility', `/tests/${encodeURIComponent(id)}/mobility`, { mobilityConfig: td.mobilityConfig }]);
  }
  // settings LAST — it finalises and locks the case.
  sections.push(['settings', `/tests/${encodeURIComponent(id)}/settings`, { settings: td.settings }]);

  const warnings: string[] = [...extraWarnings];

  for (const [step, path, body] of sections) {
    if (body == null || (body as any)[Object.keys(body as any)[0]] == null) continue;
    let r = await post(opts, token, path, body);

    // A testcase can reference a logging profile that has since been deleted
    // from the box (e.g. "enable_all"). The source still runs — the profile is
    // only resolved when a testcase is CREATED — so the copy is the first thing
    // to notice. The field is mandatory and must be non-empty, so it can't just
    // be dropped; substitute a profile that does exist rather than failing the
    // whole row over a logging setting.
    if (!r.ok && step === 'settings' && /loggingProfileName/i.test(r.text)) {
      const stale = String((td.settings ?? {}).loggingProfileName ?? '');
      for (const candidate of LOG_PROFILE_FALLBACKS.filter(c => c !== stale)) {
        r = await post(opts, token, path, { settings: { ...td.settings, loggingProfileName: candidate } });
        if (r.ok) {
          warnings.push(`logging profile "${stale}" does not exist on the box — copy created with "${candidate}"`);
          break;
        }
      }
    }

    // The safety net, not the plan.
    //
    // durationFit now does the box's own arithmetic — transcribed from its form
    // bundle and checked against every testcase on .94 and .95 — so a refusal
    // here means a build changed a constant and this file's transcription is
    // stale. Growing the window to the floor the box names is the wrong policy
    // (the row asked for a duration and should get it) but it is better than
    // the row not running at all, and the warning says what happened.
    if (!r.ok && step === 'user-plane') {
      const floor = sessionFloorFromError(r.text);
      if (floor != null) {
        const lead = Math.max(0, ...(td.userPlaneConfig?.profiles ?? []).map((p: any) =>
          (Number(p?.startDelay ?? 0) || 0) + (Number(p?.callSetupDelay ?? 0) || 0)));
        const grown = floor + lead + 5;
        applyDuration(td, grown);
        warnings.push(`the box requires a session over ${floor}s for this profile — power-on duration raised to ${grown}s`);
        r = await post(opts, token, path, { userPlaneConfig: td.userPlaneConfig });
      }
    }

    // The power-cycle section has a rule the box keeps to itself.
    //
    // Its form checks (powerOn + powerOff) × cycles + attachDelay, but the API
    // also refuses "Total Test Duration should be at least Power On Time +
    // Power Off Time + Ramp-up offset for profile 0. Minimum: 183.00" — and
    // "Ramp-up offset" appears nowhere in the form's code, so there is no
    // formula to copy. The box names the figure it wants, so take it rather
    // than guess: this is what stopped AIO_64UEs_UDP_TCP_VONR_attach-detach-loop
    // from ever being created at a 100s power-on duration.
    if (!r.ok && step === 'power-cycle') {
      const minTotal = totalDurationFromError(r.text);
      if (minTotal != null) {
        applyTotalTestDuration(td, minTotal);
        warnings.push(`the box requires a total test duration of at least ${minTotal}s for this power-cycle profile — raised to it`);
        r = await post(opts, token, path, { powerCycleConfig: td.powerCycleConfig });
      }
    }

    if (!r.ok) {
      // The case was born at the cells step, so a failure here leaves a
      // half-built one on the box wearing this row's name. Left there it is
      // worse than nothing: the next run finds the name taken, reuses it, and
      // executes a testcase that was never finished. Take it away again.
      const gone = await del(opts, token, `/testcases/${encodeURIComponent(id)}`);
      return {
        testCaseId: gone.ok ? '' : id, name: finalName, failedStep: step,
        error: r.text.slice(0, 300) + (gone.ok ? '' : ' (the half-built copy could not be removed from the box)'),
      };
    }
  }

  return {
    testCaseId: id, name: finalName,
    warning: warnings.length ? warnings.join('; ') : undefined,
  };
}

export interface UpdateResult {
  testCaseId: string;
  name: string;
  /** Sections written, in order. Empty when the edit changed nothing. */
  updated: SectionName[];
  /** The section that was refused. Every section before it WAS written; the
   *  testcase itself is never deleted, so it is left edited up to that point. */
  failedStep?: SectionName;
  error?: string;
  warning?: string;
}

/**
 * Save an edited testDefinition onto the SAME testcase.
 *
 * This used to delete the testcase and recreate it — new id, broken links and
 * playlists, and a testcase left deleted outright if any recreate step failed.
 * It rested on "the box has no update API", which is not so: the Simnovator's
 * own GUI edits with PUT v2/tests/<id>/<section>, and on 192.168.1.95 a PUT
 * kept the id and the change (power-on 650 → 657, description rewritten).
 *
 * Only sections that differ from what the box holds are written, in the box's
 * order with settings last. Nothing is ever deleted.
 */
export async function updateTestcaseInPlace(
  opts: ApiOpts,
  testcaseId: string,
  testDefinition: any,
): Promise<UpdateResult> {
  const token = await ensureToken(opts.host, opts.username, opts.password);
  const current: any = await getTestcase(opts, testcaseId);
  const curTd = current?.testDefinition ?? current ?? {};
  const td: any = JSON.parse(JSON.stringify(testDefinition));
  const currentName = String(current?.name ?? '');

  // Do what the box's own GUI does when an antenna count changes — resize
  // the per-antenna gain arrays — or a hand edit like DL 4 → 2 is refused
  // ("rxGain array size (4) must match DL antenna count (2)").
  const adjusted = td.cellConfig ? reconcileCellArrays(td.cellConfig) : [];

  const diff = diffSections(curTd, td, currentName);
  const finalName = diff.rename ?? currentName ?? testcaseId;
  const warnings = [...adjusted, ...diff.warnings];
  const updated: SectionName[] = [];
  const id = encodeURIComponent(testcaseId);

  for (const change of diff.changes) {
    let body: any = { [change.key]: td[change.key] };
    if (change.section === 'settings') {
      // A settings write requires testCaseName, which GET never returns —
      // same asymmetry applyName() fixes for copies.
      applyName(td, finalName);
      body = { settings: td.settings };
    }
    // Editing cells is PUT tests/<id>/cells; only CREATING a testcase uses
    // the id-less POST tests/cells, which is never the case here.
    const path = `/tests/${id}/${change.section}`;
    let r = await send(opts, token, change.kind === 'add' ? 'POST' : 'PUT', path, body);

    // Same fallback as a copy: a testcase can name a logging profile the box
    // has since dropped, and settings is refused until it names one it has.
    if (!r.ok && change.section === 'settings' && /loggingProfileName/i.test(r.text)) {
      const stale = String(td.settings?.loggingProfileName ?? '');
      for (const candidate of LOG_PROFILE_FALLBACKS.filter((c) => c !== stale)) {
        r = await send(opts, token, 'PUT', path, { settings: { ...td.settings, loggingProfileName: candidate } });
        if (r.ok) {
          warnings.push(`logging profile "${stale}" does not exist on the box — saved with "${candidate}"`);
          break;
        }
      }
    }

    if (!r.ok) {
      return {
        testCaseId: testcaseId, name: finalName, updated,
        failedStep: change.section, error: r.text.slice(0, 300),
        warning: warnings.length ? warnings.join('; ') : undefined,
      };
    }
    updated.push(change.section);
  }

  return {
    testCaseId: testcaseId, name: finalName, updated,
    warning: warnings.length ? warnings.join('; ') : undefined,
  };
}

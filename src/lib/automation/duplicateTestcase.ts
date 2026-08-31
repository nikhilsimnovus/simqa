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

/** Voice user-plane profiles the box refuses to create with a short session:
 *  "sessionDuration N should be greater than 70s for VOLTE". A call needs
 *  setup + ring + media inside the session, so a 10s row is not creatable. */
const VOICE_DATA_TYPES = new Set(['volte', 'vonr', 'voice', 'vt', 'video']);
const VOICE_MIN_SESSION_SEC = 75;

/** Shortest power-on duration a row may ask for. Below this there is no room
 *  for the UEs to come up and still pass traffic. */
export const MIN_POWER_ON_SEC = 20;

/**
 * Rewrite a testDefinition's duration in place.
 *
 * The figure the suite asks for is the POWER-ON DURATION — how long the UEs are
 * powered on, i.e. powerCycleConfig.powerOnTime. The user-plane session is
 * derived from it: traffic has to start after the profile's startDelay (and,
 * for voice, its call-setup delay) and finish before the UEs power off, so
 *
 *     sessionDuration = powerOnTime - startDelay - callSetupDelay
 *
 * That is the opposite of the earlier mapping, which took the session as given
 * and grew the power-on window around it.
 *
 * Returns notes describing anything that had to be adjusted upward.
 */
export function applyDuration(td: any, seconds: number): string[] {
  const notes: string[] = [];
  let powerOn = Math.max(1, Math.floor(seconds));
  if (powerOn < MIN_POWER_ON_SEC) {
    notes.push(`power-on duration raised from ${powerOn}s to the ${MIN_POWER_ON_SEC}s minimum`);
    powerOn = MIN_POWER_ON_SEC;
  }

  const profiles = (td?.userPlaneConfig?.profiles ?? []).filter((p: any) => p && typeof p === 'object');

  // Voice needs a session longer than 70s, and the session is what is left of
  // the power-on window after the delays — so a voice row can force the whole
  // window up. Work out the floor first, then apply one consistent figure.
  for (const p of profiles) {
    const type = String(p.dataType ?? '').toLowerCase();
    if (!VOICE_DATA_TYPES.has(type)) continue;
    const lead = (Number(p.startDelay ?? 0) || 0) + (Number(p.callSetupDelay ?? 0) || 0);
    const needed = VOICE_MIN_SESSION_SEC + lead;
    if (powerOn < needed) {
      notes.push(`${type} profile needs a session over 70s — power-on duration raised from ${powerOn}s to ${needed}s`);
      powerOn = needed;
    }
  }

  for (const p of profiles) {
    const lead = (Number(p.startDelay ?? 0) || 0) + (Number(p.callSetupDelay ?? 0) || 0);
    p.sessionDuration = Math.max(1, powerOn - lead);
  }

  for (const p of td?.powerCycleConfig?.profiles ?? []) {
    if (!p || typeof p !== 'object') continue;
    p.powerOnTime = powerOn;
    // durationP is the traffic window inside the power-on window: it ends when
    // the last profile's session ends, never after the UEs power off.
    const attachDelay = Number(p.attachDelay ?? 0) || 0;
    p.durationP = Math.max(1, powerOn - attachDelay);
    // A time-based loop profile also caps the whole test; keep it consistent
    // or the box rejects totalTestDuration < powerOnTime * cycles.
    if (p.loopProfile === 'time' && typeof p.totalTestDuration === 'number') {
      p.totalTestDuration = (p.powerOnTime + (Number(p.powerOffTime) || 0)) * 2 + 80;
    }
  }
  return notes;
}

/** Name the copy in every place the box reads a name from. */
function applyName(td: any, name: string): void {
  td.settings = td.settings ?? {};
  td.settings.test_name = name;
  td.settings.testCaseName = name;
}

async function post(opts: ApiOpts, token: string, path: string, body: unknown) {
  const r = await fetch(`http://${opts.host}/v2${path}`, {
    method: 'POST',
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

    if (!staleDesc) return { testCaseId: already, name: finalName, reused: true };

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

  const src = await getTestcase(opts, sourceId);
  if (!src?.testDefinition) {
    return { testCaseId: '', name: finalName, failedStep: 'fetch', error: `testcase ${sourceId} has no testDefinition` };
  }

  // Deep clone: we mutate duration/name, and the source object is also used by
  // the caller for reporting.
  const td: any = JSON.parse(JSON.stringify(src.testDefinition));
  applyName(td, finalName);
  const notes = typeof durationSec === 'number' ? applyDuration(td, durationSec) : [];
  if (rebuiltNote) notes.unshift(rebuiltNote);

  const result = await createFromDefinition(opts, token, td, finalName, notes);
  if (result.failedStep) return result;
  return { ...result, reused: !!rebuiltNote };   // same name as before, rebuilt rather than added
}

/**
 * The box's 6-step create lifecycle (cells -> subscribers -> user-plane ->
 * power-cycle -> [mobility] -> settings), shared by duplicateTestcase() and
 * recreateTestcase() so there is one implementation of "POST a testDefinition
 * onto the box", not two.
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

    if (!r.ok) return { testCaseId: id, name: finalName, failedStep: step, error: r.text.slice(0, 300) };
  }

  return {
    testCaseId: id, name: finalName,
    warning: warnings.length ? warnings.join('; ') : undefined,
  };
}

/**
 * Delete testcaseId and recreate it from an edited testDefinition, via the
 * same 6-step lifecycle as duplicateTestcase(). The box has no update API
 * (see module header) — this is the only way an edited testcase.json takes
 * effect on the Simnovator. The id ALWAYS changes on success; callers must
 * navigate to the new id.
 */
export async function recreateTestcase(
  opts: ApiOpts,
  testcaseId: string,
  testDefinition: any,
): Promise<DuplicateResult> {
  const token = await ensureToken(opts.host, opts.username, opts.password);
  const td: any = JSON.parse(JSON.stringify(testDefinition));
  const finalName = String(td?.settings?.test_name ?? td?.settings?.testCaseName ?? testcaseId);
  // GET /v2/testcases/<id> — and so the box's own testcase.json export — omits
  // testCaseName even though POST .../settings requires it non-empty
  // ("SettingsConfig: testCaseName is required"). applyName() is the same fix
  // duplicateTestcase() already needs for the same asymmetry; round-tripping
  // an edit through this function hits it too.
  applyName(td, finalName);

  const gone = await del(opts, token, `/testcases/${encodeURIComponent(testcaseId)}`);
  if (!gone.ok) {
    return { testCaseId: '', name: finalName, failedStep: 'delete', error: gone.text.slice(0, 300) };
  }

  return createFromDefinition(opts, token, td, finalName);
}

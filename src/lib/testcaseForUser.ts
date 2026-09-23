// Make a testcase available to the login that is about to run it.
//
// A Simnovator scopes testcases per user: sruthi's testcase is invisible to
// mohan, and an execution can only run what the token can see. So browsing as
// sruthi, opening her testcase, then picking mohan under "Run as" pointed the
// run at something mohan's token 404s on.
//
// The fix is the one an operator would do by hand: copy the definition into
// the chosen user's own catalogue and run THEIR copy. Same definition, same
// name, their account — and if they already have one by that name it is
// reused rather than piling up copies on the box.

import { getTestcase, ensureToken, listSimulators, type ApiOpts } from './uesimClient';
import { listBoxUsers, type InventorySystem } from './inventory';
import { createFromDefinition, sanitizeTestcaseName, updateTestcaseInPlace } from './automation/duplicateTestcase';
import { remapRfCards } from './testcaseSections';
import { pickUserSimulator } from './simulatorScope';

export interface ResolvedForUser {
  /** The id to execute — the original when the login can already see it. */
  testcaseId: string;
  name?: string;
  /** Set when a copy was made or reused under this login, for the run log. */
  note?: string;
  error?: string;
}

/** The testcase as some login of this system can see it. */
async function findDefinition(
  sys: InventorySystem,
  testcaseId: string,
  except: string,
): Promise<{ td: any; name?: string; owner: string } | null> {
  for (const u of listBoxUsers(sys)) {
    if (u.username === except) continue;
    try {
      const tc: any = await getTestcase({ host: sys.host, username: u.username, password: u.password }, testcaseId);
      const td = tc?.testDefinition;
      if (td) return { td, name: tc?.name, owner: u.username };
    } catch { /* not this one's */ }
  }
  return null;
}

/**
 * The radio cards the login's simulator owns.
 *
 * Every simulator has its own — 0,1 / 2,3 / 4,5 on .95 — and a cell names the
 * card it runs on, so a testcase carried over from another user asks for a
 * card this simulator does not have: the box refuses to start it with "The
 * test uses sdr2, which is not assigned to this simulator".
 */
async function rfCardsOf(opts: ApiOpts): Promise<number[]> {
  try {
    const sims = await listSimulators(opts);
    const mine = pickUserSimulator((sims.items ?? []) as any, opts.username);
    const entry = (sims.items ?? []).find((s: any) => String(s.id) === mine?.id) as any;
    return (entry?.nodes?.rfCards ?? []).map(Number).filter((n: number) => Number.isFinite(n));
  } catch {
    return [];
  }
}

/** Their own copy of `name`, if they have one. */
async function sameNamed(opts: ApiOpts, name: string): Promise<string | undefined> {
  const { listTestcases } = await import('./uesimClient');
  for (let page = 0; page < 20; page++) {
    const r = await listTestcases(opts, 1000, page);
    const items = r.items ?? [];
    const hit = items.find((t: any) => t?.name === name);
    if (hit) return String(hit.id);
    if (items.length < 1000) break;
  }
  return undefined;
}

/**
 * Resolve the testcase this run should execute, as `opts` (the chosen login).
 *
 * Returns the id unchanged when that login can already see it — the common
 * case, and one round-trip. Otherwise the definition is read through whichever
 * login owns it and created under this one.
 */
export async function testcaseForUser(
  sys: InventorySystem,
  opts: ApiOpts,
  testcaseId: string,
): Promise<ResolvedForUser> {
  try {
    const mine: any = await getTestcase(opts, testcaseId);
    if (mine?.id ?? mine?.name) return { testcaseId, name: mine?.name };
  } catch { /* not visible to this login — copy it below */ }

  const found = await findDefinition(sys, testcaseId, opts.username);
  if (!found) {
    return {
      testcaseId,
      error: `${opts.username} cannot see this testcase, and no other login registered for ${sys.host} can either — so it cannot be copied to them.`,
    };
  }
  const name = found.name ?? testcaseId;
  // Testcase names are unique across the WHOLE box, not per user — the copy
  // is refused with `duplicate key value violates unique constraint
  // "tests_test_name_key"` if it reuses the name. So the copy is named after
  // the person it is for: sruthi's "sample" becomes "sample_mohan".
  const copyName = sanitizeTestcaseName(`${name}_${opts.username}`);

  // Already theirs? Run that rather than making another copy.
  const cards = await rfCardsOf(opts);

  try {
    const existing = await sameNamed(opts, copyName);
    if (existing) {
      // An older copy may still name the original's radio cards — repair it
      // in place rather than handing the box a testcase it will refuse.
      let repaired = '';
      try {
        const tc: any = await getTestcase(opts, existing);
        const td = tc?.testDefinition;
        if (td?.cellConfig && cards.length) {
          const moved = remapRfCards(td.cellConfig, cards);
          if (moved.length) {
            const u = await updateTestcaseInPlace(opts, existing, td);
            repaired = u.failedStep
              ? ` Could not move it onto this simulator's radio cards (${moved.join(', ')}): ${u.error ?? 'refused'}.`
              : ` Moved it onto this simulator's radio cards (${moved.join(', ')}).`;
          }
        }
      } catch { /* leave the copy as it is; the box will say if it cannot run */ }
      return { testcaseId: existing, name: copyName, note: `${opts.username} already has a copy of "${name}" as "${copyName}" — executed that (${existing}).${repaired}` };
    }
  } catch { /* fall through to creating one */ }

  try {
    const token = await ensureToken(opts.host, opts.username, opts.password);
    const td = JSON.parse(JSON.stringify(found.td));
    // Onto this login's own radio cards before it is created — see rfCardsOf.
    const moved = td.cellConfig && cards.length ? remapRfCards(td.cellConfig, cards) : [];

    // A name is taken box-wide even when this user cannot see the testcase
    // holding it, so a couple of suffixed attempts follow before giving up.
    for (let attempt = 1; attempt <= 4; attempt++) {
      const tryName = attempt === 1 ? copyName : `${copyName}_${attempt}`;
      // GET never returns testCaseName, but creating one requires it
      // ("SettingsConfig: testCaseName is required and must be non-empty") —
      // the same asymmetry duplicateTestcase() and the editor both fix.
      td.settings = { ...(td.settings ?? {}), test_name: tryName, testCaseName: tryName };
      const created = await createFromDefinition(opts, token, td, tryName);
      if (!created.failedStep && created.testCaseId) {
        return {
          testcaseId: created.testCaseId,
          name: tryName,
          note: `"${name}" belongs to ${found.owner}; copied it to ${opts.username} as "${tryName}" and executed their copy.`
            + (moved.length ? ` Moved onto this simulator's radio cards (${moved.join(', ')}).` : '')
            + (created.warning ? ` Note: ${created.warning}` : ''),
        };
      }
      const taken = /duplicate key|already exists|tests_test_name_key/i.test(created.error ?? '');
      if (!taken) {
        return { testcaseId, error: `could not create "${tryName}" under ${opts.username} (${created.failedStep}): ${created.error ?? 'unknown error'}` };
      }
    }
    return { testcaseId, error: `could not copy "${name}" to ${opts.username}: every name from "${copyName}" onwards is already taken on the box.` };
  } catch (e: any) {
    return { testcaseId, error: `could not copy "${name}" to ${opts.username}: ${e?.message ?? e}` };
  }
}

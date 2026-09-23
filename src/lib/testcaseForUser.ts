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

import { getTestcase, ensureToken, type ApiOpts } from './uesimClient';
import { listBoxUsers, type InventorySystem } from './inventory';
import { createFromDefinition } from './automation/duplicateTestcase';

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

  // Already theirs by name? Run that rather than making another copy.
  try {
    const existing = await sameNamed(opts, name);
    if (existing) {
      return { testcaseId: existing, name, note: `"${name}" already exists under ${opts.username} — executed their copy (${existing}).` };
    }
  } catch { /* fall through to creating one */ }

  try {
    const token = await ensureToken(opts.host, opts.username, opts.password);
    const created = await createFromDefinition(opts, token, JSON.parse(JSON.stringify(found.td)), name);
    if (created.failedStep || !created.testCaseId) {
      return { testcaseId, error: `could not create "${name}" under ${opts.username} (${created.failedStep}): ${created.error ?? 'unknown error'}` };
    }
    return {
      testcaseId: created.testCaseId,
      name,
      note: `"${name}" belongs to ${found.owner}; copied it to ${opts.username} as ${created.testCaseId} and executed their copy.`
        + (created.warning ? ` Note: ${created.warning}` : ''),
    };
  } catch (e: any) {
    return { testcaseId, error: `could not copy "${name}" to ${opts.username}: ${e?.message ?? e}` };
  }
}

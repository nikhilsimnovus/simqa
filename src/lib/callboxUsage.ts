// Who else is using a callbox right now, and what config it is on.
//
// The input to decideBringUp() (callboxShare.ts). Two sources, because either
// alone misses someone:
//
//   • the Simnovators bound to this callbox, read through every login they
//     register (collectBoxActivity) — any execution in progress there is
//     somebody's test running over this radio, whether it was started from
//     SimQA or from the Simnovator's own GUI;
//   • SimQA's own validation runs that have NOT triggered yet — they are about
//     to use the callbox, but the box knows nothing about them until they do.
//
// The caller's own login is excluded: their own running test is not a reason
// to warn them about themselves.

import { type Inventory, type InventorySystem, getSystem } from './inventory';
import { collectBoxActivity } from './boxActivity';
import { currentCfgLinks } from './labCfgLink';
import type { CfgPick, OtherExecution } from './callboxShare';

/** Simnovators whose topology binds this callbox, one per host. */
function simnovatorsOn(inv: Inventory, callbox: InventorySystem): InventorySystem[] {
  const seen = new Set<string>();
  const out: InventorySystem[] = [];
  for (const p of inv.profiles) {
    if (p.callbox !== callbox.id) continue;
    const sys = getSystem(inv, p.simnovator ?? p.uesim ?? '');
    if (sys && !seen.has(sys.host)) { seen.add(sys.host); out.push(sys); }
  }
  return out;
}

/** SimQA validation runs on this callbox that have not triggered yet. Read off
 *  the same globalThis registry endToEnd/runner.ts keeps its runs in, so this
 *  module does not import the runner (which imports the checks that call us). */
function startingRuns(callbox: InventorySystem, me?: string, exceptRunId?: string): OtherExecution[] {
  const reg: Map<string, any> | undefined = (globalThis as any).__simqaEndToEndActive;
  if (!reg) return [];
  const out: OtherExecution[] = [];
  for (const ar of reg.values()) {
    if (ar?.runId === exceptRunId || ar?.finishedAt || ar?.canceled) continue;
    if (ar?.ctx?.callbox?.id !== callbox.id) continue;
    if (ar?.ctx?.executionId) continue;          // triggered — the box reports it
    if (me && ar?.boxUser === me) continue;
    out.push({ user: ar?.boxUser, testcaseName: ar?.testcaseName ?? ar?.ctx?.testcaseName, state: 'starting' });
  }
  return out;
}

export async function callboxUsage(
  inv: Inventory,
  callbox: InventorySystem,
  opts: { me?: string; exceptRunId?: string } = {},
): Promise<{ others: OtherExecution[]; current: CfgPick }> {
  const [current, activities] = await Promise.all([
    currentCfgLinks(callbox).catch(() => ({} as CfgPick)),
    Promise.all(simnovatorsOn(inv, callbox).map((s) => collectBoxActivity(s).catch(() => null))),
  ]);

  const others: OtherExecution[] = [];
  for (const a of activities) {
    for (const e of a?.executions ?? []) {
      if (e.status !== 'in progress') continue;
      if (opts.me && e.user === opts.me) continue;
      others.push({ user: e.user, testcaseName: e.testcaseName, simulator: e.simulatorName, state: 'executing' });
    }
  }
  others.push(...startingRuns(callbox, opts.me, opts.exceptRunId));
  return { others, current };
}

/**
 * The bring-up decision for a run about to apply `pick` on `callbox`, as
 * `me`. For callers with no one to ask — the Automation Suite runs unattended
 * — so they take the non-destructive answer on 'blocked': run on the config
 * already linked rather than restart LTE under someone else's test.
 */
export async function bringUpDecision(
  inv: Inventory,
  callbox: InventorySystem,
  me: string | undefined,
  pick: CfgPick,
) {
  const { decideBringUp } = await import('./callboxShare');
  const u = await callboxUsage(inv, callbox, { me });
  return decideBringUp(pick, u.current, u.others);
}

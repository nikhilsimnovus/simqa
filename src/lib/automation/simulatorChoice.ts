// Which simulator a run executes on, and whether it may execute at all.
//
// Measured on 192.168.1.102, 2026-10-23:
//
//   id 1  Simulator_test  AVAILABLE  DISCONNECTED  2 RF cards
//   id 4  UE-Simulator    AVAILABLE  CONNECTED     0 RF cards
//
//   GET /v2/users (admin only):
//     admin → Simulator_test, UE-Simulator
//     mohan → UE-Simulator
//
// The old rule was "free first, then most RF cards", which picks
// Simulator_test — a simulator that is DISCONNECTED and that the Simnovator's
// own GUI refuses to execute on with a connectivity error. SimQA ran there
// anyway on 19 October and the box reported PASS in 213s, which is the worst
// possible outcome: a green result from a simulator that was never connected.
//
// So connectivity comes first and card count last, and a run that has nothing
// connected to execute on is REFUSED with the reason rather than started.
//
// Ownership matters too. A plain login is only shown its own simulators, so
// its /v2/simulators IS the ownership list. An admin token is shown
// everybody's, and then /v2/users says which belong to the login the suite
// runs as — the check an operator does by hand in the Users section.
//
// Pure, imports nothing, so node --test loads it directly.

export interface BoxSimulator {
  id: string;
  name?: string;
  /** AVAILABLE / BUSY — the box's execution mutex. */
  availability?: string;
  /** CONNECTED / DISCONNECTED — whether the simulator is actually there. */
  connectivity?: string;
  cards: number[];
}

export interface SimulatorPick {
  ok: true;
  sim: BoxSimulator;
  /** One line for the run log: what was chosen and why. */
  note: string;
}

export interface SimulatorRefusal {
  ok: false;
  /** Why no simulator may be used. Shown as the row's failure. */
  reason: string;
}

const up = (s?: string) => String(s ?? '').trim().toUpperCase();

export const isConnected = (s: BoxSimulator): boolean => up(s.connectivity) !== 'DISCONNECTED';
export const isFree = (s: BoxSimulator): boolean => up(s.availability) !== 'BUSY';

/** The shape /v2/simulators returns, narrowed to what matters. */
export function readSimulator(raw: any): BoxSimulator | undefined {
  if (!raw?.id && raw?.id !== 0) return undefined;
  return {
    id: String(raw.id),
    name: raw.name ? String(raw.name) : undefined,
    availability: raw.availability ? String(raw.availability) : undefined,
    connectivity: raw.connectivity ? String(raw.connectivity) : undefined,
    cards: (raw?.nodes?.rfCards ?? []).map((c: unknown) => Number(c)).filter((c: number) => Number.isFinite(c)),
  };
}

/** The simulators GET /v2/users says belong to one login. Empty when the call
 *  was not available (it is admin-only) — which is not the same as "none". */
export function simulatorsOfUser(usersResponse: any, username: string): Array<{ id: string; name?: string }> {
  const want = String(username ?? '').trim().toLowerCase();
  const users: any[] = usersResponse?.users ?? usersResponse?.items ?? [];
  const u = users.find((x) => String(x?.username ?? '').trim().toLowerCase() === want);
  const sims: any[] = u?.simulators ?? [];
  return sims
    .map((s) => ({ id: String(s?.simulatorId ?? s?.id ?? ''), name: s?.simulatorName ?? s?.name }))
    .filter((s) => s.id);
}

/**
 * Pick the simulator to execute on.
 *
 * `owned`, when given, is the list GET /v2/users reported for the login this
 * run executes as: anything outside it is somebody else's simulator and is
 * not a candidate, however good it looks.
 */
export function chooseSimulator(
  all: BoxSimulator[],
  opts: { runAs?: string; owned?: Array<{ id: string; name?: string }> } = {},
): SimulatorPick | SimulatorRefusal {
  const who = opts.runAs ? `"${opts.runAs}"` : 'this login';
  const sims = (all ?? []).filter(Boolean);
  if (sims.length === 0) {
    return { ok: false, reason: `the Simnovator lists no simulator for ${who}` };
  }

  // 1. Ownership, when it is known.
  let pool = sims;
  let ownedNote = '';
  if (opts.owned && opts.owned.length > 0) {
    const ids = new Set(opts.owned.map((o) => o.id));
    pool = sims.filter((s) => ids.has(s.id));
    ownedNote = ` of ${opts.owned.length} assigned to ${who}`;
    if (pool.length === 0) {
      const names = opts.owned.map((o) => o.name ?? o.id).join(', ');
      return {
        ok: false,
        reason: `none of the simulators the box is showing belong to ${who} — `
          + `the Users section assigns it ${names || 'nothing'}`,
      };
    }
  } else if (opts.owned && opts.owned.length === 0) {
    return {
      ok: false,
      reason: `the Simnovator's Users section assigns no simulator to ${who}, so it has nothing to execute on`,
    };
  }

  // 2. Connectivity. A DISCONNECTED simulator is not a worse choice, it is
  //    not a choice: executing on it by hand fails with a connectivity error,
  //    and executing on it through the API has produced a PASS that meant
  //    nothing at all.
  const connected = pool.filter(isConnected);
  if (connected.length === 0) {
    const list = pool.map((s) => `${s.name ?? s.id} (${up(s.connectivity) || 'unknown'})`).join(', ');
    return {
      ok: false,
      reason: `no connected simulator for ${who} — ${list}. `
        + 'Executing on a disconnected simulator fails in the Simnovator GUI too.',
    };
  }

  // 3. Free before busy, then the most radio cards: a 3-cell test case needs
  //    one simulator that owns three.
  const best = [...connected].sort((a, b) =>
    Number(isFree(b)) - Number(isFree(a)) || b.cards.length - a.cards.length)[0];

  const skipped = pool.length - connected.length;
  const note = `simulator: ${best.name ?? best.id} (id ${best.id}, ${up(best.connectivity) || 'CONNECTED'}`
    + `${best.cards.length ? `, ${best.cards.length} RF card${best.cards.length === 1 ? '' : 's'}` : ''})`
    + `${skipped > 0 ? ` — ${skipped} disconnected simulator${skipped === 1 ? '' : 's'} skipped` : ''}`
    + `${connected.length > 1 ? ` — chosen from ${connected.length} connected${ownedNote}` : ''}`;

  return { ok: true, sim: best, note };
}

/**
 * Did the execution actually run on the simulator we asked for?
 *
 * The box takes `simulatorId` on the trigger, and a run that lands somewhere
 * else is reporting about a machine nobody chose — worth saying rather than
 * reading its verdict as if it were ours.
 */
export function ranOnOurSimulator(lastExecution: any, simulatorId?: string): {
  ours: boolean; note?: string;
} {
  const got = lastExecution?.simulatorId;
  if (!simulatorId || got === undefined || got === null) return { ours: true };
  const same = String(got) === String(simulatorId);
  return same
    ? { ours: true }
    : {
        ours: false,
        note: `the box ran this on ${lastExecution?.simulatorName ?? `simulator ${got}`} `
          + `(id ${got}), not the simulator SimQA asked for (id ${simulatorId})`,
      };
}

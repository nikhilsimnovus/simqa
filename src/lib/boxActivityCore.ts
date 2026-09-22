// Who ran what on a multi-user Simnovator.
//
// The box never records a username against an execution. What it records is
// the SIMULATOR the execution ran on (lastExecution.simulatorId, and the same
// id as a string in executionHistory[].simulatorName). Every operator owns one
// simulator — on 192.168.1.95: simuser → 43, sruthi → 44, mohan → 45 — and an
// operator can only execute on their own, so the simulator IS the user.
//
// Each login also sees only its own slice: an operator's token lists its own
// simulator and its own testcases. So the full picture comes from asking the
// box once per registered login and stitching the answers together — which is
// what this does, with no admin credentials required.
//
// The simulator alone is not enough, though. Ownership is CURRENT state and
// the history is not: on .95 the simulators were recreated (40/41/42 became
// 43/44/45) and sruthi was later left with none, so her run on 44 and mohan's
// on the since-deleted 42 had no owner at all. The second signal is the
// testcase: an operator can only see — and therefore only run — their own. So
// a testcase exactly one operator can see is theirs, and that settles every
// run the simulator cannot.
//
// Pure, and imports only simulatorScope (itself dependency-free), so node
// --test can load it directly.

import { pickUserSimulator, isBusy, type SimulatorLike } from './simulatorScope.ts';

/** What one login saw when it asked the box. */
export interface LoginView {
  username: string;
  simulators: SimulatorLike[];
  testcases: Array<{ id: string; name?: string; metadata?: any }>;
  /** Set when this login could not be read — the rest still render. */
  error?: string;
}

export interface BoxExecution {
  executionId: string;
  testcaseId: string;
  testcaseName: string;
  simulatorId?: string;
  simulatorName?: string;
  /** Who ran it. Undefined when neither signal settles it — shown as
   *  "unknown", never guessed. */
  user?: string;
  /** Which signal named the user: the simulator's current owner, or the one
   *  operator whose catalogue holds the testcase. */
  attributedBy?: 'simulator' | 'testcase';
  /** 'in progress' | 'passed' | 'failed' | 'incomplete' | 'aborted' | … */
  status: string;
  startedAt: string;
  durationSec?: number;
}

export interface BoxUserState {
  username: string;
  simulator?: { id: string; name?: string; availability?: string };
  /** What this user's simulator is executing right now. */
  running?: BoxExecution;
  /** Their most recent finished execution. */
  last?: BoxExecution;
  error?: string;
  /** An admin login: sees every simulator and owns none of them. */
  admin?: boolean;
  /** Named by the box's own assignment list rather than a login registered in
   *  SimQA — shown so the box's users are visible even when only an admin
   *  login is configured. */
  discovered?: boolean;
}

/** A start this recent is trusted as running even before the simulator has
 *  flipped to BUSY — the box takes ~26s to register a start. */
const FRESH_START_MS = 120_000;

/**
 * simulator id → the operator who owns it.
 *
 * Single-simulator views claim first: that is an operator, and the box itself
 * scoped the list to them. A view seeing several simulators is an admin, and
 * only fills gaps — admin is assigned to every simulator, so letting it claim
 * first would label every operator's run as admin's. An admin view also
 * carries assignedUsers, which names the operators of simulators whose owner
 * never registered a login in SimQA.
 */
export function simulatorOwners(views: LoginView[]): Record<string, string> {
  const owners: Record<string, string> = {};
  const multi: LoginView[] = [];

  for (const v of views) {
    if (v.error) continue;
    const sims = (v.simulators ?? []).filter((s) => s && s.id != null);
    if (sims.length === 1) owners[String(sims[0].id)] ??= v.username;
    else if (sims.length > 1) multi.push(v);
  }

  for (const v of multi) {
    // Operators named by the box's own assignment list, admin excluded where
    // someone else is also the default — admin is on every simulator.
    for (const s of v.simulators) {
      const id = String(s.id);
      if (owners[id]) continue;
      const defaults = (s.nodes?.assignedUsers ?? []).filter((a) => a.isDefault && a.username);
      const operator = defaults.find((a) => a.username !== v.username) ?? defaults[0];
      if (operator?.username) owners[id] = operator.username;
    }
    // The admin's own default simulator, if still unclaimed.
    const mine = pickUserSimulator(v.simulators, v.username);
    if (mine && !owners[mine.id]) owners[mine.id] = v.username;
  }
  return owners;
}

function verdictOf(result: unknown, status: unknown): string {
  const st = String(status ?? '').toUpperCase().replace(/[\s-]+/g, '_');
  if (st === 'IN_PROGRESS' || st === 'RUNNING') return 'in progress';
  const r = String(result ?? '').toLowerCase();
  if (r === 'pass') return 'passed';
  if (r === 'fail') return 'failed';
  if (r && r !== 'not_executed') return r;
  const s = st.toLowerCase();
  return s || 'unknown';
}

function isoFromUnix(sec: unknown): string | undefined {
  const n = Number(sec);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : undefined;
}

/** Every execution the views can see, one record per execution id. */
function collect(views: LoginView[], historyPerTestcase: number): BoxExecution[] {
  const byId = new Map<string, BoxExecution>();
  const put = (e: BoxExecution, authoritative: boolean) => {
    if (!e.executionId) return;
    // lastExecution is the richer record (it carries the result as the box
    // settled it); a history row only fills in executions it doesn't cover.
    if (authoritative || !byId.has(e.executionId)) byId.set(e.executionId, e);
  };

  for (const v of views) {
    if (v.error) continue;
    for (const t of v.testcases ?? []) {
      const name = t.name ?? String(t.id);
      const last = t.metadata?.lastExecution;
      if (last?.executionId && last.executedOn) {
        const dur = Number(last.durationSeconds);
        put({
          executionId: String(last.executionId),
          testcaseId: String(t.id),
          testcaseName: name,
          simulatorId: last.simulatorId != null ? String(last.simulatorId) : undefined,
          simulatorName: last.simulatorName,
          status: verdictOf(last.result, last.status),
          startedAt: new Date(last.executedOn).toISOString(),
          durationSec: Number.isFinite(dur) && dur > 0 ? dur : undefined,
        }, true);
      }
      for (const h of (t.metadata?.executionHistory ?? []).slice(0, historyPerTestcase)) {
        const startedAt = isoFromUnix(h?.startTimeUnix);
        if (!h?.iterationId || !startedAt) continue;
        const end = Number(h.endTimeUnix);
        const start = Number(h.startTimeUnix);
        put({
          executionId: String(h.iterationId),
          testcaseId: String(t.id),
          testcaseName: name,
          // History stores the simulator's ID in a field called simulatorName.
          simulatorId: h.simulatorName != null && h.simulatorName !== '' ? String(h.simulatorName) : undefined,
          status: verdictOf(h.execution_result, h.status),
          startedAt,
          durationSec: end > start ? end - start : undefined,
        }, false);
      }
    }
  }
  return [...byId.values()];
}

/**
 * The attributed picture of one box: every execution labelled with its user,
 * and a per-login summary of what each person is doing right now.
 */
export function attributeBoxActivity(
  views: LoginView[],
  opts: { historyPerTestcase?: number; now?: number } = {},
): { executions: BoxExecution[]; users: BoxUserState[]; owners: Record<string, string> } {
  const now = opts.now ?? Date.now();
  const owners = simulatorOwners(views);

  // Simulator id → its live record, from whichever view could see it.
  const sims = new Map<string, SimulatorLike>();
  for (const v of views) for (const s of v.simulators ?? []) if (s?.id != null) sims.set(String(s.id), s);

  // testcase id → the operators who can see it. Operator views only (one
  // simulator or none — sruthi currently has none but still sees her own
  // testcases); an admin sees everything, which says nothing about ownership.
  const visibleTo = new Map<string, Set<string>>();
  for (const v of views) {
    if (v.error || (v.simulators ?? []).length > 1) continue;
    for (const t of v.testcases ?? []) {
      const k = String(t.id);
      if (!visibleTo.has(k)) visibleTo.set(k, new Set());
      visibleTo.get(k)!.add(v.username);
    }
  }

  const whoRan = (e: BoxExecution): Pick<BoxExecution, 'user' | 'attributedBy'> => {
    const simOwner = e.simulatorId ? owners[e.simulatorId] : undefined;
    const tcOwners = visibleTo.get(e.testcaseId);
    // Both signals agree, or the testcase tells us nothing.
    if (simOwner && (!tcOwners?.size || tcOwners.has(simOwner))) return { user: simOwner, attributedBy: 'simulator' };
    // The simulator's owner cannot see this testcase, so cannot have run it —
    // or the simulator has no owner now. One operator can see it: theirs.
    if (tcOwners?.size === 1) return { user: [...tcOwners][0], attributedBy: 'testcase' };
    return { user: undefined, attributedBy: undefined };
  };

  const executions = collect(views, opts.historyPerTestcase ?? 10)
    .map((e) => {
      const sim = e.simulatorId ? sims.get(e.simulatorId) : undefined;
      let status = e.status;
      // The box leaves IN_PROGRESS behind when a run dies uncleanly. Trust it
      // only while the simulator is actually busy, or the start is too fresh
      // for the simulator to have caught up.
      if (status === 'in progress' && sim && !isBusy(sim) && now - Date.parse(e.startedAt) > FRESH_START_MS) {
        status = 'stale';
      }
      return {
        ...e,
        // A simulator id the box no longer lists was deleted or recreated —
        // name it by id rather than dropping where the run happened.
        simulatorName: e.simulatorName ?? sim?.name ?? (e.simulatorId ? `simulator ${e.simulatorId}` : undefined),
        ...whoRan(e),
        status,
      };
    })
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));

  const summary = (username: string, extra: Partial<BoxUserState> = {}): BoxUserState => {
    const own = Object.entries(owners).find(([, u]) => u === username)?.[0];
    const sim = own ? sims.get(own) : undefined;
    // By attribution, not by simulator: a user left without a simulator (or
    // moved to a new one) still has the runs they made.
    const mine = executions.filter((e) => e.user === username);
    return {
      username,
      simulator: sim ? { id: String(sim.id), name: sim.name, availability: sim.availability } : undefined,
      running: mine.find((e) => e.status === 'in progress'),
      last: mine.find((e) => e.status !== 'in progress'),
      ...extra,
    };
  };

  const users: BoxUserState[] = views.map((v) => {
    if (v.error) return { username: v.username, error: v.error };
    // An admin sees every simulator; pinning one on it would show the same
    // simulator under two names (43 is both admin's and simuser's default).
    if ((v.simulators ?? []).length > 1) return { ...summary(v.username), simulator: undefined, admin: true };
    return summary(v.username);
  });

  // The box's other users, named by an admin view's assignment list. Without
  // this, a setup registered with only its admin login shows one "admin" tile
  // and none of the people actually executing.
  const known = new Set(users.map((u) => u.username));
  for (const name of new Set(Object.values(owners))) {
    if (!known.has(name)) users.push(summary(name, { discovered: true }));
  }

  return { executions, users, owners };
}

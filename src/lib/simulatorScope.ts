// Which simulator a box login owns.
//
// Observed on 192.168.1.95 (4.x, multi-user): a Simnovator hosts several UE
// simulators, and every operator is assigned one — simuser → UE-Simulator (40),
// sruthi → UE-Simulator1 (41), mohan → UE-Simulator2 (42). Each has its own
// container, RF cards and port, which is why three people execute different
// testcases at the same time on one box.
//
// The box scopes its own answers by token: GET /v2/simulators returns ONLY the
// caller's simulator for an operator, and all of them for an admin. So the
// resolution rule differs by who is asking:
//
//   • one entry  → that is the caller's, whoever they are
//   • several    → an admin token; match nodes.assignedUsers by username and
//                  prefer the one flagged isDefault
//   • no match   → null, and the caller decides what to do rather than
//                  guessing at somebody else's simulator
//
// That last rung is the one that matters. SimQA used to answer "is this box
// busy?" by scanning every simulator, which is correct for an operator token
// (the list holds only theirs) but wrong for an admin one: user B was refused
// a start because user A was running, on hardware that was never shared.
//
// Pure, and imports nothing, so node --test can load it directly.

export interface AssignedUser {
  username?: string;
  userId?: string;
  isDefault?: boolean;
}

export interface SimulatorLike {
  id: string | number;
  name?: string;
  availability?: string;
  nodes?: { assignedUsers?: AssignedUser[] };
}

export interface ScopedSimulator {
  id: string;
  name?: string;
  availability?: string;
  /** How it was chosen — carried into messages so "busy" can say whose. */
  via: 'only' | 'assigned-default' | 'assigned';
}

/** True when this simulator reports itself busy with an execution. */
export function isBusy(sim: { availability?: string } | null | undefined): boolean {
  return String(sim?.availability ?? '').toUpperCase() === 'BUSY';
}

/**
 * The simulator `username` executes on, or null when it cannot be told apart.
 *
 * Returning null is deliberate: with an admin token and no assignment match,
 * any pick would be a coin toss between other people's hardware.
 */
export function pickUserSimulator(
  items: SimulatorLike[] | null | undefined,
  username?: string,
): ScopedSimulator | null {
  const sims = (items ?? []).filter((s) => s && s.id != null);
  if (sims.length === 0) return null;

  const shape = (s: SimulatorLike, via: ScopedSimulator['via']): ScopedSimulator => ({
    id: String(s.id),
    name: s.name,
    availability: s.availability,
    via,
  });

  // An operator token only ever sees their own.
  if (sims.length === 1) return shape(sims[0], 'only');

  const name = (username ?? '').trim().toLowerCase();
  if (!name) return null;

  const assignedTo = sims.filter((s) =>
    (s.nodes?.assignedUsers ?? []).some((a) => (a.username ?? '').trim().toLowerCase() === name),
  );
  if (assignedTo.length === 0) return null;

  // admin is assigned to every simulator — only the isDefault flag separates
  // "this is mine" from "I can see yours".
  const preferred = assignedTo.find((s) =>
    (s.nodes?.assignedUsers ?? []).some(
      (a) => (a.username ?? '').trim().toLowerCase() === name && a.isDefault,
    ),
  );
  if (preferred) return shape(preferred, 'assigned-default');
  return assignedTo.length === 1 ? shape(assignedTo[0], 'assigned') : null;
}

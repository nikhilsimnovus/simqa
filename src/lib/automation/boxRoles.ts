// What a Simnovator login IS, and what the box it sits on is.
//
// Two facts the product has always had and SimQA has been guessing at:
//
//   * admin is not an operator. It is the box's administrator — it creates
//     users and simulators and sees everybody's — and it does not execute
//     test cases. Only a user login does. SimQA used to infer "this is an
//     admin" from "it can see more than one simulator", which is a symptom,
//     not the fact: GET /v2/users states the roles outright.
//
//   * a Simnovator is installed in ONE mode, regular or container, and
//     /v2/hosts reports it per node as machine.installMode. The box refuses a
//     simulator whose mode is not the box's own, and a simulator left over
//     from the other install still appears in the list — which is exactly
//     what 192.168.1.102 is showing: installMode "regular", and a
//     "Simulator_test" holding both RF cards while reporting DISCONNECTED.
//
// Measured on 192.168.1.102, 2026-10-23 (4.1.0, Build 2026-10-16-6117).
//
// Pure, imports nothing, so node --test loads it directly.

export interface BoxUserRecord {
  username: string;
  roles: string[];
  /** Simulators the box assigns to this login. */
  simulators: Array<{ id: string; name?: string }>;
  isAdmin: boolean;
  /** False for an administrator: the box does not execute test cases as one. */
  canExecute: boolean;
}

export type InstallMode = 'regular' | 'container';

export interface BoxNode {
  host: string;
  role?: string;
  mode?: InstallMode;
  agentConnected?: boolean;
  os?: string;
  agentVersion?: string;
}

export interface BoxHost {
  id: string;
  name: string;
  /** How RF is handed out on this host: a whole board, or one device. */
  rfAllocation?: string;
  nodes: BoxNode[];
  cards: Array<{ device: number; board?: string; role?: string; holder?: string; busy?: boolean }>;
}

const lower = (s: unknown) => String(s ?? '').trim().toLowerCase();

/** Roles as the box spells them, for one user record. */
export function rolesOf(raw: any): string[] {
  const r = raw?.roles ?? raw?.role;
  if (Array.isArray(r)) return r.map((x) => lower(x)).filter(Boolean);
  return lower(r) ? [lower(r)] : [];
}

export function isAdminRecord(raw: any): boolean {
  return rolesOf(raw).includes('admin');
}

/** GET /v2/users, read into something with a stated role. */
export function readBoxUsers(usersResponse: any): BoxUserRecord[] {
  const users: any[] = usersResponse?.users ?? usersResponse?.items ?? [];
  return users.map((u) => {
    const roles = rolesOf(u);
    const isAdmin = roles.includes('admin');
    return {
      username: String(u?.username ?? ''),
      roles,
      simulators: (u?.simulators ?? [])
        .map((s: any) => ({ id: String(s?.simulatorId ?? s?.id ?? ''), name: s?.simulatorName ?? s?.name }))
        .filter((s: any) => s.id),
      isAdmin,
      // The product's rule, not a guess: an administrator manages the box and
      // the box does not let it run a test case.
      canExecute: !isAdmin,
    };
  }).filter((u) => u.username);
}

/** The logins on this box that may actually execute, by name. */
export function executingLogins(users: BoxUserRecord[]): string[] {
  return users.filter((u) => u.canExecute).map((u) => u.username);
}

/** Why a run as this login is refused, and what to run as instead. */
export function adminCannotExecute(username: string, users: BoxUserRecord[] = []): string {
  const others = executingLogins(users).filter((u) => lower(u) !== lower(username));
  return `"${username}" is the Simnovator's administrator, not an execution account: `
    + 'it manages users and simulators, and the box does not execute test cases as admin. '
    + (others.length
      ? `Run this suite as one of its user logins — ${others.join(', ')}.`
      : 'Run this suite as a user login registered on the box.');
}

/**
 * Is this login an administrator?
 *
 * `users` is GET /v2/users when it could be read (admin only). Without it the
 * name is all there is — and "admin" is the name the product ships, so it is
 * treated as one rather than letting a run start that the box will refuse.
 */
export function looksLikeAdmin(username: string, users?: BoxUserRecord[]): boolean {
  const name = lower(username);
  if (users && users.length) {
    const rec = users.find((u) => lower(u.username) === name);
    if (rec) return rec.isAdmin;
  }
  return name === 'admin';
}

/** GET /v2/hosts, read for the mode and the RF cards. */
export function readHosts(hostsResponse: any): BoxHost[] {
  const hosts: any[] = hostsResponse?.hosts ?? hostsResponse?.items ?? [];
  return hosts.map((h) => ({
    id: String(h?.id ?? ''),
    name: String(h?.name ?? ''),
    rfAllocation: h?.rfAllocation ? String(h.rfAllocation) : undefined,
    nodes: (h?.nodes ?? []).map((n: any) => ({
      host: String(n?.ipAddress ?? ''),
      role: n?.role ? String(n.role) : undefined,
      mode: lower(n?.machine?.installMode) === 'container' ? 'container'
        : lower(n?.machine?.installMode) === 'regular' ? 'regular' : undefined,
      agentConnected: typeof n?.agentConnected === 'boolean' ? n.agentConnected : undefined,
      os: n?.machine?.software?.os ? String(n.machine.software.os) : undefined,
      agentVersion: n?.machine?.software?.agent_version ? String(n.machine.software.agent_version) : undefined,
    })),
    cards: (h?.rfCards ?? []).map((c: any) => ({
      device: Number(c?.device),
      board: c?.board ? String(c.board) : undefined,
      role: c?.role ? String(c.role) : undefined,
      holder: c?.holder ? String(c.holder) : undefined,
      busy: typeof c?.holderBusy === 'boolean' ? c.holderBusy : undefined,
    })),
  }));
}

/**
 * Which way this Simnovator is installed.
 *
 * 'mixed' is possible and worth saying: a box whose nodes disagree has one
 * left over from an earlier install, and that is the shape that produces a
 * simulator nothing can execute on.
 */
export function installModeOf(hosts: BoxHost[]): InstallMode | 'mixed' | undefined {
  const modes = new Set(hosts.flatMap((h) => h.nodes.map((n) => n.mode)).filter(Boolean) as InstallMode[]);
  if (modes.size === 0) return undefined;
  if (modes.size > 1) return 'mixed';
  return [...modes][0];
}

/** One line about the install, for the dashboard. */
export function installLine(hosts: BoxHost[]): string {
  const mode = installModeOf(hosts);
  const alloc = hosts.find((h) => h.rfAllocation)?.rfAllocation;
  const cards = hosts.reduce((n, h) => n + h.cards.length, 0);
  const held = hosts.reduce((n, h) => n + h.cards.filter((c) => c.holder).length, 0);
  const bits = [
    mode === 'mixed' ? 'mixed install — a node is left over from the other mode'
      : mode ? `${mode} install` : 'install mode not reported',
    alloc ? `RF handed out per ${alloc}` : '',
    cards ? `${held}/${cards} RF card${cards === 1 ? '' : 's'} held` : 'no RF cards reported',
  ].filter(Boolean);
  return bits.join(' · ');
}

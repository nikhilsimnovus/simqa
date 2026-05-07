// Inventory model. Loads + writes simqa/inventory.yaml describing the
// physical/virtual systems in your lab: callbox, MME, IMS, AppServer, plus
// the UESIM box itself. The runner consumes this to know where to push
// generated cfgs and which testcases to trigger.

import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';

export type SystemType =
  | 'SIMNOVATOR'  // A box running the Simnovator product. Build Check installs onto these.
                  // Functionally a superset of UESIM — a Simnovator box always exposes the
                  // UESIM REST API, so it satisfies any "needs a UESIM" requirement too.
  | 'UESIM'       // A generic UESIM box that is NOT necessarily a Simnovator install.
  | 'CALLBOX'
  | 'ENB' | 'GNB' | 'MME' | 'IMS' | 'APPSERVER';

/** True when the system can play the UESIM role (Simnovator builds always can). */
export function isUesimLike(s: { type: SystemType }): boolean {
  return s.type === 'SIMNOVATOR' || s.type === 'UESIM';
}

/** True only for systems explicitly marked Simnovator — install targets for Build Check. */
export function isSimnovatorTarget(s: { type: SystemType }): boolean {
  return s.type === 'SIMNOVATOR';
}

export type SshAuthMode = 'password' | 'privateKey';

export interface InventorySystem {
  /** Unique slug, e.g. "lab-callbox-1". */
  id: string;
  type: SystemType;
  /** Human-readable name shown in the UI. */
  name: string;
  /** IPv4 / hostname. */
  host: string;
  /** Roles a callbox plays; ignored for non-CALLBOX types. e.g. ["ENB","MME","IMS","APPSERVER"]. */
  roles?: SystemType[];
  /** SSH port. Defaults to 22. */
  sshPort?: number;
  /** SSH username. Required for any system we'll deploy to. */
  username?: string;
  /** Auth mode. Defaults to 'password'. */
  authMode?: SshAuthMode;
  /** SSH password (when authMode is 'password'). Plaintext - local-lab convenience only. */
  password?: string;
  /**
   * SSH private key for authMode === 'privateKey'. Either:
   *   - the key contents (string starting with "-----BEGIN ...PRIVATE KEY-----"), or
   *   - a filesystem path on the simqa host (absolute, or relative to project root).
   * The deploy module decides which based on the leading prefix.
   */
  privateKey?: string;
  /** Optional passphrase for the encrypted private key. */
  passphrase?: string;
  /**
   * Sudo password for `sudo -S` invocations during deploy. When authMode is
   * 'privateKey' we still need this to run privileged commands (mv into
   * /root/..., systemctl restart). Optional - if the SSH user has NOPASSWD
   * sudo, leave blank.
   */
  sudoPassword?: string;
  /** Vendor / stack hint, drives adapter selection. */
  vendor?: 'simnovus' | 'amarisoft' | 'srsran' | 'oai' | 'other';
  /** UESIM REST credentials (only meaningful for type === 'UESIM'). */
  uesim?: {
    username?: string;
    password?: string;
  };
  /**
   * For SIMNOVATOR-typed systems: the Cockpit web admin UI port (default 9090).
   * Cockpit is the way builds get installed onto a Simnovator VM — the user
   * opens https://<host>:<port>/system/terminal in their browser, pastes the
   * generated tar + ./install commands, and watches them run. No SSH from
   * this app required.
   */
  cockpitPort?: number;
  /** Cockpit login user. Defaults to "simnovus" if unset. */
  cockpitUser?: string;
  /** Cockpit login password. Defaults to "admin@123" if unset. Plaintext, local-lab convenience only. */
  cockpitPassword?: string;
  /** Free-form notes the user can scribble on. */
  notes?: string;
}

/** Defaults for Cockpit credentials on a fresh Simnovator system. */
export const COCKPIT_DEFAULTS = {
  user:     'simnovus',
  password: 'admin@123',
  port:     9090,
} as const;

/** Resolve cockpit creds for a system, applying the lab defaults. */
export function cockpitCredsFor(s: InventorySystem): { user: string; password: string; port: number } {
  return {
    user:     s.cockpitUser     ?? COCKPIT_DEFAULTS.user,
    password: s.cockpitPassword ?? COCKPIT_DEFAULTS.password,
    port:     s.cockpitPort     ?? COCKPIT_DEFAULTS.port,
  };
}

export interface TopologyProfile {
  id: string;
  name: string;
  /** System ids referenced from the systems[] list. */
  /**
   * The Simnovator VM that runs the controller / receives the build install.
   * Optional for backward compat with legacy profiles, but new End-to-End
   * setups should always set this.
   */
  simnovator?: string;
  uesim:     string;
  callbox?:  string;
  enb?:      string;
  gnb?:      string;
  mme?:      string;
  ims?:      string;
  appserver?: string;
  notes?: string;
}

/**
 * A saved automation suite: a named bundle of UESIM testcase IDs that you
 * run as a batch against a topology. The "Run" button on /automation kicks
 * off one RunRecord per testcase, all sharing a batchId.
 */
export interface AutomationSuite {
  id: string;
  name: string;
  /** UESIM testcase IDs (the leading slug from /v2/testcases). */
  testcaseIds: string[];
  /** Default topology profile id when running this suite. */
  topologyId?: string;
  /** If true, skip SSH push + execution trigger; just generate. */
  defaultDryRun?: boolean;
  /** If true, on first failure skip remaining testcases. */
  stopOnFail?: boolean;
  notes?: string;
}

export interface Inventory {
  systems: InventorySystem[];
  profiles: TopologyProfile[];
  suites?: AutomationSuite[];
}

const DEFAULT_INVENTORY: Inventory = {
  systems: [
    {
      id: 'lab-uesim',
      type: 'UESIM',
      name: 'Lab UESIM',
      host: '192.168.1.95',
      vendor: 'simnovus',
      uesim: { username: 'admin', password: 'admin' },
      notes: 'Default UESIM box reachable from this workstation.',
    },
  ],
  profiles: [],
};

export function inventoryPath(): string {
  // Project-root inventory.yaml (one level above src/lib/).
  return path.join(process.cwd(), 'inventory.yaml');
}

export function loadInventory(): Inventory {
  const p = inventoryPath();
  if (!fs.existsSync(p)) {
    saveInventory(DEFAULT_INVENTORY);
    return structuredClone(DEFAULT_INVENTORY);
  }
  const raw = fs.readFileSync(p, 'utf8');
  const parsed = YAML.parse(raw) as Partial<Inventory>;
  return {
    systems:  Array.isArray(parsed?.systems)  ? parsed.systems  : [],
    profiles: Array.isArray(parsed?.profiles) ? parsed.profiles : [],
    suites:   Array.isArray(parsed?.suites)   ? parsed.suites   : [],
  };
}

export function getSuite(inv: Inventory, id: string): AutomationSuite | undefined {
  return (inv.suites ?? []).find((s) => s.id === id);
}

export function saveInventory(inv: Inventory): void {
  const out = YAML.stringify(inv, { lineWidth: 120 });
  fs.writeFileSync(inventoryPath(), out, 'utf8');
}

export function getSystem(inv: Inventory, id: string): InventorySystem | undefined {
  return inv.systems.find((s) => s.id === id);
}

export function getProfile(inv: Inventory, id: string): TopologyProfile | undefined {
  return inv.profiles.find((p) => p.id === id);
}

/** Return the UESIM API options derived from the inventory's first UESIM-capable system (Simnovator or generic UESIM). */
export function uesimApiOptsFromInventory(inv: Inventory): { host: string; username: string; password: string } | undefined {
  const u = inv.systems.find(isUesimLike);
  if (!u) return undefined;
  return {
    host:     u.host,
    username: u.uesim?.username ?? 'admin',
    password: u.uesim?.password ?? 'admin',
  };
}

/**
 * Return UESIM API options for a specific system id, falling back to the first
 * UESIM if id is unset. Multi-user simqa picks the system per request so two
 * teammates can test different boxes in parallel.
 */
export function uesimApiOptsForSystem(inv: Inventory, systemId?: string): { systemId: string; host: string; name: string; username: string; password: string } | undefined {
  const target = systemId
    ? inv.systems.find((s) => s.id === systemId && (isUesimLike(s) || s.type === 'CALLBOX'))
    : inv.systems.find(isUesimLike);
  if (!target) return undefined;
  return {
    systemId: target.id,
    name: target.name,
    host: target.host,
    username: target.uesim?.username ?? target.username ?? 'admin',
    password: target.uesim?.password ?? target.password ?? 'admin',
  };
}

/** Lightweight summary of testable systems, for the UI's target picker. */
export function listTestableSystems(inv: Inventory): Array<{ id: string; name: string; host: string; type: SystemType }> {
  return inv.systems
    .filter((s) => isUesimLike(s) || s.type === 'CALLBOX')
    .map((s) => ({ id: s.id, name: s.name, host: s.host, type: s.type }));
}

/** Inventory systems that can be the install target for a Simnovator build (Build Check). */
export function listSimnovatorTargets(inv: Inventory): InventorySystem[] {
  return inv.systems.filter(isSimnovatorTarget);
}

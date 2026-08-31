// Inventory model. Loads + writes simqa/inventory.yaml describing the
// physical/virtual systems in your lab: callbox, MME, IMS, AppServer, plus
// the UESIM box itself. The runner consumes this to know where to push
// generated cfgs and which testcases to trigger.

// node: prefixed so bundlers can tell these are builtins rather than trying to
// resolve packages named "fs"/"path" — this module is reached from
// instrumentation.ts, which Next also compiles for the Edge runtime.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as YAML from 'yaml';

export type SystemType =
  | 'SIMNOVATOR'  // Build Check installs onto these — shown in the UI as "Cockpit".
                  // Functionally a superset of UESIM — a Simnovator box always exposes the
                  // UESIM REST API, so it satisfies any "needs a UESIM" requirement too.
  | 'SIMNOVATOR_GUI' // A box running the Simnovator product GUI + REST API. Shown
                     // as "Simnovator". Serves testcases, but is NOT a Build
                     // Check install target — that's SIMNOVATOR ("Cockpit").
  | 'UESIM'       // A generic UESIM box that is NOT necessarily a Simnovator install.
  | 'UE'          // The UE-sim host. Serves no REST API — it's an SSH target we
                  // read ue.cfg from, so it stays out of the testable pickers.
  | 'CALLBOX'
  | 'ENB' | 'GNB' | 'MME' | 'IMS' | 'APPSERVER';

/** True when the system can play the UESIM role (Simnovator builds always can). */
export function isUesimLike(s: { type: SystemType }): boolean {
  return s.type === 'SIMNOVATOR' || s.type === 'SIMNOVATOR_GUI' || s.type === 'UESIM';
}

/** True only for systems marked SIMNOVATOR — shown as "Cockpit" in the UI, and
 *  the install targets for Build Check. SIMNOVATOR_GUI ("Simnovator") serves
 *  testcases but is not something we install onto. */
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
  /**
   * Live config files to read back from this host, by module name
   * ('gnb' | 'enb' | 'mme' | 'ims' | 'ue' | 'ue_db'). Paths come from the
   * deploy module map unless overridden in `collectPaths`.
   *
   * Lab configs are split across machines — the callbox runs enb/gnb/mme,
   * while the UE-sim writes ue.cfg on its own host. Declaring `collect` on
   * each system lets the testcase view show the ACTUAL files next to the
   * ones simqa generated. Requires SSH credentials on that system.
   */
  collect?: string[];
  /** Per-module path overrides, e.g. { ue: '/opt/ue/ue.cfg' }. */
  collectPaths?: Record<string, string>;
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
  // Was required pre-2026-05-12; now optional because customer-style
  // integrated Simnovator installs have no separate UESIM box — the
  // simnovator IS the UESIM. Keep the field for the distributed-lab
  // users who do have one.
  uesim?:    string;
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
/** One concrete test row inside an Automation Suite — a Simnovator
 *  testcase paired with an optional callbox eNB cfg. The cfg gets
 *  symlinked + the eNB restarted IMMEDIATELY before the Simnovator
 *  testcase fires, so each row carries its own radio context. */
export interface SuiteItem {
  /** Stable id within the suite (so the UI can key the row). */
  id: string;
  /** Display name — defaults to the Simnovator testcase name when the
   *  row is first added, renameable. */
  name: string;
  /** Simnovator REST testcase id (the UUID from /v2/testcases). */
  simnovatorTcId: string;
  /** Which suite this row belongs to, captured from the wizard's suite-name
   *  field when the row was added. Rows added under different names are saved
   *  as separate suites, so one wizard session can build several. */
  suiteName?: string;
  /** Filename under /root/enb/config on the callbox (only for
   *  uesim+callbox suites). May refer to an existing file or to a
   *  blob in `uploadedConfigs`. Absent for uesim-only suites. */
  callboxCfg?: string;
  /** Filenames under /root/mme/config. A test needs the core up as well as
   *  the radio, so the mme + ims cfgs are bound per row alongside the gnb one. */
  mmeCfg?: string;
  imsCfg?: string;
  /** Max seconds to wait for the Simnovator testcase to reach a
   *  terminal state. Falls back to the suite's defaultDurationSec
   *  (or 10) when absent. */
  durationSec?: number;
}

export interface AutomationSuite {
  id: string;
  name: string;
  /** Who created this suite / playlist, and who last changed it. Attribution
   *  only — see src/lib/identity.ts. Absent on suites saved before sign-in
   *  existed, and on anything created outside a browser session. */
  createdBy?: string;
  updatedBy?: string;
  /** Ordered list of test rows. Each row pairs a Simnovator testcase
   *  with (optionally) a callbox eNB cfg. New in 2026-06 — supersedes
   *  the flat `testcaseIds` + `callboxConfig` pair, which the runner
   *  still falls back to when this is absent. */
  items?: SuiteItem[];
  /** LEGACY: flat list of Simnovator testcase ids. Used when `items`
   *  is absent. New suites should write `items` instead. */
  testcaseIds: string[];
  /** Single filename under /root/enb/config on the callbox (only when
   *  kind == 'uesim+callbox'). May be a file that already lives on the
   *  callbox (picked from `ls`) or one in `uploadedConfigs`. The runner:
   *    1. scp's the upload (if it's a fresh blob)
   *    2. `ln -sf /root/enb/config/<name> /root/enb/config/enb.cfg`
   *    3. `service lte restart` (falls back to systemctl)
   *    4. waits ~15s for the eNB to stabilise
   *  before triggering any Simnovator testcase. Each suite is scoped to
   *  ONE radio config — multi-config campaigns belong in separate suites. */
  callboxConfig?: string;
  /** Max seconds the runner waits for each Simnovator testcase to reach
   *  a terminal state (Completed/Failed/Aborted/Stopped/Passed) before
   *  declaring "inconclusive" and moving on. Default 10 if unset. */
  defaultDurationSec?: number;
  /** Per-testcase duration overrides (seconds). Falls back to
   *  defaultDurationSec when an entry is absent. */
  testcaseDurations?: Record<string, number>;
  /** When true, after each item's testcase completes the runner removes
   *  the deployed cfg from /root/enb/config (keeping the callbox tidy).
   *  Default true. Set false for debugging — leaves the cfg in place so
   *  an operator can inspect / re-run by hand. */
  removeConfigAfterRun?: boolean;
  /** Default topology profile id when running this suite. */
  topologyId?: string;
  /** If true, skip SSH push + execution trigger; just generate. */
  defaultDryRun?: boolean;
  /** If true, on first failure skip remaining testcases. */
  stopOnFail?: boolean;
  notes?: string;
  // ── Setup kind + system targets (new in 2026-06) ──────────────────────
  /** Setup shape:
   *    'uesim-only'    = testcases come from the Simnovator REST catalog
   *                      on `uesimSystemId`. Run = trigger each via
   *                      POST /v2/testcases/{id}/executions.
   *    'uesim+callbox' = testcases come from /root/enb/config on
   *                      `callboxSystemId` (or `uploadedConfigs` for ones
   *                      the user uploaded fresh). Run = for each .cfg
   *                      push it to /root/enb/config on the callbox
   *                      (uploaded ones only; picked ones are already
   *                      there), then report. eNB restart is left to the
   *                      operator. */
  kind?: 'uesim-only' | 'uesim+callbox';
  /** Inventory id of the UESIM / Simnovator that owns the testcases. */
  uesimSystemId?: string;
  /** Inventory id of the callbox (only when kind == 'uesim+callbox'). */
  callboxSystemId?: string;
  /** Filename → base64 content for any /root/enb/config files the user
   *  uploaded as part of this suite (kind == 'uesim+callbox' only).
   *  These files don't exist on the callbox yet — on run, the runner
   *  scp's them in before any tests fire. */
  uploadedConfigs?: Record<string, string>;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Lab-wide SSH credentials.
 *
 * In practice one key opens every box in a lab, so re-pasting it into each
 * system is busywork and drifts. These are the defaults; any system may still
 * override any single field (see withSshDefaults - the merge is per-field,
 * not all-or-nothing, so a box with a different username still inherits the
 * shared key).
 */
export interface SshDefaults {
  username?: string;
  sshPort?: number;
  authMode?: SshAuthMode;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  sudoPassword?: string;
}

/** SSH fields a system can inherit from, or override, the lab defaults. */
export const SSH_FIELDS = [
  'username', 'sshPort', 'authMode', 'password', 'privateKey', 'passphrase', 'sudoPassword',
] as const;
export type SshField = (typeof SSH_FIELDS)[number];

export interface Inventory {
  systems: InventorySystem[];
  profiles: TopologyProfile[];
  suites?: AutomationSuite[];
  /** Lab-wide fallbacks. Absent on older inventories, which keeps this
   *  backward compatible: no defaults means the previous per-system behaviour. */
  defaults?: { ssh?: SshDefaults };
}

function isSet(v: unknown): boolean {
  return v !== undefined && v !== null && v !== '';
}

/** authMode as implied by what is actually set — deploy defaults an unset
 *  authMode to 'password', so a bare `password:` entry has always meant
 *  password auth, and a bare `privateKey:` can only mean key auth. */
function impliedAuthMode(v: { authMode?: SshAuthMode; password?: string; privateKey?: string }): SshAuthMode | undefined {
  if (isSet(v.authMode)) return v.authMode;
  if (isSet(v.password)) return 'password';    // matches deploy's default when both are set
  if (isSet(v.privateKey)) return 'privateKey';
  return undefined;
}

/**
 * Merge lab SSH defaults UNDER a system's own values, field by field —
 * but auth-mode aware. Two failure modes this guards against:
 *
 *   1. A box that carries only `password:` (authMode implied) must NOT be
 *      flipped to key auth by a lab default of authMode=privateKey, and
 *      must not inherit the lab key at all — deploy would silently switch
 *      identities on it.
 *   2. The Credentials tab shows "Private key" as the default mode without
 *      writing authMode until the select is touched, so a defaults block of
 *      just {username, privateKey} must still resolve to key auth instead
 *      of failing with "no password set".
 */
export function withSshDefaults(s: InventorySystem, d?: SshDefaults): InventorySystem {
  if (!d) return s;
  const out: any = { ...s };
  const mode = impliedAuthMode(s) ?? impliedAuthMode(d) ?? 'password';
  for (const k of SSH_FIELDS) {
    // Secrets belong to exactly one auth mode; only inherit the matching one.
    if (k === 'password' && mode !== 'password') continue;
    if ((k === 'privateKey' || k === 'passphrase') && mode !== 'privateKey') continue;
    if (!isSet(out[k]) && isSet((d as any)[k])) out[k] = (d as any)[k];
  }
  // Pin the resolved mode so consumers (deploy defaults to 'password') can't
  // re-derive a different answer from the merged fields.
  out.authMode = mode;
  return out as InventorySystem;
}

/** Which SSH fields this system sets for itself (i.e. overrides the default). */
export function ownSshFields(s: InventorySystem): SshField[] {
  return SSH_FIELDS.filter((k) => isSet((s as any)[k]));
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

/**
 * The inventory exactly as written on disk - systems keep only the fields
 * they actually set. Use this when you need to know what is an override
 * versus what is inherited: the /api/inventory editor, and saving.
 */
export function loadInventoryRaw(): Inventory {
  const p = inventoryPath();
  if (!fs.existsSync(p)) {
    saveInventory(DEFAULT_INVENTORY);
    return structuredClone(DEFAULT_INVENTORY);
  }
  const raw = fs.readFileSync(p, 'utf8');
  const parsed = YAML.parse(raw) as Partial<Inventory>;
  return {
    // Spread first: unknown top-level keys must survive a GET → edit → PUT
    // round-trip through the /inventory editor, which saves this whole
    // object back. Dropping them here would silently delete hand-written
    // sections from inventory.yaml on the next Save.
    ...(parsed && typeof parsed === 'object' ? parsed : {}),
    systems:  Array.isArray(parsed?.systems)  ? parsed.systems  : [],
    profiles: Array.isArray(parsed?.profiles) ? parsed.profiles : [],
    suites:   Array.isArray(parsed?.suites)   ? parsed.suites   : [],
    defaults: (parsed?.defaults && typeof parsed.defaults === 'object') ? parsed.defaults : undefined,
  };
}

/**
 * The inventory as callers should USE it: every system already has the
 * lab-wide SSH defaults merged in underneath its own values.
 *
 * Resolving here rather than at each SSH call site means every consumer -
 * deploy, config-fidelity, gNB backup, the API routes - inherits the shared
 * key automatically, and none of them can forget to.
 */
export function loadInventory(): Inventory {
  const inv = loadInventoryRaw();
  const ssh = inv.defaults?.ssh;
  if (!ssh) return inv;
  return { ...inv, systems: inv.systems.map((s) => withSshDefaults(s, ssh)) };
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

/** System ids must be unique. inventory.yaml is hand-edited, so it's easy to
 *  reuse an id (e.g. two systems both "sys-6"). getSystem() then returns only
 *  the FIRST match — the rest are silently shadowed, which surfaces downstream
 *  as confusing errors like "callboxSystemId X is not a CALLBOX". Detect the
 *  collision up front so the UI can flag it loudly. */
export function duplicateSystemIds(inv: Inventory): Array<{ id: string; count: number; entries: Array<{ type: SystemType; name: string; host: string }> }> {
  const byId = new Map<string, Array<{ type: SystemType; name: string; host: string }>>();
  for (const s of inv.systems) {
    const arr = byId.get(s.id) ?? [];
    arr.push({ type: s.type, name: s.name, host: s.host });
    byId.set(s.id, arr);
  }
  const out: Array<{ id: string; count: number; entries: Array<{ type: SystemType; name: string; host: string }> }> = [];
  for (const [id, entries] of byId) {
    if (entries.length > 1) out.push({ id, count: entries.length, entries });
  }
  return out;
}

/** Inventory systems that can be the install target for a Simnovator build (Build Check). */
export function listSimnovatorTargets(inv: Inventory): InventorySystem[] {
  return inv.systems.filter(isSimnovatorTarget);
}

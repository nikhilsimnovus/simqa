// Which UE and App server belong to which Simnovator.
//
// The install line the Simnovator installer needs looks like
//
//     ./install --ue 'sysadmin@192.168.1.101' --app 'sysadmin@192.168.1.100'
//
// and those two IPs are DIFFERENT for every setup. Hard-coding the 1.102 values
// would silently install the wrong topology the first time anyone picked
// another station, so this module derives them from the topology profiles that
// already live in inventory.yaml — the same `simnovator` / `uesim` /
// `appserver` bindings the dashboard uses to draw Resource Status.
//
// That means adding a new setup is an inventory edit in Systems Management, not
// a code change: create the systems, bind them in a topology profile, and the
// setup appears in the Job Tracker dropdown with the right install command.

import {
  loadInventory, type Inventory, type InventorySystem, type TopologyProfile,
} from '../inventory';

/** SSH user the Simnovator installer expects on the UE and app hosts. Override
 *  per system by setting `username` on that system in inventory. */
const DEFAULT_INSTALL_USER = 'sysadmin';

export interface SetupHost {
  role: 'ue' | 'app';
  systemId: string;
  name: string;
  host: string;
  user: string;
}

export interface JobSetup {
  /** Simnovator system id. */
  systemId: string;
  name: string;
  /** Simnovator IP — what the user picks in the dropdown, e.g. "192.168.1.102". */
  host: string;
  /** Topology profile this mapping came from, for the "why these IPs" question. */
  profileId?: string;
  profileName?: string;
  ue?: SetupHost;
  app?: SetupHost;
  /** True when both --ue and --app can be resolved. The installer rejects the
   *  command without them, so we surface it before the user starts. */
  installable: boolean;
  /** Why it is not installable, when it isn't. */
  problem?: string;
  /** Cockpit endpoint the installer will drive. */
  cockpitUrl: string;
}

function hostFor(inv: Inventory, id?: string): InventorySystem | undefined {
  return id ? inv.systems.find((s) => s.id === id) : undefined;
}

function toSetupHost(role: 'ue' | 'app', sys: InventorySystem | undefined): SetupHost | undefined {
  if (!sys?.host) return undefined;
  return {
    role,
    systemId: sys.id,
    name: sys.name,
    host: sys.host,
    user: (sys.username?.trim() || DEFAULT_INSTALL_USER),
  };
}

/**
 * Every Simnovator in inventory, with the UE and app server bound to it.
 *
 * Deduped by host the same way the dashboard does it — one machine is often
 * registered twice (once as the product GUI, once as a Cockpit install target).
 */
export function listSetups(inv: Inventory = loadInventory()): JobSetup[] {
  const simnovators = inv.systems
    .filter((s) => s.type === 'SIMNOVATOR' || s.type === 'SIMNOVATOR_GUI')
    .sort((a, b) => (a.type === 'SIMNOVATOR' ? -1 : 0) - (b.type === 'SIMNOVATOR' ? -1 : 0))
    .filter((s, i, all) => all.findIndex((o) => o.host === s.host) === i);

  return simnovators.map((sim) => {
    // The profile that names this machine as its Simnovator. Fall back to one
    // that puts it in the `uesim` slot — an integrated install has no separate
    // UE box, so the Simnovator IS the UESIM.
    const profile: TopologyProfile | undefined =
      inv.profiles.find((p) => hostFor(inv, p.simnovator)?.host === sim.host)
      ?? inv.profiles.find((p) => hostFor(inv, p.uesim)?.host === sim.host);

    const ue  = toSetupHost('ue',  hostFor(inv, profile?.uesim));
    const app = toSetupHost('app', hostFor(inv, profile?.appserver));

    const missing: string[] = [];
    if (!profile) missing.push('no topology profile references this Simnovator');
    else {
      if (!ue)  missing.push('the profile has no UE bound');
      if (!app) missing.push('the profile has no App server bound');
    }

    return {
      systemId: sim.id,
      name: sim.name,
      host: sim.host,
      profileId: profile?.id,
      profileName: profile?.name,
      ue,
      app,
      installable: !!ue && !!app,
      problem: missing.length
        ? `${missing.join('; ')}. Fix it in Systems Management → Topology Setups.`
        : undefined,
      cockpitUrl: `https://${sim.host}:${sim.cockpitPort ?? 9090}/system/terminal`,
    };
  });
}

export function getSetup(host: string, inv: Inventory = loadInventory()): JobSetup | undefined {
  return listSetups(inv).find((s) => s.host === host || s.systemId === host);
}

/**
 * The `hosts` array buildInstaller wants, derived from a setup.
 * Returns [] when the setup is not installable — callers must check first so
 * the failure is reported before a browser is launched.
 */
export function installHostsFor(setup: JobSetup): Array<{ flag: '--ue' | '--app'; ip: string; user: string }> {
  const out: Array<{ flag: '--ue' | '--app'; ip: string; user: string }> = [];
  if (setup.ue)  out.push({ flag: '--ue',  ip: setup.ue.host,  user: setup.ue.user });
  if (setup.app) out.push({ flag: '--app', ip: setup.app.host, user: setup.app.user });
  return out;
}

/**
 * Which inventory system the installer should be pointed at for `host`.
 *
 * buildInstaller only accepts a system typed SIMNOVATOR. In practice a station
 * is often registered ONLY as SIMNOVATOR_GUI — that is the entry serving the
 * REST API, and nothing forces a second Cockpit registration of the same
 * machine. Both describe the same box on the same Cockpit port, so the GUI
 * registration is accepted and flagged with `retype` so the caller can present
 * it as a SIMNOVATOR for that one call.
 *
 * Extracted from the route so this resolution is testable without launching a
 * browser — getting it wrong previously failed every install in 17ms with an
 * internal type message.
 */
export function resolveInstallTarget(
  inv: Inventory, host: string,
): { systemId: string; retype: boolean } | { error: string } {
  const exact = inv.systems.find((s) => s.host === host && s.type === 'SIMNOVATOR');
  if (exact) return { systemId: exact.id, retype: false };
  const gui = inv.systems.find((s) => s.host === host && s.type === 'SIMNOVATOR_GUI');
  if (gui) return { systemId: gui.id, retype: true };
  return { error: `No Simnovator registered at ${host}. Add it in Systems Management.` };
}

/** Human preview of the install line, shown in the wizard before anything runs
 *  so the user can see which UE/app the selected setup resolved to. */
export function previewInstallCommand(setup: JobSetup): string {
  const parts = ['./install'];
  if (setup.ue)  parts.push('--ue', `'${setup.ue.user}@${setup.ue.host}'`);
  if (setup.app) parts.push('--app', `'${setup.app.user}@${setup.app.host}'`);
  return parts.join(' ');
}

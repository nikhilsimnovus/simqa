// Live resource check for a Simnovator setup.
//
// Answers one question before a job is submitted: is this station actually in a
// state where running a playlist will work? Each check probes something real —
// nothing here is inferred from configuration.
//
// Checks are declared in one array so adding another (a new service, a disk
// threshold, a licence probe) is one entry, not a rewrite. A check marked
// blocking: false can warn without stopping the job.

import * as net from 'node:net';
import { loadInventory } from '../inventory';
import { listSimulators } from '../uesimClient';
import { getSetup, type JobSetup } from './setups';
import type { ResourceCheckItem, ResourceCheckResult } from './types';

const TCP_TIMEOUT_MS = 2_500;
const API_TIMEOUT_MS = 10_000;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

function tcpAlive(host: string, port = 22, timeoutMs = TCP_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    if (!host) return resolve(false);
    const sock = new net.Socket();
    let done = false;
    const finish = (ok: boolean) => { if (done) return; done = true; sock.destroy(); resolve(ok); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    try { sock.connect(port, host); } catch { finish(false); }
  });
}

/**
 * Run every check for a setup.
 *
 * Returns ok:true only when no BLOCKING check failed — a warning (e.g. the box
 * is mid-execution) is surfaced but does not stop the user, because by the time
 * their playlist starts that testcase may well be finished.
 */
export async function runResourceCheck(setupHost: string): Promise<ResourceCheckResult> {
  const inv = loadInventory();
  const setup = getSetup(setupHost, inv);
  const items: ResourceCheckItem[] = [];
  const checkedAt = new Date().toISOString();

  if (!setup) {
    return {
      setupHost, checkedAt, ok: false,
      items: [{
        name: 'Setup resolved',
        status: 'failed',
        blocking: true,
        detail: `No Simnovator in inventory with host "${setupHost}".`,
      }],
    };
  }

  // ── 1. Topology bindings ────────────────────────────────────────────────
  // Checked first: without these the install command cannot even be built, so
  // reporting it up front beats failing three minutes into a browser session.
  items.push(
    setup.installable
      ? {
          name: 'Topology bindings',
          status: 'ready',
          blocking: true,
          detail: `UE ${setup.ue!.host} · App ${setup.app!.host} (profile "${setup.profileName ?? setup.profileId}")`,
        }
      : { name: 'Topology bindings', status: 'failed', blocking: true, detail: setup.problem },
  );

  // ── 2. Simnovator REST API + execution mutex ────────────────────────────
  // listSimulators is the cheapest authenticated call and settles three things
  // at once: the box is up, it is licensed enough to report simulators, and
  // whether one is currently BUSY.
  const sim = inv.systems.find((s) => s.id === setup.systemId);
  const opts = {
    host: setup.host,
    username: sim?.uesim?.username ?? sim?.username ?? 'admin',
    password: sim?.uesim?.password ?? sim?.password ?? 'admin',
  };
  let simulators: any[] = [];
  let apiUp = false;
  try {
    const r = await withTimeout(listSimulators(opts), API_TIMEOUT_MS, `listSimulators ${setup.host}`);
    simulators = r.items ?? [];
    apiUp = true;
  } catch (e: any) {
    items.push({
      name: 'Simnovator API',
      status: 'failed',
      blocking: true,
      detail: `${setup.host} did not answer: ${e?.message ?? e}`,
    });
  }

  if (apiUp) {
    items.push({
      name: 'Simnovator API',
      status: 'ready',
      blocking: true,
      detail: `${setup.host} responding · ${simulators.length} simulator${simulators.length === 1 ? '' : 's'}`,
    });

    const busy = simulators.filter((s: any) => String(s?.availability ?? '').toUpperCase() === 'BUSY');
    const unavailable = simulators.filter((s: any) => String(s?.availability ?? '').toUpperCase() === 'UNAVAILABLE');

    items.push(
      busy.length > 0
        // Advisory, not blocking: the box enforces one testcase at a time, so a
        // job submitted now simply queues behind whatever is running. Worded as
        // what will happen to THIS job, because that is the decision the
        // operator is making at the Submit button.
        ? {
            name: 'Execution slot',
            status: 'warning',
            blocking: false,
            detail: `A job is already running on this station — your job will start once the system is available.`,
          }
        : { name: 'Execution slot', status: 'ready', blocking: true, detail: 'Station is free — your job is ready to run now' },
    );

    if (unavailable.length > 0) {
      items.push({
        name: 'Simulator health',
        status: 'warning',
        blocking: false,
        detail: `${unavailable.length} simulator reporting UNAVAILABLE — it will not take work.`,
      });
    } else if (simulators.length > 0) {
      items.push({ name: 'Simulator health', status: 'ready', blocking: false, detail: 'All simulators selectable' });
    }
  }

  // ── 3. Cockpit (the install path) ───────────────────────────────────────
  const cockpitPort = sim?.cockpitPort ?? 9090;
  const cockpitUp = await tcpAlive(setup.host, cockpitPort);
  items.push({
    name: 'Cockpit endpoint',
    status: cockpitUp ? 'ready' : 'failed',
    blocking: true,
    detail: cockpitUp
      ? `${setup.host}:${cockpitPort} accepting connections`
      : `${setup.host}:${cockpitPort} unreachable — the build install drives Cockpit and cannot run.`,
  });

  // ── 4. The bound lab machines ───────────────────────────────────────────
  for (const member of [setup.ue, setup.app].filter(Boolean)) {
    const m = member!;
    const sys = inv.systems.find((s) => s.id === m.systemId);
    const up = await tcpAlive(m.host, sys?.sshPort ?? 22);
    items.push({
      name: m.role === 'ue' ? 'UE server' : 'App server',
      status: up ? 'ready' : 'failed',
      blocking: true,
      detail: up
        ? `${m.user}@${m.host} reachable`
        : `${m.user}@${m.host} not reachable on SSH — the installer pushes to this host.`,
    });
  }

  // `ok` gates the Submit button: a BLOCKING failure means the station cannot
  // run the job at all, so submitting would only manufacture a failed job.
  // A warning never blocks — "busy" resolves itself by waiting.
  const ok = !items.some((i) => i.blocking && i.status === 'failed');
  // `willQueue` is a different question from `ok`: the station is healthy but
  // occupied, so the job is accepted and waits rather than starting now.
  const willQueue = items.some((i) => i.name === 'Execution slot' && i.status === 'warning');
  const blockers = items.filter((i) => i.blocking && i.status === 'failed').map((i) => i.name);
  return {
    setupHost: setup.host, checkedAt, items, ok, willQueue, blockers,
    verdict: !ok
      ? `This station cannot take the job: ${blockers.join(', ')}. Fix it before submitting.`
      : willQueue
        ? 'Your job will run once the system is available.'
        : 'Ready — the station is free and the job can start immediately.',
  };
}

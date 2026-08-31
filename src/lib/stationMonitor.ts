// Background station poller — the thing that makes availability history real.
//
// Without this, "Resource Availability" only knew what was true at the instant
// somebody happened to load the dashboard. This polls every station on a timer
// from the moment the server starts, so the history in stationHistory.ts is a
// continuous record rather than a scatter of page views.
//
// HOW EACH STATE IS DECIDED (no guessing — every state maps to a real signal)
//
//   Simnovator station
//     offline    the REST API did not answer: powered off, rebooting, or the
//                network is down
//     in_use     a simulator reports availability=BUSY — the box is executing a
//                testcase, whether it was submitted from SimQA or its own GUI
//     available  answered, nothing executing
//
//   UE / callbox / app server (no REST API of their own)
//     offline    a TCP connect to the SSH port failed
//     in_use     the UE-sim of a station that is currently executing — the
//                testcase is driving it. The callbox and app server are shared
//                infrastructure whose per-station use we cannot observe, so we
//                do NOT claim they are in use; saying so would be invention.
//     available  reachable, not driven by a running test
//
// SAFETY: this runs inside the Next server process, so it must never be able to
// wedge it. Every probe has a hard timeout, ticks never overlap, and the whole
// tick is wrapped so a thrown error can only skip one round.

import * as net from 'node:net';
import { loadInventory, type Inventory, type InventorySystem } from './inventory';
import { listSimulators } from './uesimClient';
import { recordObservations, type Observation, type StationState } from './stationHistory';

/** Seconds between polls. 60s keeps the boxes' load negligible while still
 *  catching a short testcase. Override with SIMQA_STATION_POLL_SEC. */
const POLL_SEC = Math.max(15, Number(process.env.SIMQA_STATION_POLL_SEC) || 60);

/** Per-probe ceilings. Deliberately short: a dead host must not hold a tick
 *  open, and the whole point is a cheap heartbeat. */
const API_TIMEOUT_MS = 8_000;
const TCP_TIMEOUT_MS = 2_000;

interface MonitorState {
  timer: ReturnType<typeof setInterval> | null;
  /** The tick currently in progress, if any. Anything that wants a fresh
   *  reading joins this instead of starting a competing poll — two polls in
   *  flight can finish out of order and write history backwards. */
  inFlight: Promise<void> | null;
  lastTick: { at: number; ms: number; observed: number; error?: string } | null;
}

/**
 * Monitor state lives on globalThis, NOT in module scope.
 *
 * Next's dev server re-evaluates a module on every hot reload, and there is no
 * dispose hook to clear a setInterval it started. Module-scoped guards are
 * fresh in each new instance, so every edit to anything in this import graph
 * left another poller running. They then interleaved their writes — observed
 * live as bursts of six writes a minute producing hundreds of sub-second
 * segments, and a station that was never busy accruing 28 "running" intervals.
 *
 * globalThis survives re-evaluation, so there is exactly one poller per
 * process no matter how many times this module is loaded.
 */
const GLOBAL_KEY = '__simqaStationMonitor__';

function mon(): MonitorState {
  const g = globalThis as any;
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = { timer: null, inFlight: null, lastTick: null } as MonitorState;
  return g[GLOBAL_KEY] as MonitorState;
}

/** Reject rather than hang. The UESIM client has its own login timeout, but a
 *  half-open socket mid-request can still stall past it. */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/**
 * Try a probe twice before believing a failure.
 *
 * A single dropped packet or a busy box briefly refusing a connection is not an
 * outage, but written into history it becomes one — and at a poll a minute,
 * one false negative is charged as a full minute of downtime. Retrying
 * immediately costs a second or two and only when something already looks
 * wrong, while a genuinely dead machine fails both attempts and is recorded
 * without delay.
 */
async function twice<T>(probe: () => Promise<T>, failed: (v: T) => boolean): Promise<T> {
  const first = await probe();
  if (!failed(first)) return first;
  await new Promise((r) => setTimeout(r, 750));
  return probe();
}

/** Can we open a TCP connection? Read-only and credential-free — the same
 *  check the dashboard uses for machines the Simnovator does not track. */
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

/** Simnovator boxes, deduped by host the way the dashboard does it — the same
 *  machine is often registered twice (GUI + Cockpit install target). */
function simnovatorsOf(inv: Inventory): InventorySystem[] {
  return inv.systems
    .filter((s) => s.type === 'SIMNOVATOR_GUI' || s.type === 'SIMNOVATOR')
    .sort((a, b) => (a.type === 'SIMNOVATOR_GUI' ? -1 : 0) - (b.type === 'SIMNOVATOR_GUI' ? -1 : 0))
    .filter((s, i, all) => all.findIndex((o) => o.host === s.host) === i);
}

/** Role label for a system, from the topology profile that references it.
 *  Falls back to its inventory type so an unbound machine still reads sensibly. */
function roleOf(inv: Inventory, sys: InventorySystem): { role: string; stationHost?: string } {
  const ROLES: Array<[string, string]> = [
    ['simnovator', 'Simnovator'], ['uesim', 'UE'], ['callbox', 'Callbox'],
    ['enb', 'eNB'], ['gnb', 'gNB'], ['mme', 'MME'], ['ims', 'IMS'],
    ['appserver', 'App server'],
  ];
  for (const p of inv.profiles) {
    for (const [key, label] of ROLES) {
      if ((p as any)[key] !== sys.id) continue;
      const stationId = p.simnovator ?? p.uesim;
      const stationHost = inv.systems.find((s) => s.id === stationId)?.host;
      return { role: label, stationHost };
    }
  }
  const TYPE_LABEL: Record<string, string> = {
    SIMNOVATOR: 'Simnovator', SIMNOVATOR_GUI: 'Simnovator', UESIM: 'UE', UE: 'UE',
    CALLBOX: 'Callbox', ENB: 'eNB', GNB: 'gNB', MME: 'MME', IMS: 'IMS', APPSERVER: 'App server',
  };
  return { role: TYPE_LABEL[sys.type] ?? sys.type };
}

/**
 * Probe every system once and fold the result into history.
 * Returns the observations so a caller (or a test) can inspect them.
 */
export async function pollOnce(): Promise<Observation[]> {
  const inv = loadInventory();
  const at = Date.now();
  const obs: Observation[] = [];

  // ── Stations first: whether a station is executing decides whether its UE
  //    counts as in use, so we need these answers before the members.
  const stations = simnovatorsOf(inv);
  const busyByHost = new Map<string, boolean>();

  await Promise.all(stations.map(async (s) => {
    const opts = {
      host: s.host,
      username: s.uesim?.username ?? s.username ?? 'admin',
      password: s.uesim?.password ?? s.password ?? 'admin',
    };
    // listSimulators is the cheapest authenticated call: if it answers at all
    // the box is up, and its availability field is the execution mutex the box
    // uses, so one request settles online AND busy.
    const probe = () => withTimeout(listSimulators(opts), API_TIMEOUT_MS, `listSimulators ${s.host}`)
      .then((r) => ({
        up: true,
        busy: (r.items ?? []).some((x: any) => String(x?.availability ?? '').toUpperCase() === 'BUSY'),
      }))
      .catch(() => ({ up: false, busy: false }));

    const r = await twice(probe, (v) => !v.up);
    busyByHost.set(s.host, r.busy);
    const state: StationState = !r.up ? 'offline' : r.busy ? 'in_use' : 'available';
    obs.push({
      systemId: s.id, host: s.host, name: s.name,
      role: 'Simnovator', stationHost: s.host, state, at,
    });
  }));

  // ── Everything else: TCP reachability, plus in-use for a UE being driven.
  const stationIds = new Set(stations.map((s) => s.id));
  const members = inv.systems.filter((s) => !stationIds.has(s.id));

  await Promise.all(members.map(async (s) => {
    const { role, stationHost } = roleOf(inv, s);
    const up = await twice(() => tcpAlive(s.host, s.sshPort ?? 22), (v) => !v);
    const driven = role === 'UE' && !!stationHost && busyByHost.get(stationHost) === true;
    obs.push({
      systemId: s.id, host: s.host, name: s.name, role, stationHost,
      state: up ? (driven ? 'in_use' : 'available') : 'offline',
      at,
    });
  }));

  recordObservations(obs);
  return obs;
}

/**
 * One round of polling, at most once at a time. Callers that arrive while a
 * round is already running wait for it rather than starting their own — a
 * second concurrent poll can finish first and fold an older reading in after a
 * newer one, which writes a segment that ends before it starts.
 */
export function tick(): Promise<void> {
  const m = mon();
  if (m.inFlight) return m.inFlight;
  const t0 = Date.now();
  m.inFlight = pollOnce()
    .then((obs) => { m.lastTick = { at: t0, ms: Date.now() - t0, observed: obs.length }; })
    .catch((e: any) => {
      m.lastTick = { at: t0, ms: Date.now() - t0, observed: 0, error: e?.message ?? String(e) };
    })
    .finally(() => { m.inFlight = null; });
  return m.inFlight;
}

/**
 * Start the poller. Idempotent — a second call is a no-op, which matters
 * because Next can evaluate a module more than once in dev.
 *
 * WHY NOT instrumentation.ts (which is where a startup hook belongs):
 * middleware.ts forces Next to produce an Edge bundle, and it compiles
 * instrumentation.ts for BOTH runtimes. Edge cannot resolve node builtins, and
 * webpack traces through the `await import()` even when it sits behind a
 * `NEXT_RUNTIME === 'nodejs'` guard — so the Edge build fails on `fs`, whether
 * written bare or as `node:fs`, and takes the whole app down with it.
 *
 * So the monitor is started lazily instead, by ensureStationMonitor() below.
 * The cost is a small gap: nothing is recorded between a server restart and the
 * first request. That gap is stored as "no data", not as downtime, so the
 * history stays truthful about what was actually observed.
 */
export function startStationMonitor(): void {
  const m = mon();
  if (m.timer) return;
  m.timer = setInterval(tick, POLL_SEC * 1000);
  // Don't hold the process open on shutdown just for a heartbeat.
  (m.timer as any).unref?.();

  // First reading shortly after boot rather than immediately: let the server
  // finish starting before we add network work to it.
  const kick = setTimeout(tick, 3_000);
  (kick as any).unref?.();

  console.log(`[station-monitor] polling every ${POLL_SEC}s`);
}

export function stopStationMonitor(): void {
  const m = mon();
  if (m.timer) { clearInterval(m.timer); m.timer = null; }
}

/**
 * Make sure the poller is running. Safe and cheap to call from any server
 * component or route handler — after the first call it is a boolean check.
 *
 * Call it from anywhere the app is touched: whichever page someone opens first
 * after a restart is what gets availability tracking going again, and from then
 * on it runs on its own timer whether or not anyone is looking.
 */
export function ensureStationMonitor(): void {
  if (process.env.SIMQA_DISABLE_STATION_MONITOR === '1') return;
  startStationMonitor();
}

/** Health of the poller itself, for the API to report. */
export function monitorStatus(): { running: boolean; pollSec: number; lastTick: MonitorState['lastTick'] } {
  const m = mon();
  return { running: !!m.timer, pollSec: POLL_SEC, lastTick: m.lastTick };
}

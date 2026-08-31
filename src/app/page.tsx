// Dashboard. Server-rendered: pulls live from the UESIM box on each request.

import { Header } from '@/components/Header';
import { Card, CardBody, CardHeader, CardTitle, Badge } from '@/components/ui';
import { loadInventory, uesimApiOptsFromInventory } from '@/lib/inventory';
import { listTestcases, listSimulators, getTestcase } from '@/lib/uesimClient';
import { listRuns } from '@/lib/runStore';
import { findBusy } from '@/lib/executions';
import { listSystemUsage } from '@/lib/systemUsage';
import { AutoRefresh } from '@/components/AutoRefresh';
import { ensureStationMonitor } from '@/lib/stationMonitor';
import { Wifi, WifiOff } from 'lucide-react';
import * as net from 'node:net';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); } catch { return fallback; }
}

// The dashboard is force-dynamic, so every click re-probed both boxes and
// re-fetched the selected box's whole testcase catalogue — ~3-4s per
// navigation. These calls are the same for any visitor within a few seconds,
// so hold them briefly in-process. Short enough that a run finishing still
// shows up promptly.
const TTL_MS = 15_000;
const memo = new Map<string, { at: number; value: Promise<any> }>();
function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value as Promise<T>;
  // Store the PROMISE, not the resolved value: two clicks in the same second
  // then share one in-flight request instead of racing duplicates.
  const value = fn();
  memo.set(key, { at: Date.now(), value });
  return value;
}

/** Can we open a TCP connection? Used for lab machines the Simnovator doesn't
 *  track (callbox, app server) — a connect attempt is read-only and needs no
 *  credentials. Short timeout so an unplugged host can't stall the dashboard. */
function tcpAlive(host: string, port = 22, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    if (!host) return resolve(false);
    const sock = new net.Socket();
    const finish = (ok: boolean) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    try { sock.connect(port, host); } catch { finish(false); }
  });
}

/** Locale date+time with an uppercase meridiem — toLocaleString renders "am". */
function stamp(iso: string): string {
  return new Date(iso).toLocaleString().replace(/\b(am|pm)\b/gi, (m) => m.toUpperCase());
}

/**
 * One box's live state, in the three states used everywhere in SimQA:
 *
 *   available    it answered and is idle — ready for someone to use
 *   running      a simulator reports BUSY, i.e. a testcase is executing
 *   unavailable  it did not answer: powered off, rebooting, or unreachable
 *
 * `online` is the raw "did it answer" fact; `busy` narrows that to running.
 * A rebooting or powered-off box fails the call and reports unavailable rather
 * than showing a stale green badge.
 */
interface BoxStatus {
  id: string;
  name: string;
  host: string;
  online: boolean;
  busy: boolean;
  simulators: number;
}

type StationState = 'available' | 'running' | 'unavailable';

function stationStateOf(b: { online: boolean; busy: boolean }): StationState {
  if (!b.online) return 'unavailable';
  return b.busy ? 'running' : 'available';
}

/** Badge tone per state — routed through the shared <Badge> component (same
 *  green/amber/red used for every other status badge on the page) so a
 *  station's state reads in the same visual language as a run's or a lab
 *  machine's, not a one-off style just for this tile. */
const STATION_META: Record<StationState, { label: string; tone: 'success' | 'warning' | 'danger'; title: string }> = {
  available:   { label: 'available',   tone: 'success',
                 title: 'Responding and idle — free to use' },
  running:     { label: 'running',     tone: 'warning',
                 title: 'Executing a testcase right now' },
  unavailable: { label: 'unavailable', tone: 'danger',
                 title: 'No response — powered off, rebooting, or unreachable' },
};

/** Small eyebrow heading above a page section — keeps the "clearly separate
 *  zones" spacing/typography identical everywhere it's used instead of each
 *  section hand-rolling its own label style. */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">{children}</h2>;
}

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ box?: string }> }) {
  // Availability history is collected by a background poller. Kick it off here
  // so opening the dashboard after a server restart resumes tracking — it is a
  // no-op once running, and thereafter ticks on its own timer.
  ensureStationMonitor();

  const inv = loadInventory();
  const apiOpts = uesimApiOptsFromInventory(inv);
  // Which box the dashboard is focused on. Kept in the URL so the choice
  // survives a refresh and can be linked to.
  const selectedHost = (await searchParams)?.box ?? '';

  // Simnovator boxes only — a plain UESIM/UE host or a callbox has no product
  // GUI to report on, and listing them made the dashboard about the lab rather
  // than about the boxes under test. Deduped by host, since the same machine is
  // often registered twice (once as Simnovator, once as its Cockpit install
  // target); the GUI entry wins because that's the one serving the REST API.
  const simnovators = inv.systems
    .filter((s) => s.type === 'SIMNOVATOR_GUI' || s.type === 'SIMNOVATOR')
    .sort((a, b) => (a.type === 'SIMNOVATOR_GUI' ? -1 : 0) - (b.type === 'SIMNOVATOR_GUI' ? -1 : 0))
    .filter((s, i, all) => all.findIndex((o) => o.host === s.host) === i);

  const probed = await Promise.all(
    simnovators.map(async (s) => {
      const opts = {
        host: s.host,
        username: s.uesim?.username ?? s.username ?? 'admin',
        password: s.uesim?.password ?? s.password ?? 'admin',
      };
      // listSimulators is the cheapest authenticated call and settles both
      // questions at once: if it answers the box is up, and `availability` is
      // the execution mutex the box uses, so BUSY means a testcase is running.
      // Every tile therefore gets its true state from ONE request — no
      // per-box testcase count call, which is why that line is gone.
      const sims = await cached(`sims:${s.host}`, () =>
        safe(() => listSimulators(opts).then((r) => ({ ok: true, items: r.items ?? [] })),
          { ok: false, items: [] as any[] }));
      const box: BoxStatus = {
        id: s.id, name: s.name, host: s.host,
        online: sims.ok,
        busy: sims.items.some((x: any) => String(x?.availability ?? '').toUpperCase() === 'BUSY'),
        simulators: sims.items.length,
      };
      return { box, simulators: sims.items, opts };
    }),
  );
  const boxes = probed.map((p) => p.box);

  // Reuse the primary box's ALREADY-probed simulators rather than re-querying
  // via uesimApiOptsFromInventory: that helper returns the first UESIM-like
  // entry, which can be a different registration of the same machine (a
  // Cockpit row without REST credentials) — so the card read "no simulators"
  // while the tile beside it reported one.
  // The focused box: the one named in ?box=, else the inventory default.
  const selectedProbe =
    probed.find((p) => p.box.host === selectedHost)
    ?? probed.find((p) => p.box.host === apiOpts?.host)
    ?? probed[0];
  const primary = selectedProbe?.box;

  // Recent runs for the FOCUSED box only. The runner records the host as the
  // preflight-login step's detail, so that's the only per-run box marker.
  const recent = listRuns(200)
    .map((r) => ({ ...r, host: r.steps?.find((s) => s.name === 'preflight-login')?.detail ?? '' }))
    .filter((r) => !primary || r.host === primary.host)
    .slice(0, 6);

  const boxLive = !!selectedProbe?.box.online && !!selectedProbe?.opts;

  // Runs recorded before testcaseName existed only carry the id. Resolve those
  // from the box so the list never shows a raw UUID — best-effort: a testcase
  // deleted since the run still falls back to its id rather than failing.
  const simqaRunsP = Promise.all(
    recent.map(async (r) => {
      const name = r.testcaseName ?? (boxLive
        ? await cached(`tc:${selectedProbe!.box.host}:${r.testcaseId}`, () =>
            safe(() => getTestcase(selectedProbe!.opts, r.testcaseId).then((t) => t?.name), undefined))
        : undefined);
      return {
        key: `run:${r.id}`,
        href: `/runs/${r.id}`,
        name: name ?? r.testcaseId,
        at: new Date(r.startedAt).getTime(),
        startedAt: r.startedAt,
        status: r.status,
        testcaseId: r.testcaseId,
        viaSimqa: true,
      };
    }),
  );

  // Executions the box ran on its own (from its GUI). The box has no
  // executions endpoint — probed /v2/executions, /v2/history and friends, all
  // 404 — so each testcase's metadata.lastExecution is the only record.
  const boxExecutionsP = !boxLive ? Promise.resolve([] as any[]) : cached(
    `execs:${selectedProbe!.box.host}`,
    () => safe(
        () => listTestcases(selectedProbe!.opts, 1000, 0).then((r) =>
          (r.items ?? []).flatMap((t: any) => {
            const last = t?.metadata?.lastExecution;
            if (!last?.executedOn) return [];
            // Keep the box's own verdict rather than collapsing everything
            // that isn't PASS into "failed" — INCOMPLETE, ABORTED and ERROR
            // mean different things when you're triaging.
            const verdict = String(last.result ?? '').toLowerCase();
            return [{
              key: `exec:${t.id}:${last.executedOn}`,
              href: `/testcases/${encodeURIComponent(t.id)}?systemId=${encodeURIComponent(selectedProbe!.box.id)}`,
              name: t.name ?? t.id,
              at: new Date(last.executedOn).getTime(),
              startedAt: last.executedOn as string,
              status: verdict === 'pass' ? 'passed' : verdict || 'unknown',
              testcaseId: String(t.id),
              viaSimqa: false,
            }];
          }),
        ),
        [] as any[],
      ),
  );

  // Whatever the box is executing right now outranks any recorded verdict —
  // lastExecution still reports the PREVIOUS result while a test is in flight.
  const busyP = !boxLive
    ? Promise.resolve(null)
    : cached(`busy:${selectedProbe!.box.host}`, () => safe(() => findBusy(selectedProbe!.opts), null));

  // These three hit the box independently — run them together rather than
  // stacking their latencies.
  const [simqaRuns, boxExecutions, busy] = await Promise.all([simqaRunsP, boxExecutionsP, busyP]);

  // Merge both sources. A simqa-triggered run ALSO lands in the box's
  // lastExecution, so drop the box copy when one of ours covers the same
  // testcase within a couple of minutes — otherwise every run shows twice.
  // The execution happening RIGHT NOW. The box writes metadata.lastExecution
  // only when a run completes, so an in-flight one has no record to derive
  // from — without this row a test running from the Simnovator GUI is simply
  // missing from the list until it finishes.
  const liveRow = busy?.testCaseId
    ? [{
        key: `live:${busy.executionId ?? busy.testCaseId}`,
        href: `/testcases/${encodeURIComponent(busy.testCaseId)}?systemId=${encodeURIComponent(primary!.id)}`,
        name: busy.testCaseName ?? busy.testCaseId,
        at: busy.lastUpdated ? new Date(busy.lastUpdated).getTime() : Date.now(),
        startedAt: busy.lastUpdated ?? new Date().toISOString(),
        status: 'in progress',
        testcaseId: busy.testCaseId,
        // Attribute it to simqa only when one of our own runs is driving it.
        viaSimqa: simqaRuns.some((s) => s.testcaseId === busy.testCaseId && s.status === 'running'),
      }]
    : [];

  const NEAR_MS = 120_000;
  const merged = [
    ...liveRow,
    ...simqaRuns.filter((s) => !liveRow.some((l) => l.testcaseId === s.testcaseId && s.status === 'running')),
    ...boxExecutions.filter((b) =>
      !simqaRuns.some((s) => s.testcaseId === b.testcaseId && Math.abs(s.at - b.at) < NEAR_MS)
      // Drop the box's PREVIOUS record for whatever is running now — it holds
      // the older verdict and would sit next to the live row saying "failed".
      && !liveRow.some((l) => l.testcaseId === b.testcaseId)),
  ]
    .filter((r) => Number.isFinite(r.at))
    .sort((a, b) => b.at - a.at)
    .slice(0, 6);
  // The live execution is already its own row above, so nothing else needs
  // relabelling — an earlier run of the same testcase keeps its own recorded
  // verdict instead of being rewritten as "in progress".
  const runs = merged;

  // The lab machines bound to the focused box by its topology profile — the
  // only place that association is expressed (a Simnovator has no inherent
  // link to its UE / callbox / app-server).
  // `simnovator` is the binding. Fall back to `uesim` for profiles that put the
  // Simnovator in that role instead (an integrated install has no separate UE
  // box, so the Simnovator IS the UESIM) — without the fallback those profiles
  // look unattached and the panel goes blank.
  const hostOfRole = (id?: string) => (id ? inv.systems.find((s) => s.id === id)?.host : undefined);
  const profile = inv.profiles.find((p) => hostOfRole(p.simnovator) === primary?.host)
    ?? inv.profiles.find((p) => hostOfRole(p.uesim) === primary?.host);
  const ROLE_LABELS: Array<[keyof typeof profile & string, string]> = [
    ['uesim', 'UE'], ['callbox', 'Callbox'], ['enb', 'eNB'], ['gnb', 'gNB'],
    ['mme', 'MME'], ['ims', 'IMS'], ['appserver', 'App server'],
  ] as any;
  const usage = listSystemUsage();
  const memberSystems = profile
    ? ROLE_LABELS.flatMap(([role, label]) => {
        const id = (profile as any)[role] as string | undefined;
        const sys = id ? inv.systems.find((s) => s.id === id) : undefined;
        if (!sys) return [];
        const u = usage[sys.id];
        return [{
          role: label, name: sys.name, host: sys.host, port: sys.sshPort ?? 22,
          lastUsedBy: u?.by, lastUsedWhat: u?.what, lastUsedAt: u?.at,
        }];
      })
    : [];

  // Live state for each member. Two sources, in order of authority:
  //   1. the Simnovator's own simulator registry — it knows whether the UE-sim
  //      it drives is CONNECTED/STABLE, which no port check can tell you;
  //   2. a plain TCP connect, for machines the box doesn't track (callbox,
  //      app server). Read-only and capped at 1.5s so a dead host can't stall
  //      the page.
  const simByIp = new Map<string, any>();
  for (const s of selectedProbe?.simulators ?? []) {
    const ip = s?.nodes?.ipaddress;
    if (ip) simByIp.set(ip, s);
  }
  const members = await Promise.all(
    memberSystems.map(async (m) => {
      const sim = simByIp.get(m.host);
      if (sim) {
        const up = String(sim.connectivity ?? '').toUpperCase() === 'CONNECTED';
        return { ...m, online: up, label: up ? 'connected' : 'disconnected' };
      }
      const up = await cached(`tcp:${m.host}:${m.port}`, () => tcpAlive(m.host, m.port));
      return { ...m, online: up, label: up ? 'connected' : 'disconnected' };
    }),
  );

  const reachable = !!primary?.online;

  /** Letters/digits only, lowercased — for comparing a system's name against
   *  its role without spacing or case counting as a difference. */
  const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

  return (
    <>
      {/* No status pills in the header: every box already has a tile below with
          its own live state, and repeating the same IPs twice on one screen
          added noise rather than information. */}
      <Header
        title="Dashboard"
        subtitle="Overview of the test environment and recent activity"
      />
      {/* The resource cards are computed on the server from live probes, so
          they only change when the page re-renders. Refresh on a timer — a
          station that starts executing should show as in-use without anyone
          reaching for F5. */}
      <AutoRefresh seconds={30} />
      <main className="p-6 space-y-5">
        {/* ── Test Environments ───────────────────────────────────────────
            One tile per box, so every Simnovator in inventory is visible
            with its own live status instead of only the first. */}
        <section>
          <SectionLabel>Test Environments</SectionLabel>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {boxes.map((b) => {
              const state = STATION_META[stationStateOf(b)];
              return (
                // Acts like a radio group: picking a box focuses the whole
                // page on it (recent runs + its lab machines) via ?box=<host>.
                <Link key={b.id} href={`/?box=${encodeURIComponent(b.host)}`} className="block">
                  <Card className={b.host === primary?.host ? 'ring-2 ring-primary-500' : 'hover:shadow-md transition-shadow'}>
                    <CardBody className="p-4">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-xs uppercase tracking-wider text-slate-500 truncate">{b.name}</div>
                          <div className="text-lg font-semibold text-slate-900 mt-0.5">{b.host}</div>
                        </div>
                        {/* Same three words + colours used everywhere else a
                            station's state shows up, so one colour never
                            means two different things across the app. */}
                        <Badge tone={state.tone} title={state.title} className="shrink-0 gap-1">
                          {b.online ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
                          {state.label}
                        </Badge>
                      </div>
                    </CardBody>
                  </Card>
                </Link>
              );
            })}
          </div>
        </section>

        {/* ── Recent runs (left) beside Resource Status + Summary (right) —
            what ran, and what it ran on, side by side. `items-start` so a
            shorter right column doesn't get stretched to Recent Runs' height
            and sit on a pool of empty space. Summary lives stacked under
            Resource Status rather than as its own full-width row, since that
            row was rarely as tall as Recent Runs and left the space under it
            unused. ── */}
        <section className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
          {/* ── Recent runs ─────────────────────────────────────────────── */}
          <Card>
            <CardHeader className="flex items-center justify-between">
              <CardTitle>Recent runs{primary ? ` of ${primary.host}` : ''}</CardTitle>
              <Link href="/runs" className="text-xs text-primary-700 hover:underline">View all</Link>
            </CardHeader>
            <CardBody className="p-0">
              {runs.length === 0 ? (
                <div className="p-5 text-sm text-slate-500">
                  No runs yet for {primary?.host ?? 'this box'}. Trigger one from the Test Cases page.
                </div>
              ) : (
                <table className="min-w-full text-sm">
                  <thead className="bg-slate-50 text-slate-600">
                    <tr>
                      <th className="text-left px-5 py-2 font-medium">Test Case</th>
                      <th className="text-right px-5 py-2 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {runs.map((r) => (
                      <tr key={r.key} className="hover:bg-slate-50">
                        <td className="px-5 py-2.5">
                          <Link href={r.href} className="block min-w-0">
                            <div className="text-sm font-medium text-slate-900 truncate">{r.name}</div>
                            {/* No host — the list is already scoped to the selected
                                box. No origin either: the list deliberately merges
                                runs started from SimQA with the box's own, so
                                labelling each one adds noise rather than meaning. */}
                            <div className="text-xs text-slate-500 truncate">{stamp(r.startedAt)}</div>
                          </Link>
                        </td>
                        <td className="px-5 py-2.5 text-right">
                          <RunStatusBadge status={r.status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardBody>
          </Card>

          {/* ── Resource status + Summary, stacked in the right column ── */}
          <div className="space-y-4">
          {/* The focused station and every lab machine bound to it, each with
              its live state. Scoped by ?box=, so picking a different tile above
              re-points this whole card. */}
          <Card>
            <CardHeader>
              <CardTitle>Resource Status</CardTitle>
            </CardHeader>
            <CardBody className="p-0">
              {members.length === 0 ? (
                <div className="p-5 text-sm text-slate-500">
                  No topology setup binds this box to a UE, callbox and app server.
                  Open Systems Management, edit a topology setup, and set its{' '}
                  <span className="font-medium text-slate-700">Simnovator</span> to{' '}
                  <span className="font-mono text-slate-700">{primary?.host}</span> — that field is
                  what links a setup to this box.
                </div>
              ) : (
                <table className="min-w-full text-sm">
                  <thead className="bg-slate-50 text-slate-600">
                    <tr>
                      <th className="text-left px-5 py-2 font-medium">System</th>
                      <th className="text-left px-5 py-2 font-medium">IP</th>
                      <th className="text-right px-5 py-2 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {/* The lab machines bound to this box by its topology
                        profile — role first, since that is what identifies the
                        machine's job in the setup. */}
                    {members.map((m) => (
                      <tr key={`${m.role}:${m.host}`}>
                        <td className="px-5 py-2.5">
                          <div className="font-medium text-slate-900">{m.role}</div>
                          {/* The system's own name, only when it says something
                              the role doesn't — a box named "UE" in the UE role
                              would just read "UEUE". */}
                          {squash(m.role) !== squash(m.name) ? (
                            <div className="text-[11px] text-slate-400 truncate">{m.name}</div>
                          ) : null}
                          {m.lastUsedBy ? (
                            <div className="text-[11px] text-slate-400 truncate">
                              last used by {m.lastUsedBy}
                            </div>
                          ) : null}
                        </td>
                        <td className="px-5 py-2.5 font-mono text-xs text-slate-600">{m.host}</td>
                        <td className="px-5 py-2.5 text-right">
                          <Badge tone={m.online ? 'success' : 'danger'}>{m.label}</Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardBody>
          </Card>

          {/* ── Summary ──────────────────────────────────────────────── */}
          <div>
            <SectionLabel>Summary</SectionLabel>
            <div className="grid grid-cols-2 gap-4">
              {/* ?from=dashboard tells Systems Management it was reached from
                  here, so it can offer a Back link. Arriving from the sidebar
                  carries no such marker and shows none. */}
              <Link href="/inventory?from=dashboard" className="block">
                <Card className="hover:shadow-md transition-shadow">
                  <CardBody className="p-4">
                    <div className="text-xs uppercase tracking-wider text-slate-500">Systems</div>
                    <div className="text-2xl font-semibold text-slate-900 mt-1">{inv.systems.length}</div>
                  </CardBody>
                </Card>
              </Link>
              <Link href="/inventory?from=dashboard#topology" className="block">
                <Card className="hover:shadow-md transition-shadow">
                  <CardBody className="p-4">
                    <div className="text-xs uppercase tracking-wider text-slate-500">Topology Setup</div>
                    <div className="text-2xl font-semibold text-slate-900 mt-1">{inv.profiles.length}</div>
                  </CardBody>
                </Card>
              </Link>
            </div>
          </div>
          </div>
        </section>
      </main>
    </>
  );
}

/** Covers simqa's own run states AND the verdicts the box reports for
 *  executions started from its GUI (incomplete / aborted / stopped / error). */
function RunStatusBadge({ status }: { status: string }) {
  const s = status.toLowerCase();
  if (s === 'passed' || s === 'pass')       return <Badge tone="success">passed</Badge>;
  if (s === 'failed' || s === 'fail')       return <Badge tone="danger">failed</Badge>;
  if (s === 'error')                        return <Badge tone="danger">error</Badge>;
  if (s === 'in progress' || s === 'running') return <Badge tone="info">in progress</Badge>;
  if (s === 'queued')                       return <Badge tone="warning">queued</Badge>;
  if (s === 'incomplete' || s === 'aborted' || s === 'stopped') return <Badge tone="warning">{s}</Badge>;
  return <Badge>{s}</Badge>;
}


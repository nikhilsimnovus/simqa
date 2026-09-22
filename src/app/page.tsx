// Dashboard. Server-rendered: pulls live from the UESIM box on each request.

import { Header } from '@/components/Header';
import { Card, CardBody, CardHeader, CardTitle, Badge } from '@/components/ui';
import { loadInventory, uesimApiOptsFromInventory, uesimApiCredentials } from '@/lib/inventory';
import { listSimulators, getTestcase } from '@/lib/uesimClient';
import { listRuns } from '@/lib/runStore';
import { AutoRefresh } from '@/components/AutoRefresh';
import { ensureStationMonitor } from '@/lib/stationMonitor';
import { ensureFidelityWatcher } from '@/lib/liveFidelity/watcher';
import { Wifi, WifiOff, Play, History } from 'lucide-react';
import * as net from 'node:net';
import Link from 'next/link';
import { RecentRunsTable } from './RecentRunsTable';
import { collectBoxActivity, type BoxExecution, type BoxUserState } from '@/lib/boxActivity';
import { formatDuration, windowOf, endFromDuration } from '@/lib/timeFormat';

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

  // Same treatment for the config-fidelity watcher, and for the same reason it
  // was needed here: both live on globalThis and start lazily, but the station
  // monitor had TWO wake-up points (this page and /api/stations/history) while
  // the fidelity watcher had only its own page's endpoints. So a server restart
  // silently stopped fidelity capture until somebody happened to open Config
  // Fidelity — observed 2026-09-03: capture stopped at 11:35 on .102 and 11:39
  // on .95 and did not resume for ~18 hours, missing every execution on both
  // boxes in that window, RES-Len among them.
  ensureFidelityWatcher();

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
        ...uesimApiCredentials(s),
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
        // SimQA records both ends, so the duration is the difference. A run
        // still in flight has no finish and reports neither.
        endedAt: r.finishedAt,
        durationSec: r.finishedAt
          ? Math.max(0, (new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()) / 1000)
          : undefined,
        status: r.status,
        testcaseId: r.testcaseId,
        user: r.boxUser as string | undefined,
        simulator: undefined as string | undefined,
        viaSimqa: true,
      };
    }),
  );

  // Executions on the box, whoever ran them.
  //
  // The box has no executions endpoint, so each testcase's metadata is the
  // only record — and on a multi-user Simnovator an operator's token only
  // lists THEIR testcases. Reading through the setup's default login alone
  // hid every run by the other users. So the box is read once per registered
  // login and each execution is attributed to the operator who owns the
  // simulator it ran on (the box records the simulator, never a username).
  // See boxActivityCore.ts.
  const selectedSys = selectedProbe ? inv.systems.find((s) => s.id === selectedProbe.box.id) : undefined;
  const activityP = !boxLive || !selectedSys
    ? Promise.resolve(null)
    : cached(`activity:${selectedProbe!.box.host}`, () => safe(() => collectBoxActivity(selectedSys), null));

  const [simqaRuns, activity] = await Promise.all([simqaRunsP, activityP]);

  const toRow = (e: BoxExecution) => ({
    key: `exec:${e.executionId}`,
    href: testcaseHref(primary!.id, e.testcaseId, e.user),
    name: e.testcaseName,
    at: Date.parse(e.startedAt),
    startedAt: e.startedAt,
    durationSec: e.durationSec,
    endedAt: e.status === 'in progress' ? undefined : endFromDuration(e.startedAt, e.durationSec),
    status: e.status,
    testcaseId: e.testcaseId,
    user: e.user,
    simulator: e.simulatorName,
    viaSimqa: false,
  });

  // Everything executing right now — one row per busy simulator, so two
  // users running at once both show, not just whichever the default login
  // could see.
  const liveRow = (activity?.executions ?? []).filter((e) => e.status === 'in progress').map(toRow);
  const boxExecutions = (activity?.executions ?? []).filter((e) => e.status !== 'in progress').map(toRow);

  // Merge both sources. A simqa-triggered run ALSO lands in the box's own
  // record, so drop the box copy when one of ours covers the same testcase
  // within a couple of minutes — otherwise every run shows twice.
  const NEAR_MS = 120_000;
  const merged = [
    ...liveRow,
    ...simqaRuns.filter((s) => !liveRow.some((l) => l.testcaseId === s.testcaseId && s.status === 'running')),
    ...boxExecutions.filter((b) =>
      !simqaRuns.some((s) => s.testcaseId === b.testcaseId && Math.abs(s.at - b.at) < NEAR_MS)),
  ]
    .filter((r) => Number.isFinite(r.at))
    .sort((a, b) => b.at - a.at)
    // Five: the user tiles above already show what each person is running
    // and last ran, so this is a short tail. View all has the rest.
    .slice(0, 5);
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
  // No last-used attribution here any more: the members table carried a
  // "last used by <name>" line under each machine, which was removed. The
  // listSystemUsage() read that fed it went with it — it was a per-render disk
  // read serving nothing else on this page. systemUsage itself is untouched
  // and still recorded for other callers.
  const memberSystems = profile
    ? ROLE_LABELS.flatMap(([role, label]) => {
        const id = (profile as any)[role] as string | undefined;
        const sys = id ? inv.systems.find((s) => s.id === id) : undefined;
        if (!sys) return [];
        return [{ role: label, name: sys.name, host: sys.host, port: sys.sshPort ?? 22 }];
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
        {/* 2:1, not 1:1. Recent Runs carries the testcase names and the run
            window; Resource Status is three short rows of IP and state and
            Summary is two numbers, so an even split starved the side that
            needed the width. */}
        {/* ── Users on this box ───────────────────────────────────────────
            One tile per registered box login: which simulator it owns, and
            what that person is running right now. The Simnovator executes each
            user's testcases on their own simulator, so this is the answer to
            "who is using the box" — several can be running at once. */}
        {activity && activity.users.length > 0 ? (
          <BoxUsersCard host={primary?.host ?? ''} users={activity.users} systemId={primary!.id} />
        ) : null}

        <section className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-start">
          {/* ── Recent runs ─────────────────────────────────────────────── */}
          <Card className="lg:col-span-2">
            <CardHeader className="flex items-center justify-between">
              <CardTitle>Recent runs{primary ? ` of ${primary.host}` : ''}</CardTitle>
              <Link href="/runs?from=dashboard" className="text-xs text-primary-700 hover:underline">View all</Link>
            </CardHeader>
            <CardBody className="p-0">
              {runs.length === 0 ? (
                <div className="p-5 text-sm text-slate-500">
                  No runs yet for {primary?.host ?? 'this box'}. Trigger one from the Test Cases page.
                </div>
              ) : (
                /* Spreadsheet-style and column-resizable, like Run History —
                   the name column used to have no width of its own, so a long
                   testcase name was clipped with no way to see the rest. The
                   timestamp is formatted HERE, on the server, because the
                   table is a client component and formatting a date on both
                   sides of the boundary would hydrate with two timezones. */
                <RecentRunsTable
                  rows={runs.map((r) => ({
                    key: r.key, href: r.href, name: r.name,
                    duration: formatDuration(r.durationSec),
                    // Under the duration, not in a column of its own: when the
                    // run started and ended. A run still in flight has no end
                    // yet and shows only its start, with the badge saying why.
                    window: windowOf(r.startedAt, r.endedAt),
                    status: r.status,
                    user: r.user,
                    simulator: r.simulator,
                  }))}
                />
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

/**
 * A testcase's validation page, opened AS the user who ran it — an operator's
 * testcase is invisible to every other login, so without boxUserId the page
 * reads it through the default account and 404s. Usernames resolve as login
 * ids (uesimApiCredentials matches either). from=dashboard puts "Back to
 * Dashboard" on the page.
 */
function testcaseHref(systemId: string, testcaseId: string, user?: string): string {
  const p = new URLSearchParams({ systemId, from: 'dashboard' });
  if (user) p.set('boxUserId', user);
  return `/testcases/${encodeURIComponent(testcaseId)}?${p}`;
}

/** Who is on the box: one tile per registered login. */
function BoxUsersCard({ host, users, systemId }: { host: string; users: BoxUserState[]; systemId: string }) {
  const running = users.filter((u) => u.running).length;
  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <CardTitle>Users on {host}</CardTitle>
        <span className="text-xs text-slate-500">
          {running ? `${running} executing now` : 'nobody executing'} · {users.length} login{users.length === 1 ? '' : 's'}
        </span>
      </CardHeader>
      <CardBody className="p-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {users.map((u) => (
            <div
              key={u.username}
              className={`rounded-lg border px-3 py-2.5 ${u.running ? 'border-sky-300 bg-sky-50/60' : 'border-line bg-surface'}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-slate-900 truncate">{u.username}</span>
                {u.error ? <Badge tone="warning">unreachable</Badge>
                  : u.running ? <Badge tone="info">executing</Badge>
                  : <Badge>idle</Badge>}
              </div>
              <div className="text-[11px] text-slate-500 truncate">
                {u.admin ? 'admin · sees every simulator'
                  : u.simulator ? (u.simulator.name ?? `simulator ${u.simulator.id}`)
                  : u.error ? u.error : 'no simulator assigned'}
                {u.discovered ? <span className="text-slate-400" title="Named by the Simnovator's own user assignments — not a login registered in System Management"> · from box</span> : null}
              </div>
              {/* Both open the testcase's validation page, as this user. */}
              {u.running ? (
                <Link
                  href={testcaseHref(systemId, u.running.testcaseId, u.username)}
                  className="mt-2 flex items-center gap-2 rounded-md border border-sky-200 bg-white px-2 py-1.5 hover:border-sky-400 hover:bg-sky-50"
                  title={`${u.running.testcaseName} — executing now. Open its validation page.`}
                >
                  <Play className="h-3.5 w-3.5 shrink-0 fill-sky-600 text-sky-600 animate-pulse" />
                  <span className="min-w-0">
                    <span className="block text-[10px] uppercase tracking-wider text-sky-700 font-medium">Executing now</span>
                    <span className="block text-xs font-medium text-slate-900 truncate">{u.running.testcaseName}</span>
                  </span>
                </Link>
              ) : u.last ? (
                <Link
                  href={testcaseHref(systemId, u.last.testcaseId, u.username)}
                  className="mt-2 flex items-center gap-2 rounded-md border border-line bg-white px-2 py-1.5 hover:border-slate-400 hover:bg-slate-50"
                  title={`${u.last.testcaseName} — last executed (${u.last.status}). Open its validation page.`}
                >
                  <History className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[10px] uppercase tracking-wider text-slate-500 font-medium">Last executed</span>
                    <span className="block text-xs font-medium text-slate-900 truncate">{u.last.testcaseName}</span>
                  </span>
                  <Badge tone={u.last.status === 'passed' ? 'success' : u.last.status === 'failed' || u.last.status === 'error' ? 'danger' : 'warning'}>
                    {u.last.status}
                  </Badge>
                </Link>
              ) : !u.error ? (
                <div className="mt-1.5 text-xs text-slate-400">no executions yet</div>
              ) : null}
            </div>
          ))}
        </div>
      </CardBody>
    </Card>
  );
}


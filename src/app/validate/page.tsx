// Build Validation — install a Simnovator build, then prove it works.
//
// Two columns: the left is the install (build URL, hosts, watch the box come
// back), the right is the verification (the checklist and its results).
//
// They are one flow, not two. "Install Build and Verify" installs, waits for
// the box to report the new version, then runs the whole checklist itself —
// there is no separate Run button, because a verification you have to remember
// to start is one that gets skipped.
//
// SimQA DOES run the installer: "Install Build" drives the target's Cockpit
// terminal over Chromium and issues wget / tar / ./install itself, streaming
// the output back. (It did not always — it used to print the commands for the
// operator to paste, and this header used to say so.)
//
// Install Progress therefore ticks off the installer's own output, and each
// tick names the line that earned it. The one exception is the last step:
// "Installation completed" is settled by asking the BOX for its build version,
// not by the installer's exit code — a real run exited 1 on a late App Server
// SSH key and had installed the build regardless.

'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Header } from '@/components/Header';
import { INSTALL_STEPS, deriveInstallSteps, type StreamEvent } from '@/lib/installSteps';
import { BackToRunHistory } from '@/components/BackToRunHistory';
import { Card, CardBody, CardHeader, CardTitle, Button, Badge } from '@/components/ui';
import {
  CheckCircle2, XCircle, MinusCircle, Loader2, Terminal,
  ChevronRight, ChevronDown, ShieldCheck, AlertTriangle,
} from 'lucide-react';

interface SystemRow { id: string; name: string; host: string; type: string }
/** Topology row: which UE / App Server / callbox belong to a Simnovator. */
interface Profile { id: string; name?: string; simnovator?: string; uesim?: string; appserver?: string; callbox?: string }

type StepStatus = 'pass' | 'fail' | 'skip' | 'running' | 'pending';
interface Step { id: string; label: string; status: StepStatus; detail?: string; expected?: string; startedAt?: string; finishedAt?: string; durationMs?: number }
interface CheckGroup { id: string; label: string; status: StepStatus; detail?: string; steps: Step[] }
interface Report {
  id: string; startedAt: string; finishedAt?: string; ok: boolean; status: string;
  systemId: string; systemName?: string; host: string; buildVersion?: string;
  ueHost?: string; appServerHost?: string;
  install?: { buildUrl?: string; skipFlags?: string[]; commands?: string[] };
  selectedChecks: string[]; groups: CheckGroup[];
}

const VERIFICATIONS: Array<{ id: string; label: string; hint: string }> = [
  { id: 'reachable',    label: 'Simnovator Reachable',   hint: 'Pings the Simnovator, the selected UE and the App Server' },
  { id: 'login',        label: 'Able to Login',          hint: 'UI serves, and the configured credentials are accepted' },
  { id: 'sample-tests', label: 'Sample Tests Available', hint: "Sample testcases shipped with the build are present" },
  { id: 'run-tests',    label: 'Run Test Cases',         hint: 'Links the callbox to this testcase’s configuration and executes Buildcheck_SA_1Cell_1UEs_UDP on real hardware — takes minutes' },
];

const SKIP_FLAGS = ['--no_app_server', '--no_app_manager', '--no_simnovator', '--no_ue', '--no_oru'];

// The checklist and its ticking rules live in src/lib/installSteps.ts, derived
// from the installer's real output. There is no `observable` flag any more:
// SimQA drives the Cockpit terminal, so every step is visible and every tick is
// earned by a line the installer actually printed.

function StatusIcon({ status }: { status: StepStatus }) {
  if (status === 'running') return <Loader2 className="h-3.5 w-3.5 animate-spin text-primary-600" />;
  if (status === 'pass')    return <CheckCircle2 className="h-3.5 w-3.5 text-success-600" />;
  if (status === 'fail')    return <XCircle className="h-3.5 w-3.5 text-red-600" />;
  if (status === 'skip')    return <MinusCircle className="h-3.5 w-3.5 text-slate-300" />;
  return <div className="h-3.5 w-3.5 rounded-full border border-slate-300" />;
}

/** Whether an installer log event is an error — used both to colour the line
 *  and to make sure an error is never filtered out as plumbing. */
const isErr = (e: StreamEvent) => e.stream === 'error' || e.stream === 'stderr';

type StreamRow = { kind: 'log' | 'step' | 'done'; text: string; bad?: boolean };

/** The build version a URL installs — ".../Simnovator-4.0.0_2609012008.tar.gz"
 *  → "4.0.0_2609012008". This is what the box reports once the build lands, so
 *  it is also how we check afterwards that it did. */
function buildFromUrl(url?: string): string {
  const file = String(url ?? '').split('?')[0].split('/').pop() ?? '';
  return file.replace(/^Simnovator-/i, '').replace(/\.tar\.gz$/i, '');
}

/** Anything that has gone wrong. A run containing one of these prints in full;
 *  a run without one prints almost nothing. */
function isFailure(e: any): boolean {
  return isErr(e) || (e?.type === 'step' && e.status === 'fail') || (e?.type === 'done' && e.ok === false);
}

/**
 * One installer event → the line the operator sees, or null to drop it.
 *
 * A working install is two facts: which build was on the box, and which build
 * is going on. wget, tar, the extract listing, the poll heartbeats and the
 * per-phase ok markers are the installer talking to itself — they are still
 * recorded (every event is on disk, and Install Progress on the left ticks off
 * the same stream), just not printed here.
 *
 * `verbose` is decided for the run as a whole by streamRowsFor: a failed
 * install prints everything the box said about why.
 *
 * Shared by the live stream and by the replay that rebuilds the log after a
 * page refresh, so a reloaded install reads exactly like the one you watched.
 */
function streamRowFor(e: any, verbose: boolean): StreamRow | null {
  if (e?.type === 'log') {
    if (!isErr(e) && !verbose) return null;
    // Even in verbose mode, drop SimQA's own plumbing: buildId / target /
    // build URL / browser / post-login URL and every [trace:…] line describe
    // how SimQA is driving Cockpit, not what is happening to the build.
    // Errors are never dropped.
    const line = String(e.line ?? '');
    const isPlumbing = !isErr(e)
      && (/^\[trace:/.test(line)
        || /^buildId=/.test(line)
        || /^target: /.test(line)
        || /^using build URL: /.test(line)
        || /^using browser: /.test(line)
        || /^post-login url: /.test(line)
        // Locating Cockpit's terminal iframe — three lines of DOM spelunking
        // that say nothing about the build.
        || /^\[frames @/.test(line)
        || /^\s+· name=/.test(line)
        || /^terminal frame: /.test(line));
    return isPlumbing ? null : { kind: 'log', text: line, bad: isErr(e) };
  }
  if (e?.type === 'step') {
    if (e.status !== 'fail' && !verbose) return null;
    // launch / login / terminal are SimQA getting itself into position — they
    // say nothing about the build unless they are what broke.
    const setup = e.step === 'launch' || e.step === 'login' || e.step === 'terminal';
    if (setup && e.status !== 'fail') return null;
    return {
      kind: 'step',
      text: `${e.step} ${e.status}${e.durationMs ? ` (${(e.durationMs / 1000).toFixed(1)}s)` : ''}${e.detail ? ' — ' + e.detail : ''}`,
      bad: e.status === 'fail',
    };
  }
  if (e?.type === 'done') {
    const ok = !!e.ok;
    return {
      kind: 'done',
      text: ok ? `install finished in ${(e.durationMs / 1000).toFixed(0)}s — waiting for the box to come back` : 'install failed',
      bad: !ok,
    };
  }
  return null;
}

/**
 * The whole log, in order, with the quiet/verbose switch applied.
 *
 * Verbosity is a property of the RUN, not a latch that flips part-way through.
 * The installer's diagnosis precedes its failure marker — on a bad exit it
 * tails /tmp/master_setup.log and greps it, and only then emits
 * `step install fail` — so latching on the marker would hide the very lines
 * that explain the failure.
 */
function streamRowsFor(events: any[]): StreamRow[] {
  const verbose = events.some(isFailure);
  return events.map((e) => streamRowFor(e, verbose)).filter((x): x is StreamRow => !!x);
}

function StatusPill({ status }: { status: StepStatus }) {
  const map: Record<StepStatus, string> = {
    pass:    'bg-success-50 text-success-700 border-success-200',
    fail:    'bg-red-50 text-red-700 border-red-200',
    skip:    'bg-slate-50 text-slate-500 border-slate-200',
    running: 'bg-primary-50 text-primary-700 border-primary-200',
    pending: 'bg-slate-50 text-slate-400 border-slate-200',
  };
  return <span className={`text-[10px] font-semibold uppercase tracking-wide rounded border px-1.5 py-0.5 ${map[status]}`}>{status}</span>;
}

export default function BuildValidationPage() {
  const [systems, setSystems] = useState<SystemRow[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [systemId, setSystemId] = useState('');
  const [wantInstall, setWantInstall] = useState(false);
  const [buildUrl, setBuildUrl] = useState('');
  const [ueId, setUeId] = useState('');
  const [appId, setAppId] = useState('');
  // The account ./install SSHes to the UE and app-server hosts as. It needs
  // passwordless SSH from the Simnovator, so the right value is whichever user
  // that box holds a key for. Editable because that is lab configuration, not
  // a constant: sysadmin is what these boxes accept today, root is refused.
  const [sshUser, setSshUser] = useState('sysadmin');
  const [skips, setSkips] = useState<Record<string, boolean>>({});
  // All four ticked, every time: Install Build runs the whole checklist after
  // the box comes back, and a build that is only partly verified is the thing
  // this page exists to prevent. Still individually untickable before you
  // start, for a run where one check is knowingly not wanted.
  const [checks, setChecks] = useState<Record<string, boolean>>({
    reachable: true, login: true, 'sample-tests': true, 'run-tests': true,
  });
  const [busy, setBusy] = useState(false);
  /** The verification run in flight, so Cancel has something to address — the
   *  run is one long POST, so stopping it means telling the server, not
   *  aborting a fetch. */
  const [runningCheckId, setRunningCheckId] = useState<string | null>(null);
  const [canceling, setCanceling] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const [err, setErr] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Install observation
  const [watching, setWatching] = useState(false);
  const [installLog, setInstallLog] = useState<Array<{ step: string; status: StepStatus; detail: string; at: string }>>([]);
  const baselineBuild = useRef<string | undefined>(undefined);
  const watchTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  /** Set by installBuild so the watcher knows this install was driven from
   *  here and should run the verification the moment the box comes back. */
  const autoVerify = useRef(false);

  // The real install: Build Check used to only PRINT the wget/tar/./install
  // commands for the operator to paste into Cockpit themselves, then watch the
  // box come back. These drive src/lib/buildInstaller.ts instead, which opens
  // Cockpit's terminal and runs them.
  const [installing, setInstalling] = useState(false);
  const [installStream, setInstallStream] = useState<Array<{ kind: 'log' | 'step' | 'done'; text: string; bad?: boolean }>>([]);
  const [installEvents, setInstallEvents] = useState<StreamEvent[]>([]);
  const [installFinished, setInstallFinished] = useState(false);
  const installAbort = useRef<AbortController | null>(null);
  /** An install this tab is NOT driving — restored from disk on load. Set while
   *  it is still running on the box, so the page shows it as in progress and
   *  can still cancel it. */
  const [remoteRun, setRemoteRun] = useState<{ buildId: string } | null>(null);

  // Systems AND the topology profiles, because which UE / App Server belong to
  // a Simnovator is a property of the lab wiring, not something the operator
  // should have to remember. /api/inventory carries both.
  useEffect(() => {
    fetch('/api/inventory').then((r) => r.json()).then((j) => {
      setSystems(j.systems ?? []);
      setProfiles(j.profiles ?? []);
      const sims = (j.systems ?? []).filter((s: SystemRow) => s.type === 'SIMNOVATOR' || s.type === 'SIMNOVATOR_GUI');
      if (sims[0]) setSystemId(sims[0].id);
    }).catch(() => { setSystems([]); setProfiles([]); });
    return () => { if (watchTimer.current) clearInterval(watchTimer.current); };
  }, []);

  // Follow the topology whenever the Simnovator changes: picking .102 should
  // bring its own UE (.101) and App Server (.100) with it. Falls back to the
  // first machine of each type only when no profile binds them, so an
  // un-wired system still offers something sensible rather than nothing.
  useEffect(() => {
    if (!systemId) return;
    const p = profiles.find((x) => x.simnovator === systemId);
    const byId = (id?: string) => (id ? systems.find((s) => s.id === id) : undefined);
    const ue = byId(p?.uesim) ?? systems.find((s) => s.type === 'UESIM');
    const app = byId(p?.appserver) ?? systems.find((s) => s.type === 'APPSERVER');
    setUeId(ue?.id ?? '');
    setAppId(app?.id ?? '');
  }, [systemId, profiles, systems]);

  const simSystems = useMemo(() => systems.filter((s) => s.type === 'SIMNOVATOR' || s.type === 'SIMNOVATOR_GUI'), [systems]);
  const ueSystems  = useMemo(() => systems.filter((s) => s.type === 'UESIM'), [systems]);
  const appSystems = useMemo(() => systems.filter((s) => s.type === 'APPSERVER'), [systems]);
  const sim = simSystems.find((s) => s.id === systemId);

  // ── Restore the last run for this box ────────────────────────────────────
  //
  // All of this was already on disk: the installer writes every event to
  // data/builds/<buildId>/events.ndjson and each verification is saved as a
  // report. The page just never read any of it back, so a refresh — or opening
  // the page on a second machine — showed an empty card even while the install
  // was still running on the box. This replays both, and if the install is
  // still going it keeps polling, so a refresh mid-install rejoins it instead
  // of losing it.
  const hydratedFor = useRef<string>('');
  useEffect(() => {
    // Never overwrite a run this tab is actively driving or watching.
    if (!sim || !systemId || installing || busy) return;
    if (hydratedFor.current === systemId) return;
    hydratedFor.current = systemId;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const host = sim.host;

    /** Ask the box which build it is on, and tick "Installation completed"
     *  only if that is the build this run installed. After a refresh there is
     *  no before/after baseline to compare, so the build we asked for is the
     *  honest test — and it is a stronger one than "the version changed". */
    const confirmLanded = async (url?: string) => {
      const want = buildFromUrl(url);
      if (!want) return;
      try {
        const r = await fetch('/api/build-validation', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ observeInstall: { host } }),
        });
        const j = await r.json();
        const detail = String(j?.observation?.detail ?? '');
        const on = detail.match(/build ([\w.\-_]+)/)?.[1];
        if (cancelled || !on || on !== want) return;
        setInstallLog([{ step: 'completed', status: 'pass', detail, at: new Date().toISOString() }]);
      } catch { /* the box being unreachable is not a reason to lose the log */ }
    };

    const pull = async () => {
      try {
        const r = await fetch(`/api/build-install?systemId=${encodeURIComponent(systemId)}`);
        const j = await r.json();
        if (cancelled) return;
        const run = j?.run;
        if (!run) {
          // This box has no install history — show its own blank slate rather
          // than the previous box's log.
          setInstallEvents([]); setInstallStream([]); setInstallFinished(false); setInstallLog([]);
          setRemoteRun(null);
          return;
        }

        const events: StreamEvent[] = Array.isArray(run.events) ? run.events : [];
        const rows = streamRowsFor(events);
        const build = buildFromUrl(run.buildUrl) || run.buildId;
        setInstallEvents(events);
        setInstallStream([
          { kind: 'log', text: `installing build on ${host}: ${build}` },
          ...rows,
          ...(run.stalled ? [{ kind: 'done' as const, text: 'install interrupted — SimQA stopped receiving output from the box (server restarted?). Nothing was rolled back; re-run to be sure.', bad: true }] : []),
        ]);
        setInstallFinished(!run.running);
        setWantInstall(true);
        // Only fill the field in — a URL the operator has already typed is
        // theirs, not something a restore should overwrite.
        setBuildUrl((prev) => prev || String(run.buildUrl ?? ''));

        setRemoteRun(run.running ? { buildId: String(run.buildId) } : null);
        if (run.running) { timer = setTimeout(pull, 4000); return; }
        await confirmLanded(run.buildUrl);
      } catch { /* restoring is best-effort */ }
    };

    // The verification report is stored separately from the install stream, so
    // a page that was refreshed after Run Checks gets its results back too.
    const pullReport = async () => {
      try {
        const r = await fetch(`/api/build-validation?systemId=${encodeURIComponent(systemId)}`);
        const j = await r.json();
        if (cancelled) return;
        setReport(j?.report ?? null);
        setExpanded(new Set(((j?.report?.groups ?? []) as CheckGroup[]).filter((g) => g.status === 'fail').map((g) => g.id)));
      } catch { /* best-effort */ }
    };

    void pull();
    void pullReport();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [sim, systemId, installing, busy]);

  const commands = useMemo(() => {
    const url = buildUrl.trim();
    const file = url ? (url.split('/').pop() || 'simnovator.tar.gz').split('?')[0] : '<build>.tar.gz';
    const ueHost = ueSystems.find((s) => s.id === ueId)?.host;
    const appHost = appSystems.find((s) => s.id === appId)?.host;
    const parts: string[] = [];
    // Same user the request below sends. These two used to disagree — the
    // preview said root@ while the install actually ran as sysadmin@ — so the
    // copyable commands were not the commands SimQA ran.
    const u = sshUser.trim() || 'sysadmin';
    if (ueHost) parts.push(`--ue ${u}@${ueHost}`);
    if (appHost) parts.push(`--app ${u}@${appHost}`);
    for (const f of SKIP_FLAGS) if (skips[f]) parts.push(f);
    return [
      `wget --no-check-certificate -c "${url || '<paste-build-url>'}"`,
      `tar -zxvf ${file}`,
      `./install ${parts.join(' ')}`.replace(/\s+/g, ' ').trim(),
    ];
  }, [buildUrl, ueId, appId, skips, ueSystems, appSystems, sshUser]);

  const selectedChecks = useMemo(() => Object.keys(checks).filter((k) => checks[k]), [checks]);

  /** Poll the box while the operator runs the installer in Cockpit. */
  async function startWatching(keepBaseline = false) {
    if (!sim) return;
    setWatching(true);
    if (!keepBaseline) setInstallLog([]);
    // Record what build is on the box now, so "came back on a NEW build" is
    // distinguishable from "never went away". Skipped when installBuild()
    // already captured it BEFORE the install started — taking it now would
    // read the new build and make any change invisible.
    if (!keepBaseline) try {
      const r = await fetch('/api/build-validation', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ observeInstall: { host: sim.host } }),
      });
      const j = await r.json();
      const m = String(j?.observation?.detail ?? '').match(/build ([\w.\-_]+)/);
      baselineBuild.current = m?.[1];
    } catch { /* baseline is optional */ }

    const tick = async () => {
      try {
        const r = await fetch('/api/build-validation', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ observeInstall: { host: sim.host, baselineBuild: baselineBuild.current } }),
        });
        const j = await r.json();
        if (j?.observation) {
          setInstallLog((prev) => {
            const last = prev[prev.length - 1];
            // Only append when something changed, so a long install does not
            // produce hundreds of identical lines.
            if (last && last.step === j.observation.step && last.detail === j.observation.detail) return prev;
            return [...prev, j.observation];
          });
          if (j.observation.step === 'completed' && j.observation.status === 'pass') {
            stopWatching();
            // The box has come back on the new build — that is the moment the
            // verification is meaningful, and it is the whole point of having
            // installed. Run it here rather than leaving the operator to click
            // Run: waiting for an install to finish and then remembering to
            // verify is exactly the step that gets skipped.
            //
            // Only for an install driven from this page (the flag is set by
            // installBuild), and only once — a manual "watch the box" does not
            // silently start a validation nobody asked for.
            if (autoVerify.current) {
              autoVerify.current = false;
              // Nothing ticked means nothing to run. Say so rather than
              // announcing a verification and then doing nothing, which is
              // what happened once the checks stopped being pre-ticked.
              if (selectedChecks.length === 0) {
                setInstallStream((p) => [...p, {
                  kind: 'done',
                  text: 'box is up on the new build — no verification checks are selected, so none were run',
                }]);
              } else {
                setInstallStream((p) => [...p, {
                  kind: 'done',
                  text: `box is up on the new build — running ${selectedChecks.length} verification check(s) automatically`,
                }]);
                void runChecks();
              }
            }
          }
        }
      } catch { /* keep polling */ }
    };
    await tick();
    watchTimer.current = setInterval(tick, 10_000);
  }
  function stopWatching() {
    setWatching(false);
    if (watchTimer.current) { clearInterval(watchTimer.current); watchTimer.current = null; }
  }

  /**
   * Actually install the build.
   *
   * POSTs to /api/build-install, which drives the Cockpit terminal over
   * Chromium and runs wget, tar and ./install on the box. The response is a
   * stream of newline-delimited JSON events, so the log appears as it happens
   * rather than after a ten-minute wait.
   *
   * When the install reports done, startWatching() takes over and polls the
   * box until it answers on a DIFFERENT build than the one it had before —
   * which is what "reflected in the Simnovator" actually means.
   */
  async function installBuild() {
    if (!sim) return;
    const url = buildUrl.trim();
    if (!url) { setErr('Paste a build URL first — that is what gets installed.'); return; }

    const ue = ueSystems.find((s2) => s2.id === ueId);
    const app = appSystems.find((s2) => s2.id === appId);
    // The Simnovator installer requires both; saying so here beats failing
    // several minutes in with "Please provide UE/App credentials".
    if (!ue || !app) {
      setErr('The installer needs both a UE and an App Server — pick them above, or add them to this Simnovator’s topology profile.');
      return;
    }

    setErr(''); setWantInstall(true); setInstalling(true);
    setInstallStream([]); setInstallEvents([]); setInstallFinished(false); setInstallLog([]); setRemoteRun(null);
    // Verify as soon as the box comes back on the new build — see startWatching.
    autoVerify.current = true;
    setReport(null); setExpanded(new Set());

    // The two lines that are not the installer's: which build is on the box and
    // which one is going on. They stay at the top of the log while the rows
    // below are recomputed from the event stream (streamRowsFor decides how
    // much of it to print once it knows whether the run failed).
    const head: StreamRow[] = [];

    // What is on the box now, so "came back on a NEW build" is distinguishable
    // from "never went away".
    try {
      const r0 = await fetch('/api/build-validation', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ observeInstall: { host: sim.host } }),
      });
      const j0 = await r0.json();
      baselineBuild.current = String(j0?.observation?.detail ?? '').match(/build ([\w.\-_]+)/)?.[1];
      if (baselineBuild.current) {
        head.push({ kind: 'log', text: `current build on ${sim.host}: ${baselineBuild.current}` });
        setInstallStream([...head]);
      }
    } catch { /* baseline is optional */ }

    // The two facts worth stating up front: which box, and which build is
    // going onto it. Everything the installer does after this is either its own
    // output or a step marker — the browser launch / Cockpit login / terminal
    // attach are SimQA's plumbing and are filtered out below.
    const newBuild = buildFromUrl(url) || url;
    head.push({ kind: 'log', text: `installing build on ${sim.host}: ${newBuild}` });
    setInstallStream([...head]);

    const ctrl = new AbortController();
    installAbort.current = ctrl;
    try {
      const res = await fetch('/api/build-install', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctrl.signal,
        body: JSON.stringify({
          systemId,
          buildUrl: url,
          hosts: [
            { flag: '--ue', ip: ue.host, user: sshUser.trim() || undefined },
            { flag: '--app', ip: app.host, user: sshUser.trim() || undefined },
          ],
          skip: {
            app_server:  !!skips['--no_app_server'],
            app_manager: !!skips['--no_app_manager'],
            simnovator:  !!skips['--no_simnovator'],
            ue:          !!skips['--no_ue'],
            oru:         !!skips['--no_oru'],
          },
        }),
      });
      if (!res.ok || !res.body) throw new Error(`installer returned HTTP ${res.status}`);

      // Newline-delimited JSON, so the log renders as the install runs.
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let ok = false;
      const events: any[] = [];
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split(String.fromCharCode(10));
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          let e: any;
          try { e = JSON.parse(line); } catch { continue; }
          if (e.type === 'done') ok = !!e.ok;
          // Rebuilt from the whole run rather than appended, because the first
          // failure retroactively unhides everything before it — see
          // streamRowsFor. Cheap: a run is a few hundred events.
          events.push(e);
          setInstallEvents(events.slice());
          setInstallStream([...head, ...streamRowsFor(events)]);
        }
      }
      // Always ask the box, whatever the installer's exit code said.
      //
      // Those two signals genuinely disagree. A real run of this build on .102
      // ended `./install` with exit 1 — "FAILED : Please check App Server
      // credentials", an SSH key rejected on a late step — and yet the App
      // Server, the UE simulator and the Simnovator manager had all installed,
      // and the box came back reporting the new build. Trusting the exit code
      // alone would have reported that as a failed install. The box's own
      // version is the authority on whether the build landed; the exit code
      // only says whether the installer finished cleanly.
      setInstallFinished(true);
      if (!ok) {
        setErr('The installer exited with an error — checking whether the build landed anyway. See the log below for the failing step.');
      }
      await startWatching(true);
    } catch (e: any) {
      if (e?.name !== 'AbortError') setErr(e?.message ?? String(e));
    } finally {
      setInstalling(false);
      installAbort.current = null;
    }
  }

  /**
   * Stop the install on the box, not just in this tab.
   *
   * Dropping the stream no longer cancels anything — that is what made a
   * refresh kill a ten-minute install — so Cancel has to say so explicitly.
   * The DELETE writes a marker the installer checks at each checkpoint; the
   * abort() just stops rendering here.
   */
  function cancelInstall() {
    const id = buildId ?? remoteRun?.buildId;
    if (id) fetch(`/api/build-install?buildId=${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => { /* the abort below still stops this tab */ });
    try { installAbort.current?.abort(); } catch { /* ignore */ }
    setInstalling(false);
    setRemoteRun(null);
    // Cancelling means the operator no longer wants this install; a validation
    // firing afterwards because the box happened to come back would be the
    // opposite of what they asked for.
    autoVerify.current = false;
  }

  async function runChecks() {
    if (!systemId || selectedChecks.length === 0) return;
    setBusy(true); setErr(''); setReport(null); setExpanded(new Set());

    // The run is one long POST, so its own response says nothing until every
    // check is finished — and Run Test Cases executes on hardware for minutes.
    // The server publishes the report after each group; we name the run so we
    // can poll for those partials and let each check settle as it completes,
    // rather than showing four spinners for the whole run.
    const runId = `bv-${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 7)}`;
    setRunningCheckId(runId);
    let polling = true;
    const poll = async () => {
      while (polling) {
        await new Promise((r) => setTimeout(r, 2000));
        if (!polling) break;
        try {
          const r = await fetch(`/api/build-validation?id=${encodeURIComponent(runId)}`);
          const j = await r.json();
          // The POST's own result is the authority — never let a partial
          // overwrite the finished report if the poll lands late.
          if (polling && j?.ok && j.report) setReport(j.report);
        } catch { /* the POST is still the source of truth */ }
      }
    };
    void poll();

    try {
      const r = await fetch('/api/build-validation', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runId,
          systemId, checks: selectedChecks,
          ueSystemId: ueId || undefined, appServerSystemId: appId || undefined,
          install: wantInstall ? { buildUrl: buildUrl.trim() || undefined, skipFlags: SKIP_FLAGS.filter((f) => skips[f]), commands } : undefined,
        }),
      });
      const j = await r.json();
      polling = false;
      if (!j.ok) { setErr(j.error ?? 'run failed'); return; }
      setReport(j.report);
      // Open failures straight away — that is what the operator came for.
      setExpanded(new Set((j.report.groups ?? []).filter((g: CheckGroup) => g.status === 'fail').map((g: CheckGroup) => g.id)));
    } catch (e: any) { setErr(e?.message ?? String(e)); }
    finally { polling = false; setBusy(false); setRunningCheckId(null); }
  }

  /**
   * Stop the verification — on the box, not just on screen.
   *
   * The run is a single long POST, so there is nothing here to abort that would
   * reach it. The DELETE writes a marker the run checks between groups and
   * inside the execution wait loop, where it also stops the testcase on the
   * hardware. The report that comes back marks whatever had not run as
   * canceled, so the page still ends up showing what did.
   */
  async function cancelChecks() {
    if (!runningCheckId) return;
    setCanceling(true);
    try {
      await fetch(`/api/build-validation?id=${encodeURIComponent(runningCheckId)}`, { method: 'DELETE' });
    } catch { /* the run may already have finished */ }
    finally { setCanceling(false); }
  }

  // The checklist: ticked from what the installer actually printed, plus the
  // box's own version, which is the only thing that settles "completed".
  const versionChanged = installLog.some((l) => l.step === 'completed' && l.status === 'pass');
  const stepStates = useMemo(
    () => deriveInstallSteps(installEvents, { versionChanged, finished: installFinished }),
    [installEvents, versionChanged, installFinished],
  );

  /** The build id SimQA stamped this run with — the directory under data/builds
   *  holding its log and screenshots. Emitted as the installer's first line. */
  const buildId = useMemo(() => {
    for (const e of installEvents) {
      const m = typeof e.line === 'string' ? e.line.match(/buildId=(\S+)/) : null;
      if (m) return m[1];
    }
    return undefined;
  }, [installEvents]);

  /**
   * The banner while a build is going on: which build, which box, since when.
   *
   * Covers the install this tab is driving, an install restored from disk after
   * a refresh, and the wait afterwards for the box to come back — all three are
   * "installing" as far as anyone reading the page is concerned.
   *
   * The start time comes from the first installer event rather than a clock
   * started here, so a restored run shows when it actually began, not when the
   * page was reloaded.
   */
  const installBanner = useMemo(() => {
    if (!installing && !remoteRun && !watching) return null;
    const startedAt = installEvents.find((e) => typeof e.ts === 'number')?.ts;
    return {
      build: buildFromUrl(buildUrl.trim()) || buildId || 'the build',
      host: sim?.host,
      startedAt,
    };
  }, [installing, remoteRun, watching, installEvents, buildUrl, buildId, sim]);

  /**
   * The install, as a row in the RESULTS panel.
   *
   * The install already streams into Install Progress on the left, but the
   * results panel is where the outcome is read, and it showed only the
   * verification checks — so a build that failed to install left the results
   * side blank while the reason sat in another column.
   *
   * Every line here is one the installer or the box actually produced:
   * deriveInstallSteps records WHICH line earned each tick (`because`), and the
   * final word comes from the box reporting a new version, not from the
   * installer's exit code — a real run exited 1 on a late SSH key having
   * installed the build regardless.
   */
  const installSummary = useMemo(() => {
    if (!installing && !watching && !remoteRun && installEvents.length === 0) return null;

    const running = installing || watching || !!remoteRun;
    const status: StepStatus = running ? 'running' : versionChanged ? 'pass' : installFinished ? 'fail' : 'pending';

    // The build being installed, as an engineer names it — the version out of
    // the tarball filename, e.g. 4.0.0_2609012008 — not SimQA's own run id.
    // After the install the box's reported version is the authority, so that
    // one wins when we have it.
    const fromUrl = buildFromUrl(buildUrl.trim());
    const reported = installLog.filter((l) => l.step === 'completed').slice(-1)[0]?.detail?.match(/build ([\w.\-_]+)/)?.[1];
    const build = reported || fromUrl || buildId || 'the build';

    // Failures keep their reason. Everything else is one line: which build,
    // and whether it landed — the step-by-step evidence is in Install
    // Progress on the left, and repeating it here was noise.
    const failure = installLog.filter((l) => l.status === 'fail').slice(-1)[0]?.detail
      ?? installStream.filter((l) => l.bad).slice(-1)[0]?.text;

    const headline = running
      ? (watching && !installing ? `Installing ${build} — waiting for the box to come back` : `Installing ${build}`)
      : versionChanged
        ? `Installed successfully — ${build}`
        : installFinished
          ? `Could not install ${build}${failure ? ` — ${failure}` : ''}`
          : 'Install has not started';

    return { status, headline };
  }, [installing, watching, remoteRun, installEvents, installFinished, versionChanged, installLog, installStream, buildId, buildUrl]);

  const toggleExpand = (id: string) => setExpanded((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  /* The install as one line in the results: which build, and whether it
     landed. Not expandable — the step-by-step evidence is in Install Progress
     on the left, and repeating it here was noise. */
  const installRow = installSummary ? (
    <li className="px-3 py-2 flex items-start gap-2">
      <span className="mt-0.5 shrink-0"><StatusIcon status={installSummary.status} /></span>
      <span className="min-w-0 flex-1">
        <span className="text-xs font-medium text-slate-800">Build installation</span>
        <span className={`block text-[11px] ${installSummary.status === 'fail' ? 'text-red-700' : 'text-slate-500'}`}>
          {installSummary.headline}
        </span>
      </span>
      <StatusPill status={installSummary.status} />
    </li>
  ) : null;

  const inputCls = 'w-full rounded-md border border-slate-300 px-2 py-1.5 text-xs bg-white';

  return (
    // The page owns the full height of the app shell's content column and
    // scrolls inside itself, so the Header stays put. As a bare fragment it was
    // the shell's column that scrolled and the Header — which is only `sticky`
    // — travelled with it, taking Install Build and Run out of reach.
    <div className="flex-1 min-h-0 flex flex-col">
      <Header
        title="Build Validation"
        subtitle="Install a Simnovator build and automatically run the validation checklist"
        left={<BackToRunHistory />}
        right={
          <div className="flex items-center gap-2">
            {/* Install Build now RUNS the install — SimQA drives this box's
                Cockpit terminal — and then waits for the box to come back on a
                different build. It used to only print the commands to paste. */}
            {/* Same model as Run Checks beside it: one primary button that
                turns into a spinner with a present-tense label while it works
                and disables itself, rather than a differently-styled button
                that swaps for a red one. Cancel moves to a quiet ghost button
                shown only while installing — losing the ability to abort a
                ten-minute install would be a real cost, so it stays. */}
            {/* `remoteRun` covers the install this tab is not driving — after a
                refresh the run is still going on the box, and the page rejoins
                it, so it must still look and behave like an install. */}
            {installing || remoteRun ? (
              <>
                <Button size="sm" disabled>
                  <Loader2 className="h-4 w-4 animate-spin" />Installing…
                </Button>
                <Button size="sm" variant="ghost" onClick={cancelInstall}>Cancel</Button>
              </>
            ) : (
              <Button
                size="sm"
                onClick={installBuild}
                disabled={busy || !sim || watching || !buildUrl.trim()}
                title={buildUrl.trim() ? `Install ${buildUrl.trim()} on ${sim?.host ?? ''}, then run the verification checklist` : 'Paste a build URL first'}
              >
                {watching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Terminal className="h-4 w-4" />}
                {watching ? 'Waiting for the box…' : 'Install Build and Verify'}
              </Button>
            )}
            {/* No separate Run Checks button: verification is not a thing you
                remember to do afterwards, it is part of installing a build.
                Install Build installs, waits for the box to come back on the
                new version, then runs the whole checklist itself. */}
            {/* Verifying gets a Cancel for the same reason installing does:
                Run Test Cases executes on hardware for minutes, and being
                unable to stop it is a real cost. */}
            {busy ? (
              <>
                <Button size="sm" disabled>
                  <Loader2 className="h-4 w-4 animate-spin" />Verifying…
                </Button>
                <Button
                  size="sm" variant="ghost" onClick={cancelChecks}
                  disabled={!runningCheckId || canceling}
                  title="Stop the verification — the testcase running on the box is stopped too"
                >
                  {canceling ? 'Stopping…' : 'Cancel'}
                </Button>
              </>
            ) : null}
          </div>
        }
      />

      {/* Fills the space under the header. The verdict banner and any error
          stay put here; only the two columns below scroll. */}
      <main className="flex-1 min-h-0 flex flex-col p-4 gap-3">
        {/* The banner. While a build is going on it names that build; once the
            verification has run it names the build the box is now on.
            SimQA's own run id used to sit on the right — it identifies a file
            on disk, not anything the operator can act on, so it is gone. */}
        {installBanner ? (
          <div className="rounded-lg border px-4 py-2.5 flex items-center gap-3 bg-primary-50 border-primary-200">
            <Loader2 className="h-5 w-5 animate-spin text-primary-700" />
            <div className="min-w-0">
              <div className="text-sm font-semibold text-primary-800">INSTALLING BUILD</div>
              <div className="text-[11px] text-slate-600">
                Build ID <span className="font-mono">{installBanner.build}</span>
                {installBanner.host ? ` · ${installBanner.host}` : ''}
                {installBanner.startedAt ? ` · started ${new Date(installBanner.startedAt).toLocaleString()}` : ''}
              </div>
            </div>
          </div>
        ) : report && report.status !== 'running' ? (
          <div className={`rounded-lg border px-4 py-2.5 flex items-center gap-3 ${
            report.status === 'canceled' ? 'bg-amber-50 border-amber-200'
              : report.ok ? 'bg-success-50 border-success-200' : 'bg-red-50 border-red-200'}`}>
            {report.status === 'canceled' ? <MinusCircle className="h-5 w-5 text-amber-700" />
              : report.ok ? <ShieldCheck className="h-5 w-5 text-success-700" />
              : <AlertTriangle className="h-5 w-5 text-red-700" />}
            <div className="min-w-0">
              <div className={`text-sm font-semibold ${
                report.status === 'canceled' ? 'text-amber-800'
                  : report.ok ? 'text-success-800' : 'text-red-800'}`}>
                {report.status === 'canceled' ? 'BUILD VALIDATION CANCELED'
                  : report.ok ? 'BUILD VALIDATION PASSED' : 'BUILD VALIDATION FAILED'}
              </div>
              <div className="text-[11px] text-slate-600">
                Current Build ID <span className="font-mono">{report.buildVersion ?? '—'}</span> · {report.host}
                {' · '}{new Date(report.startedAt).toLocaleString()}
                {report.finishedAt ? ` → ${new Date(report.finishedAt).toLocaleTimeString()}` : ''}
              </div>
            </div>
          </div>
        ) : null}

        {err ? <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{err}</div> : null}

        {/* Two independent panes: the install form on the left keeps its place
            while the install log and checklist on the right scroll, and vice
            versa. Previously the whole page scrolled as one, so watching the
            log meant losing sight of the controls.
            min-h-0 on the grid is what lets the columns be shorter than their
            content — without it each column grows to fit and neither scrolls. */}
        <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-2 gap-3">
          {/* ───── Left: system + install ───── */}
          <div className="space-y-3 min-h-0 overflow-y-auto pr-1">
            <Card>
              <CardHeader><CardTitle>System</CardTitle></CardHeader>
              <CardBody className="space-y-2">
                <select value={systemId} onChange={(e) => setSystemId(e.target.value)} className={inputCls} disabled={busy}>
                  {simSystems.length === 0 ? <option value="">No Simnovator systems in inventory.yaml</option> : null}
                  {simSystems.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.host})</option>)}
                </select>
                <p className="text-[11px] text-slate-500">Pick the target Simnovator before installing or validating.</p>
              </CardBody>
            </Card>

            <Card>
              <CardHeader><CardTitle>Cockpit Install Plan</CardTitle></CardHeader>
              <CardBody className="space-y-2.5">
                <label className="flex items-start gap-2 text-xs">
                  <input type="checkbox" className="mt-0.5" checked={wantInstall} onChange={(e) => setWantInstall(e.target.checked)} />
                  <span className="font-medium text-slate-800">I want to install a new build</span>
                </label>
                {/* Rewritten twice over: SimQA no longer prints commands for
                    you to paste (it drives the terminal itself), and there is
                    no longer a separate Run Checks button. */}
                <p className="text-[11px] text-slate-500 leading-relaxed">
                  Paste the build URL and pick the UE and App Server, then click{' '}
                  <span className="font-medium">Install Build and Verify</span>. SimQA drives this Simnovator&apos;s
                  Cockpit terminal to run <code className="font-mono">wget</code>, <code className="font-mono">tar</code> and{' '}
                  <code className="font-mono">./install</code> itself, waits for the box to come back on the new
                  version, then runs the verification checklist.
                </p>

                {wantInstall ? (
                  <div className="space-y-2.5 pt-1 border-t border-slate-100">
                    <div>
                      <div className="text-[10px] uppercase tracking-wider text-slate-400 mb-1">Build URL</div>
                      <textarea
                        value={buildUrl} onChange={(e) => setBuildUrl(e.target.value)} rows={2}
                        placeholder="Paste Simnovator build URL here…"
                        className={`${inputCls} font-mono resize-y`}
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <div className="text-[10px] uppercase tracking-wider text-slate-400 mb-1">UE</div>
                        <select value={ueId} onChange={(e) => setUeId(e.target.value)} className={inputCls}>
                          <option value="">— none —</option>
                          {ueSystems.map((s) => <option key={s.id} value={s.id}>{s.host}</option>)}
                        </select>
                      </div>
                      <div>
                        <div className="text-[10px] uppercase tracking-wider text-slate-400 mb-1">App Server</div>
                        <select value={appId} onChange={(e) => setAppId(e.target.value)} className={inputCls}>
                          <option value="">— none —</option>
                          {appSystems.map((s) => <option key={s.id} value={s.id}>{s.host}</option>)}
                        </select>
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-wider text-slate-400 mb-1">
                        SSH user for UE / App <span className="normal-case tracking-normal text-slate-400">(editable)</span>
                      </div>
                      {/* Free text with a list of the accounts these boxes are
                          known to have — the right value is whichever one the
                          Simnovator holds a key for, which is lab config and
                          changes. Typing anything else is allowed on purpose. */}
                      <input
                        list="build-ssh-users"
                        value={sshUser}
                        onChange={(e) => setSshUser(e.target.value)}
                        placeholder="sysadmin"
                        spellCheck={false}
                        autoComplete="off"
                        className={`${inputCls} font-mono`}
                      />
                      <datalist id="build-ssh-users">
                        <option value="sysadmin" />
                        <option value="root" />
                        <option value="simnovus" />
                      </datalist>
                      <div className="text-[10px] text-slate-500 mt-1 leading-snug">
                        ./install SSHes from the Simnovator to these two hosts as this user, and it has no password
                        option — the Simnovator must already hold a key for it. sysadmin is what these boxes accept;
                        root is currently refused (<span className="font-mono">Permission denied (publickey)</span>).
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-wider text-slate-400 mb-1">Skip</div>
                      <div className="flex flex-wrap gap-x-3 gap-y-1">
                        {SKIP_FLAGS.map((f) => (
                          <label key={f} className="flex items-center gap-1.5 text-[11px] font-mono">
                            <input type="checkbox" checked={!!skips[f]} onChange={(e) => setSkips((s) => ({ ...s, [f]: e.target.checked }))} />
                            {f}
                          </label>
                        ))}
                      </div>
                    </div>
                    {/* The "Generated Installation Commands" block with its
                        Copy all button lived here, from when the operator
                        pasted wget / tar / ./install into Cockpit by hand.
                        SimQA runs them itself now, so it was instructions for a
                        job nobody does. The commands are still recorded on the
                        run and still appear in the install log as each one is
                        typed. */}
                  </div>
                ) : null}
              </CardBody>
            </Card>

          </div>

          {/* ───── Right: verification + results ───── */}
          <div className="space-y-3 min-h-0 overflow-y-auto pr-1">
            <Card>
              <CardHeader><CardTitle>Build Verification</CardTitle></CardHeader>
              <CardBody className="space-y-1.5">
                {VERIFICATIONS.map((v) => (
                  <label key={v.id} className="flex items-start gap-2 text-xs">
                    <input type="checkbox" className="mt-0.5" checked={!!checks[v.id]} onChange={(e) => setChecks((c) => ({ ...c, [v.id]: e.target.checked }))} disabled={busy} />
                    {/* Label only. The description used to sit under each one
                        explaining what it would do; the result now states what
                        it DID, with the actual hosts — which is the same
                        information at the point it is worth reading. Kept as
                        the checkbox's tooltip rather than deleted. */}
                    <span className="min-w-0 font-medium text-slate-800" title={v.hint}>{v.label}</span>
                  </label>
                ))}

                {/* Run Test Cases is one fixed testcase with one fixed
                    callbox configuration — a build check has to compare like
                    with like across builds, which a picker (or a name-matched
                    guess) cannot do. Stated here so it is clear what ticking
                    the box will actually do to the lab. */}
                {checks['run-tests'] ? (
                  <div className="ml-6 mt-1 space-y-1 border-l border-slate-200 pl-3 text-[11px] text-slate-600">
                    <div>
                      Runs <span className="font-mono text-slate-800">Buildcheck_SA_1Cell_1UEs_UDP</span> on the
                      selected Simnovator.
                    </div>
                    <div className="text-slate-500">
                      First links the callbox to this testcase&apos;s configuration —
                      <span className="font-mono"> enb.cfg → SA-1cell</span>,
                      <span className="font-mono"> mme.cfg → demo-mme.cfg</span>,
                      <span className="font-mono"> ims.cfg → demo-ims.cfg</span> — and restarts lte.
                      Executes on real hardware and takes minutes.
                    </div>
                  </div>
                ) : null}
              </CardBody>
            </Card>

            {wantInstall ? (
              <Card>
                {/* Watch install / Stop watching lived here, for when someone
                    ran the commands in Cockpit themselves and wanted SimQA to
                    observe from outside. There is no such flow now — Install
                    Build and Verify starts the watch itself as part of the run.
                    startWatching() is still called from installBuild. */}
                <CardHeader>
                  <CardTitle>Install Progress</CardTitle>
                </CardHeader>
                <CardBody className="space-y-2">
                  <p className="text-[11px] text-slate-500 leading-relaxed">
                    SimQA opens this box&apos;s Cockpit terminal and issues the <code className="font-mono">wget</code>,{' '}
                    <code className="font-mono">tar</code> and <code className="font-mono">./install</code> commands, streaming
                    the output below. The steps here are the outside view of the same install — the box dropping off and
                    returning on a new build, which is what proves it actually landed.
                  </p>

                  {installStream.length > 0 ? (
                    <div className="rounded-md border border-slate-200 bg-slate-900 text-slate-100 font-mono text-[10px] leading-relaxed max-h-56 overflow-y-auto p-2">
                      {installStream.map((l, i) => (
                        <div key={i} className={l.bad ? 'text-red-300' : l.kind === 'step' ? 'text-sky-300' : l.kind === 'done' ? 'text-emerald-300' : 'text-slate-300'}>
                          {l.kind === 'step' ? '-- ' : l.kind === 'done' ? '== ' : ''}{l.text}
                        </div>
                      ))}
                    </div>
                  ) : null}
                  <ul className="space-y-1.5">
                    {INSTALL_STEPS.map((st) => {
                      const d = stepStates[st.id] ?? { state: 'pending' as const };
                      // The checklist state model and the icon's are different
                      // vocabularies; map rather than conflate them.
                      const icon: StepStatus =
                        d.state === 'done' ? 'pass' : d.state === 'failed' ? 'fail' : d.state === 'running' ? 'running' : 'pending';
                      return (
                        <li key={st.id} className="flex items-start gap-2 text-[11px]">
                          <span className="mt-0.5"><StatusIcon status={icon} /></span>
                          <span className={
                            'min-w-[168px] ' +
                            (d.state === 'done' ? 'text-slate-800 font-medium'
                              : d.state === 'running' ? 'text-primary-700 font-medium'
                              : d.state === 'failed' ? 'text-red-700 font-medium'
                              : 'text-slate-400')
                          }>{st.label}</span>
                          <span className="text-slate-500 flex-1 leading-snug">
                            {/* What earned the tick, so it is auditable rather
                                than a green mark you have to take on faith. */}
                            {d.because ?? (d.state === 'pending' ? st.evidence : '')}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                  {installLog.length > 0 ? (
                    <div className="pt-1 border-t border-slate-100">
                      <div className="text-[10px] uppercase tracking-wider text-slate-400 mb-1">Observations</div>
                      <ul className="space-y-0.5 max-h-32 overflow-y-auto">
                        {installLog.map((l, i) => (
                          <li key={i} className="text-[10px] font-mono text-slate-500">
                            {new Date(l.at).toLocaleTimeString()} · {l.detail}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </CardBody>
              </Card>
            ) : null}

            <Card>
              <CardHeader className="flex items-center justify-between">
                <CardTitle>Results</CardTitle>
                {/* Not while the run is still publishing partials — `ok` is
                    false until the last group lands, and a mid-run "failures"
                    badge would be a verdict nothing has earned yet. */}
                {report && report.status !== 'running'
                  ? report.status === 'canceled'
                    ? <Badge tone="warning">canceled</Badge>
                    : report.ok ? <Badge tone="success">all passed</Badge> : <Badge tone="danger">failures</Badge>
                  : null}
              </CardHeader>
              <CardBody className="p-0">
                {busy && !report ? (
                  /* Only until the first partial arrives (~2s). After that the
                     list below renders the real report, so a check that has
                     finished reads pass or fail instead of spinning until the
                     hardware test — the slowest by minutes — comes back. */
                  <ul className="divide-y divide-slate-100">
                    {installRow}
                    {selectedChecks.map((id) => {
                      const v = VERIFICATIONS.find((x) => x.id === id);
                      return (
                        <li key={id} className="px-4 py-2.5 flex items-center gap-2 text-xs">
                          <Loader2 className="h-3.5 w-3.5 animate-spin text-primary-600" />
                          <span className="font-medium text-slate-800">{v?.label ?? id}</span>
                          {id === 'run-tests' ? (
                            <span className="text-slate-500">
                              — executing <span className="font-mono">Buildcheck_SA_1Cell_1UEs_UDP</span> on the box, this takes minutes
                            </span>
                          ) : null}
                          <StatusPill status="running" />
                        </li>
                      );
                    })}
                  </ul>
                ) : !report && !installSummary ? (
                  <div className="px-4 py-6 text-xs text-slate-500">Paste a build URL and click <span className="font-medium">Install Build and Verify</span> — the checklist runs on its own once the box comes back on the new build.</div>
                ) : (
                  <ul className="divide-y divide-slate-100">
                    {installRow}
                    {(report?.groups ?? []).map((g) => {
                      const open = expanded.has(g.id);
                      const Caret = open ? ChevronDown : ChevronRight;
                      return (
                        <li key={g.id}>
                          <button onClick={() => toggleExpand(g.id)} className="w-full text-left px-3 py-2 flex items-start gap-2 hover:bg-slate-50">
                            <Caret className="h-3.5 w-3.5 mt-0.5 text-slate-400 shrink-0" />
                            <span className="mt-0.5 shrink-0"><StatusIcon status={g.status} /></span>
                            <span className="min-w-0 flex-1">
                              <span className="text-xs font-medium text-slate-800">{g.label}</span>
                              <span className={`block text-[11px] ${g.status === 'fail' ? 'text-red-700' : 'text-slate-500'}`}>{g.detail}</span>
                            </span>
                            <StatusPill status={g.status} />
                          </button>
                          {open ? (
                            <div className="px-3 pb-2.5 pl-9 space-y-1.5 bg-slate-50/50">
                              {g.steps.length === 0 ? <div className="text-[11px] text-slate-400">no sub-steps recorded</div> : g.steps.map((s) => (
                                <div key={s.id} className="text-[11px]">
                                  <div className="flex items-center gap-1.5">
                                    <StatusIcon status={s.status} />
                                    <span className="font-medium text-slate-700">{s.label}</span>
                                    {typeof s.durationMs === 'number' ? <span className="text-slate-400">{(s.durationMs / 1000).toFixed(1)}s</span> : null}
                                    {s.startedAt ? <span className="text-slate-300 ml-auto font-mono text-[10px]">{new Date(s.startedAt).toLocaleTimeString()}</span> : null}
                                  </div>
                                  <div className={`ml-5 ${s.status === 'fail' ? 'text-red-700' : 'text-slate-500'}`}>{s.detail}</div>
                                  {s.status === 'fail' && s.expected ? <div className="ml-5 text-slate-400">Expected: {s.expected}</div> : null}
                                </div>
                              ))}
                            </div>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </CardBody>
            </Card>

            {/* The Report metadata card lived here — system, build, hosts,
                build URL, skip flags, timestamps and the saved-file path. It
                restated what the verdict banner and the check results already
                show, so it was removed. The run IS still saved to
                data/build-validation/<id>.json and still appears in Run
                History; only the panel is gone. */}
          </div>
        </div>
      </main>
    </div>
  );
}

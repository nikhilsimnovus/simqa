// Build Validation — install a Simnovator build, then prove it works.
//
// Two columns, because the two halves are independent jobs: the left is the
// install (plan the commands, watch the box come back), the right is the
// verification (pick checks, read results). A validate-only run uses the right
// column alone and never touches the left.
//
// One thing to be clear-eyed about: SimQA does NOT run the installer. The
// build is installed by pasting the generated commands into Cockpit, and SimQA
// does not drive that terminal session. So Install
// Progress reports what SimQA can *observe* from outside — the box dropping
// off and returning on a new build — and labels itself as observed rather than
// pretending to stream an installer log it cannot see.

'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Header } from '@/components/Header';
import { BackToRunHistory } from '@/components/BackToRunHistory';
import { Card, CardBody, CardHeader, CardTitle, Button, Badge } from '@/components/ui';
import {
  CheckCircle2, XCircle, MinusCircle, Loader2, Copy, ClipboardCheck, Terminal,
  ChevronRight, ChevronDown, Play, ShieldCheck, AlertTriangle,
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
  { id: 'run-tests',    label: 'Run Test Cases',         hint: 'Executes a 5G and an LTE testcase on real hardware — takes minutes' },
];

const SKIP_FLAGS = ['--no_app_server', '--no_app_manager', '--no_simnovator', '--no_ue', '--no_oru'];

// Mirrors INSTALL_STEPS in src/lib/buildValidation.ts. `observable` marks the
// steps SimQA can genuinely see from outside; the rest happen inside Cockpit.
const INSTALL_STEPS: Array<{ id: string; label: string; observable: boolean }> = [
  { id: 'download',   label: 'Build download',           observable: false },
  { id: 'extract',    label: 'Build extraction',         observable: false },
  { id: 'started',    label: 'Installation started',     observable: true },
  { id: 'simnovator', label: 'Simnovator installation',  observable: true },
  { id: 'ue',         label: 'UE configuration',         observable: true },
  { id: 'appserver',  label: 'App Server configuration', observable: true },
  { id: 'completed',  label: 'Installation completed',   observable: true },
];

function StatusIcon({ status }: { status: StepStatus }) {
  if (status === 'running') return <Loader2 className="h-3.5 w-3.5 animate-spin text-primary-600" />;
  if (status === 'pass')    return <CheckCircle2 className="h-3.5 w-3.5 text-success-600" />;
  if (status === 'fail')    return <XCircle className="h-3.5 w-3.5 text-red-600" />;
  if (status === 'skip')    return <MinusCircle className="h-3.5 w-3.5 text-slate-300" />;
  return <div className="h-3.5 w-3.5 rounded-full border border-slate-300" />;
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
  const [skips, setSkips] = useState<Record<string, boolean>>({});
  const [checks, setChecks] = useState<Record<string, boolean>>({ reachable: true, login: true, 'sample-tests': true, 'run-tests': false });
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const [err, setErr] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState(false);

  // Install observation
  const [watching, setWatching] = useState(false);
  const [installLog, setInstallLog] = useState<Array<{ step: string; status: StepStatus; detail: string; at: string }>>([]);
  const baselineBuild = useRef<string | undefined>(undefined);
  const watchTimer = useRef<ReturnType<typeof setInterval> | null>(null);

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

  const commands = useMemo(() => {
    const url = buildUrl.trim();
    const file = url ? (url.split('/').pop() || 'simnovator.tar.gz').split('?')[0] : '<build>.tar.gz';
    const ueHost = ueSystems.find((s) => s.id === ueId)?.host;
    const appHost = appSystems.find((s) => s.id === appId)?.host;
    const parts: string[] = [];
    if (ueHost) parts.push(`--ue root@${ueHost}`);
    if (appHost) parts.push(`--app root@${appHost}`);
    for (const f of SKIP_FLAGS) if (skips[f]) parts.push(f);
    return [
      `wget --no-check-certificate -c "${url || '<paste-build-url>'}"`,
      `tar -zxvf ${file}`,
      `./install ${parts.join(' ')}`.replace(/\s+/g, ' ').trim(),
    ];
  }, [buildUrl, ueId, appId, skips, ueSystems, appSystems]);

  const selectedChecks = useMemo(() => Object.keys(checks).filter((k) => checks[k]), [checks]);

  async function copyCommands() {
    try { await navigator.clipboard.writeText(commands.join('\n')); setCopied(true); setTimeout(() => setCopied(false), 1600); }
    catch { /* clipboard blocked — the block is selectable anyway */ }
  }

  /** Poll the box while the operator runs the installer in Cockpit. */
  async function startWatching() {
    if (!sim) return;
    setWatching(true);
    setInstallLog([]);
    // Record what build is on the box now, so "came back on a NEW build" is
    // distinguishable from "never went away".
    try {
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
          if (j.observation.step === 'completed' && j.observation.status === 'pass') stopWatching();
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

  async function runChecks() {
    if (!systemId || selectedChecks.length === 0) return;
    setBusy(true); setErr(''); setReport(null); setExpanded(new Set());
    try {
      const r = await fetch('/api/build-validation', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemId, checks: selectedChecks,
          ueSystemId: ueId || undefined, appServerSystemId: appId || undefined,
          install: wantInstall ? { buildUrl: buildUrl.trim() || undefined, skipFlags: SKIP_FLAGS.filter((f) => skips[f]), commands } : undefined,
        }),
      });
      const j = await r.json();
      if (!j.ok) { setErr(j.error ?? 'run failed'); return; }
      setReport(j.report);
      // Open failures straight away — that is what the operator came for.
      setExpanded(new Set((j.report.groups ?? []).filter((g: CheckGroup) => g.status === 'fail').map((g: CheckGroup) => g.id)));
    } catch (e: any) { setErr(e?.message ?? String(e)); }
    finally { setBusy(false); }
  }

  const toggleExpand = (id: string) => setExpanded((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const inputCls = 'w-full rounded-md border border-slate-300 px-2 py-1.5 text-xs bg-white';

  return (
    <>
      <Header
        title="Build Validation"
        subtitle="Install a Simnovator build and automatically run the validation checklist"
        left={<BackToRunHistory />}
        right={
          <div className="flex items-center gap-2">
            {/* Install Build ticks the install plan on and starts watching the
                box in one action — the installer itself still runs in Cockpit. */}
            <Button
              size="sm" variant="secondary"
              onClick={() => { setWantInstall(true); if (!watching) startWatching(); }}
              disabled={busy || !sim || watching}
            >
              <Terminal className="h-4 w-4" />{watching ? 'Watching install…' : 'Install Build'}
            </Button>
            <Button size="sm" onClick={runChecks} disabled={busy || !systemId || selectedChecks.length === 0}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              {busy ? 'Running…' : 'Run Checks'}
            </Button>
          </div>
        }
      />

      <main className="p-4 space-y-3">
        {/* Overall verdict banner */}
        {report ? (
          <div className={`rounded-lg border px-4 py-2.5 flex items-center gap-3 ${report.ok ? 'bg-success-50 border-success-200' : 'bg-red-50 border-red-200'}`}>
            {report.ok ? <ShieldCheck className="h-5 w-5 text-success-700" /> : <AlertTriangle className="h-5 w-5 text-red-700" />}
            <div className="min-w-0">
              <div className={`text-sm font-semibold ${report.ok ? 'text-success-800' : 'text-red-800'}`}>
                {report.ok ? 'BUILD VALIDATION PASSED' : 'BUILD VALIDATION FAILED'}
              </div>
              <div className="text-[11px] text-slate-600">
                {report.systemName ?? report.host} · build {report.buildVersion ?? '—'} · {new Date(report.startedAt).toLocaleString()}
                {report.finishedAt ? ` → ${new Date(report.finishedAt).toLocaleTimeString()}` : ''}
              </div>
            </div>
            <span className="ml-auto text-[11px] text-slate-500 font-mono">{report.id}</span>
          </div>
        ) : null}

        {err ? <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{err}</div> : null}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {/* ───── Left: system + install ───── */}
          <div className="space-y-3">
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
                <p className="text-[11px] text-slate-500 leading-relaxed">
                  Install a new Simnovator build or validate the current setup. Tick <span className="font-medium">I want to install a new build</span> to
                  generate the <code className="font-mono">wget</code>, <code className="font-mono">tar</code> and <code className="font-mono">./install</code> commands,
                  ready to paste into the Cockpit Terminal. Otherwise click <span className="font-medium">Run Checks</span> to validate the existing setup.
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
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <div className="text-[10px] uppercase tracking-wider text-slate-400">Generated Installation Commands</div>
                        <button onClick={copyCommands} className="inline-flex items-center gap-1 text-[11px] text-slate-600 hover:text-slate-900">
                          {copied ? <ClipboardCheck className="h-3 w-3" /> : <Copy className="h-3 w-3" />}{copied ? 'Copied' : 'Copy all'}
                        </button>
                      </div>
                      <pre className="cfg text-[11px] whitespace-pre-wrap break-all">{commands.join('\n')}</pre>
                      <p className="text-[10px] text-slate-400 mt-1 flex items-center gap-1">
                        <Terminal className="h-3 w-3" />Paste into the Cockpit Terminal on the install host.
                      </p>
                    </div>
                  </div>
                ) : null}
              </CardBody>
            </Card>

          </div>

          {/* ───── Right: verification + results ───── */}
          <div className="space-y-3">
            <Card>
              <CardHeader><CardTitle>Build Verification</CardTitle></CardHeader>
              <CardBody className="space-y-1.5">
                {VERIFICATIONS.map((v) => (
                  <label key={v.id} className="flex items-start gap-2 text-xs">
                    <input type="checkbox" className="mt-0.5" checked={!!checks[v.id]} onChange={(e) => setChecks((c) => ({ ...c, [v.id]: e.target.checked }))} disabled={busy} />
                    <span className="min-w-0">
                      <span className="font-medium text-slate-800">{v.label}</span>
                      <span className="block text-[10px] text-slate-500">{v.hint}</span>
                    </span>
                  </label>
                ))}
              </CardBody>
            </Card>

            {wantInstall ? (
              <Card>
                <CardHeader className="flex items-center justify-between">
                  <CardTitle>Install Progress</CardTitle>
                  {watching
                    ? <Button size="sm" variant="secondary" onClick={stopWatching}>Stop watching</Button>
                    : <Button size="sm" variant="secondary" onClick={startWatching} disabled={!sim}>Watch install</Button>}
                </CardHeader>
                <CardBody className="space-y-2">
                  <p className="text-[11px] text-slate-500 leading-relaxed">
                    SimQA cannot run or stream the installer — it runs in your Cockpit terminal, and inventory holds no SSH
                    credentials for these machines. These steps are <span className="font-medium">observed from outside</span>: the box
                    dropping off and returning on a new build.
                  </p>
                  <ul className="space-y-1">
                    {INSTALL_STEPS.map((st) => {
                      const seen = installLog.filter((l) => l.step === st.id);
                      const last = seen[seen.length - 1];
                      const status: StepStatus = last ? last.status : (watching && st.observable ? 'pending' : 'pending');
                      return (
                        <li key={st.id} className="flex items-start gap-2 text-[11px]">
                          <span className="mt-0.5"><StatusIcon status={status} /></span>
                          <span className={`${st.observable ? 'text-slate-700' : 'text-slate-400'} min-w-[150px]`}>{st.label}</span>
                          <span className="text-slate-500 flex-1">
                            {last?.detail ?? (st.observable ? '' : 'runs inside Cockpit — not visible to SimQA')}
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
                {report ? (report.ok ? <Badge tone="success">all passed</Badge> : <Badge tone="danger">failures</Badge>) : null}
              </CardHeader>
              <CardBody className="p-0">
                {!report ? (
                  <div className="px-4 py-6 text-xs text-slate-500">Pick a system and the checks to run, then click <span className="font-medium">Run Checks</span>.</div>
                ) : (
                  <ul className="divide-y divide-slate-100">
                    {report.groups.map((g) => {
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

            {report ? (
              <Card>
                <CardHeader><CardTitle>Report</CardTitle></CardHeader>
                <CardBody className="text-[11px] text-slate-600 space-y-0.5">
                  <div><span className="text-slate-400">System:</span> {report.systemName ?? '—'} ({report.host})</div>
                  <div><span className="text-slate-400">Build:</span> {report.buildVersion ?? '—'}</div>
                  {report.ueHost ? <div><span className="text-slate-400">UE:</span> {report.ueHost}</div> : null}
                  {report.appServerHost ? <div><span className="text-slate-400">App Server:</span> {report.appServerHost}</div> : null}
                  {report.install?.buildUrl ? <div className="break-all"><span className="text-slate-400">Build URL:</span> {report.install.buildUrl}</div> : null}
                  {report.install?.skipFlags?.length ? <div><span className="text-slate-400">Skip:</span> <span className="font-mono">{report.install.skipFlags.join(' ')}</span></div> : null}
                  <div><span className="text-slate-400">Checks:</span> {report.selectedChecks.join(', ')}</div>
                  <div><span className="text-slate-400">Started:</span> {new Date(report.startedAt).toLocaleString()}</div>
                  {report.finishedAt ? <div><span className="text-slate-400">Completed:</span> {new Date(report.finishedAt).toLocaleString()}</div> : null}
                  <div className="pt-1 text-slate-400">Saved to data/build-validation/{report.id}.json — also listed on Run History.</div>
                </CardBody>
              </Card>
            ) : null}
          </div>
        </div>
      </main>
    </>
  );
}

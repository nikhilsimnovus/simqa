'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Header } from '@/components/Header';
import { Card, CardBody, CardHeader, CardTitle, Input, Field, Button, Badge } from '@/components/ui';
import {
  CheckCircle2, XCircle, Loader2, ShieldCheck, AlertTriangle, ExternalLink,
  Copy, ClipboardCheck, Terminal, Download,
} from 'lucide-react';

interface InventorySystem {
  id: string;
  type: string;
  name: string;
  host: string;
  cockpitPort?: number;
  cockpitUser?: string;
  cockpitPassword?: string;
}

const COCKPIT_DEFAULT_USER = 'simnovus';
const COCKPIT_DEFAULT_PASSWORD = 'admin@123';
const COCKPIT_DEFAULT_PORT = 9090;
interface CheckResult { name: string; ok: boolean; detail?: string; durationMs?: number }
interface ValidationResult {
  ok: boolean;
  startedAt: string;
  finishedAt: string;
  checks: CheckResult[];
  build?: { source: string; targetPath: string; bytes: number; installResult?: { ok: boolean; output: string } };
}

const ALL_CHECKS: Array<{ id: string; label: string; default: boolean }> = [
  { id: 'ui-reachable',            label: 'UI reachable',                  default: true },
  { id: 'login',                   label: 'REST API login',                default: true },
  { id: 'me',                      label: 'GET /v2/users/me',              default: true },
  { id: 'list-simulators',         label: 'List simulators',               default: true },
  { id: 'list-testcases',          label: 'List testcases',                default: true },
  { id: 'list-bands',              label: 'POST /v2/band-info',            default: true },
  { id: 'cfg-generator-roundtrip', label: 'Cfg generator round-trip',      default: true },
  { id: 'sample-execution',        label: 'Run a sample testcase live',    default: false },
];

// Flags for the Simnovator `./install` script. Mirror the real `./install --help`
// output:
//
//   -u, --ue              credentials of the UE machine to install UE stack
//   -o, --oru             credentials of the ORU machine to install ORU stack
//   -a, --app             credentials of the App server machine
//   -e, --external        IP address of the external data generator
//   -m, --max_simulators  number of simulators to use
//   --no_app_server       skip installing app server
//   --no_app_manager      skip installing app manager
//   --no_simnovator       skip installing simnovator manager
//   --no_ue               skip installing UE
//   --no_oru              skip installing ORU
//   -t, --timezone        set timezone on all machines (e.g. -t Asia/Kolkata)
//   -r, --restore         restore simnovator testcases
//
// `--ue`, `--oru`, `--app` take "user@IP". `--external` is just an IP.
// The "host" flags get auto-filled from inventory by type; everything else
// is a free-form input or toggle.

interface HostFlag {
  key: 'ue' | 'oru' | 'app' | 'external';
  flag: string;            // e.g. "--ue"
  short?: string;          // e.g. "-u"
  label: string;
  description: string;
  /** What inventory types should auto-populate this flag's IP? */
  types: string[];
  /** True for `--external` which takes just an IP (no user@). */
  ipOnly?: boolean;
  required: boolean;
}

const HOST_FLAGS: HostFlag[] = [
  { key: 'ue',       flag: '--ue',       short: '-u', label: 'UE Machine',          description: 'Where the UE stack is installed',  types: ['UESIM', 'SIMNOVATOR'], required: true },
  { key: 'app',      flag: '--app',      short: '-a', label: 'App Server',          description: 'Where the App server is installed', types: ['APPSERVER'],           required: true },
  { key: 'oru',      flag: '--oru',      short: '-o', label: 'ORU Machine',         description: 'Where the ORU stack is installed (optional)', types: ['ORU', 'CALLBOX'], required: false },
  { key: 'external', flag: '--external', short: '-e', label: 'External Generator',  description: 'IP of the external data generator (optional)',  types: [], ipOnly: true, required: false },
];

interface SkipFlag { key: string; flag: string; label: string }
const SKIP_FLAGS: SkipFlag[] = [
  { key: 'no_app_server',  flag: '--no_app_server',  label: 'Skip App server'    },
  { key: 'no_app_manager', flag: '--no_app_manager', label: 'Skip App manager'   },
  { key: 'no_simnovator',  flag: '--no_simnovator',  label: 'Skip Simnovator mgr' },
  { key: 'no_ue',          flag: '--no_ue',          label: 'Skip UE install'    },
  { key: 'no_oru',          flag: '--no_oru',         label: 'Skip ORU install'   },
];

interface TimezoneOption { value: string; label: string }
const TIMEZONES: TimezoneOption[] = [
  { value: 'Asia/Kolkata',     label: '🇮🇳 Asia/Kolkata (IST)' },
  { value: 'America/New_York', label: '🇺🇸 America/New_York (EST)' },
  { value: 'America/Toronto',  label: '🇨🇦 America/Toronto (EST)' },
  { value: 'America/Los_Angeles', label: '🇺🇸 America/Los_Angeles (PST)' },
  { value: 'Europe/London',    label: '🇬🇧 Europe/London (GMT)' },
  { value: 'Europe/Paris',     label: '🇫🇷 Europe/Paris (CET)' },
  { value: 'Asia/Tokyo',       label: '🇯🇵 Asia/Tokyo (JST)' },
  { value: 'Asia/Shanghai',    label: '🇨🇳 Asia/Shanghai (CST)' },
  { value: 'Australia/Sydney', label: '🇦🇺 Australia/Sydney (AEST)' },
];
const DEFAULT_TIMEZONE = 'Asia/Kolkata';

const INSTALL_USER = 'sysadmin'; // user the Simnovator install script SSHes as

// Step status pill for the install progress strip.
type StepName = 'launch' | 'login' | 'terminal' | 'preflight' | 'fetch' | 'extract' | 'install';
type StepStatus = 'idle' | 'start' | 'ok' | 'fail';
const STEP_LABEL: Record<StepName, string> = {
  launch:    '1. Launch browser',
  login:     '2. Cockpit login',
  terminal:  '3. Open Terminal',
  preflight: '4. Reach build URL',
  fetch:     '5. wget tarball',
  extract:   '6. Extract',
  install:   '7. ./install',
};
const STEP_ORDER: StepName[] = ['launch', 'login', 'terminal', 'preflight', 'fetch', 'extract', 'install'];
function StepPill({ name, status }: { name: StepName; status: StepStatus }) {
  const cls =
    status === 'ok'    ? 'border-emerald-300 bg-emerald-50 text-emerald-800' :
    status === 'fail'  ? 'border-red-300 bg-red-50 text-red-700' :
    status === 'start' ? 'border-sky-300 bg-sky-50 text-sky-700' :
                         'border-slate-200 bg-slate-50 text-slate-500';
  const icon =
    status === 'ok'    ? <CheckCircle2 className="h-3.5 w-3.5" /> :
    status === 'fail'  ? <XCircle className="h-3.5 w-3.5" /> :
    status === 'start' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> :
                         <span className="h-3.5 w-3.5 inline-block rounded-full border border-slate-300" />;
  return (
    <div className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] font-medium ${cls}`}>
      {icon}
      <span className="truncate">{STEP_LABEL[name]}</span>
    </div>
  );
}

function CopyBtn({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const onClick = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch {}
  };
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50 transition-colors"
      title={`Copy ${label ?? 'command'}`}
    >
      {copied ? <ClipboardCheck className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

function CommandBlock({ title, command }: { title?: string; command: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-900 overflow-hidden">
      {title ? (
        <div className="flex items-center justify-between border-b border-slate-800 bg-slate-950 px-3 py-1.5">
          <span className="text-[11px] uppercase tracking-wider text-slate-400">{title}</span>
          <CopyBtn text={command} />
        </div>
      ) : null}
      <pre className="px-3 py-2.5 text-[12.5px] leading-relaxed text-slate-100 font-mono whitespace-pre-wrap break-all">{command}</pre>
      {!title ? <div className="border-t border-slate-800 bg-slate-950 px-3 py-1.5 flex justify-end"><CopyBtn text={command} /></div> : null}
    </div>
  );
}

// derive the tarball file/dir name from a URL
function nameFromUrl(url: string): { fileName: string; dirName: string } {
  try {
    const u = new URL(url);
    const file = u.pathname.split('/').filter(Boolean).pop() ?? 'build.tar.gz';
    const dir = file.replace(/\.tar\.gz$|\.tgz$/i, '');
    return { fileName: file, dirName: dir };
  } catch {
    return { fileName: 'build.tar.gz', dirName: 'build' };
  }
}

export default function ValidatePage() {
  const [systems, setSystems] = useState<InventorySystem[]>([]);
  const [target, setTarget] = useState<string>('');
  const [tcs, setTcs] = useState<Array<{ id: string; name: string }>>([]);
  const [sampleId, setSampleId] = useState<string>('');
  const [enabled, setEnabled] = useState<Set<string>>(new Set(ALL_CHECKS.filter((c) => c.default).map((c) => c.id)));

  // Build install plan state
  const [includeBuild, setIncludeBuild] = useState(false);
  /** Where the build comes from. 'url' = wget on the VM. 'local' = file is
   *  already on the VM (uploaded via Cockpit File Browser, scp, etc). */
  const [sourceMode, setSourceMode] = useState<'url' | 'local'>('url');
  const [buildUrl, setBuildUrl] = useState('');
  const [localFile, setLocalFile] = useState('');
  const [browseDirs, setBrowseDirs] = useState<string>('/tmp, /home/simnovus, /home/simnovus/builds');
  const [browseBusy, setBrowseBusy] = useState(false);
  const [browseErr, setBrowseErr]  = useState<string | null>(null);
  const [vmFiles, setVmFiles]      = useState<Array<{ path: string; size: number; mtime: string }> | null>(null);
  const [installDir, setInstallDir] = useState('/tmp');
  const [extraArgs, setExtraArgs] = useState('');
  // Per-host-flag enabled state (UE & App default ON because they're required;
  // ORU & External are off until the user opts in).
  const [hostEnabled, setHostEnabled] = useState<Record<string, boolean>>(
    () => Object.fromEntries(HOST_FLAGS.map((f) => [f.key, f.required])),
  );
  // Per-host IP override (when blank, falls back to inventory auto-pick).
  const [hostIp, setHostIp] = useState<Record<string, string>>({});
  // Per-host SSH user override. Pre-filled with "sysadmin" for every host
  // flag (the default user the Simnovator install script SSHes as) — the
  // user can edit any of these before clicking Install.
  const [hostUser, setHostUser] = useState<Record<string, string>>(
    () => Object.fromEntries(HOST_FLAGS.filter((f) => !f.ipOnly).map((f) => [f.key, INSTALL_USER])),
  );
  // Skip flags state
  const [skipFlags, setSkipFlags] = useState<Record<string, boolean>>(
    () => Object.fromEntries(SKIP_FLAGS.map((f) => [f.key, false])),
  );
  // Timezone (default Asia/Kolkata, dropdown + free-form override)
  const [timezone, setTimezone] = useState<string>(DEFAULT_TIMEZONE);
  const [maxSimulators, setMaxSimulators] = useState<string>('');
  const [restore, setRestore] = useState<boolean>(false);
  const [urlCheck, setUrlCheck] = useState<{ status: 'idle' | 'checking' | 'ok' | 'fail'; detail?: string }>({ status: 'idle' });

  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ValidationResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [inventoryLoading, setInventoryLoading] = useState(true);

  // Install run state (StepName/StepStatus are module-level above)
  type LogEvent  = { type: 'log'; stream: 'stdout'|'stderr'|'info'|'error'; line: string; ts: number };
  type StepEvent = { type: 'step'; step: StepName; status: 'start'|'ok'|'fail'; detail?: string; durationMs?: number; ts: number };
  type ShotEvent = { type: 'screenshot'; step: StepName | 'final'; file: string; ts: number };
  type DoneEvent = { type: 'done'; ok: boolean; durationMs: number; ts: number };
  type AnyEvent  = LogEvent | StepEvent | ShotEvent | DoneEvent;

  const [installBusy,    setInstallBusy]    = useState(false);
  const [installErr,     setInstallErr]     = useState<string | null>(null);
  const [installEvents,  setInstallEvents]  = useState<AnyEvent[]>([]);
  const [installSteps,   setInstallSteps]   = useState<Record<StepName, StepStatus>>({
    launch: 'idle', login: 'idle', terminal: 'idle', preflight: 'idle', fetch: 'idle', extract: 'idle', install: 'idle',
  });
  const [installDone,    setInstallDone]    = useState<{ ok: boolean; durationMs: number } | null>(null);
  const [showManualFallback, setShowManualFallback] = useState(false);
  /** When true, ask the backend to launch Chromium in HEADED mode so the
   *  user can watch the install happen in a real browser window. */
  const [headedMode, setHeadedMode] = useState(false);

  useEffect(() => {
    // Inventory is fast (local file read) — fetch + render its result regardless
    // of whether testcases comes back. The testcases call hits the live UESIM
    // box and can take 10–30s; we don't want that latency to keep the user from
    // seeing their Simnovator system or making it look like inventory is empty.
    fetch('/api/inventory')
      .then((r) => r.json())
      .then((inv) => {
        const sys: InventorySystem[] = inv.systems ?? [];
        setSystems(sys);
        const sn = sys.find((s) => s.type === 'SIMNOVATOR');
        if (sn) setTarget(sn.id);
      })
      .catch((e) => setErr(`Failed to load inventory: ${e?.message ?? e}`))
      .finally(() => setInventoryLoading(false));

    // Testcases is best-effort and only used by the optional "Run a sample
    // testcase live" check. Failures here must not block the page.
    fetch('/api/testcases?limit=500')
      .then((r) => r.json())
      .then((t) => setTcs(t.items ?? []))
      .catch(() => { /* silent — sample-execution will show "no testcases" */ });
  }, []);

  // Once inventory is loaded, pre-fill the host IPs from the first matching
  // system per flag so the per-host dropdown shows the auto-pick (rather
  // than appearing as "custom" with an empty input). User edits override.
  useEffect(() => {
    if (systems.length === 0) return;
    setHostIp((cur) => {
      const next = { ...cur };
      let changed = false;
      for (const f of HOST_FLAGS) {
        if (next[f.key]?.trim()) continue; // user already filled it
        const sys = systems.find((s) => f.types.includes(s.type));
        if (sys?.host) { next[f.key] = sys.host; changed = true; }
      }
      return changed ? next : cur;
    });
  }, [systems]);

  const simnovators = useMemo(() => systems.filter((s) => s.type === 'SIMNOVATOR'), [systems]);
  const overallOk   = result?.ok;
  const targetSys   = systems.find((s) => s.id === target);
  const hasTarget   = simnovators.length > 0 && !!targetSys;

  // Pick an inventory system whose type matches one of `types`. Returns its host.
  const inventoryHostFor = (types: string[]): string | undefined =>
    systems.find((s) => types.includes(s.type))?.host;

  // For each host flag, resolve the IP it would point at (override > inventory auto-pick).
  const resolvedHostIp: Record<string, string | undefined> = useMemo(() => {
    const out: Record<string, string | undefined> = {};
    for (const f of HOST_FLAGS) {
      out[f.key] = (hostIp[f.key] || '').trim() || inventoryHostFor(f.types);
    }
    return out;
  }, [systems, hostIp]);

  // Required host flags that the user has enabled but for which we still
  // can't resolve an IP. The install line will be malformed without these.
  const missingRequired: string[] = useMemo(() => {
    return HOST_FLAGS
      .filter((f) => f.required && hostEnabled[f.key])
      .filter((f) => !resolvedHostIp[f.key])
      .map((f) => f.flag);
  }, [hostEnabled, resolvedHostIp]);

  // Build the full install plan as discrete commands.
  const plan = useMemo(() => {
    const url = buildUrl.trim();
    const { fileName, dirName } = nameFromUrl(url || 'build.tar.gz');
    const dir = (installDir.trim() || '/tmp').replace(/\/+$/, '');

    // Build the install flags string.
    const parts: string[] = [];
    for (const f of HOST_FLAGS) {
      if (!hostEnabled[f.key]) continue;
      const ip = resolvedHostIp[f.key];
      if (!ip) continue;
      const user = (hostUser[f.key] || '').trim() || INSTALL_USER;
      // --external is IP-only; the others use 'user@IP' (single-quoted to be safe).
      parts.push(f.ipOnly ? `${f.flag} '${ip}'` : `${f.flag} '${user}@${ip}'`);
    }
    if (timezone.trim()) parts.push(`-t '${timezone.trim()}'`);
    if (maxSimulators.trim()) parts.push(`-m ${maxSimulators.trim()}`);
    for (const s of SKIP_FLAGS) {
      if (skipFlags[s.key]) parts.push(s.flag);
    }
    if (restore) parts.push('--restore');
    const extra = extraArgs.trim() ? ' ' + extraArgs.trim() : '';
    const installLine = `./install ${parts.join(' ')}${extra}`.replace(/\s+/g, ' ').trim();

    return {
      fileName, dirName, dir,
      cdTmp:    `cd ${dir}`,
      wget:     url ? `wget --no-check-certificate -c "${url}"` : `wget --no-check-certificate -c "<paste-build-url>"`,
      untar:    `tar -zxvf ${fileName}`,
      cdBuild:  `cd ${dirName}`,
      install:  installLine,
      oneLiner: [
        `cd ${dir}`,
        url ? `wget --no-check-certificate -c "${url}"` : `wget --no-check-certificate -c "<paste-build-url>"`,
        `tar -zxvf ${fileName}`,
        `cd ${dirName}`,
        installLine,
      ].join(' && \\\n  '),
    };
  }, [buildUrl, installDir, extraArgs, hostEnabled, hostIp, hostUser, resolvedHostIp, skipFlags, timezone, maxSimulators, restore]);

  const cockpitTerminalUrl = useMemo(() => {
    if (!targetSys?.host) return '';
    const port = targetSys.cockpitPort ?? COCKPIT_DEFAULT_PORT;
    return `https://${targetSys.host}:${port}/system/terminal`;
  }, [targetSys]);

  const cockpitCreds = useMemo(() => ({
    user:     targetSys?.cockpitUser     ?? COCKPIT_DEFAULT_USER,
    password: targetSys?.cockpitPassword ?? COCKPIT_DEFAULT_PASSWORD,
  }), [targetSys]);

  function toggleCheck(id: string) {
    const next = new Set(enabled);
    next.has(id) ? next.delete(id) : next.add(id);
    setEnabled(next);
  }

  // ── VM file browser (Cockpit-driven `find` for .tar.gz files) ──────────
  async function browseVmFiles() {
    if (!targetSys) return;
    setBrowseBusy(true); setBrowseErr(null); setVmFiles(null);
    try {
      const dirs = browseDirs.split(',').map((s) => s.trim()).filter(Boolean);
      const r = await fetch('/api/vm-files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ systemId: targetSys.id, searchDirs: dirs, maxDepth: 3 }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setVmFiles(j.files ?? []);
      // The backend may also surface a diagnostic 'error' string on a
      // successful empty result (e.g. raw terminal output) — show it so the
      // user can see what the VM actually returned.
      if ((j.files?.length ?? 0) === 0 && j.error) setBrowseErr(j.error);
    } catch (e: any) {
      setBrowseErr(e?.message ?? String(e));
    } finally {
      setBrowseBusy(false);
    }
  }

  async function probeUrl() {
    if (!buildUrl.trim()) { setUrlCheck({ status: 'fail', detail: 'enter a URL first' }); return; }
    setUrlCheck({ status: 'checking' });
    try {
      const r = await fetch(`/api/build-probe?url=${encodeURIComponent(buildUrl.trim())}`);
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setUrlCheck({ status: 'ok', detail: `${j.status} · ${j.bytes ? (j.bytes / 1024 / 1024).toFixed(1) + ' MB' : 'reachable'}` });
    } catch (e: any) {
      setUrlCheck({ status: 'fail', detail: e?.message ?? String(e) });
    }
  }

  // ── Install + Validate flow (backend-driven) ────────────────────────────
  async function runInstall(): Promise<{ ok: boolean; buildId: string | null }> {
    if (!targetSys) return { ok: false, buildId: null };
    if (sourceMode === 'url' && !buildUrl.trim()) {
      setInstallErr('Enter a Build URL first.');
      return { ok: false, buildId: null };
    }
    if (sourceMode === 'local' && !localFile.trim()) {
      setInstallErr('Pick (or type) the path to the .tar.gz on the VM.');
      return { ok: false, buildId: null };
    }
    // Validate required host flags resolve to an IP. The Simnovator install
    // script refuses to proceed without --ue and --app, so we refuse to
    // generate an obviously-broken command.
    const missing: string[] = [];
    for (const f of HOST_FLAGS) {
      if (!f.required) continue;
      if (!hostEnabled[f.key]) continue;
      const ip = ((hostIp[f.key] || '').trim() || resolvedHostIp[f.key] || '').trim();
      if (!ip) missing.push(f.flag);
    }
    if (missing.length > 0) {
      setInstallErr(`Missing required IP for ${missing.join(', ')}. Add an ${missing.includes('--app') ? 'APPSERVER' : 'system'} in Inventory or type the IP into the host card above.`);
      return { ok: false, buildId: null };
    }
    setInstallErr(null);
    setInstallBusy(true);
    setInstallEvents([]);
    setInstallSteps({ launch: 'idle', login: 'idle', terminal: 'idle', preflight: 'idle', fetch: 'idle', extract: 'idle', install: 'idle' });
    setInstallDone(null);

    const body = {
      systemId: targetSys.id,
      buildUrl:  sourceMode === 'url'   ? buildUrl.trim()  : undefined,
      localFile: sourceMode === 'local' ? localFile.trim() : undefined,
      workingDir: installDir.trim() || '/tmp',
      hosts: HOST_FLAGS
        .filter((f) => hostEnabled[f.key])
        .map((f) => ({
          flag: f.flag as '--ue' | '--app' | '--oru' | '--external',
          ip: ((hostIp[f.key] || '').trim() || resolvedHostIp[f.key] || ''),
          user: (hostUser[f.key] || '').trim() || undefined,
          ipOnly: !!f.ipOnly,
        }))
        .filter((h) => h.ip),
      timezone: timezone.trim() || undefined,
      maxSimulators: maxSimulators.trim() || undefined,
      skip: {
        app_server: !!skipFlags.no_app_server,
        app_manager: !!skipFlags.no_app_manager,
        simnovator: !!skipFlags.no_simnovator,
        ue: !!skipFlags.no_ue,
        oru: !!skipFlags.no_oru,
      },
      restore,
      extraArgs: extraArgs.trim() || undefined,
      headed: headedMode,
    };

    let buildId: string | null = null;
    try {
      const resp = await fetch('/api/build-install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      buildId = resp.headers.get('X-Build-Id');
      if (!resp.ok || !resp.body) {
        const txt = await resp.text().catch(() => '');
        setInstallErr(`HTTP ${resp.status}: ${txt.slice(0, 300)}`);
        setInstallBusy(false);
        return { ok: false, buildId };
      }
      // Stream-decode line-delimited JSON events.
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let finalOk = false;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          let ev: any;
          try { ev = JSON.parse(line); } catch { continue; }
          setInstallEvents((prev) => [...prev, ev]);
          if (ev.type === 'step') {
            setInstallSteps((prev) => ({ ...prev, [ev.step]: ev.status }));
          } else if (ev.type === 'done') {
            finalOk = !!ev.ok;
            setInstallDone({ ok: finalOk, durationMs: ev.durationMs });
          }
        }
      }
      setInstallBusy(false);
      return { ok: finalOk, buildId };
    } catch (e: any) {
      setInstallErr(e?.message ?? String(e));
      setInstallBusy(false);
      return { ok: false, buildId };
    }
  }

  // Top-of-page button: if "install a new build" is ticked, run install
  // then checks. Otherwise just run checks.
  async function runAll() {
    if (includeBuild) {
      const r = await runInstall();
      if (!r.ok) return;
    }
    await runChecks();
  }

  async function runChecks() {
    setBusy(true); setErr(null); setResult(null);
    try {
      const body: any = {
        uesimSystemId: target || undefined,
        checks: Array.from(enabled),
      };
      if (enabled.has('sample-execution') && sampleId) body.sampleTestcaseId = sampleId;
      const r = await fetch('/api/validate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const j: ValidationResult = await r.json();
      setResult(j);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Header
        title="Build validation"
        subtitle="Install a Simnovator build and run the checklist — fully automated, with a saved report"
        right={
          <Button size="sm" onClick={runAll} disabled={busy || installBusy || !hasTarget}>
            {(busy || installBusy) ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
            {installBusy ? 'Installing…' : busy ? 'Running checks…' : (includeBuild ? 'Install + Validate' : 'Run checks')}
          </Button>
        }
      />
      <main className="p-6 grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* LEFT — config */}
        <div className="lg:col-span-1 space-y-4">
          <Card>
            <CardHeader><CardTitle>Target</CardTitle></CardHeader>
            <CardBody className="space-y-3">
              {inventoryLoading ? (
                <div className="flex items-center gap-2 text-[12px] text-slate-500">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading inventory…
                </div>
              ) : simnovators.length === 0 ? (
                <div className="rounded-lg border border-orange-200 bg-orange-50 p-3 text-[11px] text-orange-800 leading-relaxed flex gap-2">
                  <AlertTriangle className="h-4 w-4 mt-0.5 flex-none" />
                  <div>
                    No Simnovator system in inventory yet.
                    {' '}<Link className="underline hover:no-underline font-medium" href="/inventory">Add one</Link>{' '}
                    to install a build and run checks.
                  </div>
                </div>
              ) : (
                <Field label="Simnovator system">
                  <select
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                    className="h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900"
                  >
                    {simnovators.map((s) => (
                      <option key={s.id} value={s.id}>{s.name || s.id} ({s.host})</option>
                    ))}
                  </select>
                </Field>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader><CardTitle>Checks</CardTitle></CardHeader>
            <CardBody className="space-y-2">
              {ALL_CHECKS.map((c) => (
                <label key={c.id} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={enabled.has(c.id)} onChange={() => toggleCheck(c.id)} />
                  {c.label}
                </label>
              ))}
              {enabled.has('sample-execution') ? (
                <Field label="Sample testcase to run live">
                  <select
                    value={sampleId}
                    onChange={(e) => setSampleId(e.target.value)}
                    className="h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900"
                  >
                    <option value="">— pick —</option>
                    {tcs.map((t) => <option key={t.id} value={t.id}>{t.name || t.id}</option>)}
                  </select>
                </Field>
              ) : null}
            </CardBody>
          </Card>
        </div>

        {/* RIGHT — install plan + check results */}
        <div className="lg:col-span-2 space-y-4">
          {/* COCKPIT INSTALL PLAN */}
          {hasTarget ? (
            <Card>
              <CardHeader className="flex items-center justify-between">
                <CardTitle>Cockpit install plan</CardTitle>
                <div className="flex items-center gap-4">
                  {includeBuild ? (
                    <label className="flex items-center gap-2 text-xs text-slate-600" title="Run with a visible browser window so you can watch the Cockpit Terminal type the install commands. Slower; uses display.">
                      <input type="checkbox" checked={headedMode} onChange={(e) => setHeadedMode(e.target.checked)} />
                      Show browser window (live demo)
                    </label>
                  ) : null}
                  <label className="flex items-center gap-2 text-xs text-slate-600">
                    <input type="checkbox" checked={includeBuild} onChange={(e) => setIncludeBuild(e.target.checked)} />
                    I want to install a new build
                  </label>
                </div>
              </CardHeader>
              {!includeBuild ? (
                <CardBody>
                  <div className="text-xs text-slate-500">
                    Tick "I want to install a new build" to generate the wget + tar + ./install commands ready to paste into Cockpit Terminal on <span className="font-mono">{targetSys?.host}</span>. Otherwise just click <span className="font-medium">Run checks</span> to validate the box as-is.
                  </div>
                </CardBody>
              ) : (
                <CardBody className="space-y-4">
                  {/* SOURCE MODE PICKER */}
                  <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4 space-y-3">
                    <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">Build source</div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {([
                        { id: 'url',   title: 'Download from URL', desc: 'wget runs on the VM. Best when the VM has network access to the build host.' },
                        { id: 'local', title: 'File already on VM', desc: 'You uploaded the .tar.gz to the VM (Cockpit Files / scp). Pick it from the list.' },
                      ] as const).map((m) => (
                        <label
                          key={m.id}
                          className={`flex gap-3 cursor-pointer rounded-lg border px-3 py-2 transition-colors ${sourceMode === m.id ? 'border-primary-500 bg-primary-50/40 ring-1 ring-primary-200' : 'border-slate-200 bg-white hover:bg-slate-50'}`}
                        >
                          <input
                            type="radio"
                            name="source-mode"
                            value={m.id}
                            checked={sourceMode === m.id}
                            onChange={() => setSourceMode(m.id)}
                            className="mt-1"
                          />
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium text-slate-900">{m.title}</div>
                            <div className="text-[11px] text-slate-500 mt-0.5">{m.desc}</div>
                          </div>
                        </label>
                      ))}
                    </div>
                  </div>

                  {/* URL MODE */}
                  {sourceMode === 'url' ? (
                    <div>
                      <Field
                        label="Build URL (.tar.gz)"
                        hint='Pasting works even when Chrome blocks the download — the Simnovator VM fetches it directly with wget, not your browser.'
                      >
                        <div className="flex gap-2">
                          <Input
                            value={buildUrl}
                            onChange={(e) => { setBuildUrl(e.target.value); setUrlCheck({ status: 'idle' }); }}
                            placeholder="http://192.168.0.19/builds/.../Simnovator-4.0.0_260424.tar.gz"
                            className="flex-1"
                          />
                          <Button size="sm" variant="secondary" onClick={probeUrl} disabled={!buildUrl.trim() || urlCheck.status === 'checking'}>
                            {urlCheck.status === 'checking' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                            Test URL
                          </Button>
                        </div>
                      </Field>
                      {urlCheck.status === 'ok' ? (
                        <div className="mt-1 text-[11px] text-emerald-700 flex items-center gap-1.5"><CheckCircle2 className="h-3 w-3" /> Reachable from this server · {urlCheck.detail}</div>
                      ) : urlCheck.status === 'fail' ? (
                        <div className="mt-1 text-[11px] text-red-600 flex items-center gap-1.5"><XCircle className="h-3 w-3" /> {urlCheck.detail}</div>
                      ) : null}

                      {(() => {
                        const u = buildUrl.trim().toLowerCase();
                        if (!u) return null;
                        const matches = [
                          { test: /sharepoint\.com/, name: 'SharePoint' },
                          { test: /onedrive\.live\.com|1drv\.ms/, name: 'OneDrive' },
                          { test: /drive\.google\.com|docs\.google\.com/, name: 'Google Drive' },
                          { test: /dropbox\.com/, name: 'Dropbox' },
                        ];
                        const hit = matches.find((m) => m.test.test(u));
                        if (!hit) return null;
                        return (
                          <div className="mt-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-[11px] text-amber-900 leading-relaxed flex gap-2">
                            <AlertTriangle className="h-4 w-4 mt-0.5 flex-none" />
                            <div>
                              <div className="font-semibold">{hit.name} share URLs don't work with <span className="font-mono">wget</span>.</div>
                              <div className="mt-0.5">
                                {hit.name} share links serve an HTML viewer that authenticates via browser cookies, not a direct file. Switch to <span className="font-semibold">"File already on VM"</span> above and upload the .tar.gz to the VM via Cockpit Files first, or host it on a plain HTTP server reachable from the VM.
                              </div>
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  ) : null}

                  {/* LOCAL-FILE MODE */}
                  {sourceMode === 'local' ? (
                    <div className="space-y-3">
                      {/* Browser */}
                      <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4 space-y-3">
                        <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">Browse VM for .tar.gz files</div>
                        <div className="flex gap-2">
                          <Input
                            value={browseDirs}
                            onChange={(e) => setBrowseDirs(e.target.value)}
                            placeholder="/tmp, /home/simnovus, /home/simnovus/builds"
                            className="flex-1"
                          />
                          <Button size="sm" variant="secondary" onClick={browseVmFiles} disabled={browseBusy || !targetSys}>
                            {browseBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                            {browseBusy ? 'Searching…' : 'Find files'}
                          </Button>
                        </div>
                        <div className="text-[11px] text-slate-500">
                          Comma-separated list of directories on the VM to scan (max depth 3). Tool opens Cockpit Terminal, runs <span className="font-mono">find</span>, and returns matches sorted newest-first. Takes ~15-25s on first run.
                        </div>

                        {browseErr ? (
                          <details className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-900">
                            <summary className="cursor-pointer flex items-start gap-1.5"><AlertTriangle className="h-3 w-3 mt-0.5" /> Diagnostic from VM (click to expand)</summary>
                            <pre className="mt-2 whitespace-pre-wrap font-mono text-[10.5px] text-slate-700 max-h-48 overflow-auto">{browseErr}</pre>
                          </details>
                        ) : null}

                        {vmFiles ? (
                          vmFiles.length === 0 ? (
                            <div className="text-[12px] text-slate-600 italic">No <span className="font-mono">.tar.gz</span> / <span className="font-mono">.tgz</span> files found in those directories.</div>
                          ) : (
                            <div className="rounded-lg border border-slate-200 bg-white divide-y divide-slate-100 max-h-72 overflow-auto">
                              {vmFiles.map((f) => {
                                const sizeMB = (f.size / (1024 * 1024)).toFixed(1);
                                const sizeGB = (f.size / (1024 * 1024 * 1024)).toFixed(2);
                                const sizeStr = f.size >= 1e9 ? `${sizeGB} GB` : `${sizeMB} MB`;
                                const when = new Date(f.mtime).toLocaleString();
                                const selected = localFile === f.path;
                                return (
                                  <label
                                    key={f.path}
                                    className={`flex items-start gap-3 px-3 py-2 cursor-pointer ${selected ? 'bg-primary-50/60' : 'hover:bg-slate-50'}`}
                                  >
                                    <input
                                      type="radio"
                                      name="vm-file"
                                      checked={selected}
                                      onChange={() => setLocalFile(f.path)}
                                      className="mt-1"
                                    />
                                    <div className="min-w-0 flex-1">
                                      <div className="text-[12px] font-mono text-slate-900 break-all">{f.path}</div>
                                      <div className="text-[11px] text-slate-500 flex flex-wrap gap-x-3 mt-0.5">
                                        <span>{sizeStr}</span>
                                        <span>· {when}</span>
                                      </div>
                                    </div>
                                  </label>
                                );
                              })}
                            </div>
                          )
                        ) : null}
                      </div>

                      {/* Manual path fallback */}
                      <Field label="Or type the .tar.gz path on the VM" hint="absolute path; the file must already exist on the Simnovator VM">
                        <Input
                          value={localFile}
                          onChange={(e) => setLocalFile(e.target.value)}
                          placeholder="/home/simnovus/Simnovator-4.0.0_260424.tar.gz"
                        />
                      </Field>
                    </div>
                  ) : null}

                  {/* Working dir + Install flags + extra args */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <Field label="Working directory on the VM" hint="where to wget + tar">
                      <Input value={installDir} onChange={(e) => setInstallDir(e.target.value)} placeholder="/tmp" />
                    </Field>
                    <Field label="Extra args" hint="pass-through to ./install (e.g. --license …, --no-update)">
                      <Input value={extraArgs} onChange={(e) => setExtraArgs(e.target.value)} placeholder="--license /opt/license.bin" />
                    </Field>
                  </div>

                  {/* Host machines (--ue, --app, --oru, --external) */}
                  <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">Host machines</div>
                      <div className="text-[10px] text-slate-500">user defaults to <span className="font-mono">{INSTALL_USER}</span> · pick from inventory or type a custom IP</div>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {HOST_FLAGS.map((f) => {
                        const candidates = systems.filter((s) => f.types.includes(s.type));
                        const enabled = hostEnabled[f.key];
                        const ipValue   = hostIp[f.key]   ?? '';
                        const userValue = hostUser[f.key] ?? INSTALL_USER;
                        // Match the current IP to a system in inventory so the
                        // dropdown shows the right entry as selected.
                        const matchedSystemId = candidates.find((s) => s.host === ipValue)?.id ?? '';
                        return (
                          <div key={f.key} className={`rounded-lg border bg-white px-3 py-2 ${enabled ? 'border-slate-200' : 'border-slate-200 opacity-60'}`}>
                            <label className="flex items-center justify-between gap-2 text-xs">
                              <span className="flex items-center gap-2">
                                <input
                                  type="checkbox"
                                  checked={!!enabled}
                                  disabled={f.required}
                                  onChange={(e) => setHostEnabled((s) => ({ ...s, [f.key]: e.target.checked }))}
                                />
                                <span className="font-mono text-slate-900">{f.flag}</span>
                                <span className="text-slate-500">· {f.label}</span>
                                {f.required ? <span className="text-[9px] uppercase tracking-wider text-red-500">req</span> : null}
                              </span>
                            </label>
                            <div className="text-[10px] text-slate-500 mt-1">{f.description}</div>

                            {/* System picker (skipped for --external which is IP-only) */}
                            {!f.ipOnly ? (
                              <div className="mt-2">
                                <select
                                  value={matchedSystemId}
                                  onChange={(e) => {
                                    const id = e.target.value;
                                    if (!id) {
                                      // "Custom" was picked — clear the IP so the user types one.
                                      setHostIp((o) => ({ ...o, [f.key]: '' }));
                                      return;
                                    }
                                    const sys = systems.find((s) => s.id === id);
                                    if (sys) {
                                      setHostIp((o) => ({ ...o, [f.key]: sys.host }));
                                      // Don't overwrite a user-edited username with system.username; only
                                      // pre-fill if it's still the default.
                                      setHostUser((o) => ({
                                        ...o,
                                        [f.key]: o[f.key] && o[f.key] !== INSTALL_USER ? o[f.key] : ((sys as any).username || INSTALL_USER),
                                      }));
                                    }
                                  }}
                                  className="h-8 w-full rounded-md border border-slate-300 bg-white px-2 text-[12px] text-slate-900 focus:outline-none focus:ring-2 focus:ring-primary-300"
                                >
                                  <option value="">— custom IP below —</option>
                                  {candidates.length > 0 ? (
                                    <optgroup label="From Inventory">
                                      {candidates.map((s) => (
                                        <option key={s.id} value={s.id}>{(s.name || s.id) + ' · ' + s.host + (s.type ? ` (${s.type})` : '')}</option>
                                      ))}
                                    </optgroup>
                                  ) : null}
                                </select>
                                {candidates.length === 0 ? (
                                  <div className="text-[10px] text-slate-500 mt-1">
                                    No <span className="font-mono">{f.types.join(' / ')}</span> systems in inventory yet.{' '}
                                    <Link href="/inventory" className="underline hover:no-underline">Add one</Link>{' '}
                                    or type the IP below.
                                  </div>
                                ) : null}
                              </div>
                            ) : null}

                            <div className="mt-2 flex items-center gap-1.5">
                              {!f.ipOnly ? (
                                <>
                                  <input
                                    value={userValue}
                                    onChange={(e) => setHostUser((o) => ({ ...o, [f.key]: e.target.value }))}
                                    placeholder={INSTALL_USER}
                                    className="w-24 h-7 rounded-md border border-slate-300 bg-white px-2 text-[12px] font-mono text-slate-900 focus:outline-none focus:ring-2 focus:ring-primary-300"
                                  />
                                  <span className="text-[11px] text-slate-500 font-mono">@</span>
                                </>
                              ) : null}
                              <input
                                value={ipValue}
                                onChange={(e) => setHostIp((o) => ({ ...o, [f.key]: e.target.value }))}
                                placeholder={f.ipOnly ? 'IP address' : (matchedSystemId ? '' : '192.168.x.x')}
                                className="flex-1 h-7 rounded-md border border-slate-300 bg-white px-2 text-[12px] font-mono text-slate-900 focus:outline-none focus:ring-2 focus:ring-primary-300"
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Timezone + max simulators + restore */}
                  <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <Field label="Timezone (-t)" hint="set on all machines during install">
                      <select
                        value={TIMEZONES.some((tz) => tz.value === timezone) ? timezone : '__manual__'}
                        onChange={(e) => {
                          const v = e.target.value;
                          if (v === '__manual__') return; // keep user's free-form value
                          if (v === '__none__') { setTimezone(''); return; }
                          setTimezone(v);
                        }}
                        className="h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900"
                      >
                        <option value="__none__">— none —</option>
                        {TIMEZONES.map((tz) => (
                          <option key={tz.value} value={tz.value}>{tz.label}</option>
                        ))}
                        <option value="__manual__">✏ Enter manually below</option>
                      </select>
                      {!TIMEZONES.some((tz) => tz.value === timezone) && timezone !== '' ? (
                        <Input
                          value={timezone}
                          onChange={(e) => setTimezone(e.target.value)}
                          placeholder="e.g. Asia/Singapore"
                          className="mt-1.5"
                        />
                      ) : null}
                    </Field>
                    <Field label="Max simulators (-m)" hint="optional — number of simulators to use">
                      <Input
                        value={maxSimulators}
                        onChange={(e) => setMaxSimulators(e.target.value.replace(/[^0-9]/g, ''))}
                        placeholder="e.g. 4"
                      />
                    </Field>
                    <Field label="Other" hint="">
                      <label className="flex items-center gap-2 text-sm h-9 mt-0">
                        <input type="checkbox" checked={restore} onChange={(e) => setRestore(e.target.checked)} />
                        <span className="font-mono text-[12px]">--restore</span>
                        <span className="text-[11px] text-slate-500">restore testcases</span>
                      </label>
                    </Field>
                  </div>

                  {/* Skip flags */}
                  <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
                    <div className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-3">Skip options</div>
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
                      {SKIP_FLAGS.map((s) => (
                        <label key={s.key} className={`flex items-center gap-2 rounded-md border bg-white px-2.5 py-1.5 text-[11px] cursor-pointer ${skipFlags[s.key] ? 'border-orange-300 bg-orange-50' : 'border-slate-200'}`}>
                          <input
                            type="checkbox"
                            checked={!!skipFlags[s.key]}
                            onChange={(e) => setSkipFlags((p) => ({ ...p, [s.key]: e.target.checked }))}
                          />
                          <span className="font-mono">{s.flag}</span>
                        </label>
                      ))}
                    </div>
                    <div className="mt-2 text-[10px] text-slate-500">{SKIP_FLAGS.map((s) => s.label).join(' · ')}</div>
                  </div>

                  {/* GENERATED COMMAND PREVIEW (read-only) */}
                  <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4 space-y-2">
                    <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">Generated install command</div>
                    <CommandBlock command={plan.install} />
                    {missingRequired.length > 0 ? (
                      <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-[12px] text-red-700 leading-relaxed flex gap-2">
                        <AlertTriangle className="h-4 w-4 mt-0.5 flex-none" />
                        <div>
                          <div className="font-semibold">Required flag{missingRequired.length > 1 ? 's' : ''} missing: {missingRequired.join(', ')}</div>
                          <div className="mt-0.5">
                            The Simnovator installer will refuse to run without {missingRequired.length > 1 ? 'these' : 'this'}.{' '}
                            {missingRequired.includes('--app') ? <>Add an <span className="font-semibold">APPSERVER</span> system in <Link href="/inventory" className="underline hover:no-underline">Inventory</Link>, or type the IP into the App Server card above.</> : null}
                          </div>
                        </div>
                      </div>
                    ) : null}
                    <div className="text-[11px] text-slate-500">
                      This is the exact line the tool will run on <span className="font-mono">{targetSys?.host}</span> after fetching + extracting the build. Click <span className="font-medium">Install + Validate</span> at the top to do it automatically.
                    </div>
                  </div>
                </CardBody>
              )}
            </Card>
          ) : null}

          {/* INSTALL PROGRESS / LOG */}
          {hasTarget && includeBuild ? (
            <Card>
              <CardHeader className="flex items-center justify-between">
                <CardTitle>Install progress</CardTitle>
                {installDone ? (
                  installDone.ok
                    ? <Badge tone="success">install ok · {(installDone.durationMs / 1000).toFixed(0)}s</Badge>
                    : <Badge tone="danger">install failed · {(installDone.durationMs / 1000).toFixed(0)}s</Badge>
                ) : installBusy ? <Badge tone="info">running…</Badge> : null}
              </CardHeader>
              <CardBody className="space-y-3">
                {/* Step strip */}
                <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
                  {STEP_ORDER.map((s) => (
                    <StepPill key={s} name={s} status={installSteps[s]} />
                  ))}
                </div>

                {installErr ? (
                  <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-[12px] text-red-700">{installErr}</div>
                ) : null}

                {/* Live log */}
                {installEvents.length > 0 ? (
                  <div className="rounded-lg border border-slate-200 bg-slate-900 overflow-hidden">
                    <div className="flex items-center justify-between border-b border-slate-800 bg-slate-950 px-3 py-1.5">
                      <span className="text-[11px] uppercase tracking-wider text-slate-400">Live log · {installEvents.filter((e) => e.type === 'log').length} lines</span>
                      <CopyBtn text={installEvents.filter((e): e is LogEvent => e.type === 'log').map((e) => e.line).join('\n')} label="log" />
                    </div>
                    <div className="max-h-80 overflow-auto px-3 py-2.5 text-[12px] leading-relaxed font-mono whitespace-pre-wrap">
                      {installEvents.map((e, i) =>
                        e.type === 'log' ? (
                          <div
                            key={i}
                            className={
                              e.stream === 'error'  ? 'text-red-300' :
                              e.stream === 'stderr' ? 'text-amber-300' :
                              e.stream === 'info'   ? 'text-sky-300' :
                              'text-slate-100'
                            }
                          >{e.line}</div>
                        ) : e.type === 'step' ? (
                          <div key={i} className={
                            e.status === 'fail' ? 'text-red-400' :
                            e.status === 'ok'   ? 'text-emerald-400' :
                            'text-slate-400'
                          }>
                            ── {e.step.toUpperCase()} {e.status}{e.durationMs ? ` (${e.durationMs}ms)` : ''}{e.detail ? ` :: ${e.detail.slice(0, 200)}` : ''}
                          </div>
                        ) : null
                      )}
                    </div>
                  </div>
                ) : !installBusy ? (
                  <div className="text-[12px] text-slate-500">Waiting to start. Click <span className="font-medium">Install + Validate</span> at the top.</div>
                ) : null}

                {/* Manual fallback */}
                <details className="rounded-lg border border-slate-200 bg-slate-50/60 p-3" open={showManualFallback} onToggle={(e) => setShowManualFallback((e.target as HTMLDetailsElement).open)}>
                  <summary className="cursor-pointer text-[11px] uppercase tracking-wider text-slate-500 flex items-center gap-2">
                    <Terminal className="h-3.5 w-3.5" /> Manual fallback — paste these into Cockpit if SSH is blocked
                  </summary>
                  <div className="mt-3 space-y-2">
                    <div className="flex items-center justify-end">
                      <a
                        href={cockpitTerminalUrl}
                        target="_blank" rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 rounded-md bg-primary-700 hover:bg-primary-800 px-2.5 py-1 text-[11px] font-medium text-white transition-colors"
                      >
                        <Terminal className="h-3.5 w-3.5" /> Open Cockpit Terminal
                        <ExternalLink className="h-3 w-3 opacity-80" />
                      </a>
                    </div>
                    <div className="rounded-lg border border-slate-200 bg-white p-3 space-y-2">
                      <div className="text-[11px] text-slate-600">Log in with:</div>
                      <div className="grid grid-cols-2 gap-2">
                        <div className="rounded-md bg-slate-50 border border-slate-200 px-2.5 py-1.5 flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <div className="text-[10px] uppercase tracking-wider text-slate-500">User</div>
                            <div className="font-mono text-[12px] text-slate-900 truncate">{cockpitCreds.user}</div>
                          </div>
                          <CopyBtn text={cockpitCreds.user} label="user" />
                        </div>
                        <div className="rounded-md bg-slate-50 border border-slate-200 px-2.5 py-1.5 flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <div className="text-[10px] uppercase tracking-wider text-slate-500">Password</div>
                            <div className="font-mono text-[12px] text-slate-900 truncate">{cockpitCreds.password}</div>
                          </div>
                          <CopyBtn text={cockpitCreds.password} label="password" />
                        </div>
                      </div>
                    </div>
                    {sourceMode === 'url' ? (
                      <>
                        <CommandBlock title={`1. Fetch — ${plan.fileName}`} command={`${plan.cdTmp}\n${plan.wget}`} />
                        <CommandBlock title="2. Extract" command={`${plan.untar}\n${plan.cdBuild}`} />
                        <CommandBlock title="3. Install" command={plan.install} />
                      </>
                    ) : (
                      <>
                        <CommandBlock title={`1. Extract — ${localFile || '(pick a file above)'}`} command={localFile ? `cd ${localFile.replace(/\/[^/]+$/, '') || '/'}\ntar -zxvf ${localFile.replace(/.*\//, '')}` : '(pick a file above)'} />
                        <CommandBlock title="2. Install" command={plan.install} />
                      </>
                    )}
                  </div>
                </details>
              </CardBody>
            </Card>
          ) : null}

          {/* CHECK RESULTS */}
          {err ? <Card><CardBody><div className="text-sm text-red-700">{err}</div></CardBody></Card> : null}

          <Card>
            <CardHeader className="flex items-center justify-between">
              <CardTitle>Checks</CardTitle>
              {result ? (overallOk ? <Badge tone="success">all passed</Badge> : <Badge tone="danger">failed</Badge>) : null}
            </CardHeader>
            <CardBody className="p-0">
              {!result ? (
                <div className="p-5 text-sm text-slate-500">{busy ? 'Running…' : 'Click "Run checks" to validate the box.'}</div>
              ) : (
                <ol className="divide-y divide-slate-100">
                  {result.checks.map((c, i) => (
                    <li key={i} className="px-5 py-3 flex items-start gap-3">
                      {c.ok ? <CheckCircle2 className="h-4 w-4 text-success-600 mt-0.5" /> : <XCircle className="h-4 w-4 text-red-600 mt-0.5" />}
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-slate-900">{c.name}</div>
                        {c.detail ? <div className="text-xs text-slate-500 mt-0.5 break-all">{c.detail}</div> : null}
                      </div>
                      {typeof c.durationMs === 'number' ? <span className="text-[11px] text-slate-400">{c.durationMs}ms</span> : null}
                    </li>
                  ))}
                </ol>
              )}
            </CardBody>
          </Card>
        </div>
      </main>
    </>
  );
}

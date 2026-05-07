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

// Optional flags for `./install`. The `--ue` and `--app` ones are always
// shown (they're in the basic install command). The rest are toggleable
// because most labs only have a subset.
interface InstallFlag { key: string; flag: string; types: string[]; label: string; default: boolean; alwaysOn?: boolean }
const INSTALL_FLAGS: InstallFlag[] = [
  { key: 'ue',  flag: '--ue',  types: ['UESIM', 'SIMNOVATOR'], label: 'UE simulator',  default: true,  alwaysOn: true },
  { key: 'app', flag: '--app', types: ['APPSERVER'],            label: 'App server',    default: true,  alwaysOn: true },
  { key: 'enb', flag: '--enb', types: ['ENB', 'CALLBOX'],       label: 'eNB',           default: false },
  { key: 'gnb', flag: '--gnb', types: ['GNB', 'CALLBOX'],       label: 'gNB',           default: false },
  { key: 'mme', flag: '--mme', types: ['MME', 'CALLBOX'],       label: 'MME',           default: false },
  { key: 'ims', flag: '--ims', types: ['IMS', 'CALLBOX'],       label: 'IMS',           default: false },
];

const INSTALL_USER = 'sysadmin'; // user the Simnovator install script SSHes as

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
  const [buildUrl, setBuildUrl] = useState('');
  const [installDir, setInstallDir] = useState('/tmp');
  const [extraArgs, setExtraArgs] = useState('');
  const [flagsEnabled, setFlagsEnabled] = useState<Record<string, boolean>>(
    () => Object.fromEntries(INSTALL_FLAGS.map((f) => [f.key, f.default])),
  );
  const [overrides, setOverrides] = useState<Record<string, string>>({}); // per-flag IP override
  const [urlCheck, setUrlCheck] = useState<{ status: 'idle' | 'checking' | 'ok' | 'fail'; detail?: string }>({ status: 'idle' });

  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ValidationResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      fetch('/api/inventory').then((r) => r.json()),
      fetch('/api/testcases?limit=500').then((r) => r.json()),
    ]).then(([inv, t]) => {
      const sys: InventorySystem[] = inv.systems ?? [];
      setSystems(sys);
      // Build Check only ever installs Simnovator. If no Simnovator system is
      // in inventory yet, the dropdown stays empty and the user is pointed at
      // the Inventory page.
      const sn = sys.find((s) => s.type === 'SIMNOVATOR');
      if (sn) setTarget(sn.id);
      setTcs(t.items ?? []);
    });
  }, []);

  const simnovators = useMemo(() => systems.filter((s) => s.type === 'SIMNOVATOR'), [systems]);
  const overallOk   = result?.ok;
  const targetSys   = systems.find((s) => s.id === target);
  const hasTarget   = simnovators.length > 0 && !!targetSys;

  // Pick an inventory system whose type matches one of `types`. Returns its host.
  const inventoryHostFor = (types: string[]): string | undefined =>
    systems.find((s) => types.includes(s.type))?.host;

  // For each install flag, resolve the IP it would point at.
  const resolvedFlagIps: Record<string, string | undefined> = useMemo(() => {
    const out: Record<string, string | undefined> = {};
    for (const f of INSTALL_FLAGS) {
      out[f.key] = overrides[f.key] ?? inventoryHostFor(f.types);
    }
    return out;
  }, [systems, overrides]);

  // Build the full install plan as discrete commands.
  const plan = useMemo(() => {
    const url = buildUrl.trim();
    const { fileName, dirName } = nameFromUrl(url || 'build.tar.gz');
    const dir = (installDir.trim() || '/tmp').replace(/\/+$/, '');
    const flags = INSTALL_FLAGS
      .filter((f) => flagsEnabled[f.key] || f.alwaysOn)
      .filter((f) => resolvedFlagIps[f.key])
      .map((f) => `${f.flag} ${INSTALL_USER}@${resolvedFlagIps[f.key]}`);
    const extra = extraArgs.trim() ? ' ' + extraArgs.trim() : '';
    const installLine = `./install ${flags.join(' ')}${extra}`.replace(/\s+/g, ' ').trim();
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
  }, [buildUrl, installDir, extraArgs, flagsEnabled, resolvedFlagIps]);

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

  async function run() {
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
        subtitle="Install a Simnovator build via Cockpit, then run the checklist"
        right={
          <Button size="sm" onClick={run} disabled={busy || !hasTarget}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
            {busy ? 'Running…' : 'Run checks'}
          </Button>
        }
      />
      <main className="p-6 grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* LEFT — config */}
        <div className="lg:col-span-1 space-y-4">
          <Card>
            <CardHeader><CardTitle>Target</CardTitle></CardHeader>
            <CardBody className="space-y-3">
              {simnovators.length === 0 ? (
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
                <label className="flex items-center gap-2 text-xs text-slate-600">
                  <input type="checkbox" checked={includeBuild} onChange={(e) => setIncludeBuild(e.target.checked)} />
                  I want to install a new build
                </label>
              </CardHeader>
              {!includeBuild ? (
                <CardBody>
                  <div className="text-xs text-slate-500">
                    Tick "I want to install a new build" to generate the wget + tar + ./install commands ready to paste into Cockpit Terminal on <span className="font-mono">{targetSys?.host}</span>. Otherwise just click <span className="font-medium">Run checks</span> to validate the box as-is.
                  </div>
                </CardBody>
              ) : (
                <CardBody className="space-y-4">
                  {/* Build URL */}
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
                  </div>

                  {/* Working dir + Install flags + extra args */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <Field label="Working directory on the VM" hint="where to wget + tar">
                      <Input value={installDir} onChange={(e) => setInstallDir(e.target.value)} placeholder="/tmp" />
                    </Field>
                    <Field label="Extra args" hint="pass-through to ./install (e.g. --license …, --no-update)">
                      <Input value={extraArgs} onChange={(e) => setExtraArgs(e.target.value)} placeholder="--license /opt/license.bin" />
                    </Field>
                  </div>

                  {/* Per-flag config */}
                  <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4 space-y-3">
                    <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">Install flags</div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {INSTALL_FLAGS.map((f) => {
                        const ip = resolvedFlagIps[f.key];
                        const auto = !overrides[f.key];
                        const enabled = flagsEnabled[f.key] || f.alwaysOn;
                        return (
                          <div key={f.key} className={`rounded-lg border bg-white px-3 py-2 ${enabled ? 'border-slate-200' : 'border-slate-200 opacity-60'}`}>
                            <label className="flex items-center justify-between gap-2 text-xs">
                              <span className="flex items-center gap-2">
                                <input
                                  type="checkbox"
                                  checked={!!enabled}
                                  disabled={!!f.alwaysOn}
                                  onChange={(e) => setFlagsEnabled((s) => ({ ...s, [f.key]: e.target.checked }))}
                                />
                                <span className="font-mono text-slate-900">{f.flag}</span>
                                <span className="text-slate-500">· {f.label}</span>
                              </span>
                              {auto && ip ? <span className="text-[10px] uppercase tracking-wider text-slate-400">auto</span> : null}
                            </label>
                            <div className="mt-2 flex items-center gap-2">
                              <span className="text-[11px] text-slate-500 font-mono whitespace-nowrap">{INSTALL_USER}@</span>
                              <input
                                value={overrides[f.key] ?? ip ?? ''}
                                onChange={(e) => setOverrides((o) => ({ ...o, [f.key]: e.target.value }))}
                                placeholder={ip ? '' : `(no ${f.types.join(' / ')} in Inventory)`}
                                className="flex-1 h-7 rounded-md border border-slate-300 bg-white px-2 text-[12px] font-mono text-slate-900 focus:outline-none focus:ring-2 focus:ring-primary-300"
                              />
                              {overrides[f.key] ? (
                                <button
                                  className="text-[10px] text-slate-500 underline hover:no-underline"
                                  onClick={() => setOverrides((o) => { const n = { ...o }; delete n[f.key]; return n; })}
                                  title="Reset to inventory value"
                                >reset</button>
                              ) : null}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* GENERATED COMMANDS */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">Run these in Cockpit Terminal</div>
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
                      <div className="text-[11px] text-slate-600">
                        Cockpit Terminal opens at <span className="font-mono">{cockpitTerminalUrl || '<set host on selected system>'}</span>. Log in with:
                      </div>
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
                      <div className="text-[10px] text-slate-500">
                        Defaults shown — change them on the Simnovator system in <Link className="underline hover:no-underline" href="/inventory">Inventory</Link>.
                      </div>
                    </div>
                    <CommandBlock title={`1. Fetch — ${plan.fileName}`} command={`${plan.cdTmp}\n${plan.wget}`} />
                    <CommandBlock title="2. Extract" command={`${plan.untar}\n${plan.cdBuild}`} />
                    <CommandBlock title="3. Install" command={plan.install} />
                    <details className="rounded-lg border border-slate-200 bg-slate-50/60 p-3">
                      <summary className="cursor-pointer text-[11px] uppercase tracking-wider text-slate-500">As a single one-liner</summary>
                      <div className="mt-2"><CommandBlock command={plan.oneLiner} /></div>
                    </details>
                    <div className="rounded-lg border border-sky-200 bg-sky-50 p-3 text-[11px] text-sky-900 leading-relaxed">
                      <span className="font-medium">Tip:</span> if you don't know the full set of <span className="font-mono">./install</span> flags this build supports, run <span className="font-mono">./install --help</span> in step 3 first. Anything you find can be added under <span className="font-medium">Extra args</span>.
                    </div>
                  </div>
                </CardBody>
              )}
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

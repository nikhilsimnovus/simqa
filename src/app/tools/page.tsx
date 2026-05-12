'use client';

// /tools — home for the lab utilities that don't fit elsewhere.
//
// Today this hosts a single card: the UE-sim cfg patcher. The user picks a
// UESIM from the inventory dropdown, then can:
//   • Install + Start the watcher on that box (one click)
//   • Refresh status (running? how many patches applied? last 20 log lines)
//   • Stop + Remove (with an optional "also remove .orig backups" checkbox)
//
// All work happens server-side via SSH — see src/lib/labTools.ts. The page
// just orchestrates the three actions and shows a live status panel.

import { useEffect, useState } from 'react';
import { Header } from '@/components/Header';
import { Card, CardBody, CardHeader, CardTitle, Button, Badge } from '@/components/ui';
import {
  Wrench, Server, Play, Square, RefreshCw, Trash2, CheckCircle2, XCircle, Loader2, AlertTriangle, Activity,
} from 'lucide-react';

interface UesimSystem {
  id: string;
  name: string;
  host: string;
  type: string;
  authMode: 'password' | 'privateKey';
  hasUsername: boolean;
  ready: boolean;
  missing: string[];
}

interface PatcherStatus {
  systemId: string;
  host: string;
  running: boolean;
  pids: number[];
  scriptInstalled: boolean;
  inotifyAvailable: boolean;
  patchCount: number;
  recentLog: string[];
  detail?: string;
}

interface OpResult { ok: boolean; detail: string; output?: string }

export default function ToolsPage() {
  const [systems, setSystems] = useState<UesimSystem[] | null>(null);
  const [selectedId, setSelectedId] = useState<string>('');
  const [status, setStatus] = useState<PatcherStatus | null>(null);
  const [busy, setBusy] = useState<null | 'install' | 'status' | 'uninstall'>(null);
  const [lastOp, setLastOp] = useState<{ kind: string; result: OpResult } | null>(null);
  const [removeBackups, setRemoveBackups] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // ── Load UESIM systems on mount + restore last selection ──
  useEffect(() => {
    fetch('/api/tools/uesim-systems').then((r) => r.json()).then((j) => {
      const list: UesimSystem[] = j.systems ?? [];
      setSystems(list);
      const stored = typeof window !== 'undefined' ? localStorage.getItem('simqa-tools-uesim') : null;
      const valid = list.find((s) => s.id === stored);
      if (valid) setSelectedId(valid.id);
      else if (list.length > 0) setSelectedId(list[0].id);
    }).catch((e) => setErr(`load systems failed: ${e?.message ?? String(e)}`));
  }, []);

  useEffect(() => {
    if (typeof window !== 'undefined' && selectedId) localStorage.setItem('simqa-tools-uesim', selectedId);
  }, [selectedId]);

  const sel = systems?.find((s) => s.id === selectedId);

  // ── Status refresh ──
  async function refreshStatus() {
    if (!sel) return;
    setBusy('status'); setErr(null);
    try {
      const r = await fetch(`/api/tools/uesim-patcher/status?systemId=${encodeURIComponent(sel.id)}`, { cache: 'no-store' });
      const j = await r.json();
      if (!r.ok) { setErr(j?.error ?? `HTTP ${r.status}`); return; }
      setStatus(j);
    } catch (e: any) {
      setErr(`status fetch failed: ${e?.message ?? String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  // Auto-refresh status on selection change (only if ready).
  useEffect(() => { if (sel?.ready) refreshStatus(); else setStatus(null); /* eslint-disable-next-line */ }, [selectedId, sel?.ready]);

  async function runOp(kind: 'install' | 'uninstall') {
    if (!sel) return;
    setBusy(kind); setErr(null); setLastOp(null);
    try {
      const body: any = { systemId: sel.id };
      if (kind === 'uninstall' && removeBackups) body.removeBackups = true;
      const r = await fetch(`/api/tools/uesim-patcher/${kind}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = await r.json();
      setLastOp({ kind, result: j });
      // Re-poll status so the panel reflects reality.
      await refreshStatus();
    } catch (e: any) {
      setErr(`${kind} failed: ${e?.message ?? String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <Header
        title="Tools"
        subtitle="Lab utilities — currently: UE-sim cfg patcher for no-SDR boxes"
      />
      <main className="flex-1 overflow-y-auto p-6 space-y-6 bg-slate-50">

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Wrench className="h-4 w-4 text-primary-600" />
              UE-sim cfg patcher
            </CardTitle>
          </CardHeader>
          <CardBody className="space-y-4">

            <p className="text-xs text-slate-600 leading-relaxed">
              Watches <code className="font-mono text-[11px] bg-slate-100 px-1 rounded">/root/ue/config/ue.cfg</code> on
              the selected UE-sim box. Whenever App Manager regenerates it during a test run, the watcher swaps the
              SDR <code className="font-mono text-[11px] bg-slate-100 px-1 rounded">rf_driver</code> block for{' '}
              <code className="font-mono text-[11px] bg-slate-100 px-1 rounded">#include "rf_driver/config.cfg"</code> and
              strips <code className="font-mono text-[11px] bg-slate-100 px-1 rounded">tx_gain</code> /{' '}
              <code className="font-mono text-[11px] bg-slate-100 px-1 rounded">rx_gain</code> — so tests work on boxes
              without SDR hardware. Originals are backed up as <code className="font-mono text-[11px] bg-slate-100 px-1 rounded">ue.cfg.orig.&lt;ts&gt;</code>.
            </p>

            {/* System picker */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-700 flex items-center gap-1.5">
                <Server className="h-3.5 w-3.5" /> Target UE-sim
              </label>
              {systems === null ? (
                <div className="text-xs text-slate-500 flex items-center gap-1.5"><Loader2 className="h-3 w-3 animate-spin" /> loading…</div>
              ) : systems.length === 0 ? (
                <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 leading-relaxed">
                  No UESIM-typed systems in inventory.yaml. Add a system with <code className="font-mono text-[10px]">type: UESIM</code> + SSH creds (<code className="font-mono text-[10px]">username</code> + <code className="font-mono text-[10px]">password</code>, or <code className="font-mono text-[10px]">authMode: privateKey</code> + <code className="font-mono text-[10px]">privateKey</code>) and reload.
                </div>
              ) : (
                <select
                  value={selectedId}
                  onChange={(e) => setSelectedId(e.target.value)}
                  className="w-full md:w-[420px] border border-slate-300 rounded-md px-3 py-2 text-sm bg-white text-slate-700"
                >
                  {systems.map((s) => (
                    <option key={s.id} value={s.id} disabled={!s.ready}>
                      {s.name} ({s.host}) — {s.type}{s.ready ? '' : ` · missing: ${s.missing.join(', ')}`}
                    </option>
                  ))}
                </select>
              )}
              {sel && !sel.ready ? (
                <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 leading-relaxed flex gap-2">
                  <AlertTriangle className="h-3.5 w-3.5 mt-0.5 flex-none" />
                  <span>This system has no SSH credentials in inventory.yaml. Add: <code className="font-mono text-[10px]">{sel.missing.join(', ')}</code>.</span>
                </div>
              ) : null}
            </div>

            {/* Status panel */}
            {sel?.ready ? (
              <div className="rounded-lg border border-slate-200 bg-white p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">Status</div>
                  <Button onClick={refreshStatus} disabled={busy !== null} variant="ghost" className="h-7 px-2">
                    {busy === 'status' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                    <span className="ml-1 text-xs">Refresh</span>
                  </Button>
                </div>

                {status === null ? (
                  <div className="text-xs text-slate-500">No status yet — click Refresh.</div>
                ) : (
                  <>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                      <StatusTile label="Watcher" value={status.running ? `running (pid ${status.pids[0]})` : 'stopped'} tone={status.running ? 'green' : 'gray'} icon={status.running ? <Activity className="h-3 w-3" /> : <XCircle className="h-3 w-3" />} />
                      <StatusTile label="Script on box" value={status.scriptInstalled ? 'installed' : 'not installed'} tone={status.scriptInstalled ? 'green' : 'gray'} icon={status.scriptInstalled ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />} />
                      <StatusTile label="inotifywait" value={status.inotifyAvailable ? 'available' : 'missing'} tone={status.inotifyAvailable ? 'green' : 'amber'} icon={status.inotifyAvailable ? <CheckCircle2 className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />} />
                      <StatusTile label="Patches applied" value={String(status.patchCount)} tone={status.patchCount > 0 ? 'blue' : 'gray'} icon={<Activity className="h-3 w-3" />} />
                    </div>

                    {status.recentLog.length > 0 ? (
                      <div className="space-y-1 pt-1">
                        <div className="text-[10px] uppercase tracking-wider text-slate-500">Recent log (last {status.recentLog.length} lines)</div>
                        <pre className="text-[11px] bg-slate-900 text-slate-100 rounded p-2.5 overflow-x-auto leading-relaxed font-mono max-h-48">
{status.recentLog.join('\n')}
                        </pre>
                      </div>
                    ) : null}

                    {status.detail ? (
                      <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{status.detail}</div>
                    ) : null}
                  </>
                )}
              </div>
            ) : null}

            {/* Action buttons */}
            {sel?.ready ? (
              <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-slate-100">
                <Button onClick={() => runOp('install')} disabled={busy !== null} className="bg-primary-600 hover:bg-primary-700 text-white">
                  {busy === 'install' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4 fill-current" />}
                  <span className="ml-1.5">{status?.running ? 'Re-install + restart' : 'Install + Start'}</span>
                </Button>
                <Button onClick={() => runOp('uninstall')} disabled={busy !== null} variant="secondary">
                  {busy === 'uninstall' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Square className="h-4 w-4" />}
                  <span className="ml-1.5">Stop + Remove</span>
                </Button>
                <label className="flex items-center gap-2 text-xs text-slate-600 cursor-pointer">
                  <input type="checkbox" checked={removeBackups} onChange={(e) => setRemoveBackups(e.target.checked)} />
                  <Trash2 className="h-3 w-3" />
                  Also delete <code className="font-mono text-[10px]">.orig.&lt;ts&gt;</code> backups
                </label>
              </div>
            ) : null}

            {lastOp ? (
              <div className={
                'rounded-md border px-3 py-2 text-xs leading-relaxed ' +
                (lastOp.result.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-red-200 bg-red-50 text-red-700')
              }>
                <span className="font-semibold capitalize">{lastOp.kind}: </span>{lastOp.result.detail}
                {lastOp.result.output ? (
                  <pre className="mt-1.5 text-[10px] bg-white/60 rounded p-2 overflow-x-auto max-h-32">{lastOp.result.output}</pre>
                ) : null}
              </div>
            ) : null}

            {err ? (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 flex gap-2">
                <AlertTriangle className="h-3.5 w-3.5 mt-0.5 flex-none" />
                <span>{err}</span>
              </div>
            ) : null}

          </CardBody>
        </Card>

      </main>
    </>
  );
}

function StatusTile({ label, value, tone, icon }: { label: string; value: string; tone: 'green' | 'amber' | 'gray' | 'blue'; icon: React.ReactNode }) {
  const tones: Record<typeof tone, string> = {
    green: 'border-emerald-200 bg-emerald-50 text-emerald-800',
    amber: 'border-amber-200 bg-amber-50 text-amber-800',
    gray:  'border-slate-200 bg-slate-50 text-slate-700',
    blue:  'border-sky-200 bg-sky-50 text-sky-800',
  };
  return (
    <div className={'rounded-md border px-2.5 py-1.5 ' + tones[tone]}>
      <div className="text-[10px] uppercase tracking-wider opacity-70 flex items-center gap-1">{icon} {label}</div>
      <div className="text-xs font-medium font-mono">{value}</div>
    </div>
  );
}

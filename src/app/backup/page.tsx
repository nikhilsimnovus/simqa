'use client';

// /backup — backup and restore simqa's persisted configuration, plus
// download all testcases from a Simnovator system as a JSON snapshot.
//
// Two cards on this page:
//
//   1. Configuration backup
//      • Download — fetches /api/backup/config which returns inventory.yaml
//        + .env.local + ui-test baselines as one JSON file. Browser saves it
//        with the timestamped filename the server suggests.
//      • Restore — user picks a previously-downloaded backup file. We read
//        it client-side, POST as JSON to /api/backup/config. The server
//        applies a strict path whitelist and ALWAYS preserves existing
//        files as <path>.bak-<timestamp> before overwriting (so this can
//        never silently destroy your current inventory).
//
//   2. Testcase export
//      • Pick a Simnovator system from inventory.
//      • Click Export — server paginates /v2/testcases/search and streams
//        the result back as a single JSON download. Workaround for the
//        SIM40-2010 bulk-export bug.
//      • Note: metadata-only today (no cfg text — that's blocked on
//        SIM40-2060). A header X-Simqa-Server-Total tells you how many the
//        server *thinks* it has, vs X-Simqa-Pulled which is how many we
//        actually got — if those differ, we caught a silent dropout.

import { useEffect, useState } from 'react';
import { Header } from '@/components/Header';
import { Card, CardBody, CardHeader, CardTitle, Button } from '@/components/ui';
import {
  Download, Upload, Database, ListChecks, CheckCircle2, AlertTriangle, Loader2, FileJson, Server,
} from 'lucide-react';

interface TestSystem {
  id: string;
  name: string;
  host: string;
  type: string;
}

interface RestoreResp {
  ok: boolean;
  restoredFiles?: string[];
  backedUpFiles?: string[];
  rejectedFiles?: string[];
  errors?: string[];
  error?: string;
}

export default function BackupPage() {
  const [systems, setSystems] = useState<TestSystem[] | null>(null);
  const [tcSystem, setTcSystem] = useState<string>('');
  const [tcBusy, setTcBusy] = useState(false);
  const [tcDetail, setTcDetail] = useState<{ pulled: number; serverTotal: number } | null>(null);
  const [tcErr, setTcErr] = useState<string | null>(null);

  const [backupBusy, setBackupBusy] = useState(false);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreResult, setRestoreResult] = useState<RestoreResp | null>(null);

  useEffect(() => {
    fetch('/api/ui-tests/systems')
      .then((r) => r.json())
      .then((j) => {
        const list: TestSystem[] = j.systems ?? [];
        setSystems(list);
        if (list.length > 0 && !tcSystem) setTcSystem(list[0].id);
      })
      .catch(() => setSystems([]));
  }, []);

  // ── Configuration backup ──
  async function downloadBackup() {
    setBackupBusy(true);
    try {
      const r = await fetch('/api/backup/config', { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const blob = await r.blob();
      // Filename comes from Content-Disposition. Browsers respect that when
      // we set the anchor's download attr to '' (empty string).
      const cd = r.headers.get('Content-Disposition') || '';
      const m = cd.match(/filename="([^"]+)"/);
      const filename = m?.[1] ?? `simqa-backup.json`;
      saveBlobAs(blob, filename);
    } catch (e: any) {
      alert(`Backup failed: ${e?.message ?? String(e)}`);
    } finally {
      setBackupBusy(false);
    }
  }

  async function restoreFromFile(file: File) {
    setRestoreBusy(true); setRestoreResult(null);
    try {
      const text = await file.text();
      let body: unknown;
      try { body = JSON.parse(text); } catch (e: any) {
        setRestoreResult({ ok: false, errors: [`File is not valid JSON: ${e?.message ?? e}`] });
        return;
      }
      const r = await fetch('/api/backup/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j: RestoreResp = await r.json();
      setRestoreResult(j);
    } catch (e: any) {
      setRestoreResult({ ok: false, errors: [e?.message ?? String(e)] });
    } finally {
      setRestoreBusy(false);
    }
  }

  // ── Testcase export ──
  async function exportTestcases() {
    if (!tcSystem) return;
    setTcBusy(true); setTcErr(null); setTcDetail(null);
    try {
      const r = await fetch(`/api/backup/testcases?systemId=${encodeURIComponent(tcSystem)}`, { cache: 'no-store' });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      const pulled      = Number(r.headers.get('X-Simqa-Pulled') ?? 0);
      const serverTotal = Number(r.headers.get('X-Simqa-Server-Total') ?? 0);
      setTcDetail({ pulled, serverTotal });
      const blob = await r.blob();
      const cd = r.headers.get('Content-Disposition') || '';
      const m = cd.match(/filename="([^"]+)"/);
      const filename = m?.[1] ?? `testcases-${tcSystem}.json`;
      saveBlobAs(blob, filename);
    } catch (e: any) {
      setTcErr(e?.message ?? String(e));
    } finally {
      setTcBusy(false);
    }
  }

  return (
    <>
      <Header
        title="Backup"
        subtitle="Export simqa configuration + testcase snapshots for safekeeping and cross-machine moves"
      />
      <main className="flex-1 overflow-y-auto p-6 space-y-6 bg-slate-50">

        {/* ── Card 1: Configuration backup / restore ──────────────── */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Database className="h-4 w-4 text-primary-600" />
              Configuration backup
            </CardTitle>
          </CardHeader>
          <CardBody className="space-y-4">
            <p className="text-xs text-slate-600 leading-relaxed">
              Saves your <code className="font-mono text-[11px] bg-slate-100 px-1 rounded">inventory.yaml</code>,{' '}
              <code className="font-mono text-[11px] bg-slate-100 px-1 rounded">.env.local</code>, and any
              UI-test baselines (<code className="font-mono text-[11px] bg-slate-100 px-1 rounded">data/ui-tests/baselines/</code>)
              as a single JSON file. Use it to move config between installs, or as a quick safety net
              before changes. Restore is whitelist-strict — anything outside those paths is rejected — and
              existing files are always preserved as <code className="font-mono text-[11px] bg-slate-100 px-1 rounded">.bak-&lt;timestamp&gt;</code>
              {' '}before overwriting.
            </p>

            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={downloadBackup} disabled={backupBusy} className="bg-primary-600 hover:bg-primary-700 text-white">
                {backupBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                <span className="ml-1.5">Download backup</span>
              </Button>

              <label className={
                'inline-flex items-center gap-1.5 px-4 h-9 rounded-md text-sm font-medium border cursor-pointer ' +
                (restoreBusy
                  ? 'bg-slate-100 text-slate-400 border-slate-200 cursor-not-allowed'
                  : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50')
              }>
                {restoreBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                <span>Restore from file…</span>
                <input
                  type="file"
                  accept=".json,application/json"
                  className="hidden"
                  disabled={restoreBusy}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) restoreFromFile(f);
                    e.target.value = '';
                  }}
                />
              </label>
            </div>

            {restoreResult ? (
              <div className={
                'rounded-md border p-3 text-xs leading-relaxed space-y-1.5 ' +
                (restoreResult.ok
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                  : 'border-red-200 bg-red-50 text-red-700')
              }>
                <div className="flex items-center gap-1.5 font-semibold">
                  {restoreResult.ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
                  {restoreResult.ok ? 'Restore complete' : 'Restore failed'}
                </div>
                {restoreResult.restoredFiles && restoreResult.restoredFiles.length > 0 ? (
                  <FileList label="Restored" tone="green" files={restoreResult.restoredFiles} />
                ) : null}
                {restoreResult.backedUpFiles && restoreResult.backedUpFiles.length > 0 ? (
                  <FileList label="Preserved as .bak" tone="slate" files={restoreResult.backedUpFiles} />
                ) : null}
                {restoreResult.rejectedFiles && restoreResult.rejectedFiles.length > 0 ? (
                  <FileList label="Rejected (outside whitelist)" tone="amber" files={restoreResult.rejectedFiles} />
                ) : null}
                {restoreResult.errors && restoreResult.errors.length > 0 ? (
                  <FileList label="Errors" tone="red" files={restoreResult.errors} />
                ) : null}
                {restoreResult.error ? (
                  <div className="text-[11px]">Error: {restoreResult.error}</div>
                ) : null}
              </div>
            ) : null}
          </CardBody>
        </Card>

        {/* ── Card 2: Testcase export ──────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ListChecks className="h-4 w-4 text-primary-600" />
              Testcase export
            </CardTitle>
          </CardHeader>
          <CardBody className="space-y-4">
            <p className="text-xs text-slate-600 leading-relaxed">
              Pulls every testcase off the selected Simnovator system as one JSON file. The export
              paginates <code className="font-mono text-[11px] bg-slate-100 px-1 rounded">/v2/testcases/search</code>{' '}
              under the hood — a workaround for{' '}
              <a className="text-primary-700 hover:underline" href="https://simnovus.atlassian.net/browse/SIM40-2010" target="_blank" rel="noreferrer">SIM40-2010</a>{' '}
              (the bulk-export endpoint silently drops cases). <span className="font-semibold">Metadata only today</span>{' '}
              — testcase cfg payloads need <a className="text-primary-700 hover:underline" href="https://simnovus.atlassian.net/browse/SIM40-2060" target="_blank" rel="noreferrer">SIM40-2060</a>{' '}
              on the product side.
            </p>

            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-slate-700 flex items-center gap-1.5">
                  <Server className="h-3.5 w-3.5" /> Source system
                </label>
                {systems === null ? (
                  <div className="text-xs text-slate-500 flex items-center gap-1.5 h-9 px-3"><Loader2 className="h-3 w-3 animate-spin" /> loading…</div>
                ) : systems.length === 0 ? (
                  <div className="text-xs text-slate-500 h-9 flex items-center px-3">No UESIM-capable systems in inventory.yaml.</div>
                ) : (
                  <select
                    value={tcSystem}
                    onChange={(e) => setTcSystem(e.target.value)}
                    className="w-full md:w-[420px] border border-slate-300 rounded-md px-3 py-2 text-sm bg-white text-slate-700"
                  >
                    {systems.map((s) => (
                      <option key={s.id} value={s.id}>{s.name} ({s.host}) — {s.type}</option>
                    ))}
                  </select>
                )}
              </div>

              <Button onClick={exportTestcases} disabled={!tcSystem || tcBusy} className="bg-primary-600 hover:bg-primary-700 text-white">
                {tcBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileJson className="h-4 w-4" />}
                <span className="ml-1.5">Export testcases</span>
              </Button>
            </div>

            {tcDetail ? (
              <div className={
                'rounded-md border p-3 text-xs leading-relaxed ' +
                (tcDetail.pulled === tcDetail.serverTotal
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                  : 'border-amber-200 bg-amber-50 text-amber-900')
              }>
                <div className="font-semibold flex items-center gap-1.5">
                  {tcDetail.pulled === tcDetail.serverTotal
                    ? <><CheckCircle2 className="h-3.5 w-3.5" /> Exported {tcDetail.pulled} testcases</>
                    : <><AlertTriangle className="h-3.5 w-3.5" /> Partial export: {tcDetail.pulled} of {tcDetail.serverTotal} pulled</>
                  }
                </div>
                {tcDetail.pulled !== tcDetail.serverTotal ? (
                  <div className="mt-0.5">
                    The server reported a total of {tcDetail.serverTotal} but pagination stopped after {tcDetail.pulled}.
                    This is consistent with the SIM40-2010 silent-dropout pattern. The file has been downloaded;
                    you may want to retry or open a ticket if the gap persists.
                  </div>
                ) : null}
              </div>
            ) : null}

            {tcErr ? (
              <div className="rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700 flex gap-2">
                <AlertTriangle className="h-3.5 w-3.5 mt-0.5 flex-none" />
                <div>{tcErr}</div>
              </div>
            ) : null}
          </CardBody>
        </Card>

      </main>
    </>
  );
}

function FileList({ label, tone, files }: { label: string; tone: 'green' | 'slate' | 'amber' | 'red'; files: string[] }) {
  const toneStyles: Record<typeof tone, string> = {
    green: 'text-emerald-900',
    slate: 'text-slate-700',
    amber: 'text-amber-800',
    red:   'text-red-700',
  };
  return (
    <div>
      <div className={'text-[10px] uppercase tracking-wider font-semibold opacity-70 ' + toneStyles[tone]}>{label} ({files.length})</div>
      <ul className="mt-0.5 space-y-0.5 font-mono text-[11px]">
        {files.map((f) => <li key={f} className={'break-all ' + toneStyles[tone]}>{f}</li>)}
      </ul>
    </div>
  );
}

function saveBlobAs(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 0);
}

'use client';

// /backup — SimQA's own configuration backup, plus the automatic backup of every
// lab system.
//
// Two cards on this page:
//
//   1. Configuration backup (SimQA's own state)
//      • Download — fetches /api/backup/config which returns inventory.yaml
//        + .env.local + ui-test baselines as one JSON file. Browser saves it
//        with the timestamped filename the server suggests.
//      • Restore — user picks a previously-downloaded backup file. We read
//        it client-side, POST as JSON to /api/backup/config. The server
//        applies a strict path whitelist and ALWAYS preserves existing
//        files as <path>.bak-<timestamp> before overwriting (so this can
//        never silently destroy your current inventory).
//      • This is the one thing the automatic backup does NOT cover: it backs up
//        the lab boxes, not SimQA itself.
//
//   2. Automatic backup (AutoBackupCard.tsx)
//      • Unlike the card above, nothing here is triggered by the user: a
//        background job snapshots every system in Systems Management every
//        five minutes and this card browses what it holds. See
//        src/lib/backup/ for the store, collectors and scheduler.
//
// REMOVED, deliberately: "Testcase export" and "Lab gNB / MME backup" used to
// sit between the two. Both were manual, one-shot versions of what the automatic
// backup now does continuously — testcases land in the Testcases category, and
// the enb/mme cfg trees in enb_config / mme_config — so keeping them meant two
// routes to the same data, one of which was only as fresh as the last time
// somebody remembered to press it. Their API routes (/api/backup/testcases and
// /api/backup/gnb) are untouched and still serve the export and the
// snapshot/restore pair, including the restore path, which has no UI now.

import { useState } from 'react';
import { Header } from '@/components/Header';
import { AutoBackupCard } from './AutoBackupCard';
import { Card, CardBody, CardHeader, CardTitle, Button } from '@/components/ui';
import { Download, Upload, Database, CheckCircle2, AlertTriangle, Loader2 } from 'lucide-react';

interface RestoreResp {
  ok: boolean;
  restoredFiles?: string[];
  backedUpFiles?: string[];
  rejectedFiles?: string[];
  errors?: string[];
  error?: string;
}

export default function BackupPage() {
  const [backupBusy, setBackupBusy] = useState(false);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreResult, setRestoreResult] = useState<RestoreResp | null>(null);

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

  return (
    <>
      <Header
        title="Backup"
        subtitle="Automatic five-minute backups of every lab system, plus backup and restore of SimQA's own configuration"
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
              <Button onClick={downloadBackup} disabled={backupBusy} className="bg-primary-600 hover:bg-primary-700 text-on-accent">
                {backupBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                <span className="ml-1.5">Download backup</span>
              </Button>

              <label className={
                'inline-flex items-center gap-1.5 px-4 h-9 rounded-md text-sm font-medium border cursor-pointer ' +
                (restoreBusy
                  ? 'bg-slate-100 text-slate-400 border-slate-200 cursor-not-allowed'
                  : 'bg-surface text-slate-700 border-slate-300 hover:bg-slate-50')
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

        {/* ── Card 2: Automatic backup ───────────────────── */}
        <AutoBackupCard />

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

'use client';

// Automatic backup — the fourth card on /backup.
//
// The three cards above it are manual one-shots: you press a button, you get a
// file. This one is a window onto a job that has already been running in the
// background every five minutes, so it is arranged the other way round — status
// first (is it working, is any box failing), then a browser to pull individual
// files back out.
//
// A selection can leave as one .zip or as separate files, because both are
// genuinely useful: three cfgs are easier to work with loose, 900 testcases are
// only sane as an archive. The loose path is one request per file with a gap
// between them, the pattern downloadAll() uses in src/app/testcases/[id]/page.tsx;
// the archive is built by src/lib/backup/zip.ts, which is node builtins only so
// that offering ZIP cost no dependency.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Card, CardBody, CardHeader, CardTitle, Button } from '@/components/ui';
import {
  HardDriveDownload, RefreshCw, Loader2, AlertTriangle, CheckCircle2, Clock, Server, FolderOpen, Download,
  FileArchive, Search, ChevronUp, ChevronDown, ChevronsUpDown,
} from 'lucide-react';

type Category = 'UE_config' | 'enb_config' | 'mme_config' | 'Testcases';

/** Label → category, plus which collector has to have run for the category to
 *  have anything in it. Keeps the picker honest: selecting "eNB configs" only
 *  offers callboxes. */
const TYPES: Array<{ label: string; category: Category; kind: 'ue' | 'callbox' | 'testcases' }> = [
  { label: 'UE_Config',   category: 'UE_config',  kind: 'ue' },
  { label: 'ENB_Config',  category: 'enb_config', kind: 'callbox' },
  { label: 'MME_Config',  category: 'mme_config', kind: 'callbox' },
  { label: 'Testcases',   category: 'Testcases',  kind: 'testcases' },
];

/** The sortable columns. Sorting is driven by clicking a column heading rather
 *  than by a separate control, so the thing you sort by is the thing you are
 *  looking at. */
type SortKey = 'name' | 'bytes' | 'lastChanged';

const COMPARE: Record<SortKey, (a: FileRow, b: FileRow) => number> = {
  name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
  bytes: (a, b) => a.bytes - b.bytes,
  lastChanged: (a, b) => (a.lastChanged || '').localeCompare(b.lastChanged || ''),
};

interface SystemRow {
  ip: string;
  name: string;
  systemType: string;
  kinds: Array<'ue' | 'callbox' | 'testcases'>;
  state: 'ok' | 'retrying' | 'failed' | 'never-run';
  lastSuccessAt?: string;
  added?: number; updated?: number; unchanged?: number;
  notes: string[];
  reason?: string;
  failingForMin: number;
  files: Record<string, number>;
}

interface StatusResp {
  ok: boolean;
  scheduler: { running: boolean; intervalMin: number; busy: boolean };
  retryWindowMin: number;
  lastCycleFinishedAt?: string;
  lastCycleMs?: number;
  systems: SystemRow[];
}

interface FileRow {
  name: string;
  bytes: number;
  lastChanged: string;
  missingFromSource: boolean;
}

export function AutoBackupCard() {
  const [status, setStatus] = useState<StatusResp | null>(null);
  const [typeIdx, setTypeIdx] = useState(0);
  const [ip, setIp] = useState('');
  const [files, setFiles] = useState<FileRow[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState<{ done: number; total: number; what: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  // Newest first by default: the question this list is usually asked is what
  // moved recently, which is also the order the server returns.
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'lastChanged', dir: 'desc' });

  const type = TYPES[typeIdx];

  const loadStatus = useCallback(async () => {
    try {
      const r = await fetch('/api/backup/auto/status', { cache: 'no-store' });
      const j: StatusResp = await r.json();
      setStatus(j);
      return j;
    } catch (e: any) {
      setErr(e?.message ?? String(e));
      return null;
    }
  }, []);

  // The status route is also what starts the scheduler after a server restart,
  // so opening this page is enough to get backups running again.
  useEffect(() => { loadStatus(); }, [loadStatus]);

  const eligible = useMemo(
    () => (status?.systems ?? []).filter((s) => s.kinds.includes(type.kind)),
    [status, type.kind],
  );

  // Keep the system selection valid when the type changes — a callbox has no
  // testcases, so the previously-picked system may not be on the new list.
  useEffect(() => {
    if (!eligible.length) { setIp(''); return; }
    if (!eligible.some((s) => s.ip === ip)) setIp(eligible[0].ip);
  }, [eligible, ip]);

  const loadFiles = useCallback(async (theIp: string, cat: Category) => {
    if (!theIp) { setFiles(null); return; }
    setErr(null);
    try {
      const r = await fetch(`/api/backup/auto/files?ip=${encodeURIComponent(theIp)}&category=${encodeURIComponent(cat)}`, { cache: 'no-store' });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setFiles(j.files ?? []);
      setSelected(new Set());
      setQuery('');
    } catch (e: any) {
      setErr(e?.message ?? String(e));
      setFiles([]);
    }
  }, []);

  useEffect(() => { loadFiles(ip, type.category); }, [ip, type.category, loadFiles]);

  async function runNow() {
    setBusy(true); setErr(null);
    try {
      const r = await fetch('/api/backup/auto/run', { method: 'POST' });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      await loadStatus();
      await loadFiles(ip, type.category);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  /** The names the buttons act on: what is selected AND currently visible. */
  function targetNames(): string[] {
    return visible.filter((f) => selected.has(f.name)).map((f) => f.name);
  }

  /** One request per file. Better for a few files: they land unpacked, under
   *  their own names, ready to diff or edit. */
  async function downloadIndividually() {
    const names = targetNames();
    if (!names.length) return;
    setErr(null);
    setDownloading({ done: 0, total: names.length, what: 'files' });
    const failed: string[] = [];
    for (let i = 0; i < names.length; i++) {
      const url = `/api/backup/auto/file?ip=${encodeURIComponent(ip)}&category=${encodeURIComponent(type.category)}&name=${encodeURIComponent(names[i])}`;
      try {
        const r = await fetch(url, { cache: 'no-store' });
        if (r.ok) saveBlobAs(await r.blob(), names[i]); else failed.push(names[i]);
      } catch { failed.push(names[i]); }
      setDownloading({ done: i + 1, total: names.length, what: 'files' });
      // A pause between saves: browsers throttle (and Chrome prompts on) a burst
      // of downloads fired from one gesture.
      if (i < names.length - 1) await new Promise((res) => setTimeout(res, 250));
    }
    setDownloading(null);
    // Said out loud rather than swallowed — a silent gap in a burst of 40 saves
    // is not something anyone would notice.
    if (failed.length) setErr(`${failed.length} file(s) could not be downloaded: ${failed.slice(0, 5).join(', ')}${failed.length > 5 ? '…' : ''}`);
  }

  /** Everything selected as one archive. The only practical option once the
   *  selection runs to hundreds of testcases. */
  async function downloadZip() {
    const names = targetNames();
    if (!names.length) return;
    setErr(null);
    setDownloading({ done: 0, total: names.length, what: 'zip' });
    try {
      const r = await fetch('/api/backup/auto/zip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip, category: type.category, names }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      const cd = r.headers.get('Content-Disposition') || '';
      const m = cd.match(/filename="([^"]+)"/);
      saveBlobAs(await r.blob(), m?.[1] ?? `${type.category}-${ip}.zip`);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setDownloading(null);
    }
  }
  // Search and sort are applied here rather than server-side: the whole list is
  // already in the browser (the largest is ~900 rows), so filtering locally is
  // instant and costs no request per keystroke.
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = q ? (files ?? []).filter((f) => f.name.toLowerCase().includes(q)) : (files ?? []);
    const cmp = COMPARE[sort.key];
    return [...rows].sort((a, b) => (sort.dir === 'asc' ? cmp(a, b) : cmp(b, a)));
  }, [files, query, sort]);

  const troubled = (status?.systems ?? []).filter((s) => s.state === 'retrying' || s.state === 'failed');
  // 'Select all' means all VISIBLE rows. Selecting rows a search has hidden
  // would put files in the download that the user cannot see.
  const allSelected = visible.length > 0 && visible.every((f) => selected.has(f.name));
  const selectedVisible = visible.filter((f) => selected.has(f.name)).length;

  function toggleSort(key: SortKey) {
    setSort((cur) => cur.key === key
      ? { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' }
      // A first click on Name should read A–Z, but on Size or Last changed the
      // useful end is the big/recent one, so those start descending.
      : { key, dir: key === 'name' ? 'asc' : 'desc' });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <HardDriveDownload className="h-4 w-4 text-primary-600" />
          Automatic backup
        </CardTitle>
      </CardHeader>
      <CardBody className="space-y-4">
        <p className="text-xs text-slate-600 leading-relaxed">
          Every system in Systems Management is backed up every{' '}
          {status?.scheduler.intervalMin ?? 5} minutes, incrementally — UESIM{' '}
          <code className="font-mono text-[11px] bg-slate-100 px-1 rounded">/root/ue/config</code>, callbox{' '}
          <code className="font-mono text-[11px] bg-slate-100 px-1 rounded">/root/enb/config</code> and{' '}
          <code className="font-mono text-[11px] bg-slate-100 px-1 rounded">/root/mme/config</code>, and every
          Simnovator testcase. Only files whose contents actually changed are transferred, and{' '}
          <span className="font-semibold">nothing is ever deleted</span>: a config removed from a box stays here,
          marked as no longer on the source. A system that cannot be reached keeps retrying for{' '}
          {status?.retryWindowMin ?? 30} minutes before it is reported as failed.
        </p>

        {/* ── Status strip ─────────────────────────────────────────── */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
          <span className="flex items-center gap-1.5 text-slate-700">
            <Clock className="h-3.5 w-3.5" />
            {status?.lastCycleFinishedAt
              ? <>Last run {new Date(status.lastCycleFinishedAt).toLocaleString()}{status.lastCycleMs ? ` (${(status.lastCycleMs / 1000).toFixed(1)}s)` : ''}</>
              : <>No cycle has finished yet</>}
          </span>
          <span className={'flex items-center gap-1.5 ' + (troubled.length ? 'text-amber-800' : 'text-emerald-800')}>
            {troubled.length
              ? <><AlertTriangle className="h-3.5 w-3.5" /> {troubled.length} system(s) need attention</>
              : <><CheckCircle2 className="h-3.5 w-3.5" /> All {status?.systems.length ?? 0} systems backed up</>}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Button
              onClick={runNow}
              disabled={busy}
              className="bg-surface text-slate-700 border border-slate-300 hover:bg-slate-50 h-8"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              <span className="ml-1.5">Back up now</span>
            </Button>
          </div>
        </div>

        {troubled.length > 0 ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 space-y-1">
            {troubled.map((s) => (
              <div key={s.ip} className="flex gap-2">
                <AlertTriangle className="h-3.5 w-3.5 mt-0.5 flex-none" />
                <div>
                  <span className="font-semibold">{s.systemType} {s.ip}</span>{' '}
                  {s.state === 'failed'
                    ? <span className="font-semibold text-red-700">failed</span>
                    : <>retrying ({s.failingForMin} of {status?.retryWindowMin ?? 30} min)</>}
                  {s.reason ? <span className="opacity-80"> — {s.reason}</span> : null}
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {/* ── Browser ──────────────────────────────────────────────── */}
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-700 flex items-center gap-1.5">
              <FolderOpen className="h-3.5 w-3.5" /> Backup type
            </label>
            <select
              value={typeIdx}
              onChange={(e) => setTypeIdx(Number(e.target.value))}
              className="w-full md:w-[200px] border border-slate-300 rounded-md px-3 py-2 text-sm bg-surface text-slate-700"
            >
              {TYPES.map((t, i) => <option key={t.category} value={i}>{t.label}</option>)}
            </select>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-700 flex items-center gap-1.5">
              <Server className="h-3.5 w-3.5" /> System
            </label>
            {status === null ? (
              <div className="text-xs text-slate-500 flex items-center gap-1.5 h-9 px-3"><Loader2 className="h-3 w-3 animate-spin" /> loading…</div>
            ) : eligible.length === 0 ? (
              <div className="text-xs text-slate-500 h-9 flex items-center px-3">No system in Systems Management holds {type.label}.</div>
            ) : (
              <select
                value={ip}
                onChange={(e) => setIp(e.target.value)}
                className="w-full md:w-[420px] border border-slate-300 rounded-md px-3 py-2 text-sm bg-surface text-slate-700"
              >
                {eligible.map((s) => (
                  <option key={s.ip} value={s.ip}>
                    {s.name} ({s.ip}) — {s.files[type.category] ?? 0} file(s)
                  </option>
                ))}
              </select>
            )}
          </div>

        </div>

        {/* Two ways out, because the right one depends on how much you took:
            a few cfgs are easier loose, 900 testcases only make sense zipped.
            Both are filled rather than one filled and one outlined — neither is a
            fallback for the other, so neither should look like the quiet option.
            The two colours are the app's own: primary orange and the emerald the
            theme calls "accent". */}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            onClick={downloadZip}
            disabled={!selectedVisible || !!downloading}
            className="bg-primary-600 hover:bg-primary-700 text-on-accent"
          >
            {downloading?.what === 'zip' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileArchive className="h-4 w-4" />}
            <span className="ml-1.5">
              {downloading?.what === 'zip' ? 'Building archive…' : `Download as ZIP (${selectedVisible})`}
            </span>
          </Button>

          <Button
            onClick={downloadIndividually}
            disabled={!selectedVisible || !!downloading}
            className="bg-accent-600 hover:bg-accent-700 text-white border-transparent"
          >
            {downloading?.what === 'files' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            <span className="ml-1.5">
              {downloading?.what === 'files'
                ? `Downloading ${downloading.done}/${downloading.total}…`
                : `Download individually (${selectedVisible})`}
            </span>
          </Button>

          {selectedVisible > 20 && !downloading ? (
            <span className="text-[11px] text-amber-800">
              {selectedVisible} separate downloads will take about {Math.ceil(selectedVisible * 0.25)}s and your browser may
              ask to allow them — the ZIP arrives as one file.
            </span>
          ) : null}
        </div>

        {files === null ? null : files.length === 0 ? (
          <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
            Nothing stored for {type.label} on {ip || 'this system'} yet. If the system was added recently, the next
            cycle will pick it up — or press <span className="font-semibold">Back up now</span>.
          </div>
        ) : (
          <div className="rounded-md border border-slate-200 overflow-hidden">
            {/* One header row carrying everything the list needs: select-all, the
                column headings you sort by, and the search. Keeping sort on the
                headings means the control sits on the column it reorders, instead
                of in a dropdown above that has to name it. Widths here mirror the
                data rows below so the columns line up. */}
            <div className="flex items-center gap-2 px-3 py-2 bg-slate-50 border-b border-slate-200 text-xs">
              <input
                type="checkbox"
                checked={allSelected}
                title={allSelected ? "Clear selection" : "Select every file shown"}
                onChange={(e) => {
                  // Adds or removes only what is on screen. Toggling a filtered
                  // view must not silently pick up the rows it is hiding, and must
                  // not discard a selection made before the search either.
                  const next = new Set(selected);
                  for (const f of visible) { if (e.target.checked) next.add(f.name); else next.delete(f.name); }
                  setSelected(next);
                }}
              />

              <SortHeader label="Name" col="name" sort={sort} onSort={toggleSort} className="flex-none" />

              <span className="text-slate-400 flex-none">
                ({query.trim() ? <>{visible.length} of {files.length}</> : visible.length})
              </span>

              <div className="relative flex-1 min-w-[120px] max-w-[280px]">
                <Search className="h-3 w-3 text-slate-400 absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search files…"
                  className="w-full border border-slate-300 rounded pl-7 pr-2 py-1 text-xs bg-surface text-slate-700"
                />
              </div>

              <SortHeader label="Size" col="bytes" sort={sort} onSort={toggleSort} className="flex-none w-20 justify-end" />
              <SortHeader label="Last changed" col="lastChanged" sort={sort} onSort={toggleSort} className="flex-none w-36 justify-end" />
            </div>
            <div className="max-h-72 overflow-y-auto divide-y divide-slate-100">
              {visible.length === 0 ? (
                <div className="px-3 py-4 text-xs text-slate-500">
                  No file matches “{query.trim()}”. {files.length} file(s) are stored for {type.label} on {ip}.
                </div>
              ) : null}
              {visible.map((f) => (
                <label key={f.name} className="flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-slate-50 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selected.has(f.name)}
                    onChange={(e) => {
                      const next = new Set(selected);
                      if (e.target.checked) next.add(f.name); else next.delete(f.name);
                      setSelected(next);
                    }}
                  />
                  <span className="font-mono text-[11px] text-slate-800 break-all flex-1">{f.name}</span>
                  {f.missingFromSource ? (
                    <span className="text-[10px] uppercase tracking-wider font-semibold text-amber-700 flex-none">
                      no longer on box
                    </span>
                  ) : null}
                  <span className="text-slate-500 flex-none w-20 text-right tabular-nums">{formatBytes(f.bytes)}</span>
                  <span className="text-slate-400 flex-none w-36 text-right">
                    {f.lastChanged ? new Date(f.lastChanged).toLocaleString() : '—'}
                  </span>
                </label>
              ))}
            </div>
          </div>
        )}

        {err ? (
          <div className="rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700 flex gap-2">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 flex-none" />
            <div>{err}</div>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}

/** A column heading that sorts. The arrow shows both which column is active and
 *  which way it is going, so the current order is readable without clicking. */
function SortHeader({ label, col, sort, onSort, className = '' }: {
  label: string;
  col: SortKey;
  sort: { key: SortKey; dir: 'asc' | 'desc' };
  onSort: (k: SortKey) => void;
  className?: string;
}) {
  const active = sort.key === col;
  return (
    <button
      type="button"
      onClick={() => onSort(col)}
      title={`Sort by ${label.toLowerCase()}`}
      className={
        'flex items-center gap-1 font-medium hover:text-primary-700 '
        + (active ? 'text-primary-700 ' : 'text-slate-600 ') + className
      }
    >
      {label}
      {active
        ? (sort.dir === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />)
        : <ChevronsUpDown className="h-3 w-3 opacity-40" />}
    </button>
  );
}

function formatBytes(n: number): string {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
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

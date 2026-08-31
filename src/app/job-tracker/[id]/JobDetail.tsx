'use client';

// One job's detail + log view.
//
// Polls while the job is live so a running install or playlist streams in, and
// stops once it has settled. The log is filterable by phase because a build
// install can bury the twelve lines about the playlist under ten thousand lines
// of installer output.

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ChevronLeft, RefreshCw, Download } from 'lucide-react';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui';
import type { Job, JobLogEntry, JobStepName } from '@/lib/jobTracker/types';
import { JobStatusBadge, LIVE_STATUSES, stampJob, elapsed } from '../jobUi';

const PHASES: Array<{ key: JobStepName | 'all'; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'build', label: 'Build install' },
  { key: 'resources', label: 'Resource check' },
  { key: 'execution', label: 'Execution' },
];

export function JobDetail({ initialJob, initialEntries }: { initialJob: Job; initialEntries: JobLogEntry[] }) {
  const [job, setJob] = useState<Job>(initialJob);
  /** Container health for this job's station. Fetched once on mount and
   *  re-fetched while the job is live, since an install brings services down
   *  and back up and a stale snapshot would misreport that. */
  const [health, setHealth] = useState<{
    ok: boolean; checkedAt: string; error?: string; unhealthy: string[];
    containers: Array<{ name: string; status: string; uptime?: string; healthy: boolean }>;
  } | null>(null);
  const [entries, setEntries] = useState<JobLogEntry[]>(initialEntries);
  const [phase, setPhase] = useState<JobStepName | 'all'>('all');
  const [truncated, setTruncated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [follow, setFollow] = useState(true);
  const logRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/jobs/${initialJob.id}/logs?tail=8000`, { cache: 'no-store' });
      const d = await r.json();
      if (!r.ok || !d.ok) return;
      setEntries(d.entries ?? []);
      setTruncated(!!d.truncated);
      // The logs route returns a trimmed job; merge so nothing already known
      // is lost if a field is absent.
      setJob((cur) => ({ ...cur, ...d.job }));
    } catch { /* transient — the next tick retries */ }
  }, [initialJob.id]);

  const live = LIVE_STATUSES.includes(job.status);
  useEffect(() => {
    if (!live) return;
    const t = setInterval(load, 4_000);
    return () => clearInterval(t);
  }, [live, load]);

  // Container health: once on mount, then on a slow timer while the job is
  // live. 20s rather than the log's 4s — containers change on the scale of an
  // install, and the box does real work to answer this.
  useEffect(() => {
    if (!job.setupHost) return;
    let cancelled = false;
    const read = async () => {
      try {
        const r = await fetch(`/api/jobs/container-health?host=${encodeURIComponent(job.setupHost)}`, { cache: 'no-store' });
        const d = await r.json();
        if (!cancelled && d?.ok) setHealth(d.health);
      } catch { /* leave the previous snapshot rather than blanking it */ }
    };
    read();
    if (!live) return () => { cancelled = true; };
    const t = setInterval(read, 20_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [job.setupHost, live]);

  useEffect(() => {
    if (!follow) return;
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries, follow]);

  const shown = phase === 'all' ? entries : entries.filter((e) => e.phase === phase);

  const download = () => {
    const text = entries
      .map((e) => `${new Date(e.ts).toISOString()} [${e.phase}] ${e.line}`)
      .join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${job.id}-log.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const stepRow = (name: JobStepName, label: string) => {
    const s = job.steps?.[name];
    const tone =
      s?.status === 'ok' ? 'text-success-700'
      : s?.status === 'failed' ? 'text-red-700'
      : s?.status === 'running' ? 'text-blue-700'
      : 'text-slate-400';
    return (
      <div key={name} className="flex items-baseline justify-between gap-3 text-sm py-1.5">
        <span className="text-slate-600">{label}</span>
        <span className={'text-right ' + tone}>
          {s?.status === 'ok' ? 'Completed' : s?.status === 'failed' ? 'Failed' : s?.status === 'running' ? 'Running' : 'Not started'}
          {s?.detail ? <span className="block text-[11px] text-slate-400">{s.detail}</span> : null}
        </span>
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link href="/job-tracker" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
          <ChevronLeft className="h-4 w-4" /> Job Tracker
        </Link>
        <div className="flex items-center gap-3">
          <JobStatusBadge status={job.status} />
          <button
            onClick={async () => { setBusy(true); await load(); setBusy(false); }}
            className="inline-flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-800"
          >
            <RefreshCw className={'h-3.5 w-3.5 ' + (busy ? 'animate-spin' : '')} /> Refresh
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <Card>
          <CardHeader><CardTitle>Job</CardTitle></CardHeader>
          <CardBody className="text-sm space-y-2">
            <Row k="Job ID" v={<span className="font-mono">{job.id}</span>} />
            <Row k="User" v={job.user ?? <span className="text-slate-400 italic">not recorded</span>} />
            <Row k="Setup" v={<span className="font-mono">{job.setupHost}</span>} />
            <Row k="Playlist" v={job.playlistName ?? <span className="text-slate-400 italic">not selected</span>} />
            <Row k="Created" v={stampJob(job.createdAt)} />
            <Row k="Started" v={job.startedAt ? stampJob(job.startedAt) : '—'} />
            <Row k="Finished" v={job.finishedAt ? stampJob(job.finishedAt) : live ? <span className="text-yellow-700">in progress</span> : '—'} />
            {job.startedAt ? <Row k="Duration" v={elapsed(job.startedAt, job.finishedAt)} /> : null}
          </CardBody>
        </Card>

        <Card>
          <CardHeader><CardTitle>Build</CardTitle></CardHeader>
          <CardBody className="text-sm space-y-2">
            {job.build?.skipped ? (
              <Row k="Install" v={<span className="text-slate-600">Skipped — ran against the build already on the station</span>} />
            ) : (
              <>
                <Row k="Name" v={job.build?.buildName ?? '—'} />
                <Row k="URL" v={<span className="font-mono text-[11px] break-all">{job.build?.buildUrl}</span>} />
                {job.build?.installPending
                  ? <Row k="Install" v={<span className="text-amber-700">Queued — runs on the server after submit</span>} />
                  : null}
                {job.build?.installCommand
                  ? <Row k="Command" v={<span className="font-mono text-[11px] break-all">{job.build.installCommand}</span>} />
                  : null}
              </>
            )}
            <div className="pt-2 mt-1 border-t border-slate-100">
              {stepRow('build', 'Build install')}
              {stepRow('resources', 'Resource check')}
              {stepRow('execution', 'Playlist execution')}
            </div>
          </CardBody>
        </Card>

        {/* What the installed build is actually running.
            An installer exit code says the files landed; it does not say the
            services came up. These are the containers the build brought up on
            the station, so "installed" can be backed by evidence. */}
        <Card>
          <CardHeader className="flex items-center justify-between">
            <CardTitle>Build containers</CardTitle>
            {health ? (
              <span className={'text-[11px] font-medium rounded border px-1.5 py-0.5 ' + (health.ok
                ? 'bg-success-50 text-success-700 border-success-200'
                : 'bg-red-50 text-red-700 border-red-200')}>
                {health.ok ? `all ${health.containers.length} healthy` : `${health.unhealthy.length} down`}
              </span>
            ) : null}
          </CardHeader>
          <CardBody className="text-sm">
            {!health ? (
              <div className="text-xs text-slate-500">Reading container health from {job.setupHost}…</div>
            ) : health.error && health.containers.length === 0 ? (
              <div className="text-xs text-red-700">{health.error}</div>
            ) : (
              <>
                <ul className="divide-y divide-slate-100">
                  {health.containers.map((c) => (
                    <li key={c.name} className="flex items-center gap-2 py-1">
                      <span className={'h-1.5 w-1.5 rounded-full shrink-0 ' + (c.healthy ? 'bg-success-500' : 'bg-red-500')} />
                      <span className="font-mono text-[11px] text-slate-700 truncate flex-1">{c.name}</span>
                      <span className={'text-[11px] ' + (c.healthy ? 'text-slate-400' : 'text-red-700 font-medium')}>{c.status}</span>
                      {c.uptime ? <span className="text-[10px] text-slate-400 w-20 text-right shrink-0">{c.uptime}</span> : null}
                    </li>
                  ))}
                </ul>
                <div className="text-[10px] text-slate-400 pt-2">
                  {job.setupHost} · checked {new Date(health.checkedAt).toLocaleTimeString()}
                </div>
              </>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader><CardTitle>Testcases</CardTitle></CardHeader>
          <CardBody className="p-0">
            {job.testcases?.length ? (
              <ul className="divide-y divide-slate-100">
                {job.testcases.map((t, i) => (
                  <li key={i} className="px-4 py-2.5 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-xs font-mono text-slate-800 truncate">{t.name}</div>
                      {t.detail ? <div className="text-[11px] text-slate-400 truncate">{t.detail}</div> : null}
                    </div>
                    <span className={
                      'shrink-0 text-[11px] font-medium rounded-full px-2 py-0.5 ' +
                      (t.status === 'passed' ? 'bg-success-100 text-success-700'
                        : t.status === 'failed' ? 'bg-red-100 text-red-700'
                        : t.status === 'running' ? 'bg-yellow-100 text-yellow-800'
                        : t.status === 'skipped' ? 'bg-slate-100 text-slate-500'
                        : 'bg-slate-100 text-slate-500')
                    }>
                      {t.status}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="p-4 text-sm text-slate-500">No playlist selected.</div>
            )}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle>Logs</CardTitle>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-0.5">
              {PHASES.map((p) => (
                <button
                  key={p.key}
                  onClick={() => setPhase(p.key)}
                  className={
                    'px-2.5 py-1 text-xs font-medium rounded-md transition-colors ' +
                    (phase === p.key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700')
                  }
                >
                  {p.label}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer select-none">
              <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} className="h-3.5 w-3.5" />
              Follow
            </label>
            <button onClick={download} className="inline-flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-800">
              <Download className="h-3.5 w-3.5" /> Download
            </button>
          </div>
        </CardHeader>
        <CardBody className="p-0">
          {truncated ? (
            <div className="px-4 py-2 text-[11px] text-amber-700 bg-amber-50 border-b border-amber-100">
              Showing the most recent lines only — the full log is on disk under data/jobs/{job.id}/.
            </div>
          ) : null}
          <div ref={logRef} className="h-[420px] overflow-y-auto bg-slate-900 text-slate-100 font-mono text-[11px] leading-relaxed p-4">
            {shown.length === 0 ? (
              <div className="text-slate-500">No log lines for this phase yet.</div>
            ) : shown.map((e, i) => (
              <div
                key={i}
                className={
                  e.level === 'error' ? 'text-red-300'
                  : e.level === 'step' ? 'text-cyan-300 font-semibold'
                  : e.level === 'info' ? 'text-slate-400'
                  : ''
                }
              >
                <span className="text-slate-600 mr-2">
                  {new Date(e.ts).toLocaleTimeString('en-GB', { hour12: false })}
                </span>
                {e.line}
              </div>
            ))}
          </div>
        </CardBody>
      </Card>
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-slate-500 text-xs shrink-0">{k}</span>
      <span className="text-slate-900 text-right min-w-0">{v}</span>
    </div>
  );
}

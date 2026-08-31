'use client';

// The Job History table.
//
// Polls while any job is mid-flight so a running build or playlist updates
// without the user reaching for refresh, and stops polling once everything has
// settled — a table of finished jobs has no reason to keep hitting the server.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { FileText, RefreshCw } from 'lucide-react';
import type { Job } from '@/lib/jobTracker/types';
import { JobStatusBadge, LIVE_STATUSES, stampJob, elapsed } from './jobUi';

export function JobHistory({ initialJobs }: { initialJobs: Job[] }) {
  const [jobs, setJobs] = useState<Job[]>(initialJobs);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/jobs', { cache: 'no-store' });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d?.error ?? `HTTP ${r.status}`);
      setJobs(d.jobs ?? []);
      setErr(null);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    }
  }, []);

  const anyLive = jobs.some((j) => LIVE_STATUSES.includes(j.status));
  useEffect(() => {
    if (!anyLive) return;              // nothing moving — don't poll
    const t = setInterval(load, 5_000);
    return () => clearInterval(t);
  }, [anyLive, load]);

  const manualRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  if (jobs.length === 0) {
    return (
      <div className="p-8 text-center">
        <div className="text-sm text-slate-600">No jobs yet.</div>
        <div className="text-xs text-slate-400 mt-1">
          Create one to install a build, pick a playlist, check resources, and run it.
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between px-5 py-2.5 border-b border-slate-100">
        <span className="text-xs text-slate-500">
          {jobs.length} job{jobs.length === 1 ? '' : 's'}
          {anyLive ? <span className="text-yellow-700"> · live updating</span> : null}
        </span>
        <div className="flex items-center gap-3">
          {err ? <span className="text-xs text-red-600">{err}</span> : null}
          <button
            onClick={manualRefresh}
            className="inline-flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-800"
          >
            <RefreshCw className={'h-3.5 w-3.5 ' + (refreshing ? 'animate-spin' : '')} />
            Refresh
          </button>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="text-left px-5 py-2.5 font-medium whitespace-nowrap">Job ID</th>
              <th className="text-left px-5 py-2.5 font-medium whitespace-nowrap">Playlist</th>
              <th className="text-left px-5 py-2.5 font-medium whitespace-nowrap">User</th>
              <th className="text-left px-5 py-2.5 font-medium whitespace-nowrap">Result</th>
              <th className="text-left px-5 py-2.5 font-medium whitespace-nowrap">Logs</th>
              <th className="text-left px-5 py-2.5 font-medium whitespace-nowrap">Time</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {jobs.map((j) => {
              const running = LIVE_STATUSES.includes(j.status);
              const passedCount = j.testcases.filter((t) => t.status === 'passed').length;
              const total = j.testcases.length;
              return (
                <tr key={j.id} className="hover:bg-slate-50">
                  <td className="px-5 py-3 whitespace-nowrap">
                    <Link href={`/job-tracker/${j.id}`} className="font-mono font-medium text-primary-700 hover:underline">
                      {j.id}
                    </Link>
                    <div className="text-[11px] text-slate-400 font-mono">{j.setupHost}</div>
                  </td>

                  <td className="px-5 py-3">
                    {j.playlistName
                      ? <>
                          <div className="text-slate-900">{j.playlistName}</div>
                          {total > 0 ? (
                            <div className="text-[11px] text-slate-400">
                              {total} testcase{total === 1 ? '' : 's'}
                              {j.status === 'passed' || j.status === 'failed' ? ` · ${passedCount}/${total} passed` : ''}
                            </div>
                          ) : null}
                        </>
                      : <span className="text-slate-400 italic text-xs">not selected</span>}
                  </td>

                  <td className="px-5 py-3 whitespace-nowrap">
                    {/* Absent rather than guessed — a job created outside a
                        browser session genuinely has no user to name. */}
                    {j.user
                      ? <span className="text-slate-900">{j.user}</span>
                      : <span className="text-slate-400 italic text-xs">not recorded</span>}
                  </td>

                  <td className="px-5 py-3 whitespace-nowrap">
                    <JobStatusBadge status={j.status} />
                    {!j.submittedAt && (j.status === 'ready' || j.status === 'pending') ? (
                      <div className="text-[11px] text-slate-400 mt-1">not submitted</div>
                    ) : null}
                  </td>

                  <td className="px-5 py-3 whitespace-nowrap">
                    <Link
                      href={`/job-tracker/${j.id}`}
                      className="inline-flex items-center gap-1.5 text-xs text-primary-700 hover:underline"
                    >
                      <FileText className="h-3.5 w-3.5" />
                      View
                    </Link>
                  </td>

                  <td className="px-5 py-3 whitespace-nowrap text-xs">
                    <div className="text-slate-700">
                      {stampJob(j.startedAt ?? j.createdAt)}
                      {j.finishedAt
                        ? <> – {stampJob(j.finishedAt)}</>
                        : running
                          ? <span className="text-yellow-700"> – in progress</span>
                          : null}
                    </div>
                    <div className="text-[11px] text-slate-400">
                      created {stampJob(j.createdAt)}
                      {j.startedAt ? ` · ran ${elapsed(j.startedAt, j.finishedAt)}` : ''}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

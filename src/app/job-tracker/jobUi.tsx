'use client';

// Shared presentation bits for the Job Tracker — status badges and the time
// formats used by both the history table and the wizard, so a status never
// looks like two different things in two places.

import type { JobStatus } from '@/lib/jobTracker/types';

const STATUS_STYLE: Record<JobStatus, { label: string; cls: string; dot: string }> = {
  pending:           { label: 'Pending',               cls: 'bg-slate-100 text-slate-700',   dot: '#94A3B8' },
  build_installing:  { label: 'Build Installing',      cls: 'bg-blue-100 text-blue-700',     dot: '#2563EB' },
  build_failed:      { label: 'Build Failed',          cls: 'bg-red-100 text-red-700',       dot: '#DC2626' },
  resource_checking: { label: 'Resource Checking',     cls: 'bg-blue-100 text-blue-700',     dot: '#2563EB' },
  resource_failed:   { label: 'Resource Check Failed', cls: 'bg-red-100 text-red-700',       dot: '#DC2626' },
  ready:             { label: 'Ready',                 cls: 'bg-teal-100 text-teal-700',     dot: '#0D9488' },
  queued:            { label: 'Queued',                 cls: 'bg-amber-100 text-amber-800',   dot: '#D97706' },
  in_progress:       { label: 'In Progress',           cls: 'bg-yellow-100 text-yellow-800', dot: '#EAB308' },
  passed:            { label: 'Passed',                cls: 'bg-success-100 text-success-700', dot: '#16A34A' },
  failed:            { label: 'Failed',                cls: 'bg-red-100 text-red-700',       dot: '#DC2626' },
};

/** Statuses where something is actively happening — used to animate the dot
 *  and to decide whether the table should keep polling. */
// `queued` counts as live: the job has been accepted and is waiting for the
// station, so the table must keep polling to catch it starting.
export const LIVE_STATUSES: JobStatus[] = ['build_installing', 'resource_checking', 'queued', 'in_progress'];

export function JobStatusBadge({ status }: { status: JobStatus }) {
  const s = STATUS_STYLE[status] ?? STATUS_STYLE.pending;
  const live = LIVE_STATUSES.includes(status);
  return (
    <span className={'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ' + s.cls}>
      <span
        className={'h-1.5 w-1.5 rounded-full shrink-0 ' + (live ? 'animate-pulse' : '')}
        style={{ background: s.dot }}
      />
      {s.label}
    </span>
  );
}

/** "21-Aug-2026 04:30 PM" — the format the job history table uses. */
export function stampJob(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const day = String(d.getDate()).padStart(2, '0');
  const mon = d.toLocaleString('en-GB', { month: 'short' });
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: true }).toUpperCase();
  return `${day}-${mon}-${d.getFullYear()} ${time}`;
}

/** Elapsed time as a compact human string. */
export function elapsed(fromIso?: string, toIso?: string): string {
  if (!fromIso) return '';
  const from = new Date(fromIso).getTime();
  const to = toIso ? new Date(toIso).getTime() : Date.now();
  const ms = to - from;
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), rs = s % 60;
  if (m < 60) return rs ? `${m}m ${rs}s` : `${m}m`;
  const h = Math.floor(m / 60), rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

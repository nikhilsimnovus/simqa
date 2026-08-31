'use client';

// Resource Availability → usage history.
//
// The donut on the dashboard answers "what is free right now". This answers
// "how has this station actually been doing" over a day, week, month or year:
// what share of the time it was used (running a testcase), unused (online and
// idle), or unavailable (down) — as a percentage and as a graph over time.
//
// Scope is the STATION — the Simnovator, whose status is what the three states
// are derived from. Its bound machines follow underneath as thin strips.
//
// The chart is deliberately honest about what it does not know. Percentages are
// taken over time SimQA actually observed, and the window says how much that
// was: "98% used" across twenty minutes must not be mistaken for 98% of a day.
// Stretches where SimQA was not running show as pale "no data", never as
// downtime, and time before a station was added is left blank.

import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { History, X } from 'lucide-react';

type Range = 'day' | 'week' | 'month' | 'year';
type State = 'available' | 'in_use' | 'offline';

interface Bucket {
  from: number; to: number; label: string; title: string;
  available: number; inUse: number; offline: number;
  noData: number; notTracked: number; future: number;
}
interface Series {
  systemId: string; host: string; name: string; role: string;
  addedAt: number; range: Range; from: number; to: number;
  buckets: Bucket[];
  totals: { available: number; inUse: number; offline: number; noData: number };
  uptimePct: number | null;
  availablePct: number | null;
  inUsePct: number | null;
  coveragePct: number;
  current: { state: State; at: number; staleMs: number } | null;
  lastUsedBy?: string;
  lastUsedWhat?: string;
  lastUsedAt?: string;
}

const RANGES: Array<{ key: Range; label: string; window: string }> = [
  { key: 'day', label: 'Day', window: 'the last 24 hours' },
  { key: 'week', label: 'Week', window: 'the last 7 days' },
  { key: 'month', label: 'Month', window: 'the last 30 days' },
  { key: 'year', label: 'Year', window: 'the last 12 months' },
];

/** Same colours as the donut in the Resource Availability card — the two show
 *  the same three states, one as "now" and one as history, so a colour meaning
 *  different things across them would be actively misleading. */
const COLORS = {
  used: '#EAB308',          // running — yellow
  unused: '#16A34A',        // available — green
  unavailable: '#DC2626',   // down — red
  noData: '#E2E8F0',
} as const;

const STATE_LABEL: Record<State, string> = {
  available: 'Available',
  in_use: 'Running',
  offline: 'Unavailable',
};

/** Milliseconds as the shortest sensible unit — no room for "3600000ms", and
 *  no false precision of seconds across a year. */
function dur(ms: number): string {
  if (ms <= 0) return '0m';
  // Seconds below a minute rather than rounding to "0m": the summary shows a
  // duration next to its percentage, and "0.3% · 0m" reads as a contradiction
  // when what it means is eleven seconds.
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60), rm = m % 60;
  if (h < 24) return rm ? `${h}h ${rm}m` : `${h}h`;
  const d = Math.floor(h / 24), rh = h % 24;
  return rh ? `${d}d ${rh}h` : `${d}d`;
}

const fmtPct = (n: number | null) =>
  n === null ? '—' : `${n.toFixed(n >= 99.95 || n === 0 ? 0 : 1)}%`;

const ago = (ms: number) => (ms < 90_000 ? 'just now' : `${dur(ms)} ago`);

/**
 * Below this a slice is not a real observation, just rounding at the edge of
 * the sampling resolution — the poller reads once a minute, so anything under
 * half that is noise. Drawing it anyway was actively misleading: a segment of a
 * few hundred milliseconds got the 3px minimum height and sat in the bar
 * looking like a genuine outage, next to a tooltip that read "unavailable 0m".
 * The bar and the tooltip now agree: if it would round to 0m, it is not shown.
 */
const MIN_MEANINGFUL_MS = 30_000;
const meaningful = (ms: number) => ms >= MIN_MEANINGFUL_MS;

/** Donut of the three shares. One stroked circle per segment, offset around
 *  the ring — no chart library, and it matches the dashboard's ring exactly. */
function Donut({ parts, centre, sub }: {
  parts: Array<{ label: string; ms: number; color: string }>;
  centre: string;
  sub: string;
}) {
  const total = parts.reduce((a, p) => a + p.ms, 0);
  const R = 42, C = 2 * Math.PI * R;
  let acc = 0;
  const arcs = parts.filter((p) => p.ms > 0).map((p) => {
    const frac = total ? p.ms / total : 0;
    const arc = { ...p, dash: `${C * frac} ${C * (1 - frac)}`, offset: -C * acc };
    acc += frac;
    return arc;
  });
  return (
    <svg width="150" height="150" viewBox="0 0 100 100" role="img" aria-label={`${centre} ${sub}`}>
      <circle cx="50" cy="50" r={R} fill="none" stroke="#E2E8F0" strokeWidth="12" />
      <g transform="rotate(-90 50 50)">
        {arcs.map((a) => (
          <circle
            key={a.label} cx="50" cy="50" r={R} fill="none"
            stroke={a.color} strokeWidth="12"
            strokeDasharray={a.dash} strokeDashoffset={a.offset}
          />
        ))}
      </g>
      <text x="50" y="47" textAnchor="middle" className="fill-slate-900"
        style={{ fontSize: '20px', fontWeight: 700 }}>{centre}</text>
      <text x="50" y="62" textAnchor="middle" className="fill-slate-500"
        style={{ fontSize: '8px' }}>{sub}</text>
    </svg>
  );
}

/** Stacked bars across the range's buckets. */
function BarChart({ s, height = 'h-28', labels = true }: { s: Series; height?: string; labels?: boolean }) {
  return (
    <>
      <div className={`flex items-end gap-[2px] ${height}`}>
        {s.buckets.map((b) => {
          const span = b.to - b.from || 1;
          const h = (ms: number) => `${(ms / span) * 100}%`;
          const measurable = span - b.notTracked - b.future;
          const parts = [
            { k: 'unavailable', ms: b.offline, c: COLORS.unavailable },
            { k: 'used', ms: b.inUse, c: COLORS.used },
            { k: 'unused', ms: b.available, c: COLORS.unused },
            { k: 'noData', ms: b.noData, c: COLORS.noData },
          ].filter((p) => meaningful(p.ms));
          const untracked = measurable <= 0;
          const tip = untracked
            ? `${b.title} — before this station was tracked`
            : [
                b.title,
                meaningful(b.inUse) ? `used ${dur(b.inUse)}` : '',
                meaningful(b.available) ? `unused ${dur(b.available)}` : '',
                meaningful(b.offline) ? `unavailable ${dur(b.offline)}` : '',
                meaningful(b.noData) ? `no data ${dur(b.noData)}` : '',
              ].filter(Boolean).join(' · ');
          return (
            <div key={b.from} className="flex-1 min-w-0 flex flex-col justify-end h-full" title={tip}>
              {/* A hairline baseline for buckets with nothing to show, so an
                  as-yet-untracked range reads as "no data here" instead of
                  looking like the chart failed to draw. */}
              {parts.length === 0 ? (
                <div className="w-full h-px bg-slate-200" />
              ) : null}
              <div className="flex flex-col-reverse h-full justify-start">
                {parts.map((p) => (
                  // minHeight keeps a real-but-small slice visible: an hour of
                  // downtime inside a month bucket is 0.1% of the bar and would
                  // otherwise render as nothing at all. Only slices that passed
                  // the meaningful() threshold get here, so this can no longer
                  // inflate rounding noise into something that looks real.
                  <div key={p.k} style={{ height: h(p.ms), minHeight: '3px', background: p.c }}
                    className="w-full first:rounded-t-[2px]" />
                ))}
              </div>
            </div>
          );
        })}
      </div>
      {/* The member strips share the station's time axis, so repeating it under
          each one is noise rather than information. */}
      {labels ? (
        <div className="flex justify-between mt-1.5 text-[10px] text-slate-400 tabular-nums">
          {s.buckets.map((b, i) => (
            <span key={b.from} className="flex-1 min-w-0 text-center truncate">
              {/* Thin out labels on the dense ranges so they stay legible. */}
              {s.range === 'day' || s.range === 'month' ? (i % 3 === 0 ? b.label : '') : b.label}
            </span>
          ))}
        </div>
      ) : null}
    </>
  );
}

function HistoryWindow({ station, onClose }: { station?: string; onClose: () => void }) {
  const [range, setRange] = useState<Range>('day');
  const [data, setData] = useState<{ station: Series | null; members: Series[]; monitor: any } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const qs = new URLSearchParams({ range });
      if (station) qs.set('station', station);
      const r = await fetch(`/api/stations/history?${qs}`, { cache: 'no-store' });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d?.error ?? `HTTP ${r.status}`);
      setData({ station: d.station ?? null, members: d.members ?? [], monitor: d.monitor });
      setErr(null);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, [range, station]);

  useEffect(() => {
    setLoading(true);
    load();
    // Keep it current while the window is open. 30s sits inside the poller's
    // own cadence, so the chart never lags the data by more than one tick.
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  // Escape closes, and the page behind must not scroll while this is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const s = data?.station ?? null;
  const rangeMeta = RANGES.find((r) => r.key === range)!;

  const observed = s ? s.totals.inUse + s.totals.available + s.totals.offline : 0;
  const shares = s ? [
    { label: 'Used',        ms: s.totals.inUse,     color: COLORS.used,
      hint: 'running a testcase' },
    { label: 'Unused',      ms: s.totals.available, color: COLORS.unused,
      hint: 'online and idle' },
    { label: 'Unavailable', ms: s.totals.offline,   color: COLORS.unavailable,
      hint: 'down or unreachable' },
  ] : [];
  const share = (ms: number) => (observed > 0 ? (ms / observed) * 100 : null);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Resource availability usage history"
    >
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-4xl max-h-[88vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-4 px-6 py-4 border-b border-slate-100">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-slate-900">Usage history</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Station <span className="font-mono">{s?.host ?? station ?? '—'}</span>
              {s?.current ? <> · {STATE_LABEL[s.current.state]} now</> : null}
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-0.5">
              {RANGES.map((r) => (
                <button
                  key={r.key}
                  onClick={() => setRange(r.key)}
                  className={
                    'px-3 py-1 text-xs font-medium rounded-md transition-colors ' +
                    (range === r.key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700')
                  }
                >
                  {r.label}
                </button>
              ))}
            </div>
            <button
              onClick={onClose}
              aria-label="Close"
              className="p-1.5 rounded-md text-slate-400 hover:text-slate-700 hover:bg-slate-100"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="overflow-y-auto px-6 py-5 flex-1">
          {err ? (
            <div className="text-sm text-red-600">Could not load history: {err}</div>
          ) : loading && !data ? (
            <div className="text-sm text-slate-500">Loading history…</div>
          ) : !s ? (
            <div className="text-sm text-slate-500">
              No station has been tracked yet. The monitor records a reading every{' '}
              {data?.monitor?.pollSec ?? 60}s — the first data appears within a minute.
            </div>
          ) : observed === 0 ? (
            <div className="text-sm text-slate-500">
              Nothing observed in {rangeMeta.window}. Tracking for this station began{' '}
              {new Date(s.addedAt).toLocaleString()}.
            </div>
          ) : (
            <>
              {/* ── Percentages ───────────────────────────────────────── */}
              <div className="flex flex-wrap items-center gap-8">
                <Donut
                  parts={shares}
                  centre={fmtPct(share(s.totals.inUse))}
                  sub="used"
                />
                <ul className="flex-1 min-w-[240px] space-y-2.5">
                  {shares.map((p) => (
                    <li key={p.label} className="flex items-center justify-between gap-4 text-sm">
                      <span className="flex items-center gap-2 text-slate-600">
                        <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: p.color }} />
                        {p.label}
                        <span className="text-[11px] text-slate-400">{p.hint}</span>
                      </span>
                      <span className="tabular-nums shrink-0">
                        <span className="font-semibold text-slate-900">{fmtPct(share(p.ms))}</span>
                        <span className="text-slate-400 ml-2">{dur(p.ms)}</span>
                      </span>
                    </li>
                  ))}
                  {/* The denominator, stated. Percentages over twenty minutes
                      of data must not be read as percentages of a year. */}
                  <li className="pt-2 mt-1 border-t border-slate-100 text-[11px] text-slate-400">
                    Based on {dur(observed)} of {rangeMeta.window} that SimQA observed
                    {s.totals.noData > 0 ? <> · {dur(s.totals.noData)} not observed</> : null}
                  </li>
                </ul>
              </div>

              {/* ── Graph over time ───────────────────────────────────── */}
              <div className="mt-7">
                <BarChart s={s} />
              </div>

              {/* ── The station's machines, as thin strips ─────────────── */}
              {data!.members.length > 0 ? (
                <div className="mt-7 pt-5 border-t border-slate-100">
                  <div className="text-[11px] uppercase tracking-wider text-slate-400 mb-3">
                    Machines bound to this station
                  </div>
                  <div className="space-y-3">
                    {data!.members.map((m) => (
                      <div key={m.systemId} className="flex items-center gap-3">
                        <div className="w-32 shrink-0 min-w-0">
                          <div className="text-xs font-medium text-slate-700 truncate">{m.role}</div>
                          <div className="font-mono text-[10px] text-slate-400 truncate">{m.host}</div>
                        </div>
                        <div className="flex-1 min-w-0">
                          <BarChart s={m} height="h-8" labels={false} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </>
          )}
        </div>

        <div className="px-6 py-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
          {/* ── Who last used the station ─────────────────────────────────
              Recorded when someone submits a testcase, a Run & Validate, or an
              automation suite while signed in. Absent rather than guessed. */}
          <div className="text-xs">
            <span className="text-slate-500">Last used by: </span>
            {s?.lastUsedBy ? (
              <>
                <span className="font-semibold text-slate-900">{s.lastUsedBy}</span>
                {s.lastUsedWhat ? <span className="text-slate-400"> · {s.lastUsedWhat}</span> : null}
                {s.lastUsedAt ? (
                  <span className="text-slate-400"> · {new Date(s.lastUsedAt).toLocaleString()}</span>
                ) : null}
              </>
            ) : (
              <span className="text-slate-400 italic">
                no job submitted through SimQA yet
              </span>
            )}
          </div>
          {s ? (
            <span className="text-[11px] text-slate-400">
              Tracking since {new Date(s.addedAt).toLocaleString()}
              {s.current ? <> · last seen {ago(s.current.staleMs)}</> : null}
            </span>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** The link that lives in the Resource Availability card header. */
export function ResourceHistoryButton({ station }: { station?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-primary-700 hover:underline"
      >
        <History className="h-3.5 w-3.5" />
        Usage history
      </button>
      {open ? <HistoryWindow station={station} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

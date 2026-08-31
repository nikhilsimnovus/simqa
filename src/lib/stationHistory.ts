// Station availability history — "what state was each lab machine in, and when".
//
// WHY INTERVALS, NOT SAMPLES
// A sample every minute for a year is ~525k rows per station: slow to read,
// large on disk, and still only an approximation of when a state changed. So we
// store STATE INTERVALS instead. While a station keeps reporting the same state
// its current interval is simply extended, which means a station that sits
// available all week costs one row, and the maths for "how long was it in use
// this month" is exact rather than a count of samples.
//
// WHAT WE REFUSE TO INVENT
// Every interval is closed at the last moment we actually observed it. Time we
// did not observe — SimQA was shut down, the poller had not started yet — is
// reported as "no data", NEVER as offline. The difference matters: a station
// that was fine all weekend while SimQA was off must not be shown as having
// been down for 48 hours. Likewise nothing before a station's addedAt is
// counted at all; tracking starts when the station is first seen by the tool.
//
// Written by src/lib/stationMonitor.ts, read by the dashboard and
// /api/stations/history.

import * as fs from 'node:fs';
import * as path from 'node:path';

/** The three states a station can be in, as the user described them:
 *    available — reachable and idle, ready for someone to use
 *    in_use    — executing a testcase / running a submitted job
 *    offline   — not reachable; the machine is down for some reason  */
export type StationState = 'available' | 'in_use' | 'offline';

/** One closed observation interval. Short keys: this file is written every
 *  poll and read on every dashboard render, so the fat is worth trimming. */
export interface Segment {
  /** state */      s: StationState;
  /** from, ms */   f: number;
  /** to, ms */     t: number;
}

export interface StationRecord {
  systemId: string;
  host: string;
  name: string;
  /** Role in the topology — 'Simnovator', 'UE', 'Callbox', 'App server'… */
  role: string;
  /** Host of the Simnovator this machine belongs to, when it is a member of a
   *  topology profile. Lets the UI scope history to the selected station. */
  stationHost?: string;
  /** First moment SimQA ever observed this system. Tracking starts here — the
   *  user asked for history "from when the station is added on the tool". */
  addedAt: number;
  /** Newest last. */
  segments: Segment[];
}

interface Store {
  version: 1;
  stations: Record<string, StationRecord>;
}

const FILE = () => path.join(process.cwd(), 'data', 'station-history.json');

/**
 * How far apart two observations may be and still count as continuous. Beyond
 * this we assume SimQA was not watching and leave an explicit gap rather than
 * stretching the last known state across it.
 *
 * Three polls' grace: one missed tick (a slow box, a GC pause) should not
 * shatter an interval into fragments, but a restart should show as a gap.
 */
export const CONTINUITY_MS = 5 * 60_000;

/**
 * Minimum spacing between recorded observations for one station.
 *
 * The poller samples once a minute, so two readings seconds apart are not two
 * facts — they are one fact reported twice, by something that should not be
 * running twice. When they disagree we cannot tell which is right, and writing
 * both produces alternating sub-second segments that quietly wreck every
 * percentage derived from them. Keeping the first and ignoring the rest bounds
 * the damage; the next real sample settles the state a minute later.
 *
 * This is a backstop, not the fix — see the globalThis singleton in
 * stationMonitor.ts, which stops duplicate pollers existing at all.
 */
export const MIN_SAMPLE_MS = 10_000;

/** Keep just over a year, since "year" is the longest chart range. Older
 *  segments are dropped on write so the file cannot grow without bound. */
const RETAIN_MS = 400 * 24 * 60 * 60 * 1000;

function read(): Store {
  try {
    const j = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    if (j && typeof j === 'object' && j.stations && typeof j.stations === 'object') {
      return { version: 1, stations: j.stations };
    }
  } catch { /* no file yet, or unreadable — history is best-effort */ }
  return { version: 1, stations: {} };
}

function write(s: Store): void {
  try {
    fs.mkdirSync(path.dirname(FILE()), { recursive: true });
    // Written via a temp file + rename so a crash mid-write cannot leave a
    // truncated JSON file that loses all history.
    const tmp = FILE() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(s));
    fs.renameSync(tmp, FILE());
  } catch { /* bookkeeping must never break a run */ }
}

export interface Observation {
  systemId: string;
  host: string;
  name: string;
  role: string;
  stationHost?: string;
  state: StationState;
  /** Defaults to now. */
  at?: number;
}

/**
 * Fold a batch of observations into the history. One file write per batch —
 * the poller observes every system in a tick, and writing once per system
 * would rewrite the whole file a dozen times a minute.
 */
export function recordObservations(obs: Observation[]): void {
  if (!obs.length) return;
  const store = read();
  const now = Date.now();

  for (const o of obs) {
    if (!o?.systemId) continue;
    const at = o.at ?? now;
    let rec = store.stations[o.systemId];
    if (!rec) {
      rec = {
        systemId: o.systemId, host: o.host, name: o.name, role: o.role,
        stationHost: o.stationHost, addedAt: at, segments: [],
      };
      store.stations[o.systemId] = rec;
    }
    // Identity can change under us (renamed, re-addressed) — keep the latest,
    // but never move addedAt, which is when tracking began.
    rec.host = o.host; rec.name = o.name; rec.role = o.role;
    if (o.stationHost) rec.stationHost = o.stationHost;

    const last = rec.segments[rec.segments.length - 1];

    // Drop observations that are not newer than what we already hold. Two polls
    // can finish out of order (a timer tick overlapping an on-demand poll), and
    // folding an older reading in after a newer one would write a segment whose
    // end precedes its start — a negative duration that corrupts every total
    // derived from it. The time is already covered; there is nothing to add.
    if (last && at <= last.t) continue;

    const continuous = !!last && at - last.t <= CONTINUITY_MS;

    // Too soon to be a second real sample. Extending the current segment keeps
    // the time covered without letting a duplicate writer's disagreeing state
    // open a spurious segment.
    if (last && at - last.t < MIN_SAMPLE_MS) {
      last.t = at;
      continue;
    }

    if (continuous && last!.s === o.state) {
      last!.t = at;                       // same state, still watching — extend
    } else if (continuous) {
      // The state changed somewhere inside (previous observation, now]. We
      // cannot know when, so we must pick a convention, and the choice is not
      // neutral: crediting the interval to the OLD state would hide up to a
      // full poll interval of every outage.
      //
      // So the interval is credited to the state we just observed. An outage is
      // therefore counted from the last moment the machine was known good,
      // which errs towards reporting slightly MORE downtime than occurred —
      // the safe direction for an availability figure. Utilisation is rounded
      // the same way, at most one poll interval per transition.
      rec.segments.push({ s: o.state, f: last!.t, t: at });
    } else {
      // First ever observation, or we were not watching. Start fresh so the
      // uncovered stretch stays visible as a gap.
      rec.segments.push({ s: o.state, f: at, t: at });
    }

    const cutoff = now - RETAIN_MS;
    if (rec.segments.length > 4 && rec.segments[0].t < cutoff) {
      rec.segments = rec.segments.filter((s) => s.t >= cutoff);
    }
  }

  write(store);
}

export function listStations(): StationRecord[] {
  return Object.values(read().stations)
    .sort((a, b) => a.role.localeCompare(b.role) || a.name.localeCompare(b.name));
}

/** The most recently observed state, plus how stale that observation is.
 *  `null` when the station has never been seen. */
export function currentState(rec: StationRecord): { state: StationState; at: number; staleMs: number } | null {
  const last = rec.segments[rec.segments.length - 1];
  if (!last) return null;
  return { state: last.s, at: last.t, staleMs: Date.now() - last.t };
}

// ── Aggregation ────────────────────────────────────────────────────────────

export type Range = 'day' | 'week' | 'month' | 'year';

export const RANGE_LABELS: Record<Range, string> = {
  day: 'Day', week: 'Week', month: 'Month', year: 'Year',
};

export interface Bucket {
  from: number;
  to: number;
  /** Short axis label — "14:00", "Mon 12", "Mar". */
  label: string;
  /** Longer label for the tooltip. */
  title: string;
  /** Milliseconds in each state within this bucket. */
  available: number;
  inUse: number;
  offline: number;
  /** Observed but unaccounted-for time — SimQA was not running. */
  noData: number;
  /** Before the station was added to the tool: not history, just absence. */
  notTracked: number;
  /** Still in the future (the bucket containing "now" is partly unlived). */
  future: number;
}

export interface StationSeries {
  systemId: string;
  host: string;
  name: string;
  role: string;
  stationHost?: string;
  addedAt: number;
  range: Range;
  from: number;
  to: number;
  buckets: Bucket[];
  totals: { available: number; inUse: number; offline: number; noData: number };
  /** Share of OBSERVED time the machine was reachable (available + in use).
   *  null when nothing was observed in the window — an honest "no data"
   *  rather than a misleading 0% or 100%. */
  uptimePct: number | null;
  /** Share of observed time it was reachable AND idle. */
  availablePct: number | null;
  /** Share of observed time it was executing something. */
  inUsePct: number | null;
  /** How much of the window we actually have data for. */
  coveragePct: number;
  current: { state: StationState; at: number; staleMs: number } | null;
}

/** Bucket edges for a range, in LOCAL time so labels line up with the wall
 *  clock the user reads them against. */
function bucketEdges(range: Range, now: Date): { edges: number[]; labels: string[]; titles: string[] } {
  const edges: number[] = [];
  const labels: string[] = [];
  const titles: string[] = [];

  const pushDay = (d: Date, fmtLabel: (d: Date) => string) => {
    edges.push(d.getTime());
    labels.push(fmtLabel(d));
    titles.push(d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }));
  };

  if (range === 'day') {
    // 24 hourly buckets ending with the hour we are in.
    const start = new Date(now); start.setMinutes(0, 0, 0); start.setHours(start.getHours() - 23);
    for (let i = 0; i < 24; i++) {
      const d = new Date(start); d.setHours(start.getHours() + i);
      edges.push(d.getTime());
      labels.push(String(d.getHours()).padStart(2, '0'));
      titles.push(d.toLocaleString(undefined, { hour: 'numeric', day: 'numeric', month: 'short' }));
    }
    edges.push(new Date(start.getTime() + 24 * 3600_000).getTime());
  } else if (range === 'week' || range === 'month') {
    const days = range === 'week' ? 7 : 30;
    const start = new Date(now); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - (days - 1));
    for (let i = 0; i < days; i++) {
      const d = new Date(start); d.setDate(start.getDate() + i);
      pushDay(d, (x) =>
        range === 'week'
          ? x.toLocaleDateString(undefined, { weekday: 'short' })
          : String(x.getDate()));
    }
    const end = new Date(start); end.setDate(start.getDate() + days);
    edges.push(end.getTime());
  } else {
    // 12 monthly buckets ending with the current month.
    const start = new Date(now.getFullYear(), now.getMonth() - 11, 1);
    for (let i = 0; i < 12; i++) {
      const d = new Date(start.getFullYear(), start.getMonth() + i, 1);
      edges.push(d.getTime());
      labels.push(d.toLocaleDateString(undefined, { month: 'short' }));
      titles.push(d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }));
    }
    edges.push(new Date(start.getFullYear(), start.getMonth() + 12, 1).getTime());
  }

  return { edges, labels, titles };
}

/** Aggregate one station's segments into a bucketed series for `range`. */
export function seriesFor(rec: StationRecord, range: Range, nowMs = Date.now()): StationSeries {
  const now = new Date(nowMs);
  const { edges, labels, titles } = bucketEdges(range, now);
  const from = edges[0];
  const to = edges[edges.length - 1];

  const buckets: Bucket[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const bFrom = edges[i], bTo = edges[i + 1];
    const span = bTo - bFrom;

    // Split the bucket into what is even measurable: the future has not
    // happened, and time before the station existed in SimQA is not history.
    const future     = Math.max(0, bTo - Math.max(bFrom, nowMs));
    const notTracked = Math.max(0, Math.min(bTo, rec.addedAt, nowMs) - bFrom);
    const measurable = Math.max(0, span - future - notTracked);

    let available = 0, inUse = 0, offline = 0;
    for (const seg of rec.segments) {
      if (seg.t <= bFrom || seg.f >= bTo) continue;         // no overlap
      const ms = Math.min(seg.t, bTo) - Math.max(seg.f, bFrom);
      if (ms <= 0) continue;
      if (seg.s === 'available') available += ms;
      else if (seg.s === 'in_use') inUse += ms;
      else offline += ms;
    }
    // Guard against rounding pushing observed past measurable.
    const observed = Math.min(available + inUse + offline, measurable);
    buckets.push({
      from: bFrom, to: bTo, label: labels[i], title: titles[i],
      available, inUse, offline,
      noData: Math.max(0, measurable - observed),
      notTracked, future,
    });
  }

  const totals = buckets.reduce(
    (a, b) => ({
      available: a.available + b.available,
      inUse: a.inUse + b.inUse,
      offline: a.offline + b.offline,
      noData: a.noData + b.noData,
    }),
    { available: 0, inUse: 0, offline: 0, noData: 0 },
  );

  const observed = totals.available + totals.inUse + totals.offline;
  const measurable = observed + totals.noData;
  const pct = (n: number) => (observed > 0 ? (n / observed) * 100 : null);

  return {
    systemId: rec.systemId, host: rec.host, name: rec.name, role: rec.role,
    stationHost: rec.stationHost, addedAt: rec.addedAt,
    range, from, to, buckets, totals,
    uptimePct: pct(totals.available + totals.inUse),
    availablePct: pct(totals.available),
    inUsePct: pct(totals.inUse),
    coveragePct: measurable > 0 ? (observed / measurable) * 100 : 0,
    current: currentState(rec),
  };
}

/** Every tracked station's series for `range`. */
export function allSeries(range: Range, nowMs = Date.now()): StationSeries[] {
  return listStations().map((r) => seriesFor(r, range, nowMs));
}

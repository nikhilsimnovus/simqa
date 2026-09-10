// How long a run took, and when it ran — worded the same way everywhere.
//
// The dashboard's Recent Runs and the Test Cases list both show an execution as
// a duration with its window underneath, and they must agree: the same run read
// on two pages should not be described two different ways.
//
// Pure, and imports nothing, so it can be used from a server component (where
// the string is baked into the HTML) and from a client one alike.

/** "10:30 AM" */
export function timeOf(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

/** "07 Sep 2026" */
export function dateOf(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

/**
 * When a run ran: "8:53 AM – 11:41 AM · 07 Sep 2026".
 *
 * A run that crosses midnight — the weekend long-runs do, one of them by two
 * and a half days — gets a date on each end rather than one date that is only
 * true of the start.
 */
export function windowOf(startIso?: string, endIso?: string): string {
  const a = timeOf(startIso);
  if (!a) return '';
  const aDate = dateOf(startIso);
  const b = timeOf(endIso);
  if (!b) return `${a} · ${aDate}`;
  const bDate = dateOf(endIso);
  return aDate === bDate ? `${a} – ${b} · ${aDate}` : `${aDate}, ${a} – ${bDate}, ${b}`;
}

/** "45s", "11m 49s", "1h 04m". Rounded to whole seconds: a run's length is read
 *  to judge whether it was quick or slow, not to the millisecond. */
export function formatDuration(sec?: number): string {
  if (sec === undefined || !Number.isFinite(sec)) return '—';
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/**
 * The end of a run the box reported, from its start and how long it ran.
 *
 * The Simnovator records `durationSeconds` / `testDuration` but never an end
 * time, so this is the only way to state when one of its executions finished.
 */
export function endFromDuration(startIso?: string, durationSec?: number): string | undefined {
  if (!startIso || !durationSec || !Number.isFinite(durationSec)) return undefined;
  const t = new Date(startIso).getTime();
  return Number.isNaN(t) ? undefined : new Date(t + durationSec * 1000).toISOString();
}

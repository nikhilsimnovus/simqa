// Draggable column widths that cannot add up to a horizontal scrollbar.
//
// The History table is meant to read like a spreadsheet: aligned columns, and
// a handle on each heading to widen one. The usual way to do that — give every
// column a pixel width and let the table grow — is exactly what produces the
// horizontal scrolling it is not supposed to have.
//
// So widths are FRACTIONS of the table, they always sum to 1, and dragging a
// handle moves space between the column on its left and the one on its right.
// Nothing is created or destroyed, so the table is always exactly as wide as
// the page gives it, at any zoom and on any screen.
//
// Pure, imports nothing, so node --test loads it directly.

/** Nothing may be dragged thinner than this — a column you cannot see is a
 *  column you cannot drag back. */
export const MIN_FRACTION = 0.04;

/** Equal columns, as a starting point. */
export function evenWidths(n: number): number[] {
  if (n <= 0) return [];
  return Array.from({ length: n }, () => 1 / n);
}

/**
 * Move `delta` (a fraction of the whole table) from the column after the
 * handle to the column before it.
 *
 * `handle` is the index of the column on the handle's LEFT, so the last
 * column has no handle — there would be nothing on its right to take from.
 *
 * Both neighbours keep at least MIN_FRACTION, and the pair's total is
 * unchanged, which is what keeps the sum at 1.
 */
export function resizeColumns(widths: number[], handle: number, delta: number): number[] {
  if (handle < 0 || handle >= widths.length - 1) return widths;
  const a = widths[handle];
  const b = widths[handle + 1];
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(delta)) return widths;

  // Clamp the drag to what the pair can actually give up, so a fast drag
  // stops at the limit instead of pushing a neighbour below it.
  const room = Math.max(0, b - MIN_FRACTION);
  const give = Math.max(0, a - MIN_FRACTION);
  const d = Math.min(room, Math.max(-give, delta));
  if (d === 0) return widths;

  const next = [...widths];
  next[handle] = a + d;
  next[handle + 1] = b - d;
  return next;
}

/**
 * Make a stored or hand-written set of widths usable: the right length, all
 * finite, none below the minimum, summing to 1.
 *
 * Needed because these are persisted per browser, and a saved set from a
 * table that has since gained or lost a column would otherwise misalign every
 * row under a correct-looking heading.
 */
export function normaliseWidths(widths: unknown, n: number): number[] {
  if (n <= 0) return [];
  const raw = Array.isArray(widths) ? widths : [];
  if (raw.length !== n) return evenWidths(n);

  const clean = raw.map((w) => {
    const x = Number(w);
    return Number.isFinite(x) && x > 0 ? x : 0;
  });
  const sum = clean.reduce((t, x) => t + x, 0);
  if (sum <= 0) return evenWidths(n);

  // To fractions, then lift anything too thin and take it back off whatever
  // has room, so the sum stays 1.
  const scaled = clean.map((x) => x / sum);
  const lifted = scaled.map((x) => Math.max(MIN_FRACTION, x));
  const over = lifted.reduce((t, x) => t + x, 0) - 1;
  if (over <= 1e-9) return lifted;

  const spare = lifted.map((x) => Math.max(0, x - MIN_FRACTION));
  const spareTotal = spare.reduce((t, x) => t + x, 0);
  if (spareTotal <= 0) return evenWidths(n);
  return lifted.map((x, i) => x - over * (spare[i] / spareTotal));
}

/** As CSS percentages, for a <colgroup> on a fixed-layout table. */
export function asPercents(widths: number[]): string[] {
  return widths.map((w) => `${(w * 100).toFixed(4)}%`);
}

// Why a row did not do what was hoped, in one line, next to the row.
//
// A step's `detail` is the whole narrative of what SimQA did for that test
// case — where the definition came from, every config pushed, every symlink,
// the restart, the attach check — joined with " · ". It is the right thing to
// keep and the wrong thing to put in a table cell: the reason a run failed is
// the last thing in it, behind six lines of housekeeping that succeeded.
//
// So: the last segment, which is where the runner writes the outcome, unless
// that segment is plainly a success note — in which case there is nothing to
// explain and the row says nothing.
//
// Pure, imports nothing, so node --test loads it directly.

/** Segments that describe work done, not an outcome. A row that ends on one
 *  of these ended well, or ended without the runner having anything to add. */
const HOUSEKEEPING = /^(cfg-|server-configs:|testcase:|licence:|attach:|note:|configs:|verdict=)/;

/**
 * The one line to show beside a row, or undefined when there is nothing worth
 * saying.
 *
 * `status` is the row's own label: a Completed row needs no explanation even
 * when its last segment reads oddly, and an unexecuted one needs it most.
 */
export function failureReason(detail?: string, status?: string): string | undefined {
  const text = (detail ?? '').trim();
  if (!text) return undefined;
  if (status === 'Completed' || status === 'In Progress') return undefined;

  const parts = text.split(' · ').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return undefined;

  // From the end: the first segment that is not housekeeping is the reason.
  for (let i = parts.length - 1; i >= 0; i--) {
    if (!HOUSEKEEPING.test(parts[i])) return parts[i];
  }
  // All housekeeping — the run stopped without the runner saying why, which
  // is itself worth showing rather than inventing a reason.
  return parts[parts.length - 1];
}

/**
 * Is this reason something an operator can act on in SimQA, or is it about the
 * hardware?
 *
 * Only used to choose a hint, never to hide anything: a reason is always
 * shown, and this says whether to point at the suite or at the box.
 */
export function reasonIsOnTheBox(reason?: string): boolean {
  if (!reason) return false;
  return /RF card|not assigned to this simulator|already running|simulator still busy|licence/i.test(reason);
}

// Is the testcase on the box still the one this row means to run?
//
// A suite row owns ONE testcase on the Simnovator, named after the row, and
// every run executes that same one — no `_2`, `_3` copies piling up. Which
// makes "is it still right" the question that decides whether a run can reuse
// it or has to tear it down and build it again from the automation server's
// copy.
//
// It stops being right for reasons that have nothing to do with SimQA: the
// saved copy edited, the row's power-on duration changed, or somebody opening
// the testcase on the Simnovator and changing it there. All three have to end
// the same way — the run executes what the server says, not what the box
// happens to hold — and all three are the same comparison.
//
// Only the sections a definition is BUILT from are compared. The box fills in
// its own defaults, stamps metadata and echoes back fields nobody sent, so
// comparing whole objects would report a difference on every run and rebuild
// a testcase that was perfectly good.
//
// Pure, imports nothing, so node --test loads it directly.

/** The five sections the box's create lifecycle is given, in its own order. */
export const BUILT_FROM = [
  'cellConfig',
  'subsConfig',
  'userPlaneConfig',
  'powerCycleConfig',
  'mobilityConfig',
] as const;

/**
 * Which of those sections differ between the testcase on the box and the one
 * this run would build. Empty means the box's copy can be reused as it is.
 *
 * A section absent on both sides counts as the same — plenty of testcases
 * have no mobility — and a section present on one side only is a difference,
 * because that is a section the run would add or drop.
 */
export function changedSections(onBox: unknown, wanted: unknown): string[] {
  const a = (onBox ?? {}) as Record<string, unknown>;
  const b = (wanted ?? {}) as Record<string, unknown>;
  return BUILT_FROM.filter((k) => stable(a[k]) !== stable(b[k]));
}

/** True when the run has to rebuild rather than reuse. */
export function definitionDiffers(onBox: unknown, wanted: unknown): boolean {
  return changedSections(onBox, wanted).length > 0;
}

/**
 * JSON with object keys sorted, so two definitions that say the same thing in
 * a different order compare equal.
 *
 * They routinely do: the box returns its sections with keys in its own order,
 * and a definition that has been through a save, a file and a parse comes
 * back in insertion order. Comparing raw JSON.stringify output reported a
 * difference on every single run.
 */
function stable(v: unknown): string {
  return JSON.stringify(v ?? null, (_k, val) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      return Object.fromEntries(Object.keys(val as object).sort().map((k) => [k, (val as any)[k]]));
    }
    return val;
  });
}

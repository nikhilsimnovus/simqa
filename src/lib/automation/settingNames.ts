// Matching a testcase's named settings to the ones the box actually has.
//
// A test definition names two settings by string:
//
//   "loggingProfileName": "nas_rrc_debug"
//   "successCriteriaName": "4gMobility"
//
// and the box refuses to create a testcase that names one it does not hold:
//
//   BAD_REQUEST  successCriteriaName '4gMobility' does not exist
//
// which is what stopped NSA_3cell_Mobility_Vonr_1UEs_automation. The setting
// was not missing. 192.168.1.95 holds "4gmobility" — same name, lowercase m —
// and the box compares exactly. A definition captured on one box, or written
// before someone renamed a setting, carries the old spelling for ever.
//
// So the name is resolved against what the box reports, in this order:
//
//   1. exactly as written — the common case, and never guesses;
//   2. ignoring case and surrounding space — "4gMobility" finds "4gmobility";
//   3. the box's own default, which is what it would have used anyway;
//   4. nothing, and the caller leaves the field alone rather than inventing
//      a value the box never offered.
//
// Pure, imports nothing, so node --test loads it directly.

export interface BoxSetting {
  name: string;
  isDefault?: boolean;
}

export interface Resolution {
  /** The name to write, or undefined when the box offered nothing usable. */
  name?: string;
  /** How it was found — for the note shown against the row. */
  how: 'exact' | 'case' | 'default' | 'none';
}

/**
 * Which of the box's settings a testcase means.
 *
 * `wanted` is what the definition says; `available` is what the box listed.
 */
export function resolveSettingName(wanted: string | undefined, available: BoxSetting[]): Resolution {
  const have = (available ?? []).filter((s) => s && typeof s.name === 'string' && s.name !== '');
  const asked = (wanted ?? '').trim();

  if (asked) {
    const exact = have.find((s) => s.name === asked);
    if (exact) return { name: exact.name, how: 'exact' };

    const loose = have.find((s) => s.name.trim().toLowerCase() === asked.toLowerCase());
    if (loose) return { name: loose.name, how: 'case' };
  }

  const fallback = have.find((s) => s.isDefault);
  if (fallback) return { name: fallback.name, how: 'default' };

  return { how: 'none' };
}

/** One line for the row's detail, or nothing when the name was already right. */
export function resolutionNote(field: string, wanted: string | undefined, r: Resolution): string | undefined {
  if (r.how === 'exact') return undefined;
  const asked = (wanted ?? '').trim() || '(none)';
  if (r.how === 'case') return `${field}: the box spells "${asked}" as "${r.name}" — used the box's spelling`;
  if (r.how === 'default') return `${field}: the box has no "${asked}" — used its default, "${r.name}"`;
  return `${field}: the box has no "${asked}" and names no default — left as it was`;
}

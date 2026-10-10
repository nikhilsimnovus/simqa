// Which key a subscriber authenticates with, when the definition forgot to say.
//
// The box's subscriber schema carries four key-material fields — op, opc, top
// and topc — in one radio group, and a separate required field saying which of
// them is live:
//
//   algorithmKeyMode: { type: "string", radio: true, enum: ["op", "opc"],
//                       default: "opc" }
//
// With it present, the named field holds its value and the others must be
// empty. With it ABSENT, nothing is selected, so the box requires every one of
// them to be empty and refuses the definition:
//
//   SubsConfig: /opc: does not match pattern '^$' for SA profile 0
//
// Which is what happened to AIO_Validation_of_IMEISV_automation. Its saved
// copy had been edited by hand and the one line that selects the mode was
// commented out, while the opc it selects was left in place:
//
//       "algorithm": "xor",
//       // "algorithmKeyMode": "opc",
//
// The data still says what was meant — exactly one key field is populated — so
// the selection is reconstructable rather than a guess, and reconstructing it
// restores the file the author wrote instead of clearing a key to satisfy the
// box. When the data does NOT say unambiguously, nothing is touched and the
// box's own refusal stands.
//
// Pure, imports nothing, so node --test loads it directly.

/** The schema's radio group. Only op and opc are in algorithmKeyMode's enum;
 *  top and topc belong to tuak, which that enum does not cover, so a profile
 *  using those is left alone. */
const MODE_FIELDS = ['op', 'opc'] as const;
const OTHER_KEY_FIELDS = ['top', 'topc'] as const;

const filled = (v: unknown): boolean => typeof v === 'string' && v.trim() !== '';

/** Every subscriber list a definition might carry, under either spelling. */
function subscriberLists(td: any): any[][] {
  const out: any[][] = [];
  for (const section of [td?.subsConfig, td?.subscriberConfig, td?.subscriberData?.subsConfig]) {
    const subs = section?.subs;
    if (Array.isArray(subs)) out.push(subs);
  }
  return out;
}

/**
 * Put back an `algorithmKeyMode` the definition implies but does not state.
 *
 * Mutates in place. Returns one note per subscriber that was repaired, so the
 * run log says the definition was not quite what was stored — silently fixing
 * a file and silently failing on it are both ways of leaving the operator
 * guessing.
 */
export function restoreKeyMode(td: any): string[] {
  const notes: string[] = [];
  for (const subs of subscriberLists(td)) {
    subs.forEach((sub, i) => {
      if (!sub || typeof sub !== 'object') return;
      if (filled(sub.algorithmKeyMode)) return;
      // A tuak profile's key fields are outside this enum: not ours to decide.
      if (OTHER_KEY_FIELDS.some((f) => filled(sub[f]))) return;
      const set = MODE_FIELDS.filter((f) => filled(sub[f]));
      if (set.length !== 1) return;                 // nothing, or ambiguous
      sub.algorithmKeyMode = set[0];
      notes.push(`subscriber ${i}: algorithmKeyMode was missing and ${set[0]} holds a value — set it to "${set[0]}", which is what the box requires and its own default`);
    });
  }
  return notes;
}

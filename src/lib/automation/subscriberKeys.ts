// Subscriber key material the box will not accept where it is.
//
// The box keys op, opc, top and topc off the authentication ALGORITHM, and
// its schema spells out which may carry a value:
//
//   algorithm "milenage" + algorithmKeyMode "op"   -> op required, opc/top/topc  ^$
//   algorithm "milenage" + algorithmKeyMode "opc"  -> opc required, op/top/topc  ^$
//   algorithm "tuak"     + algorithmKeyMode "op"   -> top required, the rest     ^$
//   algorithm "tuak"     + algorithmKeyMode "opc"  -> topc required, the rest    ^$
//   algorithm "xor"                                -> algorithmKeyMode, op, opc,
//                                                     top and topc all { not: {} }
//
// xor is the one that bites. It authenticates with the shared key alone and
// uses no operator key at all, so the schema says those fields must not be
// there — and a subscriber switched from milenage to xor keeps its old OPc
// sitting in the file, where it is now meaningless. The API refuses the whole
// definition over it:
//
//   SubsConfig: /opc: does not match pattern '^$' for SA profile 0
//
// Which is what stopped AIO_Validation_of_IMEISV_automation from being created
// at all. Emptying a field the algorithm does not read changes nothing about
// what the test authenticates with; leaving it there means the test cannot run.
//
// The milenage and tuak cases are left alone except for one thing: a mode that
// is missing while exactly one key field is populated is reconstructable — the
// data says which — and those algorithms do require the selector.
//
// Pure, imports nothing, so node --test loads it directly.

/** The operator-key fields, all four of them. */
const KEY_FIELDS = ['op', 'opc', 'top', 'topc'] as const;
/** The two algorithmKeyMode selects between — its enum is ["op","opc"]. */
const MODE_FIELDS = ['op', 'opc'] as const;

const filled = (v: unknown): boolean => typeof v === 'string' && v.trim() !== '';
const algorithmOf = (sub: any): string => String(sub?.algorithm ?? '').trim().toLowerCase();

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
 * Make the subscriber section's key fields agree with its algorithm.
 *
 * Mutates in place. Returns one note per subscriber changed, so the run log
 * says the definition was not quite what was stored — silently fixing a file
 * and silently failing on it both leave the operator guessing.
 *
 * DELETED, not emptied. The schema says { not: {} }, which means absent, and
 * the box proved the difference: with a value it answers "/opc: does not
 * match pattern '^$'", and with an empty string it answers "/opc: does not
 * match pattern '^[a-fA-F0-9]{32}$'". Neither is satisfiable, because the two
 * complaints come from different branches — the only state that matches no
 * pattern at all is the field not being there.
 */
export function alignSubscriberKeys(td: any): string[] {
  const notes: string[] = [];
  for (const subs of subscriberLists(td)) {
    subs.forEach((sub, i) => {
      if (!sub || typeof sub !== 'object') return;
      const algorithm = algorithmOf(sub);

      if (algorithm === 'xor') {
        // algorithmKeyMode goes with them: the same branch says it must be
        // absent too, and it selects between fields that are no longer there.
        const cleared = [...KEY_FIELDS, 'algorithmKeyMode'].filter((f) => f in sub);
        if (!cleared.length) return;
        for (const f of cleared) delete sub[f];
        notes.push(
          `subscriber ${i}: removed ${cleared.join(', ')} — xor authenticates with the shared key alone, `
          + `and the box's schema says those fields must not be there at all`,
        );
        return;
      }

      // milenage and tuak: the selector is required, and when it is missing
      // the populated field says what it should have been.
      if (algorithm !== 'milenage' && algorithm !== 'tuak') return;
      if (filled(sub.algorithmKeyMode)) return;
      // tuak selects top/topc THROUGH the same op/opc mode, so look at which
      // of the four is populated and map it back onto the selector.
      const set = KEY_FIELDS.filter((f) => filled(sub[f]));
      if (set.length !== 1) return;                       // nothing, or ambiguous
      const mode: (typeof MODE_FIELDS)[number] | undefined =
        set[0] === 'op' || set[0] === 'top' ? 'op'
        : set[0] === 'opc' || set[0] === 'topc' ? 'opc'
        : undefined;
      if (!mode) return;
      sub.algorithmKeyMode = mode;
      notes.push(`subscriber ${i}: algorithmKeyMode was missing and ${set[0]} holds a value — set it to "${mode}", which is what ${algorithm} requires`);
    });
  }
  return notes;
}

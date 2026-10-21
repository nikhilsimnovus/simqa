// Deciding whether a ticket's expected result can actually be checked, and
// checking it.
//
// The rule from the requirement, and the one that shapes everything here: "A
// successful page load alone does not mean the Jira ticket has passed." So
// walking a ticket's pages without error is NOT a pass. It is a pass only
// when the ticket's own expected result was put to the page and held.
//
// What that looks like in practice. The expectations these tickets carry,
// once parsed or derived, are mostly of four shapes:
//
//   "<thing> should display <X>"      -> is X on the page?
//   "<X> should be present"           -> is X on the page?
//   "<X> should appear once"          -> how many times is X on the page?
//   "<thing> should not <do X>"       -> is X absent?
//
// Anything else — "the layout should be proper", "the admin should be able to
// stop another user's test" — cannot be settled by reading a page, and is
// reported as such with its evidence kept for a person. That is BLOCKED, not
// PASS, because claiming to have verified something unverifiable is the one
// failure mode worse than finding nothing.
//
// Pure, imports nothing, so node --test can load this directly.

export type CheckKind = 'present' | 'absent' | 'once' | 'none';

export interface Checkable {
  kind: CheckKind;
  /** The text to look for. Empty when kind is 'none'. */
  needle: string;
  /** Why this is not machine-checkable, when kind is 'none'. */
  why?: string;
}

/** Words that carry no meaning on their own, so a needle made only of these
 *  would match any page and prove nothing. */
const NOISE = new Set([
  'the', 'a', 'an', 'is', 'are', 'be', 'been', 'should', 'shall', 'must', 'will',
  'on', 'in', 'at', 'to', 'of', 'for', 'and', 'or', 'with', 'from', 'by', 'it',
  'this', 'that', 'these', 'those', 'page', 'screen', 'gui', 'ui', 'properly',
  'proper', 'correctly', 'correct', 'display', 'displayed', 'displays', 'shown',
  'show', 'shows', 'visible', 'available', 'present', 'appear', 'appears',
  'simnovator', 'user', 'option', 'options', 'value', 'values', 'field', 'fields',
]);

/** Is there enough left in a needle to be worth looking for? */
function meaningful(needle: string): boolean {
  const words = needle.toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean);
  const real = words.filter((w) => !NOISE.has(w) && w.length > 2);
  return real.length > 0 && needle.trim().length >= 3;
}

/** Trim an expectation down to the thing to look for. */
function clean(s: string): string {
  return dropWhere(s
    .replace(/^(?:the|a|an)\s+/i, '')
    .replace(/[.,;:]+$/, '')
    .replace(/\s+/g, ' ')
    .trim());
}

/**
 * Cut the "where" off the end of a needle.
 *
 * "installed version on GUI dashboard" describes a thing AND the page it
 * belongs on. Searching for the whole phrase finds nothing, because a page
 * renders "Installed Version 4.1.0" and never repeats its own name next to
 * it. The page is already decided by the step's navigation, so only the
 * thing matters here.
 *
 * Only cut when what is left still means something — "values in the list"
 * must not become "values".
 */
function dropWhere(s: string): string {
  const m = /^(.*?)\s+(?:on|in|under|within|from|for|of)\s+(?:the\s+)?(?:gui\s+)?.{0,40}$/i.exec(s);
  if (!m) return s;
  const head = m[1].trim();
  return meaningful(head) ? head : s;
}

/**
 * Can this expected result be put to a page, and how?
 *
 * Deliberately conservative: a shape this does not recognise is reported as
 * not checkable rather than approximated. A wrong PASS is worse than an
 * honest "a person needs to look at this".
 */
export function checkableFrom(expected: string): Checkable {
  const e = String(expected ?? '').trim();
  if (!e) return { kind: 'none', needle: '', why: 'the ticket states no expected result' };

  // "... should appear once" — a duplicate-element ticket turned round.
  let m = /^(.*?)\s+should\s+appear\s+once\b/i.exec(e);
  if (m && meaningful(clean(m[1]))) return { kind: 'once', needle: clean(m[1]) };

  // "... should not <verb> ..." — the thing must be absent.
  m = /^(?:.*?)\s+should\s+not\s+(?:be\s+)?(?:display|displayed|show|shown|present|visible|appear)\w*\s*(.*)$/i.exec(e);
  if (m && meaningful(clean(m[1]))) return { kind: 'absent', needle: clean(m[1]) };

  // "<thing> should display/show <X>"
  m = /\bshould\s+(?:be\s+able\s+to\s+)?(?:display|show|list|contain)\s+(.*)$/i.exec(e);
  if (m && meaningful(clean(m[1]))) return { kind: 'present', needle: clean(m[1]) };

  // "<X> should be present/visible/available/displayed"
  m = /^(.*?)\s+should\s+be\s+(?:present|visible|available|displayed|shown|enabled)\b/i.exec(e);
  if (m && meaningful(clean(m[1]))) return { kind: 'present', needle: clean(m[1]) };

  // "<X> should be <something>" where the something is a concrete VALUE.
  //
  // Guarded, because this is the loosest shape here and it will happily
  // swallow a capability. "the Admin should be able to stop another user's
  // ongoing test case" is not a string to look for on a page — it is a
  // behaviour, and no amount of reading the DOM settles it. So a remainder
  // that describes being able to do something is refused, and so is a long
  // one, which is a clause rather than a value.
  m = /^(.*?)\s+should\s+be\s+(.*)$/i.exec(e);
  if (m) {
    const rest = clean(m[2]);
    const isCapability = /^able\s+to\b/i.test(rest) || /\b(able\s+to|allowed\s+to)\b/i.test(rest);
    if (!isCapability && rest.length <= 48 && meaningful(rest)) {
      return { kind: 'present', needle: rest };
    }
  }

  return {
    kind: 'none', needle: '',
    why: `the expected result "${e.slice(0, 120)}" is not something that can be settled by reading `
      + 'the page — it needs a person',
  };
}

export interface CheckOutcome {
  /** undefined when the check could not be made at all. */
  pass?: boolean;
  /** What was looked for and what was found, for the result row. */
  detail: string;
}

/**
 * Put a checkable expectation to the text of a page.
 *
 * Matching is case-insensitive and whitespace-tolerant, because a page renders
 * "Installed Version" where a ticket writes "installed version", and because
 * the page text arrives with its own line breaks.
 */
export function runCheck(c: Checkable, pageText: string): CheckOutcome {
  if (c.kind === 'none') return { detail: c.why ?? 'not checkable' };
  const hay = String(pageText ?? '').replace(/\s+/g, ' ').toLowerCase();
  const needle = c.needle.replace(/\s+/g, ' ').toLowerCase();
  if (!needle) return { detail: 'nothing to look for' };

  if (c.kind === 'once') {
    let n = 0;
    let at = hay.indexOf(needle);
    while (at >= 0) { n += 1; at = hay.indexOf(needle, at + needle.length); }
    return {
      pass: n === 1,
      detail: `"${c.needle}" appears ${n} time${n === 1 ? '' : 's'} on the page; expected exactly once`,
    };
  }
  const there = hay.includes(needle);
  if (c.kind === 'present') {
    return {
      pass: there,
      detail: there
        ? `found "${c.needle}" on the page, as expected`
        : `"${c.needle}" is NOT on the page, but the ticket expects it`,
    };
  }
  // absent
  return {
    pass: !there,
    detail: there
      ? `"${c.needle}" IS on the page, but the ticket expects it not to be`
      : `"${c.needle}" is absent, as expected`,
  };
}

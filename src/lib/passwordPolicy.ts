// What counts as an acceptable password, in one place.
//
// The rules are checked on the server — that is where they are enforced — and
// the same function drives the live checklist while someone types, so the two
// can never drift into disagreeing about whether a password is good enough.
//
// Configurable through the environment, because a lab on a closed network and
// an instance someone exposes have different ideas of "enough":
//
//   SIMQA_PW_MIN_LENGTH       default 8
//   SIMQA_PW_REQUIRE_UPPER    default on
//   SIMQA_PW_REQUIRE_LOWER    default on
//   SIMQA_PW_REQUIRE_DIGIT    default on
//   SIMQA_PW_REQUIRE_SPECIAL  default off
//
// The policy applies when a password is SET — signing up, resetting, changing.
// It is never applied at sign-in: an account made under older rules must still
// be able to log in, and telling someone their existing password is now
// invalid at the one moment they need it is how people get locked out of a
// tool they rely on.
//
// Pure, imports nothing, so node --test can load it directly.

export interface PasswordPolicy {
  minLength: number;
  requireUpper: boolean;
  requireLower: boolean;
  requireDigit: boolean;
  requireSpecial: boolean;
  /** Longer than any human types; a guard against hashing something enormous. */
  maxLength: number;
}

// Length only, by choice: the composition rules were asked for and then asked
// to be taken away again. Every one of them can be switched back on through
// the environment without touching code — that is what the flags below are
// for — and the server will enforce whatever is on.
export const DEFAULT_POLICY: PasswordPolicy = {
  minLength: 6,
  requireUpper: false,
  requireLower: false,
  requireDigit: false,
  requireSpecial: false,
  maxLength: 200,
};

const flag = (name: string, fallback: boolean): boolean => {
  const v = (process.env[name] ?? '').trim().toLowerCase();
  if (!v) return fallback;
  return !['0', 'false', 'no', 'off'].includes(v);
};

export function policy(): PasswordPolicy {
  const min = Number(process.env.SIMQA_PW_MIN_LENGTH);
  return {
    minLength: Number.isFinite(min) && min >= 1 ? Math.floor(min) : DEFAULT_POLICY.minLength,
    requireUpper: flag('SIMQA_PW_REQUIRE_UPPER', DEFAULT_POLICY.requireUpper),
    requireLower: flag('SIMQA_PW_REQUIRE_LOWER', DEFAULT_POLICY.requireLower),
    requireDigit: flag('SIMQA_PW_REQUIRE_DIGIT', DEFAULT_POLICY.requireDigit),
    requireSpecial: flag('SIMQA_PW_REQUIRE_SPECIAL', DEFAULT_POLICY.requireSpecial),
    maxLength: DEFAULT_POLICY.maxLength,
  };
}

/** One rule, and whether this password satisfies it. The UI ticks these off
 *  as they are typed; the server rejects on the same list. */
export interface RuleResult { id: string; label: string; ok: boolean }

export function checkPassword(password: string, p: PasswordPolicy = policy()): {
  ok: boolean;
  rules: RuleResult[];
  /** The first unmet rule, worded for a person. */
  error?: string;
} {
  const pw = password ?? '';
  const rules: RuleResult[] = [
    { id: 'length', label: `At least ${p.minLength} characters`, ok: pw.length >= p.minLength },
  ];
  if (p.requireUpper)   rules.push({ id: 'upper',   label: 'An uppercase letter', ok: /[A-Z]/.test(pw) });
  if (p.requireLower)   rules.push({ id: 'lower',   label: 'A lowercase letter', ok: /[a-z]/.test(pw) });
  if (p.requireDigit)   rules.push({ id: 'digit',   label: 'A number', ok: /[0-9]/.test(pw) });
  if (p.requireSpecial) rules.push({ id: 'special', label: 'A special character', ok: /[^A-Za-z0-9]/.test(pw) });

  if (pw.length > p.maxLength) {
    return { ok: false, rules, error: `Password must be ${p.maxLength} characters or fewer.` };
  }
  const failed = rules.find(r => !r.ok);
  return failed
    ? { ok: false, rules, error: `Password needs: ${failed.label.toLowerCase()}.` }
    : { ok: true, rules };
}

/**
 * A rough strength reading for the meter.
 *
 * Deliberately crude — it counts what the rules count, plus length — because a
 * confident-looking score computed from nothing is worse than an honest
 * "weak". It never gates anything: checkPassword decides that.
 */
export function strength(password: string): { score: 0 | 1 | 2 | 3 | 4; label: string } {
  const pw = password ?? '';
  if (!pw) return { score: 0, label: '' };
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 12) s++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) s++;
  if (/[0-9]/.test(pw) && /[^A-Za-z0-9]/.test(pw)) s++;
  // A single repeated character or a straight run is long without being much.
  if (/^(.)\1+$/.test(pw) || /^(?:0123456789|abcdefghij|qwerty)/i.test(pw)) s = Math.min(s, 1);
  const score = Math.max(0, Math.min(4, s)) as 0 | 1 | 2 | 3 | 4;
  return { score, label: ['', 'Weak', 'Fair', 'Good', 'Strong'][score] };
}

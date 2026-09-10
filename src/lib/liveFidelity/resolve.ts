// Find the ue.cfg counterpart of an authored testcase parameter — WITHOUT
// relying on the two sides using the same name.
//
// They usually do not. The GUI writes camelCase and the cfg writes snake_case,
// the cfg moves qualifiers around, and it drops or adds words:
//
//   dataBitrate.dl.value      ->  bitrate_dl
//   antennas.dl               ->  n_antenna_dl
//   EARFCN.dl                 ->  dl_earfcn
//   prach                     ->  prach_delay
//   globalTimingAdvance       ->  global_timing_advance
//   scs                       ->  subcarrier_spacing
//   sharedKey                 ->  K
//
// An earlier version of this feature carried a hand-written table of about
// thirty of those and reported every other parameter as "not checked", which on
// screen reads as "missing". dataBitrate was one of them: the table had no
// entry, so a value that IS in the cfg as bitrate_dl was shown as absent. With
// 270 distinct parameters in the corpus, a table was never going to be the
// answer.
//
// So resolution is structural, in four steps, each tried in order:
//
//   1. an explicit alias, for the handful no rule could reach (sharedKey -> K)
//   2. an exact match on the NORMALISED name — tokenised, stemmed, de-noised
//      and order-free, so dl_earfcn and EARFCN.dl are the same name
//   3. a unique subset match, so prach finds prach_delay
//   4. a value search within the scope, which resolves the rest and is also
//      what tells us a parameter really is absent rather than just renamed
//
// Only after all four fail does the parameter get reported as not found, and
// the note then says it was searched by name AND by value.
//
// IMPORTS: node builtins only (in fact none) — unit-tested under `node --test`.

/** Split a name into comparable word tokens. */
export function tokens(name: string): string[] {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')     // camelCase -> camel_Case
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')  // EARFCNDl  -> EARFCN_Dl
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Words that carry no meaning for matching. `n_antenna_dl` and `antennas.dl`
 *  are the same parameter; so are `dataBitrate.dl.value` and `bitrate_dl`. */
const NOISE = new Set([
  'n', 'num', 'number', 'value', 'data', 'unit', 'info', 'config', 'cfg',
  'p', 'profile', 'list', 'the', 'is', 'enable', 'enabled',
]);

/**
 * Tokens too generic to identify a field on their own.
 *
 * Every one of these produced a wrong match: attachType matched attach_pdn_type,
 * dataType and pdnType and attachTypeSIP all matched a traffic profile's "type",
 * ueCategoryType matched ue_category. A partial match resting only on "type" is
 * not evidence of anything.
 */
const GENERIC = new Set(['type', 'mode', 'name', 'id', 'index', 'count', 'time', 'delay', 'size', 'group']);

/** Singular/plural and spelling variants that mean the same thing. */
const STEM: Record<string, string> = {
  antennas: 'antenna', cells: 'cell', ues: 'ue', subs: 'sub', bitrates: 'bitrate',
  packets: 'packet', profiles: 'profile', groups: 'group', algorithms: 'algorithm',
  algo: 'algorithm', addr: 'address', ip: 'ip', idx: 'index', dur: 'duration',
};

/** An order-free, de-noised key for a name. Two names with the same key are the
 *  same parameter as far as matching is concerned. */
export function normKey(name: string): string {
  return tokens(name)
    .map((t) => STEM[t] ?? t)
    .filter((t) => !NOISE.has(t))
    .sort()
    .join('_');
}

/** The meaningful token set, for subset matching. */
function tokenSet(name: string): Set<string> {
  return new Set(tokens(name).map((t) => STEM[t] ?? t).filter((t) => !NOISE.has(t)));
}

/**
 * Names no structural rule can reach, because the cfg calls them something
 * unrelated. Keyed by the authored name's normalised key.
 */
const ALIAS_SOURCE: Array<[authored: string, cfgNames: string[]]> = [
  ['sharedKey', ['K']],
  ['scs', ['subcarrier_spacing']],
  ['servingCell', ['cell_index']],
  ['algorithm', ['sim_algo']],
  ['pdnType', ['attach_pdn_type']],
  ['securityContext', ['use_security_context_for_registration']],
  ['powerControl', ['power_control_enabled']],
  ['cipherAlgorithm', ['cipher_algo_bitmap']],
  ['integrityAlgorithm', ['integ_algo_bitmap']],
  ['startingIMSI', ['imsi']],
  ['startingSUPI', ['supi', 'imsi']],
  ['asRelease', ['as_release']],
  ['ueCategory', ['ue_category']],
  ['turboIteration', ['pdsch_max_its']],
  ['ldpcIteration', ['ldpc_max_its']],
  ['serverIpAddress', ['dest_ip']],
  ['serverAddress', ['dest_ip']],
  ['numberOfPackets', ['packet_count']],
  ['startDelay', ['start_time']],
  ['rfCard', ['rf_port']],
  ['loggingProfileName', ['log_options']],
  ['test_name', ['log_filename']],
  ['attachDelay', ['power_on_start_time']],
  ['powerOnTime', ['power_off_start_time']],
  ['prach', ['prach_delay']],
];

/**
 * Keyed by the NORMALISED authored name, built at load time.
 *
 * Writing the keys out by hand is how this went wrong the first time: entries
 * like `cipheralgorithm` were never reachable, because normKey('cipherAlgorithm')
 * is 'algorithm_cipher' — tokens are sorted. Running the source through the same
 * normaliser the matching uses means the table cannot drift from it.
 */
const ALIASES = new Map<string, string[]>(ALIAS_SOURCE.map(([k, v]) => [normKey(k), v]));

export interface Scope {
  /** Object in the ue.cfg to search. */
  obj: any;
  /** Its path, for the row's "ue.cfg parameter" column. */
  path: string;
}

export interface Resolution {
  path: string;
  value: unknown;
  /** How it was found — shown in the row's note so the match is auditable. */
  how: 'alias' | 'name' | 'partial-name' | 'value';
  /**
   * Whether a DISAGREEMENT here should be believed.
   *
   * Only an exact normalised name or an explicit alias is firm enough: those
   * two identify the field, so a differing value is a real finding. A partial
   * or value-based match is a guess, and a guess that disagrees is far more
   * likely to be the wrong field than a genuine defect — reporting those as
   * mismatches is what filled the table with false failures.
   */
  firm: boolean;
}

const isScalar = (v: unknown) => v === null || typeof v !== 'object';

/**
 * Find `authoredName` inside one or more cfg scopes.
 *
 * `expected` is the authored value, used both to disambiguate several name
 * candidates and, as a last resort, to find a counterpart whose name shares
 * nothing with the authored one.
 */
/**
 * Do we know what the cfg calls this parameter, even if this cfg lacks it?
 *
 * The difference matters for the verdict. A parameter with a known cfg name
 * that is absent from THIS cfg was dropped — a defect. One we have never been
 * able to place anywhere is a gap in our coverage, not evidence about the box.
 */
export function hasKnownCfgName(authoredName: string): boolean {
  return ALIASES.has(normKey(authoredName));
}

export function resolveParam(
  authoredName: string, expected: unknown, scopes: Scope[],
): Resolution | undefined {
  const wantKey = normKey(authoredName);
  const wantTokens = tokenSet(authoredName);
  if (!wantKey) return undefined;

  // dataType de-noises to {type}; matching that against a traffic profile's
  // "type" is an exact match on a word that identifies nothing. Only an
  // explicit alias may resolve a name this generic.
  const tooGeneric = [...wantTokens].every((t) => GENERIC.has(t));
  if (tooGeneric && !ALIASES.has(wantKey)) return undefined;

  const candidates: Resolution[] = [];

  for (const scope of scopes) {
    if (!scope.obj || typeof scope.obj !== 'object') continue;
    const keys = Object.keys(scope.obj).filter((k) => isScalar(scope.obj[k]) || Array.isArray(scope.obj[k]));

    // 1. explicit alias
    for (const alias of ALIASES.get(wantKey) ?? []) {
      if (alias in scope.obj) {
        return { path: `${scope.path}.${alias}`, value: scope.obj[alias], how: 'alias', firm: true };
      }
    }

    // 2. exact normalised name
    const exact = keys.filter((k) => normKey(k) === wantKey);
    if (exact.length === 1) return { path: `${scope.path}.${exact[0]}`, value: scope.obj[exact[0]], how: 'name', firm: true };
    if (exact.length > 1) {
      const byValue = exact.find((k) => looseEqual(expected, scope.obj[k]));
      const pick = byValue ?? exact[0];
      return { path: `${scope.path}.${pick}`, value: scope.obj[pick], how: 'name', firm: true };
    }

    // 3. subset of tokens, either direction — prach finds prach_delay, and
    //    bitrate_dl finds a dataBitrate.dl authored as just "dl".
    const partial = keys.filter((k) => {
      const ks = tokenSet(k);
      if (!ks.size || !wantTokens.size) return false;
      // One direction only, and the shared tokens must carry identity.
      // "prach" ⊂ "prach_delay" is a real match; "attachType" ⊂ "attach_pdn_type"
      // is not, and neither is anything resting on "type" alone.
      const wantInKey = [...wantTokens].every((t) => ks.has(t));
      if (!wantInKey) return false;
      const specific = [...wantTokens].filter((t) => !GENERIC.has(t));
      if (!specific.length) return false;
      // The cfg key may only add generic words. attachType -> attach_pdn_type
      // adds "pdn", a real qualifier, and they are different parameters.
      const extra = [...ks].filter((t) => !wantTokens.has(t));
      return extra.every((t) => GENERIC.has(t));
    });
    if (partial.length === 1) {
      return { path: `${scope.path}.${partial[0]}`, value: scope.obj[partial[0]], how: 'partial-name', firm: false };
    }
    if (partial.length > 1) {
      const byValue = partial.find((k) => looseEqual(expected, scope.obj[k]));
      if (byValue) return { path: `${scope.path}.${byValue}`, value: scope.obj[byValue], how: 'partial-name', firm: false };
      // Ambiguous by name and undecidable by value: remember, keep looking in
      // the next scope, and fall back to it rather than guessing silently.
      candidates.push({ path: `${scope.path}.${partial[0]}`, value: scope.obj[partial[0]], how: 'partial-name', firm: false });
    }

    // 4. value search — the parameter may be named nothing like the authored
    //    one. Only meaningful for values distinctive enough to identify a field.
    if (isDistinctive(expected)) {
      const hit = keys.find((k) => looseEqual(expected, scope.obj[k]));
      if (hit) candidates.push({ path: `${scope.path}.${hit}`, value: scope.obj[hit], how: 'value', firm: false });
    }
  }

  return candidates[0];
}

/**
 * Is this value specific enough that finding it identifies a field?
 *
 * Booleans and small integers are not: half the cfg is 0, 1 and false, so
 * matching on them would attach a parameter to whatever happened to sit first.
 */
function isDistinctive(v: unknown): boolean {
  if (typeof v === 'boolean' || v === null || v === undefined) return false;
  if (typeof v === 'number') return Math.abs(v) > 8 && Number.isFinite(v);
  if (typeof v === 'string') return v.length >= 4 && v !== 'auto' && v !== 'none' && v !== 'null';
  if (Array.isArray(v)) return v.length > 0 && v.some((x) => isDistinctive(x));
  return false;
}

/** The comparison used while searching. Deliberately looser than the one used
 *  for the verdict: here it is a hint, not a judgement. */
function looseEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => looseEqual(v, b[i]));
  }
  const sa = String(a).toLowerCase(), sb = String(b).toLowerCase();
  if (sa === sb) return true;
  const na = Number(sa), nb = Number(sb);
  if (!Number.isNaN(na) && !Number.isNaN(nb) && sa.trim() && sb.trim()) return Math.abs(na - nb) < 1e-3;
  return sa.replace(/[-_\s]/g, '') === sb.replace(/[-_\s]/g, '');
}

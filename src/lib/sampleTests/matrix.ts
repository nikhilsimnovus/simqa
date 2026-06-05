// Matrix expansion of the 17-item SAMPLE_TESTS plan into the full
// combinatorial variation set that gives us GA-level coverage on the
// box's actually-shipped sample testcases.
//
// Each base entry (see catalog.ts) is one scenario shape. For every base
// we want to validate it across the dimensions that actually affect
// behaviour for *that* scenario: bands, traffic profiles, UE counts,
// channel models, etc.
//
// All 17 base scenarios are already 64-UE multi-user, so `ueCount` is not
// a primary dimension here (we don't compress 64 → 1). Instead the main
// variations are band (within each RAT), channel model, mobility profile,
// and (for the dual-traffic items) the relative load split.
//
// Cross-multiplying every dimension across every base would explode into
// thousands of cases; instead each base declares only the dimensions that
// matter for it, and `maxVariants` caps each one. Output is a flat list of
// `MatrixTest` rows — each becomes a row in the API + UI verification
// reports, with category metadata for the dashboard breakdown.

import { SAMPLE_TESTS, type SampleCategory, type SampleTestEntry, CATEGORY_LABELS, CATEGORY_ORDER } from './catalog';

// ─── Dimension vocabularies ───────────────────────────────────────────────

// Band selections we exercise per RAT. Kept conservative so the matrix
// stays reviewable; the config-fidelity engine has the master band table
// (master-all-rats.csv) if a wider sweep is needed.
export const BANDS = {
  'NR-SA':  ['n78', 'n41', 'n7', 'n2', 'n66'],         // most-deployed NR bands
  'NR-NSA': ['n78', 'n41'],                             // ENDC realistically only on a couple
  'LTE':    ['b3', 'b7', 'b41', 'b2', 'b13'],           // common LTE bands
  'NB-IoT': ['nbiot-b8', 'nbiot-b20'],
  'CATM':   ['catm-b3', 'catm-b20'],
  'NTN':    ['ntn-leo', 'ntn-geo'],
} as const;

export const TRAFFIC_PROFILES  = ['ping', 'iperf-udp', 'iperf-tcp', 'ftp', 'http', 'vonr', 'volte', 'vinr', 'web-mix'] as const;
export const DIRECTIONS        = ['dl', 'ul', 'dl+ul'] as const;
export const MOBILITY_PROFILES = ['stationary', 'ping-pong', 'round-trip'] as const;
export const CHANNEL_MODELS    = ['awgn', 'tdla30', 'tdlb100', 'epa', 'eva'] as const;
export const HO_MODES          = ['intra-cell', 'intra-gnb', 'inter-gnb', 'inter-rat'] as const;
export const LOAD_PROFILES     = ['light', 'medium', 'heavy'] as const;

// ─── Per-base variation specs ─────────────────────────────────────────────
//
// For each of the 17 base testcases, declare which dimensions vary and the
// values to cover. Missing dimensions = "doesn't vary for this scenario".
//
// Keep the per-base output bounded so the total stays roughly 80–150 matrix
// entries — granular enough for real signal, light enough for a single
// CI-pipeline sweep.

export interface VariationSpec {
  bands?:      readonly string[];
  traffic?:    readonly string[];
  direction?: readonly string[];
  mobility?:   readonly string[];
  channel?:    readonly string[];
  hoMode?:     readonly string[];
  load?:       readonly string[];
  /** Optional max cap on variants for this base. Default 24. */
  maxVariants?: number;
}

// Curated dimension picks per base. Order matches catalog.ts.
// item numbers reference catalog.ts SAMPLE_TESTS items.
const VARIATIONS_BY_ITEM: Record<number, VariationSpec> = {
  // ── NR SA (items 1–9) ───────────────────────────────────────────────────
  1:  { bands: BANDS['NR-SA'],          channel: ['awgn', 'tdla30'] },                              // SA AttDetach 4x2
  2:  { bands: BANDS['NR-SA'],          hoMode: ['intra-gnb', 'inter-gnb'], channel: ['awgn'] },    // SA HO 4x2
  3:  { bands: BANDS['NR-SA'],          load: LOAD_PROFILES,                channel: ['awgn'] },    // SA TCP DL 4x2
  4:  { bands: BANDS['NR-SA'],          direction: DIRECTIONS,              channel: ['awgn'] },    // SA UDP 2x2
  5:  { bands: BANDS['NR-SA'],          direction: DIRECTIONS,              channel: ['awgn'] },    // SA UDP 4x2
  6:  { bands: ['n78', 'n41', 'n7'],    load: LOAD_PROFILES },                                       // SA UDP_DL + TCP_DL 4x2
  7:  { bands: ['n78', 'n41'],          load: LOAD_PROFILES },                                       // SA UDP_DL + VoNR 4x2
  8:  { bands: ['n78', 'n41', 'n7'],    channel: ['awgn', 'tdla30'] },                              // SA VoNR IMSI 4x2
  9:  { bands: ['n78', 'n41'],          mobility: MOBILITY_PROFILES },                              // SA VoNR Telephon 4x2

  // ── LTE (items 10–15) ───────────────────────────────────────────────────
  10: { bands: BANDS['LTE'],            channel: ['epa', 'eva'] },                                  // LTE AttDetach 4x1
  11: { bands: BANDS['LTE'],            hoMode: ['intra-gnb', 'inter-gnb'], channel: ['epa'] },     // LTE HO 4x1
  12: { bands: BANDS['LTE'],            load: LOAD_PROFILES },                                       // LTE TCP DL 4x1
  13: { bands: BANDS['LTE'],            direction: DIRECTIONS },                                     // LTE UDP 4x1
  14: { bands: ['b3', 'b7', 'b41'],     load: LOAD_PROFILES },                                       // LTE UDP_DL + TCP_DL 4x1
  15: { bands: ['b3', 'b7'],            channel: ['epa', 'eva'] },                                  // LTE VoLTE IMSI 4x1

  // ── NR NSA (item 16) ────────────────────────────────────────────────────
  16: { bands: BANDS['NR-NSA'],         direction: DIRECTIONS,              channel: ['awgn'] },    // NSA UDP 2x1

  // ── NB-IoT (item 17) ────────────────────────────────────────────────────
  17: { bands: BANDS['NB-IoT'],         channel: ['awgn', 'tdla30'] },                              // NB-IoT standalone ping
};

// ─── Variant generation ───────────────────────────────────────────────────

export interface MatrixTest {
  /** Stable id, e.g. "matrix-sample-1-band-n78-channel-awgn". */
  id: string;
  /** Display name combining base name + the dimension values. */
  name: string;
  /** Source category (sa / lte / nsa / nbiot). */
  category: SampleCategory;
  /** The base item this expansion came from (1–17). */
  baseItem: number;
  /** Canonical base id from the box (with the trailing underscore). */
  baseId: string;
  /** Canonical base name. */
  baseName: string;
  /** Owner of the base (carries through for accountability). */
  owner: string;
  /** Concrete parameter values for this variant. */
  params: {
    band?:      string;
    traffic?:   string;
    direction?: string;
    mobility?:  string;
    channel?:   string;
    hoMode?:    string;
    load?:      string;
  };
}

// Map spec key (plural / dimension name) → params key (singular / value name).
// Without this, `bands: ['n78', ...]` lands as `params.bands = 'n78'` and
// the shortLabel/report code that reads `params.band` sees undefined.
const SPEC_TO_PARAM_KEY: Record<string, string> = {
  bands:     'band',
  traffic:   'traffic',
  direction: 'direction',
  mobility:  'mobility',
  channel:   'channel',
  hoMode:    'hoMode',
  load:      'load',
};

/** Deterministic cross-product, truncated to maxVariants. */
function crossProduct(spec: VariationSpec, maxVariants: number): Array<Record<string, any>> {
  const dims: Array<{ key: string; values: readonly any[] }> = [];
  for (const [k, v] of Object.entries(spec as Record<string, unknown>)) {
    if (k === 'maxVariants' || !v) continue;
    const arr = v as readonly any[];
    if (!Array.isArray(arr) || arr.length === 0) continue;
    const paramKey = SPEC_TO_PARAM_KEY[k] ?? k;
    dims.push({ key: paramKey, values: arr });
  }
  if (dims.length === 0) return [{}];
  // Cross-product (iterative to keep memory predictable).
  let out: Array<Record<string, any>> = [{}];
  for (const d of dims) {
    const next: Array<Record<string, any>> = [];
    for (const row of out) {
      for (const v of d.values) {
        next.push({ ...row, [d.key]: v });
        if (next.length >= maxVariants) break;
      }
      if (next.length >= maxVariants) break;
    }
    out = next;
    if (out.length >= maxVariants) break;
  }
  return out.slice(0, maxVariants);
}

function shortLabel(params: MatrixTest['params']): string {
  const bits: string[] = [];
  if (params.band)      bits.push(params.band);
  if (params.traffic)   bits.push(params.traffic);
  if (params.direction) bits.push(params.direction);
  if (params.mobility)  bits.push(params.mobility);
  if (params.channel)   bits.push(params.channel);
  if (params.hoMode)    bits.push(params.hoMode);
  if (params.load)      bits.push(params.load);
  return bits.join('-') || 'default';
}

export function generateMatrix(): MatrixTest[] {
  const out: MatrixTest[] = [];
  for (const base of SAMPLE_TESTS) {
    const spec = VARIATIONS_BY_ITEM[base.item];
    const max = spec?.maxVariants ?? 24;
    const variants = crossProduct(spec ?? {}, max);
    for (const params of variants) {
      const label = shortLabel(params);
      out.push({
        id: `matrix-sample-${base.item}-${label}`.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
        name: `${base.name} [${label}]`,
        category: base.category,
        baseItem: base.item,
        baseId: base.id,
        baseName: base.name,
        owner: base.owner,
        params,
      });
    }
  }
  return out;
}

/** Reporting helpers — used by both API + UI test runners to produce
 *  per-category aggregates without duplicating the logic. */
export function groupMatrixByCategory(matrix: MatrixTest[]): Record<SampleCategory, MatrixTest[]> {
  const out: Record<SampleCategory, MatrixTest[]> = {
    'sa':    [],
    'lte':   [],
    'nsa':   [],
    'nbiot': [],
  };
  for (const m of matrix) out[m.category].push(m);
  return out;
}

export function groupMatrixByBase(matrix: MatrixTest[]): Map<number, MatrixTest[]> {
  const out = new Map<number, MatrixTest[]>();
  for (const m of matrix) {
    const arr = out.get(m.baseItem) ?? [];
    arr.push(m);
    out.set(m.baseItem, arr);
  }
  return out;
}

/** Re-export the labels so report renderers don't need to import the catalog. */
export { CATEGORY_LABELS, CATEGORY_ORDER, type SampleTestEntry };

/** Quick stat for the test-plan dashboard (without running anything). */
export function matrixStats() {
  const m = generateMatrix();
  const byCat: Record<SampleCategory, number> = { 'sa': 0, 'lte': 0, 'nsa': 0, 'nbiot': 0 };
  for (const x of m) byCat[x.category] += 1;
  return { total: m.length, byCategory: byCat };
}

// Matrix expansion of the 19-item SAMPLE_TESTS plan into the full
// combinatorial variation set that gives us GA-level coverage.
//
// The wiki page is the BASE — each entry there is one scenario shape. For
// every base, we want to validate it across the dimensions that actually
// affect behaviour for *that* scenario: RAT bands, traffic profiles, UE
// counts, mobility, channel models, power-cycle modes, etc.
//
// Cross-multiplying every dimension across every base would produce
// thousands of cases; instead each base declares only the dimensions that
// matter for it. A latency-ping case varies by band + UE count; a CA peak-DL
// case varies by band + bandwidth + direction; an inter-RAT HO case varies
// by direction (5G→4G vs 4G→5G) and by background traffic.
//
// The output is a flat list of `MatrixTest` entries — each one becomes a
// single row in the API + UI verification reports, with category metadata
// for the dashboard breakdown.

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

export const TRAFFIC_PROFILES = ['ping', 'iperf-udp', 'iperf-tcp', 'ftp', 'http', 'vonr', 'volte', 'vinr', 'web-mix'] as const;
export const DIRECTIONS       = ['dl', 'ul', 'dl+ul'] as const;
export const UE_COUNTS        = [1, 4, 16, 64, 256] as const;
export const MOBILITY_PROFILES= ['stationary', 'ping-pong', 'round-trip'] as const;
export const CHANNEL_MODELS   = ['awgn', 'tdla30', 'tdlb100', 'epa', 'eva'] as const;
export const POWER_CYCLE_MODES= ['bursty', 'edrx', 'psm'] as const;
export const HO_MODES         = ['intra-cell', 'intra-gnb', 'inter-gnb', 'inter-rat'] as const;

// ─── Per-base variation specs ─────────────────────────────────────────────
//
// For each of the 19 base testcases, declare which dimensions vary and the
// values to cover. Missing dimensions = "doesn't vary for this scenario".
//
// Keep the per-base output bounded: a base with bands=5, ueCount=2,
// direction=3 produces 30 variants. Aim to keep each base ≤ 20–30 variants
// so the total is roughly 200–300 matrix entries (still walkable in a
// reasonable sweep, granular enough for diagnostics).

export interface VariationSpec {
  bands?:        readonly string[];
  traffic?:      readonly string[];
  direction?:    readonly string[];
  ueCount?:      readonly number[];
  mobility?:     readonly string[];
  channel?:      readonly string[];
  powerCycle?:   readonly string[];
  hoMode?:       readonly string[];
  /** Optional max cap on variants for this base. Default 40 (cross-product
   *  is truncated deterministically). */
  maxVariants?:  number;
}

// Curated dimension picks per base. Order is the same as the wiki page.
const VARIATIONS_BY_ITEM: Record<number, VariationSpec> = {
  // ── Foundational (1–8) ──────────────────────────────────────────────
  1:  { bands: BANDS['NR-SA'],          ueCount: [1, 4],         channel: ['awgn', 'tdla30']                },   // Latency-Ping
  2:  { bands: BANDS['NR-SA'],          direction: DIRECTIONS,   ueCount: [1, 4]                            },   // iPerf-UDP DL+UL
  3:  { bands: BANDS['NR-SA'],          direction: DIRECTIONS,   ueCount: [1, 4]                            },   // iPerf-TCP advanced
  4:  { bands: ['n78', 'n41'],          traffic: ['ftp', 'http', 'web-mix']                                 },   // Web-FTP-HTTP
  5:  { bands: ['n78'],                 traffic: ['vonr', 'vinr'],     ueCount: [1, 4]                      },   // ViNR-VoNR
  6:  { bands: BANDS['NR-NSA'],         ueCount: [1, 4]                                                     },   // NR-NSA-ENDC
  7:  { bands: BANDS['LTE'],            traffic: ['volte'],            ueCount: [1, 4]                      },   // VoLTE-Latency
  8:  { bands: BANDS['LTE']                                                                                  },   // LTE-MultiCell-4x1

  // ── NTN & Features (9–13) ───────────────────────────────────────────
  9:  { bands: ['ntn-geo'],             ueCount: [1, 4],         powerCycle: ['edrx', 'psm']                },   // NBIoT-NTN-GEO
  10: { bands: ['ntn-leo'],             ueCount: [1, 4]                                                     },   // NR-SA-NTN-LEO
  11: { bands: ['n78'],                 ueCount: [1, 4, 16]                                                 },   // NetworkSlicing
  12: { bands: ['n78'],                 ueCount: [4, 16, 64]                                                },   // UAC-Congestion
  13: { bands: ['nbiot-b8'],            powerCycle: POWER_CYCLE_MODES                                       },   // RedCap coexistence

  // ── Multi-User 64 UEs (14–19) ───────────────────────────────────────
  14: { bands: ['n78', 'n41'],          ueCount: [64]                                                       },   // AttachBurst-64UE
  15: { bands: ['n78', 'n41'],          direction: ['dl', 'dl+ul'], ueCount: [64]                           },   // CA-PeakDL-iPerf
  16: { bands: ['n78', 'b3'],           traffic: ['vonr', 'volte', 'http', 'ftp'], ueCount: [64]            },   // Mixed-LTE-NR
  17: { bands: ['n78'],                 mobility: MOBILITY_PROFILES,  ueCount: [64]                         },   // Mobility-PingPong
  18: { bands: ['n78', 'b3'],           hoMode: ['inter-rat'],        ueCount: [64]                         },   // InterRAT-HO 5G↔4G
  19: { bands: ['n78'],                 channel: CHANNEL_MODELS,      ueCount: [64]                         },   // ChannelModel near/mid/far
};

// ─── Variant generation ───────────────────────────────────────────────────

export interface MatrixTest {
  /** Stable id, e.g. "matrix-sample-1-band-n78-ueCount-1-channel-awgn". */
  id: string;
  /** Display name combining base name + the dimension values. */
  name: string;
  /** Source category (Foundational / NTN-Features / Multi-User 64UE). */
  category: SampleCategory;
  /** The base item this expansion came from (1–19). */
  baseItem: number;
  /** Canonical base name from the wiki page. */
  baseName: string;
  /** Owner of the base (carries through for accountability). */
  owner: string;
  /** Concrete parameter values for this variant. */
  params: {
    band?: string;
    traffic?: string;
    direction?: string;
    ueCount?: number;
    mobility?: string;
    channel?: string;
    powerCycle?: string;
    hoMode?: string;
  };
}

/** Deterministic cross-product, truncated to maxVariants. */
function crossProduct(spec: VariationSpec, maxVariants: number): Array<Record<string, any>> {
  // Build the list of (key, values[]) pairs; ignore undefined dimensions.
  const dims: Array<{ key: string; values: readonly any[] }> = [];
  for (const [k, v] of Object.entries(spec as Record<string, unknown>)) {
    if (k === 'maxVariants' || !v) continue;
    const arr = v as readonly any[];
    if (!Array.isArray(arr) || arr.length === 0) continue;
    dims.push({ key: k, values: arr });
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
  if (params.band)       bits.push(params.band);
  if (params.traffic)    bits.push(params.traffic);
  if (params.direction)  bits.push(params.direction);
  if (params.ueCount)    bits.push(`${params.ueCount}ue`);
  if (params.mobility)   bits.push(params.mobility);
  if (params.channel)    bits.push(params.channel);
  if (params.powerCycle) bits.push(params.powerCycle);
  if (params.hoMode)     bits.push(params.hoMode);
  return bits.join('-') || 'default';
}

export function generateMatrix(): MatrixTest[] {
  const out: MatrixTest[] = [];
  for (const base of SAMPLE_TESTS) {
    const spec = VARIATIONS_BY_ITEM[base.item];
    const max = spec?.maxVariants ?? 40;
    const variants = crossProduct(spec ?? {}, max);
    for (const params of variants) {
      const label = shortLabel(params);
      out.push({
        id: `matrix-sample-${base.item}-${label}`.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
        name: `${base.name} [${label}]`,
        category: base.category,
        baseItem: base.item,
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
    'foundational':    [],
    'ntn-features':    [],
    'multi-user-64ue': [],
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
  const byCat: Record<SampleCategory, number> = { 'foundational': 0, 'ntn-features': 0, 'multi-user-64ue': 0 };
  for (const x of m) byCat[x.category] += 1;
  return { total: m.length, byCategory: byCat };
}

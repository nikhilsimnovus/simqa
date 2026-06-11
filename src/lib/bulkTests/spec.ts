// Dimension definitions for the bulk-testcase generator.
//
// The generator can run at three different scales — pick one based on
// how much time / box bandwidth you have:
//
//   QUICK    ~40 testcases   — one of every feature/RAT/traffic family,
//                              good for a 5-minute smoke that proves
//                              every code path on the box is reachable.
//   MODERATE ~200 testcases  — broader coverage across bands/bandwidths
//                              without exhausting every combo.
//   COMPLETE ~1700 testcases — full Cartesian sweep, the "every band ×
//                              every bw × every traffic …" matrix.
//
// All three share the same dimension primitives below — only the slice
// caps and band lists differ.

export type RAT = 'LTE' | 'NR-SA' | 'NR-NSA' | 'NB-IoT';

export type DataType =
  | 'no_data'
  | 'iperf-both' | 'iperf-dl' | 'iperf-ul'
  // Single-profile TCP iperf (transportProtocol 'tcp'). Exists to catch the
  // SIM40-2303..2312 audit class: those 12 bugs went unseen because the bulk
  // matrix only ever generated the default SA/UDP paths — 'mix-iperf+tcp'
  // exercises TCP only inside a 2-group mix, never as the lone profile the
  // GUI's plain TCP flow produces.
  | 'iperf-tcp'
  // VoLTE / VoNR — IMS-signalled voice calls. LTE uses the volte dataType
  // body, NR-SA uses the same body with ratTypeP='sa'. VoNR coverage exists
  // to catch the SIM40-2306 family (VoNR runs whose per-UE stats vanish).
  | 'volte' | 'vonr'
  // Mixed traffic — subscriber group 0 gets the first profile, group 1
  // the second. Generates a 2-profile userPlaneConfig + 2-row subsConfig.
  | 'mix-iperf-dl+ul'   // group 0 = DL iperf, group 1 = UL iperf
  | 'mix-iperf+no_data' // group 0 = bidir iperf, group 1 = attach-only
  | 'mix-iperf+tcp';    // group 0 = UDP iperf, group 1 = TCP iperf
export type Mobility = 'stationary' | 'roundTrip';
// Fading model. Each one is valid ONLY for the listed RAT family per 3GPP:
//   LTE channel models (3GPP TS 36.101 Annex B):  awgn, epa5, eva70, etu70
//   NR  channel models (3GPP TS 38.101-4 Annex G): awgn, tdla30, tdlb100,
//                                                  tdlc300, tdld30, tdle30
// Use them in the per-RAT slice's `fading` list — never cross them.
export type FadingLTE = 'awgn' | 'epa5' | 'eva70' | 'etu70';
export type FadingNR  = 'awgn' | 'tdla30' | 'tdlb100' | 'tdlc300';
export type Fading = FadingLTE | FadingNR;

export type SweepSize = 'quick' | 'moderate' | 'complete';

// NB-IoT-only dimensions. Both exist to catch the NB-IoT audit bugs:
//   - ue_category nb1 vs nb2 — SIM40-2311: generated NB-IoT testcases shipped
//     unbootable ue.cfgs with ue_category dropped. Sweeping BOTH categories
//     makes the drop (and any nb1/nb2 cross-wiring) observable per category;
//     the old matrix hardcoded nb1, so nb2 paths were never generated at all.
//   - cellType standalone vs in-band — SIM40-2312: the deployment/operation
//     mode rides the NB-IoT cell's cellType (standalone / in-band /
//     guard-band, same contract the apiTester nbiot-definition-completeness
//     check and the configFidelity nbiotChecker assert). The box silently
//     reset an in-band cell to standalone; a matrix that only ever generates
//     standalone can never see the reset.
export type NbIotUeCategory = 'nb1' | 'nb2';
// guard-band is deliberately excluded until the /tests/cells cellType enum is verified against the Simnovator API documentation.
export type NbIotCellType = 'standalone' | 'in-band';

/** A single "slice" of the matrix — covers a band-set within one RAT plus
 *  the variation knobs to multiply against it. */
export interface MatrixSlice {
  rat: RAT;
  bands: readonly string[];
  bandwidths: readonly number[];
  ueCounts: readonly number[];
  antennas: ReadonlyArray<readonly [number, number]>;
  dataTypes: readonly DataType[];
  mobility: readonly Mobility[];
  fading: readonly Fading[];
  /** Only used for NR — sub-carrier spacings in kHz. Empty for LTE. */
  scs?: readonly number[];
  /** Only used for NB-IoT — ue_category sweep (nb1 / nb2). Omitted ⇒ the
   *  generator keeps the legacy single 'nb1' body and the variant name stays
   *  byte-identical to pre-audit runs (resumability). SIM40-2311. */
  nbUeCategories?: readonly NbIotUeCategory[];
  /** Only used for NB-IoT — deployment-mode sweep carried by the cell's
   *  cellType (standalone / in-band). Omitted ⇒ legacy '4g' cellType and
   *  unchanged variant names. SIM40-2312. */
  nbCellTypes?: readonly NbIotCellType[];
  /** Soft cap so a single slice can't dominate the total. */
  maxVariants?: number;
}

// ─── QUICK sweep — one of every feature, ~40 testcases ───────────────────
//
// Every entry below is intentionally narrow: one or two bands, one bw,
// one ueCount, one antennas, one mobility, one fading. The point is
// coverage breadth (every traffic type + every RAT + voice + mix-traffic
// + NSA), not depth.

const QUICK_SLICES: readonly MatrixSlice[] = [
  // LTE smoke — single-traffic, all four directions
  { rat: 'LTE', bands: ['3'], bandwidths: [10], ueCounts: [2], antennas: [[2, 1]],
    dataTypes: ['no_data', 'iperf-both', 'iperf-dl', 'iperf-ul'],
    mobility: ['stationary'], fading: ['awgn'], maxVariants: 4 },
  // LTE voice (VoLTE)
  { rat: 'LTE', bands: ['3'], bandwidths: [10], ueCounts: [1], antennas: [[2, 1]],
    dataTypes: ['volte'], mobility: ['stationary'], fading: ['awgn'], maxVariants: 1 },
  // LTE mix-traffic — one of each combo
  { rat: 'LTE', bands: ['3'], bandwidths: [10], ueCounts: [2], antennas: [[2, 1]],
    dataTypes: ['mix-iperf-dl+ul', 'mix-iperf+no_data', 'mix-iperf+tcp'],
    mobility: ['stationary'], fading: ['awgn'], maxVariants: 3 },
  // LTE fading coverage — one per LTE channel model
  { rat: 'LTE', bands: ['3'], bandwidths: [10], ueCounts: [2], antennas: [[2, 1]],
    dataTypes: ['iperf-both'], mobility: ['stationary'], fading: ['epa5', 'eva70', 'etu70'],
    maxVariants: 3 },
  // LTE mobility — one stationary + one roundTrip
  { rat: 'LTE', bands: ['3'], bandwidths: [10], ueCounts: [2], antennas: [[2, 1]],
    dataTypes: ['no_data'], mobility: ['roundTrip'], fading: ['awgn'], maxVariants: 1 },

  // NR-SA smoke — single-traffic, all four directions
  { rat: 'NR-SA', bands: ['n78'], bandwidths: [100], scs: [30], ueCounts: [2], antennas: [[2, 2]],
    dataTypes: ['no_data', 'iperf-both', 'iperf-dl', 'iperf-ul'],
    mobility: ['stationary'], fading: ['awgn'], maxVariants: 4 },
  // NR-SA voice (VoNR)
  { rat: 'NR-SA', bands: ['n78'], bandwidths: [100], scs: [30], ueCounts: [1], antennas: [[2, 2]],
    dataTypes: ['vonr'], mobility: ['stationary'], fading: ['awgn'], maxVariants: 1 },
  // NR-SA mix-traffic
  { rat: 'NR-SA', bands: ['n78'], bandwidths: [100], scs: [30], ueCounts: [2], antennas: [[2, 2]],
    dataTypes: ['mix-iperf-dl+ul', 'mix-iperf+no_data', 'mix-iperf+tcp'],
    mobility: ['stationary'], fading: ['awgn'], maxVariants: 3 },
  // NR-SA fading coverage
  { rat: 'NR-SA', bands: ['n78'], bandwidths: [100], scs: [30], ueCounts: [2], antennas: [[2, 2]],
    dataTypes: ['iperf-both'], mobility: ['stationary'], fading: ['tdla30', 'tdlb100', 'tdlc300'],
    maxVariants: 3 },
  // NR-SA SCS coverage — both 15 and 30 kHz
  { rat: 'NR-SA', bands: ['n78'], bandwidths: [20], scs: [15, 30], ueCounts: [1], antennas: [[2, 2]],
    dataTypes: ['no_data'], mobility: ['stationary'], fading: ['awgn'], maxVariants: 2 },
  // NR-SA mobility
  { rat: 'NR-SA', bands: ['n78'], bandwidths: [100], scs: [30], ueCounts: [2], antennas: [[2, 2]],
    dataTypes: ['no_data'], mobility: ['roundTrip'], fading: ['awgn'], maxVariants: 1 },

  // NR-NSA (EN-DC) — LTE anchor + NR secondary
  { rat: 'NR-NSA', bands: ['n78'], bandwidths: [100], scs: [30], ueCounts: [1], antennas: [[2, 2]],
    dataTypes: ['no_data', 'iperf-both'], mobility: ['stationary'], fading: ['awgn'], maxVariants: 2 },

  // NB-IoT smoke — ue_category (nb1/nb2) × deployment mode (standalone/
  // in-band) sweep. Catches SIM40-2311 (ue_category dropped → unbootable
  // ue.cfg; nb2 was previously never generated at all) and SIM40-2312
  // (in-band deployment mode silently reset to standalone — invisible to a
  // matrix that only generates standalone).
  { rat: 'NB-IoT', bands: ['8'], bandwidths: [5], ueCounts: [1], antennas: [[1, 1]],
    dataTypes: ['no_data'], mobility: ['stationary'], fading: ['awgn'],
    nbUeCategories: ['nb1', 'nb2'], nbCellTypes: ['standalone', 'in-band'], maxVariants: 4 },
  // NB-IoT legacy coverage canary — the swept cellType 'standalone'/'in-band'
  // values sent to POST /v2/tests/cells are an UNVERIFIED wire contract and
  // must be verified against the Simnovator API documentation before trusting
  // sweep results. This slice deliberately omits nbUeCategories/nbCellTypes so
  // it keeps the previously-working shape (cellType '4g', ue_category nb1) and
  // NB-IoT generation can never drop to zero if the new enum 400s.
  { rat: 'NB-IoT', bands: ['8'], bandwidths: [5], ueCounts: [1], antennas: [[1, 1]],
    dataTypes: ['no_data'], mobility: ['stationary'], fading: ['awgn'], maxVariants: 1 },

  // ── Post-audit traffic-profile additions (SIM40-2303..2312 class) ──────
  // Single-profile TCP iperf per RAT family. The audit bugs went unseen
  // because only the SA/UDP default paths were ever generated; these keep
  // the plain TCP path (no mix wrapper) covered on every RAT.
  { rat: 'LTE', bands: ['3'], bandwidths: [10], ueCounts: [2], antennas: [[2, 1]],
    dataTypes: ['iperf-tcp'], mobility: ['stationary'], fading: ['awgn'], maxVariants: 1 },
  { rat: 'NR-SA', bands: ['n78'], bandwidths: [100], scs: [30], ueCounts: [2], antennas: [[2, 2]],
    dataTypes: ['iperf-tcp'], mobility: ['stationary'], fading: ['awgn'], maxVariants: 1 },
  { rat: 'NR-NSA', bands: ['n78'], bandwidths: [100], scs: [30], ueCounts: [1], antennas: [[2, 2]],
    dataTypes: ['iperf-tcp'], mobility: ['stationary'], fading: ['awgn'], maxVariants: 1 },
];

// ─── MODERATE sweep — ~200 testcases ─────────────────────────────────────
//
// Broader bandwidth × band × ue-count × traffic coverage but only one
// mobility/fading combination per cell. Good middle-ground for a full
// QA cycle without burning hours.

const MODERATE_SLICES: readonly MatrixSlice[] = [
  // LTE: 5 bands × 3 bw × 2 ue × 1 ant × 4 traffic × 1 mob × 1 fade = 120
  { rat: 'LTE', bands: ['1', '3', '7', '13', '41'], bandwidths: [5, 10, 20],
    ueCounts: [1, 2], antennas: [[2, 1]],
    dataTypes: ['no_data', 'iperf-both', 'iperf-dl', 'iperf-ul'],
    mobility: ['stationary'], fading: ['awgn'], maxVariants: 120 },
  // LTE voice + mix coverage (small)
  { rat: 'LTE', bands: ['3', '7'], bandwidths: [10], ueCounts: [2], antennas: [[2, 1]],
    dataTypes: ['volte', 'mix-iperf-dl+ul', 'mix-iperf+tcp'],
    mobility: ['stationary'], fading: ['awgn'], maxVariants: 6 },
  // NR-SA: 4 bands × 3 bw × 2 ue × 1 scs × 1 ant × 4 traffic = 96 → cap 60
  { rat: 'NR-SA', bands: ['n7', 'n41', 'n66', 'n78'], bandwidths: [20, 40, 100],
    scs: [30], ueCounts: [1, 4], antennas: [[2, 2]],
    dataTypes: ['no_data', 'iperf-both', 'iperf-dl', 'iperf-ul'],
    mobility: ['stationary'], fading: ['awgn'], maxVariants: 60 },
  // NR-SA voice + mix
  { rat: 'NR-SA', bands: ['n78'], bandwidths: [100], scs: [30], ueCounts: [2], antennas: [[2, 2]],
    dataTypes: ['vonr', 'mix-iperf-dl+ul', 'mix-iperf+tcp'],
    mobility: ['stationary'], fading: ['awgn'], maxVariants: 3 },
  // NR-NSA
  { rat: 'NR-NSA', bands: ['n41', 'n78'], bandwidths: [40, 100], scs: [30],
    ueCounts: [1], antennas: [[2, 2]], dataTypes: ['no_data', 'iperf-both'],
    mobility: ['stationary'], fading: ['awgn'], maxVariants: 8 },
  // NB-IoT — full ue_category × deployment-mode sweep across both bands.
  // SIM40-2311 (dropped ue_category, nb2 never generated) + SIM40-2312
  // (in-band reset to standalone).
  { rat: 'NB-IoT', bands: ['8', '20'], bandwidths: [5], ueCounts: [1, 2], antennas: [[1, 1]],
    dataTypes: ['no_data'], mobility: ['stationary'], fading: ['awgn'],
    nbUeCategories: ['nb1', 'nb2'], nbCellTypes: ['standalone', 'in-band'], maxVariants: 16 },
  // NB-IoT legacy coverage canary — the swept cellType 'standalone'/'in-band'
  // values sent to POST /v2/tests/cells are an UNVERIFIED wire contract and
  // must be verified against the Simnovator API documentation before trusting
  // sweep results. This slice deliberately omits nbUeCategories/nbCellTypes so
  // it keeps the previously-working shape (cellType '4g', ue_category nb1) and
  // NB-IoT generation can never drop to zero if the new enum 400s.
  { rat: 'NB-IoT', bands: ['8'], bandwidths: [5], ueCounts: [1], antennas: [[1, 1]],
    dataTypes: ['no_data'], mobility: ['stationary'], fading: ['awgn'], maxVariants: 1 },

  // ── Post-audit traffic-profile additions (SIM40-2303..2312 class) ──────
  // Single-profile TCP iperf — previously TCP only existed inside the
  // 2-group 'mix-iperf+tcp' wrapper, so the plain TCP path went ungenerated.
  { rat: 'LTE', bands: ['3', '7'], bandwidths: [10, 20], ueCounts: [2], antennas: [[2, 1]],
    dataTypes: ['iperf-tcp'], mobility: ['stationary'], fading: ['awgn'], maxVariants: 4 },
  { rat: 'NR-SA', bands: ['n41', 'n78'], bandwidths: [40, 100], scs: [30], ueCounts: [2], antennas: [[2, 2]],
    dataTypes: ['iperf-tcp'], mobility: ['stationary'], fading: ['awgn'], maxVariants: 4 },
  { rat: 'NR-NSA', bands: ['n78'], bandwidths: [100], scs: [30], ueCounts: [1], antennas: [[2, 2]],
    dataTypes: ['iperf-tcp'], mobility: ['stationary'], fading: ['awgn'], maxVariants: 1 },
];

// ─── COMPLETE sweep — full Cartesian, ~1700 testcases ────────────────────

const COMPLETE_SLICES: readonly MatrixSlice[] = [
  // LTE — broadest coverage. Per 36.101 Annex B the LTE channel models
  // are EPA / EVA / ETU. LTE rejects antennas.ul > 1 ("antennas/ul:
  // value must be '1' for LTE profile 0"); DL can vary.
  {
    rat: 'LTE',
    bands: ['1', '2', '3', '5', '7', '8', '13', '20', '28', '41'],
    bandwidths: [5, 10, 15, 20],
    ueCounts: [1, 2, 4],
    antennas: [[1, 1], [2, 1], [4, 1]],
    dataTypes: ['no_data', 'iperf-both', 'iperf-dl', 'iperf-ul'],
    mobility: ['stationary', 'roundTrip'],
    fading: ['awgn', 'epa5', 'eva70'],
    maxVariants: 1000,
  },
  // LTE voice + mix-traffic
  {
    rat: 'LTE', bands: ['1', '3', '7'], bandwidths: [10, 20],
    ueCounts: [2, 4], antennas: [[2, 1]],
    dataTypes: ['volte', 'mix-iperf-dl+ul', 'mix-iperf+no_data', 'mix-iperf+tcp'],
    mobility: ['stationary'], fading: ['awgn', 'epa5'],
    maxVariants: 96,
  },
  // NR-SA — wide spread. Per 38.101-4 Annex G NR channel models are TDLA/
  // TDLB/TDLC/TDLD/TDLE.
  {
    rat: 'NR-SA',
    bands: ['n2', 'n7', 'n28', 'n41', 'n66', 'n77', 'n78'],
    bandwidths: [20, 40, 100],
    scs: [15, 30],
    ueCounts: [1, 4],
    antennas: [[2, 2], [4, 2]],
    dataTypes: ['no_data', 'iperf-both', 'iperf-dl', 'iperf-ul'],
    mobility: ['stationary', 'roundTrip'],
    fading: ['awgn', 'tdla30', 'tdlb100'],
    maxVariants: 600,
  },
  // NR-SA voice + mix-traffic
  {
    rat: 'NR-SA', bands: ['n41', 'n78'], bandwidths: [40, 100], scs: [30],
    ueCounts: [2, 4], antennas: [[2, 2]],
    dataTypes: ['vonr', 'mix-iperf-dl+ul', 'mix-iperf+no_data', 'mix-iperf+tcp'],
    mobility: ['stationary'], fading: ['awgn', 'tdla30'],
    maxVariants: 64,
  },
  // NR-NSA (EN-DC)
  {
    rat: 'NR-NSA', bands: ['n41', 'n78'], bandwidths: [40, 100], scs: [30],
    ueCounts: [1, 2], antennas: [[2, 2]],
    dataTypes: ['no_data', 'iperf-both'], mobility: ['stationary'],
    fading: ['awgn', 'tdla30'], maxVariants: 32,
  },
  // NB-IoT — full ue_category × deployment-mode sweep. SIM40-2311 (dropped
  // ue_category, nb2 never generated before this dimension existed) +
  // SIM40-2312 (in-band deployment mode silently reset to standalone).
  {
    rat: 'NB-IoT', bands: ['8', '20'], bandwidths: [5], ueCounts: [1, 2],
    antennas: [[1, 1]], dataTypes: ['no_data'], mobility: ['stationary'],
    fading: ['awgn'],
    nbUeCategories: ['nb1', 'nb2'], nbCellTypes: ['standalone', 'in-band'],
    maxVariants: 16,
  },
  // NB-IoT legacy coverage canary — the swept cellType 'standalone'/'in-band'
  // values sent to POST /v2/tests/cells are an UNVERIFIED wire contract and
  // must be verified against the Simnovator API documentation before trusting
  // sweep results. This slice deliberately omits nbUeCategories/nbCellTypes so
  // it keeps the previously-working shape (cellType '4g', ue_category nb1) and
  // NB-IoT generation can never drop to zero if the new enum 400s.
  {
    rat: 'NB-IoT', bands: ['8'], bandwidths: [5], ueCounts: [1],
    antennas: [[1, 1]], dataTypes: ['no_data'], mobility: ['stationary'],
    fading: ['awgn'], maxVariants: 1,
  },

  // ── Post-audit traffic-profile additions (SIM40-2303..2312 class) ──────
  // Single-profile TCP iperf per RAT family — the audit bugs hid in
  // never-generated scenario families; plain TCP (outside the mix wrapper)
  // was one of them.
  {
    rat: 'LTE', bands: ['1', '3', '7'], bandwidths: [10, 20],
    ueCounts: [2, 4], antennas: [[2, 1]],
    dataTypes: ['iperf-tcp'], mobility: ['stationary'], fading: ['awgn', 'epa5'],
    maxVariants: 24,
  },
  {
    rat: 'NR-SA', bands: ['n41', 'n78'], bandwidths: [40, 100], scs: [30],
    ueCounts: [2, 4], antennas: [[2, 2]],
    dataTypes: ['iperf-tcp'], mobility: ['stationary'], fading: ['awgn', 'tdla30'],
    maxVariants: 16,
  },
  {
    rat: 'NR-NSA', bands: ['n41', 'n78'], bandwidths: [40, 100], scs: [30],
    ueCounts: [1, 2], antennas: [[2, 2]],
    dataTypes: ['iperf-tcp'], mobility: ['stationary'], fading: ['awgn'],
    maxVariants: 8,
  },
];

/** Returns the slice set for the requested sweep tier. */
export function slicesFor(size: SweepSize): readonly MatrixSlice[] {
  switch (size) {
    case 'quick':    return QUICK_SLICES;
    case 'moderate': return MODERATE_SLICES;
    case 'complete': return COMPLETE_SLICES;
  }
}

/** Backwards-compat — the old default. Consumers that don't pass a tier
 *  get the full sweep. */
export const SLICES: readonly MatrixSlice[] = COMPLETE_SLICES;

/** Concrete variant ready to feed the create-lifecycle. */
export interface BulkTestCaseSpec {
  id: string;
  name: string;
  rat: RAT;
  band: string;
  bandwidth: number;
  duplexMode: 'FDD' | 'TDD';
  earfcnDl: number;
  earfcnUl?: number;
  nrarfcnSsb?: number;
  scs?: number;
  ueCount: number;
  antennas: { dl: number; ul: number };
  dataType: DataType;
  mobility: Mobility;
  fading: Fading;
  /** NB-IoT only — set when the slice sweeps ue_category (SIM40-2311). */
  nbUeCategory?: NbIotUeCategory;
  /** NB-IoT only — set when the slice sweeps deployment mode (SIM40-2312). */
  nbCellType?: NbIotCellType;
  category: 'bulk-lte' | 'bulk-nr-sa' | 'bulk-nr-nsa' | 'bulk-nbiot';
}

/** Naming prefix: every generated testcase carries this so cleanup is a
 *  one-shot search-and-delete. Also surfaced as a user_tag for filtering. */
export const BULK_NAME_PREFIX = 'qa-bulk';
export const BULK_TAG = 'qa-bulk';

/** Map RAT → category bucket for reporting. */
export function categoryOf(rat: RAT): BulkTestCaseSpec['category'] {
  switch (rat) {
    case 'LTE':    return 'bulk-lte';
    case 'NR-SA':  return 'bulk-nr-sa';
    case 'NR-NSA': return 'bulk-nr-nsa';
    case 'NB-IoT': return 'bulk-nbiot';
  }
}

/** Stable id-shaped name from a spec (lowercase, hyphen-safe). The box
 *  rejects testcase names containing characters outside
 *  [A-Za-z0-9_-] — so the dataType slug also goes through the same
 *  sanitiser (e.g. "mix-iperf-dl+ul" → "mix-iperf-dl-ul"). */
export function specToId(
  rat: RAT,
  band: string,
  bw: number,
  ueCount: number,
  antennas: { dl: number; ul: number },
  dataType: string,
  mobility: string,
  fading: string,
  scs: number | undefined,
  seq: number,
  /** NB-IoT-only dimensions (SIM40-2311/2312). Optional trailing param so
   *  pre-existing variant names stay byte-identical when a slice doesn't
   *  sweep them — duplicate-name resumability depends on that. */
  nb?: { ueCategory?: string; cellType?: string },
): string {
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  const ratSlug = slug(rat);
  const bandSlug = slug(band);
  const dataSlug = slug(dataType);
  const mobSlug = mobility === 'stationary' ? 'stat' : 'mob';
  const fadeSlug = slug(fading);
  const scsSlug = scs ? `-scs${scs}` : '';
  // e.g. "-nb1-standalone" / "-nb2-in-band" — only for swept NB-IoT variants.
  const nbSlug = [nb?.ueCategory, nb?.cellType].filter(Boolean).map(x => `-${slug(String(x))}`).join('');
  const seqStr = String(seq).padStart(4, '0');
  return `${BULK_NAME_PREFIX}-${ratSlug}-${bandSlug}-bw${bw}${scsSlug}-ue${ueCount}-ant${antennas.dl}x${antennas.ul}-${dataSlug}${nbSlug}-${mobSlug}-${fadeSlug}-${seqStr}`;
}

/** Friendly column-ready summary for a spec (used by report tables). */
export function describeSpec(s: BulkTestCaseSpec): Record<string, string | number> {
  return {
    rat: s.rat,
    band: s.band,
    bandwidth: s.bandwidth,
    duplex: s.duplexMode,
    ueCount: s.ueCount,
    antennas: `${s.antennas.dl}x${s.antennas.ul}`,
    traffic: s.dataType,
    mobility: s.mobility,
    fading: s.fading,
    scs: s.scs ?? '',
    // NB-IoT audit dimensions (SIM40-2311/2312) — blank for non-NB variants.
    nbUeCategory: s.nbUeCategory ?? '',
    nbCellType: s.nbCellType ?? '',
  };
}

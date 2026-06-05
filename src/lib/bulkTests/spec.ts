// Dimension definitions for the bulk-testcase generator.
//
// Goal: programmatically author 1500+ valid, varied testcases on the box
// via the REST create-lifecycle (POST /v2/tests/cells → subscribers →
// user-plane → power-cycle → mobility → settings), then validate every
// one of them via the API (with fidelity round-trip) and a sampled subset
// via the UI.
//
// Each entry here describes one combinatorial slice of the (RAT × band ×
// bandwidth × duplex × UE-count × traffic × mobility × fading × scs)
// space. At generation time we fetch band-info from the live box,
// intersect each spec with the actual band/duplex/bandwidth combos the
// box supports, then materialise variants as concrete `BulkTestCaseSpec`
// objects.

export type RAT = 'LTE' | 'NR-SA' | 'NR-NSA' | 'NB-IoT';

export type DataType =
  | 'no_data'
  | 'iperf-both' | 'iperf-dl' | 'iperf-ul'
  // Mixed traffic — subscriber group 0 gets the first profile, group 1 the
  // second. Generates a 2-profile userPlaneConfig + 2-row subsConfig.
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

/** A single "slice" of the matrix — covers a band-set within one RAT plus
 *  the variation knobs to multiply against it. */
export interface MatrixSlice {
  /** RAT family for this slice (drives cellType + ARFCN naming + sims). */
  rat: RAT;
  /** Bands to include from this RAT (must exist in the box's band-info). */
  bands: readonly string[];
  /** Bandwidths to attempt — at generation time we intersect with the
   *  band's allowed bandwidths from the box's band-info. */
  bandwidths: readonly number[];
  /** Subscriber counts to vary. */
  ueCounts: readonly number[];
  /** Antenna config DL×UL to vary. Each entry is `[dl, ul]`. */
  antennas: ReadonlyArray<readonly [number, number]>;
  /** User-plane data direction. */
  dataTypes: readonly DataType[];
  /** Mobility profiles to exercise. */
  mobility: readonly Mobility[];
  /** Channel/fading models to exercise (varies the mobility.fadingProfile). */
  fading: readonly Fading[];
  /** Only used for NR — sub-carrier spacings in kHz. Empty for LTE. */
  scs?: readonly number[];
  /** Soft cap so a single slice can't dominate the total. */
  maxVariants?: number;
}

// Aimed at ~1500 total variants once intersected with what the box
// actually supports.
export const SLICES: readonly MatrixSlice[] = [
  // LTE — broadest coverage by far (most common deployment scenario).
  // Per 3GPP 36.101 Annex B the LTE channel models are EPA / EVA / ETU.
  // NOTE: LTE rejects antennas.ul > 1 (the box validator says
  // "antennas/ul: value must be '1' for LTE profile 0"). DL can vary;
  // UL is fixed at 1.
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
  // LTE mix-traffic slice — exercises multi-subscriber-group testcases
  // (DL+UL split, iperf+no_data, UDP+TCP). Narrower band set since the
  // important dimension here is the traffic combo, not the radio config.
  {
    rat: 'LTE',
    bands: ['1', '3', '7'],
    bandwidths: [10, 20],
    ueCounts: [2, 4],          // need ≥2 UE per group
    antennas: [[2, 1]],
    dataTypes: ['mix-iperf-dl+ul', 'mix-iperf+no_data', 'mix-iperf+tcp'],
    mobility: ['stationary'],
    fading: ['awgn', 'epa5'],
    maxVariants: 72,
  },
  // NR-SA — per 3GPP 38.101-4 Annex G the NR channel models are TDLA / TDLB
  // / TDLC / TDLD / TDLE.
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
  // NR-SA mix-traffic slice.
  {
    rat: 'NR-SA',
    bands: ['n41', 'n78'],
    bandwidths: [40, 100],
    scs: [30],
    ueCounts: [2, 4],
    antennas: [[2, 2]],
    dataTypes: ['mix-iperf-dl+ul', 'mix-iperf+no_data', 'mix-iperf+tcp'],
    mobility: ['stationary'],
    fading: ['awgn', 'tdla30'],
    maxVariants: 48,
  },
  // NR-NSA — EN-DC anchor on LTE + secondary NR carrier. Generated as a
  // 2-cell test (LTE primary band + NR secondary band). The cellTypeP
  // chain in the subscriber config gets `nsa` so the UE attaches via the
  // LTE PCell first then adds the NR SCell.
  {
    rat: 'NR-NSA',
    bands: ['n41', 'n78'],     // the NR secondary's band (LTE anchor is fixed below)
    bandwidths: [40, 100],
    scs: [30],
    ueCounts: [1, 2],
    antennas: [[2, 2]],
    dataTypes: ['no_data', 'iperf-both'],
    mobility: ['stationary'],
    fading: ['awgn', 'tdla30'],
    maxVariants: 32,
  },
  // NB-IoT — narrow-band IoT path.
  {
    rat: 'NB-IoT',
    bands: ['8', '20'],
    bandwidths: [5],
    ueCounts: [1, 2],
    antennas: [[1, 1]],
    dataTypes: ['no_data'],
    mobility: ['stationary'],
    fading: ['awgn'],
    maxVariants: 4,
  },
];

/** Concrete variant ready to feed the create-lifecycle. Generated by
 *  `expandSlices()` after intersecting with live band-info. */
export interface BulkTestCaseSpec {
  /** Deterministic id like "bulk-lte-3-bw20-ue2-ant2x2-dl_ul-001". */
  id: string;
  /** Human-readable name pushed to the box (used as the test-case name). */
  name: string;
  rat: RAT;
  band: string;
  bandwidth: number;
  duplexMode: 'FDD' | 'TDD';
  /** EARFCN (LTE) or NRARFCN (NR) values from band-info. */
  earfcnDl: number;
  earfcnUl?: number;          // LTE only
  nrarfcnSsb?: number;        // NR only
  scs?: number;               // NR only
  ueCount: number;
  antennas: { dl: number; ul: number };
  dataType: DataType;
  mobility: Mobility;
  fading: Fading;
  /** Slice/RAT for grouped reporting. */
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

/** Stable id-shaped name from a spec (lowercase, hyphen-safe). Includes
 *  new dimensions (mobility, fading) so the name remains unique under the
 *  larger matrix. */
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
): string {
  const ratSlug = rat.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const bandSlug = band.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const mobSlug = mobility === 'stationary' ? 'stat' : 'mob';
  const fadeSlug = fading.toLowerCase();
  const scsSlug = scs ? `-scs${scs}` : '';
  const seqStr = String(seq).padStart(4, '0');
  return `${BULK_NAME_PREFIX}-${ratSlug}-${bandSlug}-bw${bw}${scsSlug}-ue${ueCount}-ant${antennas.dl}x${antennas.ul}-${dataType}-${mobSlug}-${fadeSlug}-${seqStr}`;
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
  };
}

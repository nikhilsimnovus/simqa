// GOLD-config "Environment" model.
//
// At a customer site, a known-good "GOLD" testcase JSON differs from the
// reference only in SITE FACTS: the RF plan (band / ARFCN / bandwidth /
// gains / RF card), the SIM identity range (IMSI/SUPI start + Ki + OP/OPc),
// the PLMN, and the service IPs (iperf server, P-CSCF). An Environment
// captures exactly those facts so the auto-create engine can stamp them
// onto many generated testcases — the user picks a SCENARIO matrix (cell
// count, RAT, traffic, features) and the tool produces every variant.
//
// `site`     = per-deployment facts extracted from the GOLD config.
// `defaults` = scenario knobs seeded from the GOLD config but overridable.
//
// Field paths below reference the box's testDefinition. The box stores
// testcases in TWO schema shapes (confirmed live on 192.168.1.95):
//   FLAT   (newer, what the REST API writes): cells[].band, cells[].NRARFCN,
//          subs[].sharedKey, subs[].startingSUPI
//   NESTED (older / export reads): cells[].cellConfig.band,
//          cells[].cellRadioInfo.NRARFCN, subs[].subscriberAuthSecurity.sharedKey
// The parser tries NESTED then FLAT per field; generation always EMITS flat.

/** One RF cell's site plan (cell 0 is the PCell / NSA anchor). */
export interface EnvironmentCell {
  /** '4g' (LTE / NB-IoT / NSA-anchor) or '5g' (NR). */
  cellType: '4g' | '5g';
  /** Band id, e.g. "n78", "3", "20". */
  band: string;
  duplexMode: 'FDD' | 'TDD';
  /** Channel bandwidth in MHz (string "100" normalized to 100). */
  bandwidthMhz?: number;
  /** LTE downlink+uplink EARFCN (4g cells only). */
  earfcn?: { dl: number; ul?: number };
  /** NR downlink + SSB NRARFCN (5g cells only). */
  nrarfcn?: { dl: number; ssb: number };
  /** Sub-carrier spacing kHz (NR only). */
  scs?: number;
  /** SSB sub-carrier spacing kHz (NR / NTN). */
  ssbScs?: number;
  antennas: { dl: number; ul: number };
  /** Physical RF card slot. The box requires one card per cell; multi-cell
   *  plans increment by 2 (0, 2, 4, 6). */
  rfCard: number;
  /** Per-UL-antenna TX gain. */
  txGain: number[];
  /** Per-DL-antenna RX gain. */
  rxGain: number[];
  /** rx-to-tx latency (often absent on read-side export; defaults to 4). */
  rxToTxLatency?: number;
  /** NTN cell flag (satellite). */
  ntn?: boolean;
}

/** Per-deployment values extracted from the GOLD config. */
export interface EnvironmentSite {
  /** RAT family inferred from master.ratType + cell types. NTN is modeled
   *  as a per-cell flag (cell.ntn), not a 5th RAT, but surfaced here for
   *  display when every cell is NTN. */
  rat: 'NR-SA' | 'NR-NSA' | 'LTE' | 'NB-IoT' | 'NTN';
  /** All cells in plan order. */
  cells: EnvironmentCell[];

  // ── SIM / subscriber identity ──────────────────────────────────────────
  /** startingIMSI (LTE) or startingSUPI (NR) — the start of the range. */
  imsiStart: number;
  /** nextIMSI / nextSUPI — stride between successive UE identities. */
  imsiStride: number;
  /** "milenage" | "xor". */
  algorithm: string;
  /** Ki — 32 hex chars. */
  sharedKey: string;
  /** OP (milenage). */
  op?: string;
  /** OPc (milenage). */
  opc?: string;
  incrementSharedKey?: number;

  // ── Network identity ───────────────────────────────────────────────────
  /** preferredPLMN, e.g. ["011-01", "544-780"]. */
  plmn?: string[];
  mncDigits?: number;
  /** subs[].VoNRSupport — present in voice GOLD configs. */
  voNRSupport?: boolean;

  // ── Service endpoints ──────────────────────────────────────────────────
  /** iperf server IP from the first iperf profile. */
  iperfServerIp?: string;
  /** P-CSCF IP from the first volte/vonr profile. */
  pcscfIp?: string;
  /** IMS realm from the first voice profile. */
  imsRealm?: string;
}

/** Scenario knobs the generator may vary; seeded from GOLD, overridable. */
export interface EnvironmentDefaults {
  /** Bandwidths (MHz) to sweep; seeded from the site cells. */
  bandwidths?: number[];
  /** UE count per subscriber group. */
  ueCount?: number;
  antennas?: { dl: number; ul: number };
  /** Traffic profile id ("iperf-dl" | "iperf-ul" | "iperf-both" | "volte" | …). */
  dataType?: string;
  mobility?: string;
  fading?: string;
  loggingProfileName?: string;
  successCriteriaName?: string;
}

export interface EnvironmentWarning {
  /** JSON path that was missing in the source. */
  field: string;
  /** Why a fallback was used. */
  reason: string;
}

export interface Environment {
  id: string;
  name: string;
  createdAt: string;
  updatedAt?: string;
  /** Original uploaded filename, for provenance. */
  sourceFilename: string;
  site: EnvironmentSite;
  defaults: EnvironmentDefaults;
  /** Fields that fell back to a default (no value in source) — surfaced in
   *  the UI so the user knows what to double-check before generating. */
  extractionWarnings?: EnvironmentWarning[];
  notes?: string;
}

export interface EnvironmentStore {
  environments: Environment[];
}

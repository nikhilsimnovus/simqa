// 3GPP-spec derivations for ARFCN <-> frequency conversions.
//
// References:
//   - TS 38.104 §5.4.2.1 + Table 5.4.2.1-1  (NR-ARFCN <-> frequency, channel raster)
//   - TS 38.104 Table 5.2-1                  (NR operating bands)
//   - TS 36.101 §5.6, §5.7.3 + Table 5.5-1  (LTE EARFCN <-> frequency)
//   - 3GPP TS 36.101 Table 5.7.3-1           (LTE downlink EARFCN ranges per band)
//
// These functions are independent of any product code. Use them to verify
// that a vendor's golden reference (e.g., master-all-rats.json) matches
// the 3GPP spec, and that the product's auto-populate logic is correct.

// ===========================================================================
// NR (5G New Radio)
// ===========================================================================
//
// TS 38.104 Table 5.4.2.1-1: F = F_REF-Offs + ΔF_global × (N_REF − N_REF-Offs)
//
//   Range          F_REF-Offs (MHz)   ΔF_global (kHz)   N_REF-Offs   N_REF (range)
//   0..3000  MHz   0.0                5                 0            0..599999
//   3000..24250    3000.0             15                600000       600000..2016666
//   24250..100000  24250.08           60                2016667      2016667..3279165

interface NrArfcnRow { fLowMHz: number; fOffsMHz: number; dfKHz: number; nOffs: number; nMin: number; nMax: number }
const NR_ARFCN_TABLE: NrArfcnRow[] = [
  { fLowMHz: 0,        fOffsMHz: 0.0,      dfKHz: 5,  nOffs: 0,        nMin: 0,        nMax: 599999  },
  { fLowMHz: 3000,     fOffsMHz: 3000.0,   dfKHz: 15, nOffs: 600000,   nMin: 600000,   nMax: 2016666 },
  { fLowMHz: 24250,    fOffsMHz: 24250.08, dfKHz: 60, nOffs: 2016667,  nMin: 2016667,  nMax: 3279165 },
];

/** NR ARFCN → frequency in MHz. Returns null if N is out of valid range. */
export function nrArfcnToMHz(n: number): number | null {
  if (!Number.isFinite(n) || n < 0) return null;
  for (const row of NR_ARFCN_TABLE) {
    if (n >= row.nMin && n <= row.nMax) {
      return row.fOffsMHz + (row.dfKHz / 1000) * (n - row.nOffs);
    }
  }
  return null;
}

/** Frequency in MHz → NR ARFCN (rounded to integer). null if outside any defined range. */
export function nrMHzToArfcn(fMHz: number): number | null {
  if (!Number.isFinite(fMHz) || fMHz < 0) return null;
  for (const row of NR_ARFCN_TABLE) {
    const fHigh = row.fLowMHz + ((row.dfKHz / 1000) * (row.nMax - row.nOffs));
    if (fMHz >= row.fLowMHz && fMHz <= fHigh + 0.001) {
      return Math.round(row.nOffs + ((fMHz - row.fOffsMHz) * 1000) / row.dfKHz);
    }
  }
  return null;
}

// ===========================================================================
// NR Operating Bands (TS 38.104 Table 5.2-1, condensed)
// ===========================================================================
//
// Provides downlink frequency ranges per band so we can range-check ARFCNs.
// Format: { band, dlLowMHz, dlHighMHz, duplex }

export interface NrBandSpec {
  band: number;
  dlLowMHz: number;
  dlHighMHz: number;
  ulLowMHz?: number;
  ulHighMHz?: number;
  duplex: 'FDD' | 'TDD' | 'SDL' | 'SUL';
}

// Subset covering the bands in master-all-rats.json (32 NR bands).
// Source: TS 38.104 v17 Table 5.2-1.
export const NR_BANDS: NrBandSpec[] = [
  { band: 1,  duplex: 'FDD', ulLowMHz: 1920,  ulHighMHz: 1980,  dlLowMHz: 2110,  dlHighMHz: 2170  },
  { band: 2,  duplex: 'FDD', ulLowMHz: 1850,  ulHighMHz: 1910,  dlLowMHz: 1930,  dlHighMHz: 1990  },
  { band: 3,  duplex: 'FDD', ulLowMHz: 1710,  ulHighMHz: 1785,  dlLowMHz: 1805,  dlHighMHz: 1880  },
  { band: 5,  duplex: 'FDD', ulLowMHz: 824,   ulHighMHz: 849,   dlLowMHz: 869,   dlHighMHz: 894   },
  { band: 7,  duplex: 'FDD', ulLowMHz: 2500,  ulHighMHz: 2570,  dlLowMHz: 2620,  dlHighMHz: 2690  },
  { band: 8,  duplex: 'FDD', ulLowMHz: 880,   ulHighMHz: 915,   dlLowMHz: 925,   dlHighMHz: 960   },
  { band: 12, duplex: 'FDD', ulLowMHz: 699,   ulHighMHz: 716,   dlLowMHz: 729,   dlHighMHz: 746   },
  { band: 13, duplex: 'FDD', ulLowMHz: 777,   ulHighMHz: 787,   dlLowMHz: 746,   dlHighMHz: 756   },
  { band: 14, duplex: 'FDD', ulLowMHz: 788,   ulHighMHz: 798,   dlLowMHz: 758,   dlHighMHz: 768   },
  { band: 18, duplex: 'FDD', ulLowMHz: 815,   ulHighMHz: 830,   dlLowMHz: 860,   dlHighMHz: 875   },
  { band: 20, duplex: 'FDD', ulLowMHz: 832,   ulHighMHz: 862,   dlLowMHz: 791,   dlHighMHz: 821   },
  { band: 25, duplex: 'FDD', ulLowMHz: 1850,  ulHighMHz: 1915,  dlLowMHz: 1930,  dlHighMHz: 1995  },
  { band: 26, duplex: 'FDD', ulLowMHz: 814,   ulHighMHz: 849,   dlLowMHz: 859,   dlHighMHz: 894   },
  { band: 28, duplex: 'FDD', ulLowMHz: 703,   ulHighMHz: 748,   dlLowMHz: 758,   dlHighMHz: 803   },
  { band: 29, duplex: 'SDL', dlLowMHz: 717,   dlHighMHz: 728   },
  { band: 30, duplex: 'FDD', ulLowMHz: 2305,  ulHighMHz: 2315,  dlLowMHz: 2350,  dlHighMHz: 2360  },
  { band: 34, duplex: 'TDD', dlLowMHz: 2010,  dlHighMHz: 2025  },
  { band: 38, duplex: 'TDD', dlLowMHz: 2570,  dlHighMHz: 2620  },
  { band: 39, duplex: 'TDD', dlLowMHz: 1880,  dlHighMHz: 1920  },
  { band: 40, duplex: 'TDD', dlLowMHz: 2300,  dlHighMHz: 2400  },
  { band: 41, duplex: 'TDD', dlLowMHz: 2496,  dlHighMHz: 2690  },
  { band: 46, duplex: 'TDD', dlLowMHz: 5150,  dlHighMHz: 5925  },
  { band: 48, duplex: 'TDD', dlLowMHz: 3550,  dlHighMHz: 3700  },
  { band: 50, duplex: 'TDD', dlLowMHz: 1432,  dlHighMHz: 1517  },
  { band: 51, duplex: 'TDD', dlLowMHz: 1427,  dlHighMHz: 1432  },
  { band: 53, duplex: 'TDD', dlLowMHz: 2483.5, dlHighMHz: 2495 },
  { band: 65, duplex: 'FDD', ulLowMHz: 1920,  ulHighMHz: 2010,  dlLowMHz: 2110,  dlHighMHz: 2200  },
  { band: 66, duplex: 'FDD', ulLowMHz: 1710,  ulHighMHz: 1780,  dlLowMHz: 2110,  dlHighMHz: 2200  },
  { band: 70, duplex: 'FDD', ulLowMHz: 1695,  ulHighMHz: 1710,  dlLowMHz: 1995,  dlHighMHz: 2020  },
  { band: 71, duplex: 'FDD', ulLowMHz: 663,   ulHighMHz: 698,   dlLowMHz: 617,   dlHighMHz: 652   },
  { band: 74, duplex: 'FDD', ulLowMHz: 1427,  ulHighMHz: 1470,  dlLowMHz: 1475,  dlHighMHz: 1518  },
  { band: 75, duplex: 'SDL', dlLowMHz: 1432,  dlHighMHz: 1517  },
  { band: 76, duplex: 'SDL', dlLowMHz: 1427,  dlHighMHz: 1432  },
  { band: 77, duplex: 'TDD', dlLowMHz: 3300,  dlHighMHz: 4200  },
  { band: 78, duplex: 'TDD', dlLowMHz: 3300,  dlHighMHz: 3800  },
  { band: 79, duplex: 'TDD', dlLowMHz: 4400,  dlHighMHz: 5000  },
  { band: 90, duplex: 'TDD', dlLowMHz: 2496,  dlHighMHz: 2690  },  // TS 38.104 v17, 2.5 GHz TDD
];

export function getNrBand(band: number): NrBandSpec | undefined {
  return NR_BANDS.find((b) => b.band === band);
}

// ===========================================================================
// LTE
// ===========================================================================
//
// TS 36.101 §5.7.3: F_DL = F_DL_low + 0.1 × (N_DL − N_OFFS_DL)
//
// Per Table 5.7.3-1 (downlink ranges, condensed for the bands in our golden file).

export interface LteBandSpec {
  band: number;
  duplex: 'FDD' | 'TDD' | 'SDL';
  dlLowMHz: number;
  dlHighMHz: number;
  nOffsDl: number;
  nDlMin: number;
  nDlMax: number;
}

export const LTE_BANDS: LteBandSpec[] = [
  { band: 1,  duplex: 'FDD', dlLowMHz: 2110,  dlHighMHz: 2170,  nOffsDl: 0,     nDlMin: 0,     nDlMax: 599   },
  { band: 2,  duplex: 'FDD', dlLowMHz: 1930,  dlHighMHz: 1990,  nOffsDl: 600,   nDlMin: 600,   nDlMax: 1199  },
  { band: 3,  duplex: 'FDD', dlLowMHz: 1805,  dlHighMHz: 1880,  nOffsDl: 1200,  nDlMin: 1200,  nDlMax: 1949  },
  { band: 4,  duplex: 'FDD', dlLowMHz: 2110,  dlHighMHz: 2155,  nOffsDl: 1950,  nDlMin: 1950,  nDlMax: 2399  },
  { band: 5,  duplex: 'FDD', dlLowMHz: 869,   dlHighMHz: 894,   nOffsDl: 2400,  nDlMin: 2400,  nDlMax: 2649  },
  { band: 7,  duplex: 'FDD', dlLowMHz: 2620,  dlHighMHz: 2690,  nOffsDl: 2750,  nDlMin: 2750,  nDlMax: 3449  },
  { band: 8,  duplex: 'FDD', dlLowMHz: 925,   dlHighMHz: 960,   nOffsDl: 3450,  nDlMin: 3450,  nDlMax: 3799  },
  { band: 11, duplex: 'FDD', dlLowMHz: 1475.9, dlHighMHz: 1495.9, nOffsDl: 4750, nDlMin: 4750, nDlMax: 4949 },
  { band: 12, duplex: 'FDD', dlLowMHz: 729,   dlHighMHz: 746,   nOffsDl: 5010,  nDlMin: 5010,  nDlMax: 5179  },
  { band: 13, duplex: 'FDD', dlLowMHz: 746,   dlHighMHz: 756,   nOffsDl: 5180,  nDlMin: 5180,  nDlMax: 5279  },
  { band: 14, duplex: 'FDD', dlLowMHz: 758,   dlHighMHz: 768,   nOffsDl: 5280,  nDlMin: 5280,  nDlMax: 5379  },
  { band: 17, duplex: 'FDD', dlLowMHz: 734,   dlHighMHz: 746,   nOffsDl: 5730,  nDlMin: 5730,  nDlMax: 5849  },
  { band: 18, duplex: 'FDD', dlLowMHz: 860,   dlHighMHz: 875,   nOffsDl: 5850,  nDlMin: 5850,  nDlMax: 5999  },
  { band: 19, duplex: 'FDD', dlLowMHz: 875,   dlHighMHz: 890,   nOffsDl: 6000,  nDlMin: 6000,  nDlMax: 6149  },
  { band: 20, duplex: 'FDD', dlLowMHz: 791,   dlHighMHz: 821,   nOffsDl: 6150,  nDlMin: 6150,  nDlMax: 6449  },
  { band: 21, duplex: 'FDD', dlLowMHz: 1495.9, dlHighMHz: 1510.9, nOffsDl: 6450, nDlMin: 6450, nDlMax: 6599 },
  { band: 26, duplex: 'FDD', dlLowMHz: 859,   dlHighMHz: 894,   nOffsDl: 8690,  nDlMin: 8690,  nDlMax: 9039  },
  { band: 28, duplex: 'FDD', dlLowMHz: 758,   dlHighMHz: 803,   nOffsDl: 9210,  nDlMin: 9210,  nDlMax: 9659  },
  { band: 29, duplex: 'SDL', dlLowMHz: 717,   dlHighMHz: 728,   nOffsDl: 9660,  nDlMin: 9660,  nDlMax: 9769  },
  { band: 30, duplex: 'FDD', dlLowMHz: 2350,  dlHighMHz: 2360,  nOffsDl: 9770,  nDlMin: 9770,  nDlMax: 9869  },
  { band: 38, duplex: 'TDD', dlLowMHz: 2570,  dlHighMHz: 2620,  nOffsDl: 37750, nDlMin: 37750, nDlMax: 38249 },
  { band: 39, duplex: 'TDD', dlLowMHz: 1880,  dlHighMHz: 1920,  nOffsDl: 38250, nDlMin: 38250, nDlMax: 38649 },
  { band: 40, duplex: 'TDD', dlLowMHz: 2300,  dlHighMHz: 2400,  nOffsDl: 38650, nDlMin: 38650, nDlMax: 39649 },
  { band: 41, duplex: 'TDD', dlLowMHz: 2496,  dlHighMHz: 2690,  nOffsDl: 39650, nDlMin: 39650, nDlMax: 41589 },
  { band: 42, duplex: 'TDD', dlLowMHz: 3400,  dlHighMHz: 3600,  nOffsDl: 41590, nDlMin: 41590, nDlMax: 43589 },
  { band: 43, duplex: 'TDD', dlLowMHz: 3600,  dlHighMHz: 3800,  nOffsDl: 43590, nDlMin: 43590, nDlMax: 45589 },
  { band: 46, duplex: 'TDD', dlLowMHz: 5150,  dlHighMHz: 5925,  nOffsDl: 46790, nDlMin: 46790, nDlMax: 54539 },
  { band: 48, duplex: 'TDD', dlLowMHz: 3550,  dlHighMHz: 3700,  nOffsDl: 55240, nDlMin: 55240, nDlMax: 56739 },
  // Bands present in our reference file but added to the spec table later:
  { band: 25, duplex: 'FDD', dlLowMHz: 1930,  dlHighMHz: 1995,  nOffsDl: 8040,  nDlMin: 8040,  nDlMax: 8689  },  // US PCS+G
  { band: 34, duplex: 'TDD', dlLowMHz: 2010,  dlHighMHz: 2025,  nOffsDl: 36200, nDlMin: 36200, nDlMax: 36349 },  // China TD-SCDMA reuse
  { band: 66, duplex: 'FDD', dlLowMHz: 2110,  dlHighMHz: 2200,  nOffsDl: 66436, nDlMin: 66436, nDlMax: 67335 },  // AWS-3 extended
  { band: 71, duplex: 'FDD', dlLowMHz: 617,   dlHighMHz: 652,   nOffsDl: 68586, nDlMin: 68586, nDlMax: 68935 },  // US 600 MHz
];

export function getLteBand(band: number): LteBandSpec | undefined {
  return LTE_BANDS.find((b) => b.band === band);
}

/** LTE EARFCN → frequency (MHz). null if N_DL is outside the band's range. */
export function lteEarfcnToMHz(band: number, earfcn: number): number | null {
  const b = getLteBand(band);
  if (!b) return null;
  if (earfcn < b.nDlMin || earfcn > b.nDlMax) return null;
  return b.dlLowMHz + 0.1 * (earfcn - b.nOffsDl);
}

/** LTE frequency (MHz) → EARFCN (integer). null if outside band's range. */
export function lteMHzToEarfcn(band: number, fMHz: number): number | null {
  const b = getLteBand(band);
  if (!b) return null;
  if (fMHz < b.dlLowMHz || fMHz > b.dlHighMHz) return null;
  return Math.round(b.nOffsDl + (fMHz - b.dlLowMHz) * 10);
}

// ===========================================================================
// Verification helpers - used by the band-validation tests
// ===========================================================================

export interface BandVerifyResult {
  ok: boolean;
  observation: string;
}

/**
 * Verify a single golden-file entry against 3GPP formulas.
 * Returns { ok, observation } where observation is a one-liner suitable for
 * the test detail field.
 */
export function verifyNrEntry(entry: { band: number; bwMHz: number; scsKHz: number; ssbScsKHz: number; dlArfcn: number; dlFreqMHz: number; ssbArfcn: number; ssbFreqMHz: number }): BandVerifyResult {
  const bandSpec = getNrBand(entry.band);
  if (!bandSpec) return { ok: false, observation: `band n${entry.band} not in TS 38.104 Table 5.2-1` };

  // Verify DL frequency from ARFCN
  const computedDlMHz = nrArfcnToMHz(entry.dlArfcn);
  if (computedDlMHz === null) return { ok: false, observation: `DL ARFCN ${entry.dlArfcn} is out of NR-ARFCN valid range [0..3279165]` };
  const dlDelta = Math.abs(computedDlMHz - entry.dlFreqMHz);
  if (dlDelta > 0.01) return { ok: false, observation: `DL freq mismatch: golden=${entry.dlFreqMHz} MHz, 3GPP-derived=${computedDlMHz.toFixed(3)} MHz (Δ=${dlDelta.toFixed(3)})` };

  // Verify DL frequency falls inside band's DL range (n29, n75, n76 are SDL - DL only)
  const inBand = computedDlMHz >= bandSpec.dlLowMHz - 0.001 && computedDlMHz <= bandSpec.dlHighMHz + 0.001;
  if (!inBand) return { ok: false, observation: `DL freq ${computedDlMHz.toFixed(3)} MHz is outside band n${entry.band} range [${bandSpec.dlLowMHz}, ${bandSpec.dlHighMHz}] MHz` };

  // Verify SSB frequency from SSB-ARFCN
  const computedSsbMHz = nrArfcnToMHz(entry.ssbArfcn);
  if (computedSsbMHz === null) return { ok: false, observation: `SSB ARFCN ${entry.ssbArfcn} is out of NR-ARFCN valid range` };
  const ssbDelta = Math.abs(computedSsbMHz - entry.ssbFreqMHz);
  if (ssbDelta > 0.01) return { ok: false, observation: `SSB freq mismatch: golden=${entry.ssbFreqMHz} MHz, 3GPP-derived=${computedSsbMHz.toFixed(3)} MHz` };

  return { ok: true, observation: `n${entry.band} bw=${entry.bwMHz}MHz scs=${entry.scsKHz}kHz: DL=${entry.dlFreqMHz}MHz/ARFCN${entry.dlArfcn} ✓, SSB=${entry.ssbFreqMHz}MHz/ARFCN${entry.ssbArfcn} ✓` };
}

export function verifyLteEntry(entry: { band: number; bwMHz: number; dlArfcn: number; dlFreqMHz: number }): BandVerifyResult {
  const bandSpec = getLteBand(entry.band);
  if (!bandSpec) return { ok: false, observation: `band ${entry.band} not in TS 36.101 Table 5.5-1` };

  // Bounds check
  if (entry.dlArfcn < bandSpec.nDlMin || entry.dlArfcn > bandSpec.nDlMax) {
    return { ok: false, observation: `EARFCN ${entry.dlArfcn} is outside band ${entry.band} DL range [${bandSpec.nDlMin}, ${bandSpec.nDlMax}]` };
  }

  // Derive frequency
  const computed = lteEarfcnToMHz(entry.band, entry.dlArfcn);
  if (computed === null) return { ok: false, observation: `could not derive frequency for band=${entry.band} EARFCN=${entry.dlArfcn}` };
  const delta = Math.abs(computed - entry.dlFreqMHz);
  if (delta > 0.01) return { ok: false, observation: `DL freq mismatch: golden=${entry.dlFreqMHz} MHz, 3GPP-derived=${computed.toFixed(3)} MHz (Δ=${delta.toFixed(3)})` };

  return { ok: true, observation: `b${entry.band} bw=${entry.bwMHz}MHz: DL=${entry.dlFreqMHz}MHz/EARFCN${entry.dlArfcn} ✓` };
}

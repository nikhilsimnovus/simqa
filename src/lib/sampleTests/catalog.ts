// Sample-testcase catalog — mirrors the box's actual shipped sample set.
//
// Source of truth: GET /v2/testcases?limit=1000&tags=sample on a freshly-
// deployed 4.0.0_260602 (and newer) box returns these 17 entries, all
// pre-populated with system_tags=["sample"]. They appear under the
// "Sample Tests" tab in the UI.
//
// Cross-reference to the Confluence "Sample Test Cases" page (1361936385,
// /wiki/x/AYAtUQ): that page lists 19 *conceptual* sample testcases
// (Sample-NR-SA-Latency-Ping, Sample-NR-SA-iPerf-UDP-DLUL, etc.) which the
// box does NOT ship. The shipped set covers the multi-user-64UE story end;
// the foundational + NTN-features wiki items are still aspirational. See
// bug-report.md → C2 for the reconciliation question.
//
// Categories here are by RAT (the dimension that actually varies in the
// shipped set) rather than by the wiki's narrative grouping, so the
// reporting view buckets are meaningful for the actual content.
//
// Each entry's `id` is the on-box testcase id (note the trailing underscore
// — SIM40-2015 convention). The matrix engine multiplies these along
// per-item variation specs to produce the combinatorial coverage.

export type SampleCategory = 'sa' | 'lte' | 'nsa' | 'nbiot';

export interface SampleTestEntry {
  /** Stable numeric id from the catalog order, for stable reporting. */
  item: number;
  /** On-box testcase id (with trailing underscore per SIM40-2015). */
  id: string;
  /** Display name as shown in the box UI. */
  name: string;
  /** RAT-based category for grouped reporting. */
  category: SampleCategory;
  /** Person responsible for owning behaviour of this test on the box. */
  owner: string;
  /** One-line human descriptor for the UI / report. */
  descriptor: string;
}

export const CATEGORY_LABELS: Record<SampleCategory, string> = {
  'sa':    'NR SA (5G standalone)',
  'lte':   'LTE (4G)',
  'nsa':   'NR NSA (EN-DC)',
  'nbiot': 'NB-IoT',
};

export const CATEGORY_ORDER: SampleCategory[] = ['sa', 'lte', 'nsa', 'nbiot'];

export const SAMPLE_TESTS: SampleTestEntry[] = [
  // ── NR SA (5G standalone), 4×2 or 2×2 multi-cell, 64 UEs ───────────────────
  { item: 1, id: 'SAMPLE_SA_64UES_AttDetach_4x2_',           name: 'SAMPLE_SA_64UES_AttDetach_4x2',           category: 'sa',    owner: 'Sirisha R',                        descriptor: '64 UEs attach + detach burst on NR SA 4×2 cells' },
  { item: 2, id: 'SAMPLE_SA_64UES_HO_4X2_',                  name: 'SAMPLE_SA_64UES_HO_4X2',                  category: 'sa',    owner: 'Sirisha R',                        descriptor: '64-UE handover sweep on NR SA 4×2 cells' },
  { item: 3, id: 'SAMPLE_SA_64UES_TCP_DL_4X2_',              name: 'SAMPLE_SA_64UES_TCP_DL_4X2',              category: 'sa',    owner: 'Sirisha R',                        descriptor: '64-UE TCP downlink throughput, NR SA 4×2' },
  { item: 4, id: 'SAMPLE_SA_64UES_UDP_2X2_',                 name: 'SAMPLE_SA_64UES_UDP_2X2',                 category: 'sa',    owner: 'Sirisha R',                        descriptor: '64-UE UDP bidirectional, NR SA 2×2' },
  { item: 5, id: 'SAMPLE_SA_64UES_UDP_4X2_',                 name: 'SAMPLE_SA_64UES_UDP_4X2',                 category: 'sa',    owner: 'Sirisha R',                        descriptor: '64-UE UDP bidirectional, NR SA 4×2' },
  { item: 6, id: 'SAMPLE_SA_64UES_UDP_DL_TCP_DL_4X2_',       name: 'SAMPLE_SA_64UES_UDP_DL_TCP_DL_4X2',       category: 'sa',    owner: 'Sirisha R',                        descriptor: '64-UE mixed UDP-DL + TCP-DL traffic, NR SA 4×2' },
  { item: 7, id: 'SAMPLE_SA_64UES_UDP_DL_VONR_4X2_',         name: 'SAMPLE_SA_64UES_UDP_DL_VONR_4X2',         category: 'sa',    owner: 'Sirisha R',                        descriptor: '64-UE UDP-DL with VoNR voice overlay, NR SA 4×2' },
  { item: 8, id: 'SAMPLE_SA_64UES_VONR_IMSI_4X2_',           name: 'SAMPLE_SA_64UES_VONR_IMSI_4X2',           category: 'sa',    owner: 'Sirisha R',                        descriptor: '64-UE VoNR with IMSI-based UE addressing, NR SA 4×2' },
  { item: 9, id: 'SAMPLE_SA_64UES_VONR_TELEPHON_4X2_',       name: 'SAMPLE_SA_64UES_VONR_TELEPHON_4X2',       category: 'sa',    owner: 'Sirisha R',                        descriptor: '64-UE VoNR with telephony-style call patterns, NR SA 4×2' },

  // ── LTE (4G), 4×1 multi-cell, 64 UEs ──────────────────────────────────────
  { item: 10, id: 'SAMPLE_LTE_64UES_AttDetach_4X1_',         name: 'SAMPLE_LTE_64UES_AttDetach_4X1',          category: 'lte',   owner: 'Jay Shankar Prajapati',            descriptor: '64-UE attach + detach burst on LTE 4×1' },
  { item: 11, id: 'SAMPLE_LTE_64UES_HO_4X1_',                name: 'SAMPLE_LTE_64UES_HO_4X1',                 category: 'lte',   owner: 'Jay Shankar Prajapati',            descriptor: '64-UE handover sweep on LTE 4×1' },
  { item: 12, id: 'SAMPLE_LTE_64UES_TCP_DL_4X1_',            name: 'SAMPLE_LTE_64UES_TCP_DL_4X1',             category: 'lte',   owner: 'Jay Shankar Prajapati',            descriptor: '64-UE TCP downlink throughput, LTE 4×1' },
  { item: 13, id: 'SAMPLE_LTE_64UES_UDP_4X1_',               name: 'SAMPLE_LTE_64UES_UDP_4X1',                category: 'lte',   owner: 'Jay Shankar Prajapati',            descriptor: '64-UE UDP bidirectional, LTE 4×1' },
  { item: 14, id: 'SAMPLE_LTE_64UES_UDP_DL_TCP_DL_4X1_',     name: 'SAMPLE_LTE_64UES_UDP_DL_TCP_DL_4X1',      category: 'lte',   owner: 'Jay Shankar Prajapati',            descriptor: '64-UE mixed UDP-DL + TCP-DL, LTE 4×1' },
  { item: 15, id: 'SAMPLE_LTE_64UES_VONR_IMSI_4X1_',         name: 'SAMPLE_LTE_64UES_VONR_IMSI_4X1',          category: 'lte',   owner: 'Jay Shankar Prajapati',            descriptor: '64-UE VoLTE-style with IMSI addressing on LTE 4×1' },

  // ── NR NSA (5G non-standalone / EN-DC), 2×1 multi-cell, 64 UEs ───────────
  { item: 16, id: 'SAMPLE_NSA_64UES_UDP_2X1_',               name: 'SAMPLE_NSA_64UES_UDP_2X1',                category: 'nsa',   owner: 'Pradeep Kumar Gupta',              descriptor: '64-UE UDP bidirectional, NR NSA EN-DC 2×1' },

  // ── NB-IoT, 1×1 single-cell, 64 UEs ───────────────────────────────────────
  { item: 17, id: 'SAMPLE_Nbiot_64UES_STANDALONE_PING_1X1_', name: 'SAMPLE_Nbiot_64UES_STANDALONE_PING_1X1',  category: 'nbiot', owner: 'Pradeep Kumar Gupta (Aakash — NTN)', descriptor: '64-UE NB-IoT standalone ping, 1×1 cell' },
];

/** Helper — group catalogue entries by category, preserving CATEGORY_ORDER. */
export function groupByCategory(): Record<SampleCategory, SampleTestEntry[]> {
  const out: Record<SampleCategory, SampleTestEntry[]> = {
    'sa':    [],
    'lte':   [],
    'nsa':   [],
    'nbiot': [],
  };
  for (const e of SAMPLE_TESTS) out[e.category].push(e);
  return out;
}

// Curated sample-testcase catalog mirroring the Confluence page
// "Sample Test Cases – Foundational, NTN/Features & Multi-User (64 UEs)"
// (page id 1361936385, /wiki/x/AYAtUQ).
//
// 19 testcases grouped into three categories so the reporting view can show
// progress per category at a glance:
//   - foundational    (items 1–8, single-cell except the 4G multi-cell case)
//   - ntn-features    (items 9–13, NTN + slicing + UAC + IoT coexistence)
//   - multi-user-64ue (items 14–19, 64-UE multi-user scenarios)
//
// Each entry carries the canonical testcase name, the owner team-member, and
// a `descriptor` for the report. The on-box id (with the Simnovator
// trailing-underscore convention — see SIM40-2015) is discovered at runtime
// by searching `/v2/testcases/search`. If the testcase isn't on the box yet,
// the dashboard shows "Not yet authored" against the owner.

export type SampleCategory = 'foundational' | 'ntn-features' | 'multi-user-64ue';

export interface SampleTestEntry {
  /** Stable numeric id from the source spreadsheet — matches the wiki page row order. */
  item: number;
  /** Canonical name from the wiki page (used for box-side search). */
  name: string;
  /** Category for grouped reporting. */
  category: SampleCategory;
  /** Person responsible for authoring this testcase on the box. */
  owner: string;
  /** One-line human descriptor for the UI / report. */
  descriptor: string;
}

export const CATEGORY_LABELS: Record<SampleCategory, string> = {
  'foundational':    'Foundational (1–8)',
  'ntn-features':    'NTN & Features (9–13)',
  'multi-user-64ue': 'Multi-User 64 UEs (14–19)',
};

export const CATEGORY_ORDER: SampleCategory[] = ['foundational', 'ntn-features', 'multi-user-64ue'];

export const SAMPLE_TESTS: SampleTestEntry[] = [
  // ── Foundational (single-cell except item 8) ────────────────────────────
  { item: 1,  name: 'Sample-NR-SA-Latency-Ping',                            category: 'foundational', owner: 'Jay Shankar Prajapati', descriptor: 'NR SA latency baseline — single UE, ping' },
  { item: 2,  name: 'Sample-NR-SA-Throughput-iPerfUDP-DLUL',                category: 'foundational', owner: 'Jay Shankar Prajapati', descriptor: 'NR SA UDP throughput DL+UL via iperf3' },
  { item: 3,  name: 'Sample-NR-SA-Throughput-iPerfTCP-DLUL-Adv',            category: 'foundational', owner: 'Jay Shankar Prajapati', descriptor: 'NR SA TCP throughput DL+UL (advanced flags)' },
  { item: 4,  name: 'Sample-NR-SA-Web-FTP-HTTP',                            category: 'foundational', owner: 'Jay Shankar Prajapati', descriptor: 'NR SA web traffic mix — FTP + HTTP' },
  { item: 5,  name: 'Sample-NR-SA-ViNR-VoNR',                               category: 'foundational', owner: 'Jay Shankar Prajapati', descriptor: 'NR SA ViNR + VoNR voice/video' },
  { item: 6,  name: 'Sample-NR-NSA-ENDC',                                   category: 'foundational', owner: 'Jay Shankar Prajapati', descriptor: 'NR NSA EN-DC dual connectivity' },
  { item: 7,  name: 'Sample-LTE-VoLTE-Latency',                             category: 'foundational', owner: 'Jay Shankar Prajapati', descriptor: 'LTE VoLTE latency baseline' },
  { item: 8,  name: 'Sample-LTE-MultiCell-4x1',                             category: 'foundational', owner: 'Jay Shankar Prajapati', descriptor: 'LTE multi-cell 4×1 (the one multi-cell foundational case)' },

  // ── NTN & Features ──────────────────────────────────────────────────────
  { item: 9,  name: 'Sample-NBIoT-NTN-GEO',                                 category: 'ntn-features', owner: 'Pradeep Kumar Gupta (Aakash — NTN)', descriptor: 'NB-IoT over NTN GEO' },
  { item: 10, name: 'Sample-NR-SA-NTN-LEO',                                 category: 'ntn-features', owner: 'Pradeep Kumar Gupta (Aakash — NTN)', descriptor: 'NR SA over NTN LEO' },
  { item: 11, name: 'Sample-NR-SA-NetworkSlicing',                          category: 'ntn-features', owner: 'Pradeep Kumar Gupta',                descriptor: 'NR SA network slicing (multiple S-NSSAI)' },
  { item: 12, name: 'Sample-NR-SA-UAC-Congestion',                          category: 'ntn-features', owner: 'Pradeep Kumar Gupta',                descriptor: 'NR SA UAC access-control under congestion' },
  { item: 13, name: 'Sample-IoT-NBIoT-RedCap-Coexistence',                  category: 'ntn-features', owner: 'Pradeep Kumar Gupta',                descriptor: 'NB-IoT + RedCap coexistence (eDRX/PSM, staggered)' },

  // ── Multi-User 64 UEs ───────────────────────────────────────────────────
  { item: 14, name: 'Sample-NR-SA-AttachBurst-64UE',                        category: 'multi-user-64ue', owner: 'Sirisha R', descriptor: '64 UEs attach burst 10/s; detach after 15 s' },
  { item: 15, name: 'Sample-NR-SA-CA-PeakDL-iPerfUDP-64UE',                 category: 'multi-user-64ue', owner: 'Sirisha R', descriptor: '64-UE CA peak-DL via iperf3 UDP' },
  { item: 16, name: 'Sample-Mixed-LTE-NR-Traffic-64UE',                     category: 'multi-user-64ue', owner: 'Sirisha R', descriptor: '64 UEs across LTE+NR: VoLTE/VoNR + HTTP + FTP' },
  { item: 17, name: 'Sample-NR-SA-Mobility-PingPong-iPerfUDP-64UE',         category: 'multi-user-64ue', owner: 'Sirisha R', descriptor: '64-UE NR SA mobility ping-pong while iperf3 UDP' },
  { item: 18, name: 'Sample-InterRAT-HO-5G-4G-VoNR-VoLTE-64UE',             category: 'multi-user-64ue', owner: 'Sirisha R', descriptor: 'Inter-RAT HO 5G↔4G with VoNR/VoLTE active (64 UEs)' },
  { item: 19, name: 'Sample-NR-SA-ChannelModel-NearMidFar-3UEGrp',          category: 'multi-user-64ue', owner: 'Sirisha R', descriptor: 'NR SA channel model near/mid/far across 3 UE groups (1 cell)' },
];

/** Helper — group catalogue entries by category, preserving CATEGORY_ORDER. */
export function groupByCategory(): Record<SampleCategory, SampleTestEntry[]> {
  const out: Record<SampleCategory, SampleTestEntry[]> = {
    'foundational':    [],
    'ntn-features':    [],
    'multi-user-64ue': [],
  };
  for (const e of SAMPLE_TESTS) out[e.category].push(e);
  return out;
}

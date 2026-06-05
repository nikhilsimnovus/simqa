// Coverage matrix generator.
//
// Produces Case objects (each = box-valid /tests/* bodies + the flat input
// config the validator diffs against). Strategy = pairwise (all-pairs) across
// the chosen dimensions, with optional full-sweep (Cartesian) on dimensions
// marked critical. RF anchors (band + ARFCN) are fixed per RAT to known-good
// values so creates are always accepted; band sweeps land in a later phase
// once a vetted ARFCN table exists.

import type { Case, Rat } from './types';

// ---------- dimension model ----------

export interface MatrixRequest {
  rats: Rat[];                       // which RATs to include
  bandwidths?: number[];             // override default per-RAT BW set
  antennas?: Array<[number, number]>;// [dl, ul] pairs
  ueCounts?: number[];
  dataTypes?: Array<'no_data' | 'udp' | 'tcp'>;
  featureFlags?: Array<'networkSlicing'>;
  mode?: 'pairwise' | 'full';        // full = Cartesian (use sparingly)
  cap?: number;                      // hard cap on generated cases
}

interface Spec {
  rat: Rat;
  bandwidth: number;
  antDl: number;
  antUl: number;
  ueCount: number;
  dataType: 'no_data' | 'udp' | 'tcp';
  networkSlicing: 'enable' | 'disable';
}

// Fixed RF anchors (validated/known-good).
const ANCHOR = {
  lte: { band: '1', duplex: 'FDD', EARFCN: { dl: 300, ul: 18300 }, cellType: '4g', ratType: 'smartphone' as const },
  'nr-sa': { band: 'n78', duplex: 'TDD', scs: 30, NRARFCN: { dl: 632628, ssb: 629952, ul: 632628 }, cellType: '5g', ratType: 'sa' as const },
};

// Validity constraints baked into the defaults:
//   • LTE UE-sim supports only ONE uplink antenna (antennas.ul MUST be 1) — the
//     box 400s otherwise. DL can be 1/2/4 for MIMO.
//   • NR-SA accepts ul 1 or 2.
const DEFAULTS = {
  lte: { bandwidths: [5, 10, 20], antennas: [[1, 1], [2, 1], [4, 1]] as Array<[number, number]>, ueCounts: [1, 2], dataTypes: ['no_data', 'udp'] as const },
  'nr-sa': { bandwidths: [20, 50, 100], antennas: [[1, 1], [2, 1], [2, 2], [4, 2]] as Array<[number, number]>, ueCounts: [1, 2], dataTypes: ['no_data', 'udp'] as const },
};

const arr = (n: number, v: number) => Array.from({ length: n }, () => v);

// ---------- body builders ----------

function buildCells(spec: Spec) {
  const isNr = spec.rat === 'nr-sa';
  const a = isNr ? ANCHOR['nr-sa'] : ANCHOR.lte;
  const cell: any = {
    cellType: a.cellType, syncId: 0, duplexMode: a.duplex, band: a.band,
    bandwidth: String(spec.bandwidth), prach: 0,
    antennas: { dl: spec.antDl, ul: spec.antUl }, rfCard: 0, rxToTxLatency: 4,
    txGain: arr(spec.antUl, isNr ? 80 : 70), rxGain: arr(spec.antDl, 0),
    globalTimingAdvance: -1,
    mobility: { antennaType: 'isotropic', position: [4, 3], referencePower: -25, ulAttenuation: 60 },
  };
  if (isNr) { cell.NRARFCN = ANCHOR['nr-sa'].NRARFCN; cell.scs = ANCHOR['nr-sa'].scs; cell.ssbScs = 30; cell.NTN = false; }
  else { cell.EARFCN = ANCHOR.lte.EARFCN; }
  const master: any = { product: 'UE-SIM', carrierAggregation: false, channelSim: false, pdcchDecodeOpt: true, pdcchDecodeOptThreshold: 0.1, ratType: a.ratType };
  if (isNr) master.ldpcIteration = 12; else master.turboIteration = 14;
  return { cellConfig: { master, cells: [cell] } };
}

function buildSubs(spec: Spec) {
  const isNr = spec.rat === 'nr-sa';
  const sub: any = {
    ueCount: spec.ueCount, servingCell: 0,
    algorithm: isNr ? 'xor' : 'milenage',
    sharedKey: '00112233445566778899aabbccddeeff',
    op: '000102030405060708090A0B0C0D0E0F',
    resLength: 8, securityContext: true,
    asRelease: isNr ? 16 : 13, redCap: false,
    ueCategoryType: 'combined', ueCategory: isNr ? 'nr' : '6',
    imeisv: '4085780000000102',
    powerControl: false, powerMin: 0, powerMax: 0,
    attachType: 'normal', ueInitiatedEvents: 'rrc', eventsInLoop: false, triggerTime: [10],
    pdnType: 'ipv4', defaultApn: '',
    cipherAlgorithm: isNr ? ['nea0', 'nea1', 'nea2'] : ['eea0', 'eea1', 'eea2'],
    integrityAlgorithm: isNr ? ['nia0', 'nia1', 'nia2'] : ['eia0', 'eia1', 'eia2'],
    cqi: 'auto', ri: 'auto', pmi: 'auto', preambleIndex: isNr ? 1 : 0,
    networkSlicing: spec.networkSlicing,
  };
  if (isNr) {
    // SA subscriber: SUPI is a NUMBER (uint64); these fields are REQUIRED by
    // the box validator (verified live — null on any of them -> 400).
    sub.startingSUPI = 1010123456001; sub.nextSUPI = 1; sub.mncDigits = 2;
    sub.VoNRSupport = true; sub.protectionScheme = 'null';
    sub.publicKey = '00112233445566778899aabbccddeeff'; sub.publicKeyId = 0; sub.routingIndicator = 1111;
    sub.access_control_classes = []; sub.uac_access_identities = [];
  } else {
    sub.startingIMSI = 1010123456789; sub.nextIMSI = 1;
  }
  if (spec.networkSlicing === 'enable') sub.nssaiObject = [{ sd: 1, sst: 1 }];
  return { subsConfig: { subs: [sub] } };
}

function buildUserPlane(spec: Spec) {
  if (spec.dataType === 'no_data') {
    return { userPlaneConfig: { profiles: [{ subscriberGroup: [0], dataType: 'no_data', pdnType: 'ipv4', apnName: '' }] } };
  }
  return {
    userPlaneConfig: {
      profiles: [{
        subscriberGroup: [0], dataType: 'iperf', transportProtocol: spec.dataType,
        serverIpAddress: '192.168.2.1', portRange: 5000, pdnType: 'ipv4', apnName: '',
        startDelay: 5, sessionDuration: 60, dataLoop: false, loopCount: 0, interSessionGap: 5,
        dataDirection: 'both',
        dataBitrate: { dl: { unit: 'mbps', value: 100 }, ul: { unit: 'mbps', value: 50 } },
        payloadLength: 1000, mtuSize: 1500,
      }],
    },
  };
}

function buildPowerCycle() {
  return { powerCycleConfig: { profiles: [{ subscriberGroup: [0], loopProfile: 'disable', attachType: 'bursty', attachRate: 1, attachDelay: 0, powerOnTime: 2000, powerOffTime: 10 }] } };
}

function caseId(spec: Spec): string {
  const ant = `${spec.antDl}x${spec.antUl}`;
  const slice = spec.networkSlicing === 'enable' ? '-slice' : '';
  return `${spec.rat}-${spec.bandwidth}mhz-${ant}-ue${spec.ueCount}-${spec.dataType}${slice}`;
}

function buildCase(spec: Spec): Case {
  const cells = buildCells(spec);
  const subscribers = buildSubs(spec);
  const userPlane = buildUserPlane(spec);
  const powerCycle = buildPowerCycle();
  const id = caseId(spec);
  const settings = { settings: { loggingProfileName: 'rrc_debug', successCriteriaName: 'BLER Success', testCaseName: id, test_name: id } };
  const input = {
    cellConfig: cells.cellConfig, subsConfig: subscribers.subsConfig,
    userPlaneConfig: userPlane.userPlaneConfig, powerCycleConfig: powerCycle.powerCycleConfig,
    settings: settings.settings,
  };
  const tags = [spec.rat, `${spec.antDl}x${spec.antUl}`, spec.dataType];
  if (spec.networkSlicing === 'enable') tags.push('networkSlicing');
  return { id, rat: spec.rat, description: id, cells, subscribers, userPlane, powerCycle, settings, input, tags };
}

// ---------- combinatorics ----------

/** Greedy all-pairs (pairwise) over labelled dimensions. */
function pairwise(dims: Record<string, any[]>): Array<Record<string, any>> {
  const keys = Object.keys(dims);
  if (keys.length === 0) return [];
  if (keys.length === 1) return dims[keys[0]].map((v) => ({ [keys[0]]: v }));

  // All uncovered value-pairs (i<j).
  const pairs: Array<{ ki: string; vi: any; kj: string; vj: any }> = [];
  for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++)
    for (const vi of dims[keys[i]]) for (const vj of dims[keys[j]])
      pairs.push({ ki: keys[i], vi, kj: keys[j], vj });

  const remaining = new Set(pairs.map((p) => `${p.ki}=${JSON.stringify(p.vi)}|${p.kj}=${JSON.stringify(p.vj)}`));
  const rows: Array<Record<string, any>> = [];
  let guard = 0;
  while (remaining.size > 0 && guard++ < 10_000) {
    const row: Record<string, any> = {};
    for (const k of keys) {
      // pick the value for k that covers the most still-uncovered pairs given row so far
      let best = dims[k][0]; let bestScore = -1;
      for (const v of dims[k]) {
        let score = 0;
        for (const ok of keys) {
          if (ok === k || !(ok in row)) continue;
          const a = `${k}=${JSON.stringify(v)}|${ok}=${JSON.stringify(row[ok])}`;
          const b = `${ok}=${JSON.stringify(row[ok])}|${k}=${JSON.stringify(v)}`;
          if (remaining.has(a) || remaining.has(b)) score++;
        }
        if (score > bestScore) { bestScore = score; best = v; }
      }
      row[k] = best;
    }
    // mark covered
    for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
      remaining.delete(`${keys[i]}=${JSON.stringify(row[keys[i]])}|${keys[j]}=${JSON.stringify(row[keys[j]])}`);
    }
    rows.push(row);
  }
  return rows;
}

function cartesian(dims: Record<string, any[]>): Array<Record<string, any>> {
  return Object.entries(dims).reduce<Array<Record<string, any>>>(
    (acc, [k, vals]) => acc.flatMap((row) => vals.map((v) => ({ ...row, [k]: v }))),
    [{}],
  );
}

export function generateMatrix(req: MatrixRequest): Case[] {
  const mode = req.mode ?? 'pairwise';
  const out: Case[] = [];
  for (const rat of req.rats) {
    if (rat !== 'lte' && rat !== 'nr-sa') continue; // P0 supports LTE + NR-SA
    const d = DEFAULTS[rat];
    const dims: Record<string, any[]> = {
      bandwidth: req.bandwidths ?? d.bandwidths,
      ant: (req.antennas ?? d.antennas).map((p) => p.join('x')),
      ueCount: req.ueCounts ?? d.ueCounts,
      dataType: req.dataTypes ?? [...d.dataTypes],
    };
    if (rat === 'nr-sa' && (req.featureFlags ?? []).includes('networkSlicing')) dims.networkSlicing = ['disable', 'enable'];
    const rows = (mode === 'full' ? cartesian : pairwise)(dims);
    for (const r of rows) {
      const [antDl, antUl] = String(r.ant).split('x').map(Number);
      out.push(buildCase({
        rat, bandwidth: Number(r.bandwidth), antDl, antUl,
        ueCount: Number(r.ueCount), dataType: r.dataType,
        networkSlicing: (r.networkSlicing as any) ?? 'disable',
      }));
    }
  }
  // Greedy pairwise can repeat a fully-covered row — dedup by case id so we
  // never execute (or collide artifact dirs for) the same config twice.
  const seen = new Set<string>();
  const uniq = out.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
  return req.cap ? uniq.slice(0, req.cap) : uniq;
}

export const _internals = { pairwise, cartesian, buildCase };

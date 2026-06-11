// Coverage matrix generator.
//
// Produces Case objects (each = box-valid /tests/* bodies + the flat input
// config the validator diffs against). Strategy = pairwise (all-pairs) across
// the chosen dimensions, with optional full-sweep (Cartesian) on dimensions
// marked critical. RF anchors (band + ARFCN) are fixed per RAT to known-good
// values so creates are always accepted; band sweeps land in a later phase
// once a vetted ARFCN table exists.

import type { Case, Rat } from './types';
import { BAND_TABLE, type BandRow, type BandRat } from './bandTable';

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
    // With protectionScheme 'null' there is NO public key — the hand-authored
    // on-box SA template + the bulk generator both omit `publicKey` and send
    // only publicKeyId. Sending a publicKey here is the same conditional-field
    // class as the old /op bug (accepted today, but the next to break if the
    // box tightens validation). Omit it.
    sub.publicKeyId = 0; sub.routingIndicator = 1111;
    sub.access_control_classes = []; sub.uac_access_identities = [];
  } else {
    sub.startingIMSI = 1010123456789; sub.nextIMSI = 1;
    // LTE/milenage requires a real 32-hex OP. NR-SA (xor) must OMIT op
    // entirely — the box validator flips the /op pattern based on the
    // value's presence ('^$' when non-empty, 32-hex when empty), so the
    // only state it accepts for SA is the field being absent. This
    // matches the real on-box SA-VONR-256 subscriber (op: undefined).
    sub.op = '000102030405060708090A0B0C0D0E0F';
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

// ---------- band sweep ----------
// One case per (rat, band) from the vetted master table, using its real
// ARFCN/SCS/duplex so creates are accepted. Body rules verified live:
//   • NR FDD: omit NRARFCN.ul (box derives it); NR TDD: ul = dl
//   • LTE/CATM: bandwidth clamped to {3,5,10,15,20}; FDD ul=dl+18000, TDD ul=dl
//   • NBIoT: ratType=nbiot, bandwidth "1.4"
//   • CATM = an LTE cell (CAT-M is a subscriber category, not a cell ratType)
const LTE_BW_OK = new Set([3, 5, 10, 15, 20]);
const mobObj = { antennaType: 'isotropic', position: [4, 3], referencePower: -25, ulAttenuation: 60 };

// NB-IoT deployment-mode variant (SIM40-2312). For NB-IoT the cell's cellType
// carries the deployment/operation mode (standalone / in-band) — the same
// contract the bulkTests generator and the apiTester
// nbiot-definition-completeness check use, and the field the configFidelity
// nbiotChecker reads.
type NbIotModeVariant = 'standalone' | 'in-band';

function bandCells(r: BandRow, nbMode?: NbIotModeVariant) {
  if (r.rat === 'NR') {
    const NRARFCN: any = r.duplex === 'TDD'
      ? { dl: r.dlArfcn, ssb: r.ssbArfcn, ul: r.dlArfcn }
      : { dl: r.dlArfcn, ssb: r.ssbArfcn };
    // n79 @ SCS 30 requires bandwidth ≥ 20 MHz (box rejects 15) — clamp up.
    const nrBw = r.band === 79 && r.bwMhz < 20 ? 20 : r.bwMhz;
    const cell: any = {
      cellType: '5g', syncId: 0, duplexMode: r.duplex, band: `n${r.band}`, NRARFCN,
      scs: r.scsKhz, ssbScs: r.ssbScsKhz, bandwidth: String(nrBw),
      // Some NR bands (n5/n8/n25/n50/n66/n70/n71) REQUIRE an explicit bandwidthType;
      // the rest default it. Always send 'symmetric' (DL bw = UL bw) for consistency.
      bandwidthType: 'symmetric', prach: 0,
      antennas: { dl: 1, ul: 1 }, rfCard: 0, rxToTxLatency: 4, txGain: [80], rxGain: [0],
      globalTimingAdvance: -1, NTN: false, mobility: mobObj,
    };
    return { cellConfig: { master: { product: 'UE-SIM', ratType: 'sa', carrierAggregation: false, channelSim: false, pdcchDecodeOpt: true, pdcchDecodeOptThreshold: 0.1, ldpcIteration: 12 }, cells: [cell] } };
  }
  // LTE / CATM / NBIOT → 4g cell
  const isNb = r.rat === 'NBIOT';
  const bw = isNb ? '1.4' : String(LTE_BW_OK.has(r.bwMhz) ? r.bwMhz : 5);
  // LTE band 66 has a non-standard UL plan: the box accepts only UL EARFCN 131972
  // (the band-66 UL base), not dl+18000. Override UL for that band (LTE/CATM/NB-IoT).
  const ul = String(r.band) === '66' ? 131972 : (r.duplex === 'FDD' ? r.dlArfcn + 18000 : r.dlArfcn);
  const ratType = isNb ? 'nbiot' : 'smartphone';
  const cell: any = {
    // Mode variants carry the deployment mode in cellType; plain sweep rows
    // keep the legacy mode-less '4g' (box-accepted) cellType.
    cellType: isNb && nbMode ? nbMode : '4g', syncId: 0, duplexMode: r.duplex, band: String(r.band), EARFCN: { dl: r.dlArfcn, ul },
    bandwidth: bw, prach: 0, antennas: { dl: 1, ul: 1 }, rfCard: 0, rxToTxLatency: 4, txGain: [70], rxGain: [0],
    globalTimingAdvance: -1, mobility: mobObj,
  };
  return { cellConfig: { master: { product: 'UE-SIM', ratType, carrierAggregation: false, channelSim: false, pdcchDecodeOpt: true, pdcchDecodeOptThreshold: 0.1, turboIteration: 14 }, cells: [cell] } };
}

function bandNbiotSubs() {
  return { subsConfig: { subs: [{
    ueCount: 1, servingCell: 0, startingIMSI: 1010123456789, nextIMSI: 1,
    algorithm: 'milenage', sharedKey: '00112233445566778899aabbccddeeff', op: '000102030405060708090A0B0C0D0E0F',
    resLength: 8, securityContext: true, asRelease: 13, redCap: false,
    ueCategoryType: 'combined', ueCategory: 'nb1', multiTone: true, multiCarrier: true, twoHarq: false,
    attachType: 'normal', ueInitiatedEvents: 'rrc', eventsInLoop: false, triggerTime: [10],
    pdnType: 'ipv4', defaultApn: '', preambleIndex: 0, CIOTOpt: true, halfDuplex: true,
    cipherAlgorithm: ['eea0', 'eea1', 'eea2'], integrityAlgorithm: ['eia0', 'eia1', 'eia2'], cqi: 'auto', ri: 'auto', pmi: 'auto',
  }] } };
}

const RAT_LABEL: Record<BandRat, Rat> = { NR: 'nr-sa', LTE: 'lte', CATM: 'catm', NBIOT: 'nbiot' };

function bandCase(r: BandRow, dataType: 'no_data' | 'udp' | 'tcp', nbMode?: NbIotModeVariant): Case {
  const cells = bandCells(r, nbMode);
  // NB-IoT carries no iperf data plane in this sweep.
  const dt = r.rat === 'NBIOT' ? 'no_data' : dataType;
  const subscribers = r.rat === 'NR'
    ? buildSubs({ rat: 'nr-sa', ueCount: 1, networkSlicing: 'disable' } as Spec)
    : r.rat === 'NBIOT'
      ? bandNbiotSubs()
      : buildSubs({ rat: 'lte', ueCount: 1, networkSlicing: 'disable' } as Spec);
  const userPlane = buildUserPlane({ dataType: dt } as Spec);
  const powerCycle = buildPowerCycle();
  // Test-case names allow only [A-Za-z0-9_-]; bandwidths like 1.4/0.2 have a
  // dot, so encode it as 'p' (1.4 -> 1p4mhz) to keep the name valid. Mode
  // variants likewise drop the dash ('in-band' -> '-inband' suffix).
  const modeSuffix = nbMode ? `-${nbMode.replace(/-/g, '')}` : '';
  const id = `band-${r.rat.toLowerCase()}-b${r.band}-${r.duplex.toLowerCase()}-${String(r.bwMhz).replace('.', 'p')}mhz${modeSuffix}`;
  const settings = { settings: { loggingProfileName: 'rrc_debug', successCriteriaName: 'BLER Success', testCaseName: id, test_name: id } };
  const input = { cellConfig: cells.cellConfig, subsConfig: subscribers.subsConfig, userPlaneConfig: userPlane.userPlaneConfig, powerCycleConfig: powerCycle.powerCycleConfig, settings: settings.settings };
  const tags = [RAT_LABEL[r.rat], `band${r.band}`, r.duplex.toLowerCase(), 'band-sweep'];
  if (nbMode) tags.push(nbMode);
  return { id, rat: RAT_LABEL[r.rat], description: `${r.rat} band ${r.band} ${r.duplex} ${r.bwMhz}MHz${nbMode ? ` ${nbMode}` : ''}`, cells, subscribers, userPlane, powerCycle, settings, input, tags };
}

export interface BandSweepRequest { rats?: BandRat[]; dataType?: 'no_data' | 'udp' | 'tcp'; cap?: number }

/** One test case per band in the vetted master table. */
export function generateBandSweep(req: BandSweepRequest = {}): Case[] {
  const want = new Set(req.rats ?? ['NR', 'LTE', 'CATM', 'NBIOT']);
  const dt = req.dataType ?? 'no_data';
  const rows = BAND_TABLE.filter((r) => want.has(r.rat));
  const out = rows.map((r) => bandCase(r, dt));
  // NB-IoT deployment-mode variants (SIM40-2312): the plain sweep rows keep
  // the legacy mode-less '4g' cellType, so the nbiotChecker's deployment-mode
  // check never engages on them. Emit explicit standalone + in-band variants
  // for the first NB-IoT band (ids suffixed -standalone / -inband) so the
  // check has real cases to bite on.
  const nb = rows.find((r) => r.rat === 'NBIOT');
  if (nb) for (const m of ['standalone', 'in-band'] as const) out.push(bandCase(nb, dt, m));
  return req.cap ? out.slice(0, req.cap) : out;
}

export const _internals = { pairwise, cartesian, buildCase };

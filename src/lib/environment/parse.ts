// Parse an uploaded GOLD-config JSON into an Environment.
//
// The uploaded JSON can be one of FOUR shapes — detected structurally,
// never by filename:
//   (a) export pack          { testCases | testcases: [ { testDefinition } ] }
//   (b) GET /v2/testcases/id  { id, name, testDefinition }
//   (c) bare testDefinition   { cellConfig, subsConfig, userPlaneConfig, … }
//   (d) Amarisoft sim config  { Config_File: { config: { cell_groups,
//          global_traffic, ue_list, tx_gain, rx_gain } }, Test_Name }
//       — the raw radio config a customer site actually runs. Same site
//       facts, different layout: cells live in cell_groups[].cells[] (snake
//       case: dl_nr_arfcn / n_antenna_dl / rf_port), the SIM range is read
//       off ue_list[] (imsi/K/sim_algo), and traffic is global_traffic
//       (iperf[] / volte[]) referenced per-UE. Handled by a dedicated
//       extractor (extractFromAmarisoftConfig), not the testDefinition path.
//
// And within a testDefinition, the box uses TWO field layouts (confirmed
// live on 192.168.1.95):
//   FLAT   cells[].band,  cells[].NRARFCN,  subs[].sharedKey, subs[].startingSUPI
//   NESTED cells[].cellConfig.band, cells[].cellRadioInfo.NRARFCN,
//          subs[].subscriberAuthSecurity.sharedKey,
//          subs[].subscriberProfileInfo.startingSUPI
// Every field below is read with `pick(obj, nestedPath, flatPath)` so both
// shapes parse. Generation always EMITS the flat write-side shape.

import type {
  Environment, EnvironmentCell, EnvironmentSite, EnvironmentDefaults, EnvironmentWarning,
  GoldTrafficProfile,
} from './types';

/** Safe dotted-path getter — returns undefined on any missing hop. */
function get(obj: any, dotted: string): any {
  if (obj == null) return undefined;
  let cur = obj;
  for (const key of dotted.split('.')) {
    if (cur == null) return undefined;
    cur = cur[key];
  }
  return cur;
}

/** Try a list of paths in order; first non-nullish wins. */
function pick(obj: any, ...paths: string[]): any {
  for (const p of paths) {
    const v = get(obj, p);
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

function toNum(v: any): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export interface ParseResult {
  site: EnvironmentSite;
  defaults: EnvironmentDefaults;
  warnings: EnvironmentWarning[];
  /** Name lifted from the source (testcase name) if available. */
  suggestedName?: string;
}

export class EnvironmentParseError extends Error {}

/** Step 1 — normalize any of the 3 upload shapes to a single testDefinition
 *  + a suggested name. Throws EnvironmentParseError if none match. */
export function normalizeToTestDefinition(json: any): { testDefinition: any; suggestedName?: string; multiWarning?: string } {
  if (json == null || typeof json !== 'object') {
    throw new EnvironmentParseError('upload is not a JSON object — expected a testcase export, a GET /v2/testcases/<id> response, or a bare testDefinition');
  }

  // (a) export pack — testCases | testcases is a non-empty array
  const pack = Array.isArray(json.testCases) ? json.testCases
             : Array.isArray(json.testcases) ? json.testcases
             : null;
  if (pack) {
    if (pack.length === 0) throw new EnvironmentParseError('export pack has an empty testcases array');
    const first = pack[0];
    const td = first?.testDefinition ?? first;
    if (!td?.cellConfig) throw new EnvironmentParseError('first testcase in the export pack has no cellConfig');
    return {
      testDefinition: td,
      suggestedName: first?.name ?? first?.Test_Name,
      multiWarning: pack.length > 1 ? `export pack had ${pack.length} testcases; extracted the first ("${first?.name ?? '?'}")` : undefined,
    };
  }

  // (b) GET /v2/testcases/<id> response — testDefinition object + id/name
  if (json.testDefinition && typeof json.testDefinition === 'object' && (json.id || json.name)) {
    if (!json.testDefinition.cellConfig) throw new EnvironmentParseError('testDefinition has no cellConfig');
    return { testDefinition: json.testDefinition, suggestedName: json.name };
  }

  // (c) bare testDefinition — cellConfig present at top level
  if (json.cellConfig) {
    return { testDefinition: json, suggestedName: json?.settings?.test_name };
  }

  throw new EnvironmentParseError(
    'unrecognized JSON shape — looked for `testCases`/`testcases` array, a `testDefinition` object, or a top-level `cellConfig`. ' +
    'If this is a ue.cfg (radio config), use the Config Fidelity flow instead — this tab wants a testcase JSON.',
  );
}

/** Step 2-7 — extract Environment from a normalized testDefinition. */
export function extractFromTestDefinition(td: any, suggestedName?: string): ParseResult {
  const warnings: EnvironmentWarning[] = [];
  const warn = (field: string, reason: string) => warnings.push({ field, reason });

  const cellsRaw: any[] = pick(td, 'cellConfig.cells') ?? [];
  if (!Array.isArray(cellsRaw) || cellsRaw.length === 0) {
    throw new EnvironmentParseError('cellConfig.cells is empty — cannot build an Environment without at least one cell');
  }
  const subsRaw: any[] = pick(td, 'subsConfig.subs') ?? [];
  const sub0 = subsRaw[0] ?? {};
  const profiles: any[] = pick(td, 'userPlaneConfig.profiles') ?? [];

  // ── RAT inference ────────────────────────────────────────────────────
  const masterRat: string = pick(td, 'cellConfig.master.ratType') ?? '';
  const anyNtn = cellsRaw.some(c => pick(c, 'cellConfig.NTN', 'NTN') === true);
  let rat: EnvironmentSite['rat'];
  if (masterRat === 'nsa') rat = 'NR-NSA';
  else if (masterRat === 'nbiot') rat = 'NB-IoT';
  else if (masterRat === 'sa') rat = anyNtn ? 'NTN' : 'NR-SA';
  else {
    // 'smartphone' / 'multirat' / unknown — infer from cell types.
    const types = cellsRaw.map(c => pick(c, 'cellConfig.cellType', 'cellType'));
    rat = types.every(t => t === '4g') ? 'LTE' : (anyNtn ? 'NTN' : 'NR-SA');
    if (!masterRat) warn('cellConfig.master.ratType', `absent — inferred ${rat} from cell types`);
  }

  // ── Cells ────────────────────────────────────────────────────────────
  const cells: EnvironmentCell[] = cellsRaw.map((c, i) => {
    const cellType: '4g' | '5g' = (pick(c, 'cellConfig.cellType', 'cellType') as '4g' | '5g')
      ?? (pick(c, 'cellRadioInfo.NRARFCN', 'NRARFCN') ? '5g' : '4g');
    const band = pick(c, 'cellConfig.band', 'band');
    if (band === undefined) warn(`cells[${i}].band`, 'absent — band is core RF identity, generation may fail');
    const duplexMode = (pick(c, 'cellConfig.duplexMode', 'duplexMode') as 'FDD' | 'TDD')
      ?? (cellType === '5g' ? 'TDD' : 'FDD');
    const bandwidthMhz = toNum(pick(c, 'cellBandwidthInfo.bandwidth', 'cellConfig.bandwidth', 'bandwidth'));

    const earfcnDl = toNum(pick(c, 'cellRadioInfo.EARFCN.dl', 'EARFCN.dl'));
    const earfcnUl = toNum(pick(c, 'cellRadioInfo.EARFCN.ul', 'EARFCN.ul'));
    const nrDl = toNum(pick(c, 'cellRadioInfo.NRARFCN.dl', 'NRARFCN.dl'));
    const nrSsb = toNum(pick(c, 'cellRadioInfo.NRARFCN.ssb', 'NRARFCN.ssb'));

    const antDl = toNum(pick(c, 'cellRadioInfo.antennas.dl', 'antennas.dl')) ?? (cellType === '5g' ? 2 : 2);
    const antUl = toNum(pick(c, 'cellRadioInfo.antennas.ul', 'antennas.ul')) ?? 1;

    const rfCard = toNum(pick(c, 'cellRadioInfo.rfInfo.rfCard', 'rfCard')) ?? i * 2;
    if (pick(c, 'cellRadioInfo.rfInfo.rfCard', 'rfCard') === undefined) {
      warn(`cells[${i}].rfCard`, `absent — defaulted to ${i * 2} (box requires one card per cell)`);
    }

    const txGain = pick(c, 'cellCarrierConfig.gainInfo.txGain', 'txGain') ?? Array(antUl).fill(cellType === '5g' ? 80 : 70);
    const rxGain = pick(c, 'cellCarrierConfig.gainInfo.rxGain', 'rxGain') ?? Array(antDl).fill(cellType === '5g' ? 20 : 0);

    const scs = toNum(pick(c, 'cellCarrierConfig.ScsInfo.scs', 'scs'));
    const ssbScs = toNum(pick(c, 'cellCarrierConfig.ScsInfo.ssbScs', 'ssbScs'));
    const rxToTxLatency = toNum(pick(c, 'cellRadioInfo.rxToTxLatency', 'rxToTxLatency', 'cellFreqDelay.rxToTxLatency'));

    const cell: EnvironmentCell = {
      cellType, band: String(band ?? ''), duplexMode, bandwidthMhz,
      antennas: { dl: antDl, ul: antUl }, rfCard,
      txGain: Array.isArray(txGain) ? txGain : [txGain],
      rxGain: Array.isArray(rxGain) ? rxGain : [rxGain],
      ntn: pick(c, 'cellConfig.NTN', 'NTN') === true || undefined,
    };
    if (cellType === '5g') {
      if (nrDl !== undefined) cell.nrarfcn = { dl: nrDl, ssb: nrSsb ?? nrDl };
      if (scs !== undefined) cell.scs = scs;
      if (ssbScs !== undefined) cell.ssbScs = ssbScs;
    } else if (earfcnDl !== undefined) {
      cell.earfcn = { dl: earfcnDl, ul: earfcnUl };
    }
    if (rxToTxLatency !== undefined) cell.rxToTxLatency = rxToTxLatency;
    return cell;
  });

  // ── SIM identity ─────────────────────────────────────────────────────
  const imsiStart = toNum(pick(sub0, 'subscriberProfileInfo.startingSUPI', 'startingSUPI',
                                     'subscriberProfileInfo.startingIMSI', 'startingIMSI'));
  if (imsiStart === undefined) warn('subs[0].startingIMSI/startingSUPI', 'absent — SIM range is core site data');
  const imsiStride = toNum(pick(sub0, 'subscriberProfileInfo.nextSUPI', 'nextSUPI',
                                       'subscriberProfileInfo.nextIMSI', 'nextIMSI')) ?? 1;
  const algorithm = pick(sub0, 'subscriberProfileInfo.algorithm', 'algorithm')
    ?? (rat === 'LTE' || rat === 'NB-IoT' ? 'milenage' : 'xor');
  const sharedKey = pick(sub0, 'subscriberAuthSecurity.sharedKey', 'subscriberNetworkConfig.sharedKey', 'sharedKey');
  if (sharedKey === undefined) warn('subs[0].sharedKey', 'absent — Ki is a mandatory site secret');
  const op = pick(sub0, 'subscriberNetworkConfig.op', 'subscriberNetworkConfig.OP', 'op');
  const opc = pick(sub0, 'subscriberNetworkConfig.opc', 'subscriberNetworkConfig.OPc', 'opc');
  const incrementSharedKey = toNum(pick(sub0, 'subscriberNetworkConfig.incrementSharedKey', 'incrementSharedKey')) ?? 0;
  const plmnRaw = pick(sub0, 'subscriberNetworkPreferences.preferredPLMN', 'preferredPLMN');
  const plmn = Array.isArray(plmnRaw) ? plmnRaw.filter(Boolean) : undefined;
  const mncDigits = toNum(pick(sub0, 'csiInfo.mncDigits', 'subscriberNetworkConfig.mncDigits', 'mncDigits'));
  const voNRSupport = pick(sub0, 'VoNRSupport') === true || undefined;

  // ── Service endpoints ────────────────────────────────────────────────
  const iperfProfile = profiles.find(p => {
    const dt = pick(p, 'dataGeneralInfo.dataType', 'dataType');
    return dt === 'iperf';
  });
  const iperfServerIp = iperfProfile ? pick(iperfProfile, 'dataGeneralInfo.serverIpAddress', 'serverIpAddress') : undefined;
  const voiceProfile = profiles.find(p => {
    const dt = pick(p, 'dataGeneralInfo.dataType', 'dataType');
    return dt === 'volte' || dt === 'vonr';
  });
  const pcscfIp = voiceProfile ? pick(voiceProfile, 'dataNetworkConfig.pcscfIpAddress', 'pcscfIpAddress') : undefined;
  const imsRealm = voiceProfile ? pick(voiceProfile, 'dataNetworkConfig.realm', 'realm') : undefined;

  // Capture the FULL traffic profile set so "as-GOLD" auto-create can
  // replay the customer's exact concurrent mix (e.g. UDP+TCP+VoNR on the
  // same UEs).
  const trafficProfiles = profiles.map(p => {
    const dataType = pick(p, 'dataGeneralInfo.dataType', 'dataType') ?? 'no_data';
    const sgRaw = pick(p, 'subscriberGroup');
    const subscriberGroup = Array.isArray(sgRaw) ? sgRaw : (sgRaw !== undefined ? [sgRaw] : [0]);
    return {
      dataType,
      subscriberGroup,
      direction: pick(p, 'dataSessionConfig.dataDirection', 'dataDirection') ?? undefined,
      protocol: pick(p, 'dataSessionConfig.transportProtocol', 'transportProtocol') ?? undefined,
      codec: pick(p, 'codec') ?? undefined,
    };
  }).filter(p => p.dataType);

  const site: EnvironmentSite = {
    rat, cells,
    imsiStart: imsiStart ?? 0,
    imsiStride,
    algorithm,
    sharedKey: sharedKey ?? '',
    op, opc, incrementSharedKey,
    plmn, mncDigits, voNRSupport,
    iperfServerIp, pcscfIp, imsRealm,
    trafficProfiles: trafficProfiles.length ? trafficProfiles : undefined,
  };

  // ── Scenario defaults (seeded from GOLD) ─────────────────────────────
  const profile0 = profiles[0];
  const dt0 = profile0 ? pick(profile0, 'dataGeneralInfo.dataType', 'dataType') : undefined;
  const dir0 = profile0 ? pick(profile0, 'dataSessionConfig.dataDirection', 'dataDirection') : undefined;
  let dataType: string | undefined = dt0;
  if (dt0 === 'iperf' && dir0) dataType = dir0 === 'downlink' ? 'iperf-dl' : dir0 === 'uplink' ? 'iperf-ul' : 'iperf-both';

  const mob0 = pick(td, 'mobilityConfig.profiles.0');
  const defaults: EnvironmentDefaults = {
    bandwidths: Array.from(new Set(cells.map(c => c.bandwidthMhz).filter((b): b is number => b !== undefined))),
    ueCount: toNum(pick(sub0, 'subscriberProfileInfo.ueCount', 'ueCount')) ?? 1,
    antennas: cells[0]?.antennas,
    dataType: dataType ?? 'iperf-both',
    mobility: pick(mob0, 'mobilityTrip.tripType', 'tripType') ?? 'stationary',
    fading: pick(mob0, 'mobilityChannel.fadingProfile.fadingType', 'fadingProfile.fadingType', 'fadingType') ?? 'awgn',
    loggingProfileName: pick(td, 'settings.loggingProfileName') ?? 'debug',
    successCriteriaName: pick(td, 'settings.successCriteriaName') ?? 'BLER Success',
  };

  return { site, defaults, warnings, suggestedName };
}

// ── (d) Amarisoft simulator config ─────────────────────────────────────

/** Detect the Amarisoft radio-config shape and return its `config` object +
 *  a suggested name. Returns null for any non-Amarisoft input so the caller
 *  falls through to the testDefinition path. The discriminator is
 *  `cell_groups` + `ue_list` (snake_case) — never present in a box
 *  testDefinition, which uses cellConfig/subsConfig. */
function extractAmarisoftConfigObject(json: any): { config: any; name?: string } | null {
  if (json == null || typeof json !== 'object') return null;
  const looksLikeConfig = (c: any) => c && typeof c === 'object' && Array.isArray(c.cell_groups) && Array.isArray(c.ue_list);
  // Simnovator-exported testcase envelope: { Config_File: { config }, Test_Name }
  if (looksLikeConfig(json?.Config_File?.config)) return { config: json.Config_File.config, name: json.Test_Name ?? json.Test_name ?? json.name };
  // bare config wrapper: { config: { … } }
  if (looksLikeConfig(json?.config)) return { config: json.config, name: json.Test_Name ?? json.name };
  // raw config at top level
  if (looksLikeConfig(json)) return { config: json, name: json.Test_Name ?? json.name };
  return null;
}

/** NR FR1 bands that are FDD (everything else NR → TDD). LTE TDD bands are
 *  38-44; LTE → FDD otherwise. Amarisoft config doesn't state duplexMode, so
 *  we infer it from the band and warn. */
const NR_FDD_BANDS = new Set([1, 2, 3, 5, 7, 8, 12, 13, 14, 18, 20, 25, 26, 28, 66, 70, 71, 74]);
const LTE_TDD_BANDS = new Set([33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 48]);

function inferDuplex(cellType: '4g' | '5g', bandNum: number): 'FDD' | 'TDD' {
  if (cellType === '5g') return NR_FDD_BANDS.has(bandNum) ? 'FDD' : 'TDD';
  return LTE_TDD_BANDS.has(bandNum) ? 'TDD' : 'FDD';
}

/** Normalize an Amarisoft voice codec string ("AMR-WB/16000/1") to the box's
 *  codec enum ("AMR-WB"). */
function normCodec(c: any): string {
  const s = String(c ?? '').toUpperCase();
  if (s.includes('EVS')) return 'EVS';
  if (s.includes('AMR-WB') || s.includes('WB')) return 'AMR-WB';
  if (s.startsWith('AMR')) return 'AMR-NB';
  return 'AMR-WB';
}

/** Extract an Environment from an Amarisoft `config` object. Produces the
 *  same ParseResult the testDefinition path returns. */
export function extractFromAmarisoftConfig(config: any, suggestedName?: string): ParseResult {
  const warnings: EnvironmentWarning[] = [];
  const warn = (field: string, reason: string) => warnings.push({ field, reason });

  const groups: any[] = Array.isArray(config.cell_groups) ? config.cell_groups : [];
  if (groups.length === 0) throw new EnvironmentParseError('Amarisoft config has no cell_groups — cannot build an Environment');
  const ueList: any[] = Array.isArray(config.ue_list) ? config.ue_list : [];
  if (ueList.length === 0) throw new EnvironmentParseError('Amarisoft config has an empty ue_list — no SIM identities to extract');

  // ── RAT inference from group_type ──────────────────────────────────────
  const groupTypes = groups.map(g => String(g?.group_type ?? '').toLowerCase());
  let rat: EnvironmentSite['rat'];
  if (groupTypes.includes('nr') && (groupTypes.includes('lte') || groupTypes.includes('eutra'))) rat = 'NR-NSA';
  else if (groupTypes.some(t => t === 'nbiot' || t === 'nb-iot')) rat = 'NB-IoT';
  else if (groupTypes.length > 0 && groupTypes.every(t => t === 'lte' || t === 'eutra')) rat = 'LTE';
  else rat = 'NR-SA';

  // Config-global gain arrays (Amarisoft keeps these at config level, not
  // per cell). Assigned to each cell; warned for multi-cell plans.
  const txGainGlobal: number[] = Array.isArray(config.tx_gain) ? config.tx_gain : [];
  const rxGainGlobal: number[] = Array.isArray(config.rx_gain) ? config.rx_gain : [];

  // ── Cells (flatten cell_groups[].cells[] in order) ─────────────────────
  const cells: EnvironmentCell[] = [];
  let anyNtn = false;
  groups.forEach((g) => {
    const gt = String(g?.group_type ?? '').toLowerCase();
    const cellType: '4g' | '5g' = gt === 'nr' ? '5g' : '4g';
    const cellArr: any[] = Array.isArray(g?.cells) ? g.cells : [];
    cellArr.forEach((c) => {
      const i = cells.length;
      const bandNum = toNum(c?.band);
      if (bandNum === undefined) warn(`cell_groups cell[${i}].band`, 'absent — band is core RF identity');
      const band = cellType === '5g' ? `n${bandNum ?? ''}` : String(bandNum ?? '');
      const duplexMode = inferDuplex(cellType, bandNum ?? -1);
      const ntn = c?.ntn === true;
      if (ntn) anyNtn = true;

      const antDl = toNum(c?.n_antenna_dl) ?? 2;
      const antUl = toNum(c?.n_antenna_ul) ?? 1;
      const rfCard = toNum(c?.rf_port) ?? i * 2;

      const cell: EnvironmentCell = {
        cellType, band, duplexMode,
        bandwidthMhz: toNum(c?.bandwidth),
        antennas: { dl: antDl, ul: antUl },
        rfCard,
        txGain: txGainGlobal.length ? txGainGlobal : Array(antUl).fill(cellType === '5g' ? 80 : 70),
        rxGain: rxGainGlobal.length ? rxGainGlobal : Array(antDl).fill(cellType === '5g' ? 20 : 0),
        ntn: ntn || undefined,
      };
      if (cellType === '5g') {
        const dl = toNum(c?.dl_nr_arfcn);
        const ssb = toNum(c?.ssb_nr_arfcn);
        if (dl !== undefined) cell.nrarfcn = { dl, ssb: ssb ?? dl };
        const scs = toNum(c?.subcarrier_spacing);
        if (scs !== undefined) { cell.scs = scs; cell.ssbScs = toNum(c?.ssb_subcarrier_spacing) ?? scs; }
      } else {
        const dl = toNum(c?.dl_earfcn);
        const ul = toNum(c?.ul_earfcn);
        if (dl !== undefined) cell.earfcn = { dl, ul };
      }
      cells.push(cell);
    });
  });
  if (cells.length === 0) throw new EnvironmentParseError('Amarisoft config has cell_groups but no cells inside them');
  if (cells.length > 1 && (txGainGlobal.length || rxGainGlobal.length)) {
    warn('tx_gain/rx_gain', 'Amarisoft keeps gains config-global; assigned the full arrays to every cell');
  }
  if (anyNtn) rat = rat === 'NR-SA' ? 'NTN' : rat;
  warn('duplexMode', `not stated in Amarisoft config — inferred per band (${cells.map(c => `${c.band}=${c.duplexMode}`).join(', ')})`);

  // ── SIM identity from ue_list ──────────────────────────────────────────
  const u0 = ueList[0] ?? {};
  const u1 = ueList[1];
  const imsi0 = u0.imsi !== undefined && u0.imsi !== null ? String(u0.imsi) : '';
  const supi0 = u0.supi !== undefined && u0.supi !== null ? String(u0.supi) : '';
  const idStr0 = imsi0 || supi0;
  const imsiStart = toNum(idStr0);
  if (imsiStart === undefined) warn('ue_list[0].imsi', 'absent/unparseable — SIM range is core site data');
  const id1 = u1 ? toNum(u1.imsi ?? u1.supi) : undefined;
  const imsiStride = (id1 !== undefined && imsiStart !== undefined && id1 - imsiStart !== 0) ? (id1 - imsiStart) : 1;
  const algorithm = u0.sim_algo ?? (rat === 'LTE' || rat === 'NB-IoT' ? 'milenage' : 'xor');
  const sharedKey = u0.K ?? u0.k ?? '';
  if (!sharedKey) warn('ue_list[0].K', 'absent — Ki is a mandatory site secret');
  const op = u0.op ?? u0.OP ?? undefined;
  const opc = u0.opc ?? u0.OPc ?? undefined;
  const mncDigits = toNum(u0.mnc_nb_digits) ?? 2;
  // PLMN is embedded in the IMSI (mcc=first 3, mnc=next mncDigits digits).
  let plmn: string[] | undefined;
  if (idStr0.length >= 3 + mncDigits) {
    const mcc = idStr0.slice(0, 3);
    const mnc = idStr0.slice(3, 3 + mncDigits);
    plmn = [`${mcc}-${mnc}`];
  }
  const voNRSupport = ueList.some(u => u?.nr_voice_support === true) || undefined;

  // ── Traffic + service endpoints from global_traffic ────────────────────
  const gt = config.global_traffic ?? {};
  // Each entry is a single-key wrapper: { iperf1: {…} } / { volte0: {…} }.
  const unwrap = (arr: any): any[] => (Array.isArray(arr) ? arr.map(o => (o && typeof o === 'object' ? Object.values(o)[0] : o)).filter(Boolean) : []);
  const iperfDefs = unwrap(gt.iperf);
  const volteDefs = unwrap(gt.volte ?? gt.vonr);
  const pingDefs = unwrap(gt.ping);
  const iperfServerIp = iperfDefs[0]?.dest_ip ?? iperfDefs[0]?.server_ip ?? undefined;
  const pcscfIp = volteDefs[0]?.pcscf_ip ?? undefined;
  const imsRealm = volteDefs[0]?.realm ?? undefined;

  // In Amarisoft, traffic profiles are bound per-UE via ue_list[].traffic[];
  // when every UE references the same profiles they run concurrently on all
  // subscribers → modeled as subscriberGroup [-1]. The "as-GOLD" auto-create
  // mode replays this exact concurrent mix.
  const trafficProfiles: GoldTrafficProfile[] = [];
  for (const ip of iperfDefs) {
    const dl = toNum(ip?.bitrate_dl);
    const ul = toNum(ip?.bitrate_ul);
    const direction = (dl && ul) ? 'both' : ul ? 'uplink' : dl ? 'downlink' : 'both';
    trafficProfiles.push({ dataType: 'iperf', subscriberGroup: [-1], direction, protocol: String(ip?.type ?? 'udp').toLowerCase() === 'tcp' ? 'tcp' : 'udp' });
  }
  for (const vd of volteDefs) {
    trafficProfiles.push({ dataType: voNRSupport ? 'vonr' : 'volte', subscriberGroup: [-1], codec: normCodec(vd?.codec) });
  }
  for (const _ of pingDefs) {
    trafficProfiles.push({ dataType: 'ping', subscriberGroup: [-1] });
  }

  const site: EnvironmentSite = {
    rat, cells,
    imsiStart: imsiStart ?? 0,
    imsiStride,
    algorithm,
    sharedKey: sharedKey ?? '',
    op, opc,
    incrementSharedKey: 0,
    plmn, mncDigits, voNRSupport,
    iperfServerIp, pcscfIp, imsRealm,
    trafficProfiles: trafficProfiles.length ? trafficProfiles : undefined,
  };

  // ── Scenario defaults ──────────────────────────────────────────────────
  const firstIperf = trafficProfiles.find(p => p.dataType === 'iperf');
  let dataType = 'iperf-both';
  if (firstIperf) dataType = firstIperf.direction === 'downlink' ? 'iperf-dl' : firstIperf.direction === 'uplink' ? 'iperf-ul' : 'iperf-both';
  else if (trafficProfiles.some(p => p.dataType === 'vonr' || p.dataType === 'volte')) dataType = 'volte';

  const channelSim = groups.some(g => g?.channel_sim === true);
  const defaults: EnvironmentDefaults = {
    bandwidths: Array.from(new Set(cells.map(c => c.bandwidthMhz).filter((b): b is number => b !== undefined))),
    ueCount: ueList.length,
    antennas: cells[0]?.antennas,
    dataType,
    mobility: 'stationary',
    fading: channelSim ? 'epa5' : 'awgn',
    loggingProfileName: 'debug',
    successCriteriaName: 'BLER Success',
  };

  return { site, defaults, warnings, suggestedName };
}

/** Top-level entrypoint: parse any upload into a (not-yet-persisted)
 *  Environment draft. The caller assigns id/createdAt + saves. */
export function parseEnvironmentUpload(json: any, sourceFilename: string): Omit<Environment, 'id' | 'createdAt' | 'updatedAt'> {
  // (d) Amarisoft simulator config — checked first (distinct discriminator).
  const amari = extractAmarisoftConfigObject(json);
  if (amari) {
    const { site, defaults, warnings, suggestedName } = extractFromAmarisoftConfig(amari.config, amari.name);
    const name = (suggestedName ?? sourceFilename.replace(/\.[^.]+$/, '')) || 'Environment';
    return {
      name,
      sourceFilename,
      site,
      defaults,
      extractionWarnings: warnings.length ? warnings : undefined,
    };
  }

  const { testDefinition, suggestedName, multiWarning } = normalizeToTestDefinition(json);
  const { site, defaults, warnings, suggestedName: tdName } = extractFromTestDefinition(testDefinition, suggestedName);
  if (multiWarning) warnings.unshift({ field: 'testCases', reason: multiWarning });
  const name = (suggestedName ?? tdName ?? sourceFilename.replace(/\.[^.]+$/, '')) || 'Environment';
  return {
    name,
    sourceFilename,
    site,
    defaults,
    extractionWarnings: warnings.length ? warnings : undefined,
  };
}

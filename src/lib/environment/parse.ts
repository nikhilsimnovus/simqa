// Parse an uploaded GOLD-config JSON into an Environment.
//
// The uploaded JSON can be one of THREE shapes — detected structurally,
// never by filename:
//   (a) export pack          { testCases | testcases: [ { testDefinition } ] }
//   (b) GET /v2/testcases/id  { id, name, testDefinition }
//   (c) bare testDefinition   { cellConfig, subsConfig, userPlaneConfig, … }
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

/** Top-level entrypoint: parse any upload into a (not-yet-persisted)
 *  Environment draft. The caller assigns id/createdAt + saves. */
export function parseEnvironmentUpload(json: any, sourceFilename: string): Omit<Environment, 'id' | 'createdAt' | 'updatedAt'> {
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

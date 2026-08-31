// Environment-driven auto-create generator.
//
// Given a GOLD-config Environment (extracted SITE facts) + an AutoCreate
// matrix (SCENARIO toggles), this cross-products the selections into
// testcase variants and POSTs each through the box's 6-step create-
// lifecycle (cells → subscribers → user-plane → power-cycle → mobility →
// settings). Every body emits the FLAT write-side schema the box accepts.
//
// All field recipes are confirmed against live testcases on 192.168.1.95:
//   carrier aggregation = 3CC-16HRS · multi-cell = CS-2CC-64-UDP
//   handover = CS-2cell-64-HO-UDP · NTN = Demo-5G-NTN · VoNR = CS-1cell-VONR
//   NB-IoT = nbiot-check

import type { Environment, EnvironmentCell } from './types';

// ── Matrix (the user's scenario selection) ────────────────────────────

export type EnvTraffic =
  | 'no_data' | 'iperf-dl' | 'iperf-ul' | 'iperf-both' | 'iperf-tcp'
  | 'volte' | 'vonr' | 'ping'
  // Replay the GOLD's full concurrent traffic mix verbatim (e.g.
  // UDP iperf + TCP iperf + VoNR voice, all on the same UEs).
  | 'as-gold';

/** RAT the generated testcase runs as. Defaults to whatever the GOLD was
 *  parsed as, but the user can override — the box's master.ratType (and the
 *  subscriber shape that follows from it) is a per-testcase choice, not a
 *  fixed property of the site. */
export type RatChoice = 'NR-SA' | 'NR-NSA' | 'NB-IoT' | 'MULTI-RAT' | 'LTE';

/** UI labels, in menu order. */
export const RAT_CHOICES: Array<{ id: RatChoice; label: string }> = [
  { id: 'NR-SA',     label: '5G:SA' },
  { id: 'NR-NSA',    label: '5G:NSA/DSS' },
  { id: 'NB-IoT',    label: 'NB-IoT' },
  { id: 'MULTI-RAT', label: 'MULTI-RAT' },
  { id: 'LTE',       label: '4G:SmartPhone' },
];

/** Short tag used in the generated testcase name. */
const RAT_TAG: Record<RatChoice, string> = {
  'NR-SA': 'SA', 'NR-NSA': 'NSA', 'NB-IoT': 'NBIOT', 'MULTI-RAT': 'MULTIRAT', 'LTE': 'SMARTPHONE',
};

/** The GOLD's parsed RAT mapped onto a selectable choice (NTN rides on SA). */
export function defaultRatChoice(env: Environment): RatChoice {
  return env.site.rat === 'NTN' ? 'NR-SA' : env.site.rat;
}

/** One subscriber group: how many UEs it holds and which traffic runs on it.
 *  Several traffic entries on one group run CONCURRENTLY — the box accepts
 *  multiple userPlane profiles bound to the same subscriberGroup, which is
 *  how a GOLD carries e.g. UDP iperf + VoNR on the same UEs. */
export interface UeGroupSpec {
  ueCount: number;
  traffic: EnvTraffic[];
}

/** The spec for ONE testcase. Every field is applied directly — nothing is
 *  cross-producted into on/off variants, so a spec yields exactly one
 *  testcase. (This replaced a sweep model whose array fields silently turned
 *  a single selection into several testcases.) */
export interface AutoCreateMatrix {
  /** RAT the testcase runs as. Omitted → the GOLD's own RAT. */
  rat?: RatChoice;
  /** Cells in the generated testcase (≥1). Constrained per-RAT in validate(). */
  cellCount: number;
  /** Subscriber groups, in order. Each becomes one subs[] entry plus its own
   *  userPlane profiles. */
  ueGroups: UeGroupSpec[];
  /** Feature toggles — applied as selected. */
  carrierAggregation: boolean;
  handover: boolean;
  networkSlicing: boolean;
  ntn: boolean;
  attachDetach: boolean;           // power-cycle loop
  powerControl: boolean;
  /** Channel modelling: 'off' (awgn no sim), 'all' (one fading model on all
   *  cells), 'mix' (channelSim on, per-cell distinct fading). */
  channel: 'off' | 'all' | 'mix';
  /** Optional rx-to-tx latency (cells[].rxToTxLatency). */
  rxTxLatency?: number;
}

/** The materialized testcase spec handed to the body builders. */
export interface EnvVariant {
  id: string;            // stable name pushed to the box
  rat: RatChoice;
  cellCount: number;
  ueGroups: UeGroupSpec[];
  ca: boolean;
  ho: boolean;
  slicing: boolean;
  ntn: boolean;
  loop: boolean;
  powerControl: boolean;
  channel: 'off' | 'all' | 'mix';
  rxTxLatency?: number;
}

// ── Validation / mutual exclusion ─────────────────────────────────────

/** EVERY reason this spec can't be built, not just the first. A spec now maps
 *  to a single testcase, so a rejection means "you got nothing" — reporting
 *  one conflict at a time makes the user re-run the preview to discover the
 *  next. Empty array = buildable. */
export function variantInvalidReasons(env: Environment, v: EnvVariant): string[] {
  const rat = v.rat;
  const allTraffic = v.ueGroups.flatMap(g => g.traffic);
  const out: string[] = [];

  if (!v.ueGroups.length) out.push('at least one UE group is required');
  if (v.ueGroups.some(g => !g.traffic.length)) out.push('every UE group needs at least one traffic type');
  if (v.ueGroups.some(g => !(g.ueCount >= 1))) out.push('every UE group needs a UE count of at least 1');

  // The chosen RAT has to be buildable from the GOLD's actual cell plan — an
  // n78 NR GOLD carries no LTE band/EARFCN, so it cannot become a 4G testcase.
  const has4g = env.site.cells.some(c => c.cellType === '4g');
  const has5g = env.site.cells.some(c => c.cellType === '5g');
  const ratLabel = RAT_CHOICES.find(r => r.id === rat)?.label ?? rat;
  if ((rat === 'LTE' || rat === 'NB-IoT') && !has4g) {
    out.push(`${ratLabel} needs a 4G cell — this GOLD only has 5G cells (no band/EARFCN to build from)`);
  }
  if ((rat === 'NR-NSA' || rat === 'MULTI-RAT') && !(has4g && has5g)) {
    out.push(`${ratLabel} needs both a 4G anchor and a 5G cell — this GOLD has ${has4g ? 'only 4G' : 'only 5G'} cells`);
  }
  if (rat === 'NR-SA' && !has5g) {
    out.push(`${ratLabel} needs a 5G cell — this GOLD only has 4G cells`);
  }

  if (rat === 'NB-IoT') {
    if (v.cellCount > 1) out.push('NB-IoT is single-cell');
    if (v.ca) out.push('NB-IoT cannot do carrier aggregation');
    if (v.slicing) out.push('NB-IoT cannot do network slicing');
    if (v.ntn && env.site.cells.every(c => !c.ntn)) out.push('NB-IoT-NTN needs an NTN GOLD config');
  }
  if (v.ca && v.cellCount < 2) out.push('carrier aggregation needs ≥2 cells — raise cell count to 2+');
  if (v.ca && v.ho) out.push('carrier aggregation and handover both pin servingCell — turn one off');
  if (v.ho && v.cellCount < 2) out.push('handover needs ≥2 cells — raise cell count to 2+');
  if (v.ho && v.ueGroups.length < 2) out.push('handover needs ≥2 UE groups (one per serving cell)');
  if ((v.slicing || v.powerControl) && (rat === 'LTE' || rat === 'NB-IoT')) {
    out.push('network slicing / power control are NR features');
  }
  if (allTraffic.some(t => t === 'volte' || t === 'vonr') && rat === 'NB-IoT') {
    out.push('voice not supported on NB-IoT');
  }
  return out;
}

/** Returns null if the (env, variant) combo is buildable, else all reasons
 *  joined — kept for callers that want a single string. */
export function variantInvalidReason(env: Environment, v: EnvVariant): string | null {
  const reasons = variantInvalidReasons(env, v);
  return reasons.length ? reasons.join('; ') : null;
}

/** Materialize the spec. Returns exactly one variant, or none plus the reason
 *  the combination can't be built. The `{ variants, skipped }` shape is kept
 *  so the preview/run callers stay unchanged. */
export function expandMatrix(env: Environment, m: AutoCreateMatrix): { variants: EnvVariant[]; skipped: Array<{ id: string; reason: string }> } {
  const v: EnvVariant = {
    id: '',
    rat: m.rat ?? defaultRatChoice(env),
    cellCount: m.cellCount,
    ueGroups: m.ueGroups,
    ca: m.carrierAggregation,
    ho: m.handover,
    slicing: m.networkSlicing,
    ntn: m.ntn,
    loop: m.attachDetach,
    powerControl: m.powerControl,
    channel: m.channel,
    rxTxLatency: m.rxTxLatency,
  };
  v.id = variantName(env, v);
  // One row per conflict so the UI can list them all at once.
  const reasons = variantInvalidReasons(env, v);
  if (reasons.length) return { variants: [], skipped: reasons.map(reason => ({ id: v.id, reason })) };
  return { variants: [v], skipped: [] };
}

/** Traffic id → the token used in the testcase name. */
const TRAFFIC_TAG: Record<string, string> = {
  'as-gold': 'asGold', 'no_data': 'nodata', 'ping': 'ping', 'volte': 'volte', 'vonr': 'vonr',
  'iperf-dl': 'iperfDL', 'iperf-ul': 'iperfUL', 'iperf-both': 'iperfBoth', 'iperf-tcp': 'iperfTCP',
};

/** Name reads as RAT_cells_groups_userplane_features, e.g.
 *    SA_2cell_2UEGroups_nodata_vonr_CarrierAggregation
 *
 *  Deterministic, so re-running the same spec is recognised as "already on
 *  box" instead of creating a duplicate. */
function variantName(env: Environment, v: EnvVariant): string {
  const traffic = [...new Set(v.ueGroups.flatMap(g => g.traffic))]
    .map(t => TRAFFIC_TAG[t] ?? t.replace(/[^a-zA-Z0-9]+/g, ''));
  const features = [
    v.ca ? 'CarrierAggregation' : '',
    v.ho ? 'Handover' : '',
    v.slicing ? 'NetworkSlicing' : '',
    v.ntn ? 'NTN' : '',
    v.loop ? 'AttachDetachLoop' : '',
    v.powerControl ? 'PowerControl' : '',
    v.channel === 'all' ? 'ChannelAll' : v.channel === 'mix' ? 'ChannelMix' : '',
    v.rxTxLatency !== undefined ? `Latency${v.rxTxLatency}` : '',
  ].filter(Boolean);
  return [
    RAT_TAG[v.rat],
    `${v.cellCount}cell`,
    `${v.ueGroups.length}UEGroups`,
    ...traffic,
    ...features,
  ].join('_');
}

// ── Cell derivation ───────────────────────────────────────────────────

/** Produce N cells for a variant. distinct → use GOLD cells verbatim,
 *  padding extras from cell0; replicate → all cells copy cell0 with a
 *  stepped ARFCN so component carriers stay distinct. */
function deriveCells(env: Environment, count: number, derivation: 'replicate' | 'distinct'): EnvironmentCell[] {
  const gold = env.site.cells;
  const base = gold[0];
  // ARFCN step inferred from the GOLD's own multi-cell spacing if present,
  // else a conservative default (keeps carriers distinct + likely in-band).
  const nrStep = (gold.length >= 2 && gold[0].nrarfcn && gold[1].nrarfcn)
    ? (gold[0].nrarfcn.dl - gold[1].nrarfcn.dl) || 3000
    : 3000;
  const lteStep = (gold.length >= 2 && gold[0].earfcn && gold[1].earfcn)
    ? (gold[0].earfcn.dl - gold[1].earfcn.dl) || 100
    : 100;

  const out: EnvironmentCell[] = [];
  for (let i = 0; i < count; i++) {
    if (derivation === 'distinct' && gold[i]) {
      // Use the customer's real cell plan, but force rfCard to the +2 step
      // the box requires (one physical card per cell).
      out.push({ ...gold[i], rfCard: i * 2 });
      continue;
    }
    // replicate (or pad beyond GOLD's cell count): copy cell0, step ARFCN.
    const cell: EnvironmentCell = { ...base, rfCard: i * 2 };
    if (base.nrarfcn) cell.nrarfcn = { dl: base.nrarfcn.dl - i * Math.abs(nrStep), ssb: base.nrarfcn.ssb - i * Math.abs(nrStep) };
    if (base.earfcn)  cell.earfcn = { dl: base.earfcn.dl - i * Math.abs(lteStep), ul: base.earfcn.ul !== undefined ? base.earfcn.ul - i * Math.abs(lteStep) : undefined };
    out.push(cell);
  }
  return out;
}

// ── Body builders (FLAT write-side) ───────────────────────────────────

/** The box's master.ratType for the RAT the user picked. NTN is not a RAT of
 *  its own — it rides on SA plus the per-cell NTN flag. */
function masterRatType(rat: RatChoice): string {
  switch (rat) {
    case 'NR-SA': return 'sa';
    case 'NR-NSA': return 'nsa';
    case 'NB-IoT': return 'nbiot';
    case 'MULTI-RAT': return 'multirat';
    case 'LTE': return 'smartphone';
  }
}

/** True when the chosen RAT uses the NR subscriber shape (SUPI, nea/nia, …). */
function isNrRat(rat: RatChoice): boolean {
  return rat === 'NR-SA' || rat === 'NR-NSA' || rat === 'MULTI-RAT';
}

export function buildCells(env: Environment, v: EnvVariant): any {
  // Always 'distinct': use the GOLD's real cell plan, padding any extra cells
  // from cell0 with a stepped ARFCN. (The user-facing "Extra cells" choice was
  // removed — replicating cell0 when the GOLD has real cells lost site data.)
  const cells = deriveCells(env, v.cellCount, 'distinct');
  const ratType = masterRatType(v.rat);
  const isNr = isNrRat(v.rat);
  const master: any = {
    product: 'UE-SIM',
    carrierAggregation: v.ca,
    channelSim: v.channel !== 'off' || v.ho,   // handover + channel-mix both need channelSim on
    ratType,
  };
  if (isNr) { master.ldpcIteration = 5; master.pdcchDecodeOpt = false; }
  else if (v.rat === 'NB-IoT') {
    // NB-IoT GOLDs the box exports ship pdcchDecodeOpt OFF and carry no
    // threshold at all — the LTE decode-optimisation pair is smartphone-only.
    master.turboIteration = 6;
    master.pdcchDecodeOpt = false;
  }
  else { master.turboIteration = 14; master.pdcchDecodeOpt = true; master.pdcchDecodeOptThreshold = 0.1; }

  const cellsOut = cells.map((c, i) => {
    const cell: any = {
      cellType: c.cellType,
      syncId: i,
      duplexMode: c.duplexMode,
      band: c.band,
      bandwidth: String(c.bandwidthMhz ?? (c.cellType === '5g' ? 100 : 20)),
      prach: 0,
      antennas: { dl: c.antennas.dl, ul: c.antennas.ul },
      rfCard: c.rfCard,
      ratTypeP: ratType,
      carrierAggregationP: v.ca,
      channelSimP: v.channel === 'mix' || (v.channel === 'all'),
      txGain: c.txGain,
      rxGain: c.rxGain,
    };
    if (c.cellType === '5g') {
      cell.NRARFCN = { dl: c.nrarfcn?.dl ?? 632628, ssb: c.nrarfcn?.ssb ?? c.nrarfcn?.dl ?? 632628 };
      cell.scs = c.scs ?? 30;
      cell.ssbScs = c.ssbScs ?? c.scs ?? 30;
      cell.NTN = v.ntn;
      cell.asymmetricApplicable = false;
      // When channel modelling is on, the box validates a TOP-LEVEL
      // antennaType (string) + position (array) for SA cells. Confirmed on
      // 192.168.10.202 (4.0.0_260605): a nested mobility{} block — which is
      // all the 4g path emits — is NOT read for SA, so these must be flat on
      // the cell. Omitted when channel sim is off (channelSim-off NR cells
      // create fine without them, matching the bulk generator). Handover
      // forces master.channelSim, so cover v.ho too.
      if (v.channel !== 'off' || v.ho) {
        cell.antennaType = 'isotropic';
        cell.position = [4, 3];
      }
    } else {
      cell.EARFCN = { dl: c.earfcn?.dl ?? 300, ul: c.earfcn?.ul ?? (c.earfcn?.dl ?? 300) + 18000 };
      cell.rxToTxLatency = v.rxTxLatency ?? c.rxToTxLatency ?? 4;
      cell.globalTimingAdvance = -1;
      cell.mobility = { antennaType: 'isotropic', position: [4, 3], referencePower: -25, ulAttenuation: 60 };
    }
    if (v.rxTxLatency !== undefined && c.cellType === '5g') cell.rxToTxLatency = v.rxTxLatency;
    return cell;
  });

  return { cellConfig: { master, cells: cellsOut } };
}

export function buildSubscribers(env: Environment, v: EnvVariant): any {
  const isNr = isNrRat(v.rat);
  // One subs[] entry per UE group. Identity ranges are laid end to end from
  // the GOLD start so groups never overlap, whatever their sizes.
  const subs: any[] = [];
  let startId = env.site.imsiStart;
  for (let g = 0; g < v.ueGroups.length; g++) {
    const group = v.ueGroups[g];
    const ueCount = group.ueCount;
    // Handover puts each group on its own serving cell.
    const common: any = {
      ueCount,
      servingCell: v.ho ? g : 0,
      cellsLen: v.cellCount,
      carrierAggregationP: v.ca,
      sharedKey: env.site.sharedKey,
      incrementSharedKey: env.site.incrementSharedKey ?? 0,
      resLength: 8,
      securityContext: true,
      imeisv: '4085780000000102',
      powerControl: v.powerControl,
      attachType: 'normal',
      preambleIndex: 0,
      cqi: 'auto', ri: 'auto', pmi: 'auto',
    };
    if (isNr) {
      subs.push({
        ...common,
        startingSUPI: startId,
        nextSUPI: env.site.imsiStride,
        algorithm: env.site.algorithm || 'xor',
        asRelease: 15,
        ueCategory: 'nr',
        ueCategoryType: 'combined',
        ueInitiatedEvents: 'none',
        pdnType: 'ipv4',
        cipherAlgorithm: ['nea0', 'nea1', 'nea2'],
        integrityAlgorithm: ['nia0', 'nia1', 'nia2'],
        mncDigits: env.site.mncDigits ?? 2,
        VoNRSupport: group.traffic.includes('vonr') || (env.site.voNRSupport ?? false),
        protectionScheme: 'null',
        publicKeyId: 0,
        routingIndicator: 1111,
        networkSlicing: v.slicing ? 'enable' : 'disable',
        ...(v.slicing ? { pduSnssai: { pduSNSSAISst: 1, pduSNSSAISd: 1 } } : {}),
        ratTypeP: masterRatType(v.rat),
        cellTypeP: '5g',
        carrierAggregationP: v.ca,
        channelSimP: v.channel === 'mix' || v.channel === 'all',
        duplexModeP: env.site.cells[0]?.duplexMode ?? 'TDD',
        NTNP: v.ntn,
        BLEROverrideValue: 0,
        external_sim: false,
        access_control_classes: [],
        uac_access_identities: [],
        // The box rejects a non-empty opc for SA+xor (pattern ^$). Only
        // carry op/opc for milenage auth; xor uses sharedKey alone.
        ...(env.site.algorithm === 'milenage' && env.site.opc ? { opc: env.site.opc } : {}),
        ...(env.site.algorithm === 'milenage' && env.site.op ? { op: env.site.op } : {}),
      });
    } else {
      subs.push({
        ...common,
        startingIMSI: startId,
        nextIMSI: env.site.imsiStride,
        preferredPLMN: env.site.plmn ?? ['011-01', '544-780'],
        algorithm: env.site.algorithm || 'milenage',
        ...(env.site.op ? { op: env.site.op } : {}),
        ...(env.site.opc ? { opc: env.site.opc } : {}),
        asRelease: 13,
        redCap: false,
        ueCategoryType: 'combined',
        ueCategory: v.rat === 'NB-IoT' ? 'nb1' : '6',
        // NB-IoT GOLDs use 'none' and carry no event loop; a periodic TAU
        // trigger is a smartphone behaviour.
        ...(v.rat === 'NB-IoT'
          ? { ueInitiatedEvents: 'none' }
          : { ueInitiatedEvents: 'tau', eventsInLoop: true, triggerTime: [10] }),
        pdnType: 'ipv4',
        defaultApn: '',
        cipherAlgorithm: ['eea0', 'eea1', 'eea2'],
        integrityAlgorithm: ['eia0', 'eia1', 'eia2'],
        // NB-IoT-only flags. CIOTOpt is a BOOL on the box — sending the string
        // 'control' gets "cannot unmarshal string into Go struct field
        // PLoadSubscriber.subs.CIOTOpt of type bool". halfDuplex belongs with
        // it; both match the box-accepted set in lib/bulkTests/generator.ts
        // and the NB-IoT GOLDs the box itself exports.
        ...(v.rat === 'NB-IoT'
          ? { cellTypeP: '4g', CIOTOpt: true, halfDuplex: true, multiTone: true, multiCarrier: false }
          : {}),
      });
    }
    startId += ueCount * (env.site.imsiStride || 1);
  }
  return { subsConfig: { subs } };
}

function iperfProfile(group: number, direction: 'uplink' | 'downlink' | 'both', protocol: 'udp' | 'tcp', subsLen: number, serverIp: string): any {
  return {
    subscriberGroup: [group], dataType: 'iperf', dataDirection: direction, dataLoop: false,
    dataBitrate: { dl: { unit: 'mbps', value: 100 }, ul: { unit: 'mbps', value: 20 } },
    transportProtocol: protocol, startDelay: 5, sessionDuration: 60,
    serverIpAddress: serverIp, portRange: 5000, mtuSize: 1500, subsLen, pdnType: 'ipv4', apnName: '',
  };
}

function voiceProfile(env: Environment, group: number, kind: 'volte' | 'vonr', subsLen: number): any {
  // The box's userPlane voice dataType is ALWAYS 'volte' — VoNR vs VoLTE
  // is distinguished by the subscriber's VoNRSupport flag + the cell RAT,
  // NOT by a 'vonr' dataType (which the box rejects as invalid).
  return {
    subscriberGroup: [group], dataType: 'volte', apnName: 'ims', attachTypeSIP: true,
    authentication: 'HTTP-Digest', callDuration: 500, callSetupDelay: 5, codec: 'AMR-WB', dataLoop: false,
    mtuSize: 1500, networkSlicingP: false, password: 'sim',
    pcscfIpAddress: env.site.pcscfIp ?? '192.168.4.1', pdnType: 'ipv4', pdnTypeNonIp: false, precondition: true,
    ...(kind === 'vonr' ? { ratTypeP: 'sa' } : {}),
    realm: env.site.imsRealm ?? 'ims.mnc001.mcc001.3gppnetwork.org', registrationExpiry: 3600, registrationOnly: false,
    sessionDuration: 600, startDelay: 5, subsLen, uniquePassword: false,
    userName: env.site.imsRealm ?? 'ims.mnc001.mcc001.3gppnetwork.org', videoCodec: 'NONE',
  };
}

/** Emit the userPlane profiles for ONE traffic selection, bound to group `g`.
 *  `as-gold` expands to several profiles (the GOLD's whole concurrent mix);
 *  every other type yields exactly one. */
function profilesFor(env: Environment, t: EnvTraffic, g: number, ueCount: number): any[] {
  const serverIp = env.site.iperfServerIp ?? '20.10.10.1';

  // as-GOLD: replay the customer's exact concurrent traffic mix, re-stamping
  // site IPs and binding every profile to THIS group.
  if (t === 'as-gold') {
    if (!env.site.trafficProfiles?.length) {
      return [{ subscriberGroup: [g], dataType: 'no_data', pdnType: 'ipv4', apnName: '' }];
    }
    return env.site.trafficProfiles.map(gp => {
      if (gp.dataType === 'iperf') {
        return iperfProfile(g, (gp.direction as any) ?? 'both', (gp.protocol as any) ?? 'udp', ueCount, serverIp);
      }
      if (gp.dataType === 'volte' || gp.dataType === 'vonr') {
        const p = voiceProfile(env, g, 'vonr', ueCount);
        if (gp.codec) p.codec = gp.codec;
        return p;
      }
      if (gp.dataType === 'ping') {
        return { subscriberGroup: [g], dataType: 'ping', pdnType: 'ipv4', apnName: '', startDelay: 5, sessionDuration: 60, serverIpAddress: serverIp };
      }
      if (gp.raw) {
        // Any other dataType the box supports (ftp, http, dns, …). We don't
        // model their type-specific keys, so replay the GOLD profile as-is
        // and only re-stamp the site's server IP where one is present.
        // Collapsing these to no_data silently produced traffic-less tests.
        const p = { ...gp.raw, subscriberGroup: [g] };
        if (p.serverIpAddress) p.serverIpAddress = serverIp;
        return p;
      }
      return { subscriberGroup: [g], dataType: 'no_data', pdnType: 'ipv4', apnName: '' };
    });
  }

  if (t === 'no_data') return [{ subscriberGroup: [g], dataType: 'no_data', pdnType: 'ipv4', apnName: '' }];
  if (t === 'ping')    return [{ subscriberGroup: [g], dataType: 'ping', pdnType: 'ipv4', apnName: '', startDelay: 5, sessionDuration: 60, serverIpAddress: serverIp }];
  if (t === 'volte' || t === 'vonr') return [voiceProfile(env, g, t, ueCount)];

  const dir = t === 'iperf-dl' ? 'downlink' : t === 'iperf-ul' ? 'uplink' : 'both';
  const proto = t === 'iperf-tcp' ? 'tcp' : 'udp';
  return [iperfProfile(g, dir as any, proto, ueCount, serverIp)];
}

/** Every traffic type selected on a group becomes its own profile bound to
 *  that group, so a group with e.g. [no_data, vonr] yields two profiles in
 *  one testcase rather than two separate testcases. */
export function buildUserPlane(env: Environment, v: EnvVariant): any {
  const profiles: any[] = [];
  v.ueGroups.forEach((group, g) => {
    for (const t of group.traffic) profiles.push(...profilesFor(env, t, g, group.ueCount));
  });
  return { userPlaneConfig: { profiles } };
}

export function buildPowerCycle(env: Environment, v: EnvVariant): any {
  const groups = v.ueGroups.length;
  // A time-based attach/detach loop REQUIRES totalTestDuration > 0, and the
  // box enforces totalTestDuration >= (powerOnTime + powerOffTime) * cycles.
  // Confirmed on 192.168.10.202 (4.0.0_260605): powerOnTime 2000 +
  // powerOffTime 10 + totalTestDuration 4100 is accepted (~2 cycles). A
  // 'disable' (non-loop) profile must NOT carry totalTestDuration.
  const powerOnTime = 2000, powerOffTime = 10;
  const profile = (g: number) => ({
    subscriberGroup: [g],
    loopProfile: v.loop ? 'time' : 'disable',
    attachType: 'bursty',
    attachRate: 1, attachDelay: 0, powerOnTime, powerOffTime,
    ...(v.loop ? { totalTestDuration: (powerOnTime + powerOffTime) * 2 + 80 } : {}),
  });
  const profiles = [];
  for (let g = 0; g < groups; g++) profiles.push(profile(g));
  return { powerCycleConfig: { profiles } };
}

/** Clamp a requested fading model to one the box accepts for this RAT.
 *  Confirmed enums on 192.168.10.202 (4.0.0_260605):
 *    NR : awgn, tdla30, tdlb100, tdlc300, tdld, tdle
 *    LTE: awgn, epa, eva, etu, mbsfn
 *  Falls back to awgn (always valid) for anything unrecognized — e.g. a
 *  GOLD that carried an LTE model name like "epa5" onto an NR cell. */
function validFading(rat: RatChoice, requested?: string): string {
  const NR = ['awgn', 'tdla30', 'tdlb100', 'tdlc300', 'tdld', 'tdle'];
  const LTE = ['awgn', 'epa', 'eva', 'etu', 'mbsfn'];
  const allowed = isNrRat(rat) ? NR : LTE;
  const req = (requested ?? '').toLowerCase();
  if (allowed.includes(req)) return req;
  const alias: Record<string, string> = { epa5: 'epa', eva70: 'eva', etu70: 'etu', etu300: 'etu', tdla: 'tdla30', tdlb: 'tdlb100', tdlc: 'tdlc300' };
  if (alias[req] && allowed.includes(alias[req])) return alias[req];
  return 'awgn';
}

export function buildMobility(env: Environment, v: EnvVariant): any | null {
  // mobilityConfig presence is the HANDOVER discriminator. For non-HO
  // variants with channel modelling, we still emit a stationary mobility
  // profile to carry the fading model.
  if (!v.ho && v.channel === 'off') return null;
  const groups = v.ueGroups.length;
  const fading = v.channel === 'off' ? 'awgn' : validFading(v.rat, env.defaults.fading);
  // NB: fadingType + mimoCorrelation are FLAT on the profile — confirmed on
  // 192.168.10.202 (4.0.0_260605) that the box validator reads them at the
  // profile top level, NOT nested under a fadingProfile{} object (which the
  // older bulk generator used; that shape now 400s with "expected string,
  // but got null").
  const profile = (g: number) => ({
    subscriberGroup: [g],
    tripType: v.ho ? 'roundTrip' : 'stationary',
    loopProfile: 'time',
    startDelay: 5, duration: 380, waitTime: 0,
    uePosition: [0, 0],
    speed: v.ho ? 10 : 0,
    direction: v.ho ? (g === 0 ? 0 : 180) : 0,
    distance: v.ho ? 50 : 0,
    fadingType: fading,
    frequencyDoppler: 70,
    mimoCorrelation: 'low',
    noiseSpectralDensity: -174,
  });
  const profiles = [];
  for (let g = 0; g < groups; g++) profiles.push(profile(g));
  return { mobilityConfig: { profiles } };
}

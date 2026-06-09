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

export interface AutoCreateMatrix {
  /** Cell counts to generate (each ≥1). Constrained per-RAT in validate(). */
  cellCounts: number[];
  /** Traffic profiles to sweep. */
  trafficTypes: EnvTraffic[];
  /** Feature toggles — each produces on/off variants when the array has
   *  both true and false, or a single variant when one value. */
  carrierAggregation: boolean[];   // e.g. [false] or [true] or [false,true]
  handover: boolean[];
  networkSlicing: boolean[];
  ntn: boolean[];
  attachDetach: boolean[];         // power-cycle loop
  powerControl: boolean[];
  /** Channel modelling: 'off' (awgn no sim), 'all' (one fading model on all
   *  cells), 'mix' (channelSim on, per-cell distinct fading). */
  channelMix: Array<'off' | 'all' | 'mix'>;
  /** Optional rx-to-tx latency values to sweep (cells[].rxToTxLatency). */
  rxTxLatency?: number[];
  /** How to derive cells beyond what the GOLD provides. */
  cellDerivation: 'replicate' | 'distinct';
  /** UE count per subscriber group (overrides env.defaults.ueCount). */
  ueCount?: number;
  /** Cap the total variant count (safety). */
  maxVariants?: number;
}

/** One materialized variant — a concrete point in the matrix. */
export interface EnvVariant {
  id: string;            // stable name pushed to the box
  cellCount: number;
  traffic: EnvTraffic;
  ca: boolean;
  ho: boolean;
  slicing: boolean;
  ntn: boolean;
  loop: boolean;
  powerControl: boolean;
  channel: 'off' | 'all' | 'mix';
  rxTxLatency?: number;
  /** How to derive cells beyond the GOLD's plan (carried from the matrix). */
  derivation: 'replicate' | 'distinct';
}

// ── Validation / mutual exclusion ─────────────────────────────────────

/** Returns null if the (env, variant) combo is buildable, else a reason. */
export function variantInvalidReason(env: Environment, v: EnvVariant): string | null {
  const rat = env.site.rat;
  if (rat === 'NB-IoT') {
    if (v.cellCount > 1) return 'NB-IoT is single-cell';
    if (v.ca) return 'NB-IoT cannot do carrier aggregation';
    if (v.slicing) return 'NB-IoT cannot do network slicing';
    if (v.ntn && env.site.cells.every(c => !c.ntn)) return 'NB-IoT-NTN needs an NTN GOLD config';
  }
  if (v.ca && v.cellCount < 2) return 'carrier aggregation needs ≥2 cells';
  if (v.ca && v.ho) return 'CA and handover both pin servingCell — mutually exclusive';
  if (v.ho && v.cellCount < 2) return 'handover needs ≥2 cells';
  if ((v.slicing || v.powerControl) && (rat === 'LTE' || rat === 'NB-IoT')) {
    return 'network slicing / power control are NR features';
  }
  if ((v.traffic === 'volte' || v.traffic === 'vonr') && rat === 'NB-IoT') {
    return 'voice not supported on NB-IoT';
  }
  return null;
}

/** Cross-product the matrix into valid variants. */
export function expandMatrix(env: Environment, m: AutoCreateMatrix): { variants: EnvVariant[]; skipped: Array<{ id: string; reason: string }> } {
  const variants: EnvVariant[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  let seq = 0;
  const cap = m.maxVariants ?? 500;
  const latencies = (m.rxTxLatency && m.rxTxLatency.length) ? m.rxTxLatency : [undefined];

  outer:
  for (const cellCount of m.cellCounts)
  for (const traffic of m.trafficTypes)
  for (const ca of m.carrierAggregation)
  for (const ho of m.handover)
  for (const slicing of m.networkSlicing)
  for (const ntn of m.ntn)
  for (const loop of m.attachDetach)
  for (const powerControl of m.powerControl)
  for (const channel of m.channelMix)
  for (const lat of latencies) {
    seq += 1;
    const v: EnvVariant = {
      id: '', cellCount, traffic, ca, ho, slicing, ntn, loop, powerControl, channel,
      rxTxLatency: lat, derivation: m.cellDerivation,
    };
    v.id = variantName(env, v, seq);
    const reason = variantInvalidReason(env, v);
    if (reason) { skipped.push({ id: v.id, reason }); continue; }
    variants.push(v);
    if (variants.length >= cap) break outer;
  }
  return { variants, skipped };
}

function variantName(env: Environment, v: EnvVariant, seq: number): string {
  const rat = env.site.rat.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const bits = [
    `${v.cellCount}cell`,
    v.traffic,
    v.ca ? 'ca' : '',
    v.ho ? 'ho' : '',
    v.slicing ? 'slice' : '',
    v.ntn ? 'ntn' : '',
    v.loop ? 'loop' : '',
    v.powerControl ? 'pc' : '',
    v.channel !== 'off' ? `ch-${v.channel}` : '',
    v.rxTxLatency !== undefined ? `lat${v.rxTxLatency}` : '',
  ].filter(Boolean);
  const slug = env.name.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 12);
  return `env-${slug}-${rat}-${bits.join('-')}-${String(seq).padStart(3, '0')}`;
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

function masterRatType(env: Environment, ntn: boolean): string {
  switch (env.site.rat) {
    case 'NR-SA': return 'sa';
    case 'NR-NSA': return 'nsa';
    case 'NB-IoT': return 'nbiot';
    case 'NTN': return 'sa';     // NTN rides on SA + the per-cell NTN flag
    case 'LTE': return 'smartphone';
  }
}

export function buildCells(env: Environment, v: EnvVariant): any {
  const cells = deriveCells(env, v.cellCount, v.derivation);
  const ratType = masterRatType(env, v.ntn);
  const isNr = env.site.rat === 'NR-SA' || env.site.rat === 'NR-NSA' || env.site.rat === 'NTN';
  const master: any = {
    product: 'UE-SIM',
    carrierAggregation: v.ca,
    channelSim: v.channel !== 'off' || v.ho,   // handover + channel-mix both need channelSim on
    ratType,
  };
  if (isNr) { master.ldpcIteration = 5; master.pdcchDecodeOpt = false; }
  else { master.turboIteration = env.site.rat === 'NB-IoT' ? 6 : 14; master.pdcchDecodeOpt = true; master.pdcchDecodeOptThreshold = 0.1; }

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

export function buildSubscribers(env: Environment, v: EnvVariant, ueCount: number): any {
  const isNr = env.site.rat === 'NR-SA' || env.site.rat === 'NR-NSA' || env.site.rat === 'NTN';
  // For handover, split into 2 groups starting on different serving cells.
  // Each group's identity range is pinned to the GOLD start + group*ueCount.
  const groups = v.ho ? 2 : 1;
  const subs: any[] = [];
  for (let g = 0; g < groups; g++) {
    const startId = env.site.imsiStart + g * ueCount;
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
        VoNRSupport: v.traffic === 'vonr' || (env.site.voNRSupport ?? false),
        protectionScheme: 'null',
        publicKeyId: 0,
        routingIndicator: 1111,
        networkSlicing: v.slicing ? 'enable' : 'disable',
        ...(v.slicing ? { pduSnssai: { pduSNSSAISst: 1, pduSNSSAISd: 1 } } : {}),
        ratTypeP: masterRatType(env, v.ntn),
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
        ueCategory: env.site.rat === 'NB-IoT' ? 'nb1' : '6',
        ueInitiatedEvents: 'tau',
        eventsInLoop: true,
        triggerTime: [10],
        pdnType: 'ipv4',
        defaultApn: '',
        cipherAlgorithm: ['eea0', 'eea1', 'eea2'],
        integrityAlgorithm: ['eia0', 'eia1', 'eia2'],
        ...(env.site.rat === 'NB-IoT' ? { cellTypeP: '4g', CIOTOpt: 'control', multiTone: true, multiCarrier: false } : {}),
      });
    }
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

export function buildUserPlane(env: Environment, v: EnvVariant, ueCount: number): any {
  const serverIp = env.site.iperfServerIp ?? '20.10.10.1';
  const profiles: any[] = [];
  const t = v.traffic;

  // as-GOLD: replay the customer's exact concurrent traffic mix. Each
  // GOLD profile is re-emitted with site IPs re-stamped; subscriberGroup
  // is preserved ([-1] = every UE → concurrent on the same subscribers).
  if (t === 'as-gold' && env.site.trafficProfiles?.length) {
    for (const gp of env.site.trafficProfiles) {
      const group = gp.subscriberGroup?.[0] ?? 0;   // preserve -1 (all UEs)
      if (gp.dataType === 'iperf') {
        const dir = (gp.direction as any) ?? 'both';
        const proto = (gp.protocol as any) ?? 'udp';
        const p = iperfProfile(group, dir, proto, ueCount, serverIp);
        p.subscriberGroup = gp.subscriberGroup ?? [group];
        profiles.push(p);
      } else if (gp.dataType === 'volte' || gp.dataType === 'vonr') {
        const p = voiceProfile(env, group, 'vonr', ueCount);
        p.subscriberGroup = gp.subscriberGroup ?? [group];
        if (gp.codec) p.codec = gp.codec;
        profiles.push(p);
      } else if (gp.dataType === 'ping') {
        profiles.push({ subscriberGroup: gp.subscriberGroup ?? [group], dataType: 'ping', pdnType: 'ipv4', apnName: '', startDelay: 5, sessionDuration: 60, serverIpAddress: serverIp });
      } else {
        profiles.push({ subscriberGroup: gp.subscriberGroup ?? [group], dataType: 'no_data', pdnType: 'ipv4', apnName: '' });
      }
    }
    return { userPlaneConfig: { profiles } };
  }

  if (t === 'no_data' || t === 'as-gold') {
    profiles.push({ subscriberGroup: [0], dataType: 'no_data', pdnType: 'ipv4', apnName: '' });
  } else if (t === 'ping') {
    profiles.push({ subscriberGroup: [0], dataType: 'ping', pdnType: 'ipv4', apnName: '', startDelay: 5, sessionDuration: 60, serverIpAddress: serverIp });
  } else if (t === 'volte' || t === 'vonr') {
    profiles.push(voiceProfile(env, 0, t, ueCount));
  } else {
    const dir = t === 'iperf-dl' ? 'downlink' : t === 'iperf-ul' ? 'uplink' : 'both';
    const proto = t === 'iperf-tcp' ? 'tcp' : 'udp';
    profiles.push(iperfProfile(0, dir as any, proto, ueCount, serverIp));
  }
  // Handover splits into 2 groups — give group 1 the same traffic.
  if (v.ho && t !== 'no_data') {
    const dir = t === 'iperf-dl' ? 'downlink' : t === 'iperf-ul' ? 'uplink' : 'both';
    profiles.push(iperfProfile(1, dir as any, t === 'iperf-tcp' ? 'tcp' : 'udp', ueCount, serverIp));
  } else if (v.ho) {
    profiles.push({ subscriberGroup: [1], dataType: 'no_data', pdnType: 'ipv4', apnName: '' });
  }
  return { userPlaneConfig: { profiles } };
}

export function buildPowerCycle(env: Environment, v: EnvVariant): any {
  const groups = v.ho ? 2 : 1;
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
function validFading(env: Environment, requested?: string): string {
  const NR = ['awgn', 'tdla30', 'tdlb100', 'tdlc300', 'tdld', 'tdle'];
  const LTE = ['awgn', 'epa', 'eva', 'etu', 'mbsfn'];
  const isNr = env.site.rat === 'NR-SA' || env.site.rat === 'NR-NSA' || env.site.rat === 'NTN';
  const allowed = isNr ? NR : LTE;
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
  const groups = v.ho ? 2 : 1;
  const fading = v.channel === 'off' ? 'awgn' : validFading(env, env.defaults.fading);
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

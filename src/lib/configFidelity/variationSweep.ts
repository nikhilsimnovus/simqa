// Variation sweep: keep a USER-SELECTED test case's base (cellConfig + subsConfig)
// fixed, and enumerate combinations of the variable dimensions — traffic
// profile, mobility, channel model (fading), and power-cycle / loop count.
//
// Dimension values are the authoritative enums from the Simnovator OpenAPI spec:
//   • traffic dataType: no_data, udp, tcp, volte, ftp, rtsp, ping, http, sms, external
//   • mobility tripType: roundTrip, stationary, oneWayTrip; loopProfile: count/time/disable
//   • channel model fadingType: LTE {awgn,epa,eva,etu,mbsfn}; NR {awgn,tdla30,tdlb100,tdlc300,tdld,tdle}
//   • mimoCorrelation: low/medium/high
//   • power-cycle loopProfile: disable/time/count; attachType: bursty/staggered
//
// Channel-model (fading) requires the channel simulator, so variations that set
// a non-awgn fading model force cellConfig.master.channelSim = true.

import type { Case, InputConfig, Rat } from './types';
import { ensureToken } from '../uesimClient';
import type { ApiOpts } from './testCreator';

// ---------- base config fetch (export → intermediate object) ----------

/** Export the selected test case and return its intermediate config object
 *  ({ cellConfig, subsConfig, userPlaneConfig, powerCycleConfig, settings }). */
export async function fetchBaseConfig(api: ApiOpts, testcaseId: string): Promise<InputConfig & { _name?: string }> {
  const token = await ensureToken(api.host, api.username, api.password);
  const res = await fetch(`http://${api.host}/v2/testcases/export`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ testCaseIds: [testcaseId], output: { type: 'json' } }),
  });
  if (!res.ok) throw new Error(`export ${testcaseId} returned ${res.status}`);
  const body: any = await res.json();
  const detail = body?.test_case_details?.[0];
  if (!detail) throw new Error(`export returned no test_case_details for ${testcaseId}`);
  let ico = detail.Test_Config_Intermediate_Object;
  ico = typeof ico === 'string' ? JSON.parse(ico) : ico;
  if (!ico?.cellConfig) throw new Error(`exported config has no cellConfig`);
  return { ...ico, _name: detail.Test_Name };
}

function ratOf(base: InputConfig): Rat {
  const rt = String(base.cellConfig?.master?.ratType ?? '').toLowerCase();
  if (rt === 'sa') return 'nr-sa';
  if (rt === 'nsa') return 'nsa';
  if (rt === 'nbiot') return 'nbiot';
  if (rt === 'multirat') return 'multirat';
  return 'lte';
}
const isNrLike = (rat: Rat) => rat === 'nr-sa' || rat === 'nsa' || rat === 'multirat';

// ---------- dimension value sets ----------

export type TrafficKind = 'no_data' | 'udp' | 'tcp' | 'volte' | 'ftp' | 'rtsp' | 'ping' | 'http' | 'sms' | 'external';

function trafficProfile(kind: TrafficKind): any {
  const g = [0];
  switch (kind) {
    case 'no_data': return { subscriberGroup: g, dataType: 'no_data', pdnType: 'ipv4', apnName: '' };
    case 'udp': return { subscriberGroup: g, dataType: 'iperf', transportProtocol: 'udp', serverIpAddress: '192.168.2.1', portRange: 5000, pdnType: 'ipv4', apnName: '', startDelay: 5, sessionDuration: 60, dataLoop: false, loopCount: 0, interSessionGap: 5, dataDirection: 'both', dataBitrate: { dl: { unit: 'mbps', value: 100 }, ul: { unit: 'mbps', value: 50 } }, payloadLength: 1000, mtuSize: 1500 };
    case 'tcp': return { subscriberGroup: g, dataType: 'iperf', transportProtocol: 'tcp', serverIpAddress: '192.168.2.1', portRange: 5000, pdnType: 'ipv4', apnName: '', startDelay: 5, sessionDuration: 60, dataLoop: false, loopCount: 0, interSessionGap: 5, dataDirection: 'both', dataBitrate: { dl: { unit: 'mbps', value: 100 }, ul: { unit: 'mbps', value: 50 } }, payloadLength: 1000, mtuSize: 1500 };
    case 'volte': return { subscriberGroup: g, dataType: 'volte', pcscfIpAddress: '192.168.4.1', pdnType: 'ipv4', apnName: 'ims', realm: 'ims.mnc001.mcc001.3gppnetwork.org', startDelay: 5, sessionDuration: 100, dataLoop: false, loopCount: 0, InterSessionGap: 0, callSetupDelay: 5, callDuration: 80, countryCode: 91, telephoneNumber: '1234567890', codec: 'AMR-WB', videoCodec: 'ALL', authentication: 'HTTP-Digest', userName: 'ims', password: 'sim', registrationExpiry: 3600, precondition: true, AMF: '0x800', mtuSize: 1500, payloadLength: 1000, registrationOnly: true };
    case 'ftp': return { subscriberGroup: g, dataType: 'ftp', serverIpAddress: '192.168.1.46', pdnType: 'ipv4', apnName: '', startDelay: 5, sessionDuration: 500, dataLoop: false, loopCount: 0, InterSessionGap: 0, dataDirection: 'both', mtuSize: 1500, anonymous: false, uplinkFilename: 'file1.json', downlinkFilename: 'file2.json', username: 'user_name', password: 'pass_word' };
    case 'rtsp': return { subscriberGroup: g, dataType: 'rtsp', transportProtocol: 'udp', serverIpAddress: '192.168.1.46', portRange: 8554, apnName: '', startDelay: 5, sessionDuration: 500, dataLoop: false, loopCount: 0, InterSessionGap: 0, dataDirection: 'downlink', downlinkFilename: 'sample_60sec.mp4', codec: 'AAC', videoCodec: 'H265' };
    case 'ping': return { subscriberGroup: g, dataType: 'ping', serverIpAddress: '192.168.1.46', pdnType: 'ipv4', apnName: '', startDelay: 5, sessionDuration: 500, dataLoop: false, interval: 1, packetSize: 56, numberOfPackets: 100 };
    case 'http': return { subscriberGroup: g, dataType: 'http', urlAddress: 'https://www.google.com', pdnType: 'ipv4', apnName: '', startDelay: 5, sessionDuration: 500, dataLoop: false };
    case 'sms': return { subscriberGroup: g, dataType: 'sms', sendTo: '63726867236', startDelay: 5, dataLoop: false, loopCount: 0, InterSessionGap: 0, message: 'Hi' };
    case 'external': return { subscriberGroup: g, dataType: 'external', pdnType: 'ipv4', apnName: '', startDelay: 5, sessionDuration: 1800, dataLoop: false, loopCount: 0, InterSessionGap: 0 };
  }
}

const FADING_LTE = ['awgn', 'epa', 'eva', 'etu', 'mbsfn'] as const;
const FADING_NR = ['awgn', 'tdla30', 'tdlb100', 'tdlc300', 'tdld', 'tdle'] as const;
const TRIP_TYPES = ['stationary', 'roundTrip', 'oneWayTrip'] as const;

function mobilityProfile(tripType: string, fadingType: string, mimo: string): any {
  return { mobilityConfig: { profiles: [{
    subscriberGroup: [0], tripType, loopProfile: tripType === 'stationary' ? 'disable' : 'time',
    startDelay: 5, duration: 120, tripCount: 1, waitTime: 0, uePosition: [0, 0],
    speed: tripType === 'stationary' ? 0 : 5, direction: 0, distance: tripType === 'stationary' ? 0 : 50,
    fadingProfile: { fadingType, frequencyDoppler: 70, mimoCorrelation: mimo }, noiseSpectralDensity: -174,
  }] } };
}

function powerCycleProfile(loopProfile: string, attachType: string, count: number): any {
  const p: any = { subscriberGroup: [0], loopProfile, attachType, attachRate: 1, attachDelay: 0, powerOnTime: 2000, powerOffTime: 10 };
  if (loopProfile === 'count') p.noOfPowerOnCycles = count;
  // For 'time', the box requires totalTestDuration >= powerOnTime + powerOffTime.
  if (loopProfile === 'time') p.totalTestDuration = 5000;
  if (attachType === 'staggered') p.staggerTime = 0;
  return { powerCycleConfig: { profiles: [p] } };
}

// ---------- combinatorics (pairwise / full) reused shape ----------

function cartesian(dims: Record<string, any[]>): Array<Record<string, any>> {
  return Object.entries(dims).reduce<Array<Record<string, any>>>((acc, [k, vals]) => acc.flatMap((row) => vals.map((v) => ({ ...row, [k]: v }))), [{}]);
}
function pairwise(dims: Record<string, any[]>): Array<Record<string, any>> {
  const keys = Object.keys(dims);
  if (keys.length <= 1) return cartesian(dims);
  const pairs = new Set<string>();
  for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) for (const a of dims[keys[i]]) for (const b of dims[keys[j]]) pairs.add(`${keys[i]}=${JSON.stringify(a)}|${keys[j]}=${JSON.stringify(b)}`);
  const rows: Array<Record<string, any>> = []; let guard = 0;
  while (pairs.size && guard++ < 5000) {
    const row: Record<string, any> = {};
    for (const k of keys) { let best = dims[k][0], bs = -1; for (const v of dims[k]) { let s = 0; for (const ok of keys) { if (ok === k || !(ok in row)) continue; if (pairs.has(`${k}=${JSON.stringify(v)}|${ok}=${JSON.stringify(row[ok])}`) || pairs.has(`${ok}=${JSON.stringify(row[ok])}|${k}=${JSON.stringify(v)}`)) s++; } if (s > bs) { bs = s; best = v; } } row[k] = best; }
    for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) pairs.delete(`${keys[i]}=${JSON.stringify(row[keys[i]])}|${keys[j]}=${JSON.stringify(row[keys[j]])}`);
    rows.push(row);
  }
  return rows;
}

export interface VariationRequest {
  base: InputConfig;
  traffic?: TrafficKind[];
  fading?: string[];
  tripTypes?: string[];
  mimo?: string[];
  powerLoops?: Array<{ loopProfile: string; attachType: string; count: number }>;
  mode?: 'pairwise' | 'full';
  cap?: number;
}

/** Build variation cases: cellConfig + subsConfig are taken verbatim from the
 *  base; userPlane / mobility / power-cycle vary across the requested dimensions. */
export function generateVariationSweep(req: VariationRequest): Case[] {
  const base = req.base;
  const rat = ratOf(base);
  const baseName = (base as any)._name ?? 'base';
  // SMS is not a supported dataType on the box; valid set excludes it.
  const traffic = req.traffic ?? ['no_data', 'udp', 'tcp', 'volte', 'ftp', 'rtsp', 'ping', 'http', 'external'];
  const fading = req.fading ?? (isNrLike(rat) ? [...FADING_NR] : [...FADING_LTE]);
  const trips = req.tripTypes ?? [...TRIP_TYPES];
  const mimo = req.mimo ?? ['low'];
  const powerLoops = req.powerLoops ?? [
    { loopProfile: 'disable', attachType: 'bursty', count: 0 },
    { loopProfile: 'count', attachType: 'bursty', count: 2 },
    { loopProfile: 'count', attachType: 'staggered', count: 5 },
    { loopProfile: 'time', attachType: 'bursty', count: 0 },
  ];

  const dims: Record<string, any[]> = {
    traffic,
    trip: trips,
    fading,
    power: powerLoops.map((p, i) => i), // index into powerLoops
  };
  const rows = (req.mode === 'full' ? cartesian : pairwise)(dims);

  const out: Case[] = [];
  for (const r of rows) {
    const tripType = r.trip as string;
    const fadingType = r.fading as string;
    const pl = powerLoops[r.power as number];

    // Base cell config + subscribers taken verbatim (fading/mobility apply
    // without the channel simulator — verified live, so channelSim is left as-is).
    const cells = JSON.parse(JSON.stringify({ cellConfig: base.cellConfig }));
    const subscribers = { subsConfig: base.subsConfig };
    const userPlane = { userPlaneConfig: { profiles: [trafficProfile(r.traffic as TrafficKind)] } };
    const powerCycle = powerCycleProfile(pl.loopProfile, pl.attachType, pl.count);
    // mobility only when not stationary-with-awgn-disable (i.e. when there is something to vary)
    const mobility = mobilityProfile(tripType, fadingType, r.mimo as string ?? mimo[0]);

    const id = `var-${baseName}-${r.traffic}-${tripType}-${fadingType}-pc_${pl.loopProfile}${pl.attachType === 'staggered' ? '_stag' : ''}`.replace(/[^A-Za-z0-9_-]/g, '_');
    const settings = { settings: { loggingProfileName: 'rrc_debug', successCriteriaName: 'BLER Success', testCaseName: id, test_name: id } };
    const input = { cellConfig: cells.cellConfig, subsConfig: subscribers.subsConfig, userPlaneConfig: userPlane.userPlaneConfig, powerCycleConfig: powerCycle.powerCycleConfig, mobilityConfig: mobility.mobilityConfig, settings: settings.settings };
    const tags = [rat, `traffic:${r.traffic}`, `trip:${tripType}`, `fading:${fadingType}`, `loop:${pl.loopProfile}`, 'variation'];
    out.push({ id, rat, description: `${baseName} · ${r.traffic} · ${tripType} · ${fadingType} · ${pl.loopProfile}`, cells, subscribers, userPlane, powerCycle, mobility, settings, input, tags });
  }
  return req.cap ? out.slice(0, req.cap) : out;
}

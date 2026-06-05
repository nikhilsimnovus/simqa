// NEGATIVE testing of the /tests/* test-creator: hundreds of invalid configs
// (bad IMSI/K length, bad band/bw/ARFCN, bad enums, type mismatches, missing
// fields, out-of-range). Each case is EXPECTED to be rejected (4xx). Verdict:
//   REJECTED (4xx)  -> PASS (validation working)
//   ACCEPTED (2xx)  -> FAIL = validation gap (the box let invalid input through)
//   5xx / network   -> ERROR (crash / robustness issue)
// REST-API path (the same API the GUI calls). No executions — fast.
import * as fs from 'fs';
import * as path from 'path';
import { ensureToken } from '../src/lib/uesimClient';

const HOST = '192.168.10.202';
const api = { host: HOST, username: 'admin', password: 'admin' };
const mob = { antennaType: 'isotropic', position: [4, 3], referencePower: -25, ulAttenuation: 60 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call(method: string, p: string, body?: unknown): Promise<{ status: number; text: string }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const tok = await ensureToken(api.host, api.username, api.password);
      const r = await fetch(`http://${api.host}/v2${p}`, { method, headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
      return { status: r.status, text: (await r.text()).slice(0, 200) };
    } catch (e: any) { if (attempt === 2) return { status: 0, text: 'NETERR ' + (e?.message ?? e) }; await sleep(1500); }
  }
  return { status: 0, text: 'NETERR' };
}
const del = (id: string) => call('DELETE', `/testcases/${id}`);

// ---- valid bases (LTE + NR-SA) ----
const clone = (o: any) => JSON.parse(JSON.stringify(o));
const lteCells = () => ({ cellConfig: { master: { product: 'UE-SIM', ratType: 'smartphone', carrierAggregation: false, channelSim: false, pdcchDecodeOpt: true, pdcchDecodeOptThreshold: 0.1, turboIteration: 14 }, cells: [{ cellType: '4g', syncId: 0, duplexMode: 'FDD', band: '1', EARFCN: { dl: 300, ul: 18300 }, bandwidth: '5', prach: 0, antennas: { dl: 1, ul: 1 }, rfCard: 0, rxToTxLatency: 4, txGain: [70], rxGain: [0], globalTimingAdvance: -1, mobility: mob }] } });
const lteSubs = () => ({ subsConfig: { subs: [{ ueCount: 1, servingCell: 0, startingIMSI: 1010123456789, nextIMSI: 1, algorithm: 'milenage', sharedKey: '00112233445566778899aabbccddeeff', op: '000102030405060708090A0B0C0D0E0F', resLength: 8, securityContext: true, asRelease: 13, redCap: false, ueCategoryType: 'combined', ueCategory: '6', imeisv: '4085780000000102', powerControl: false, attachType: 'normal', ueInitiatedEvents: 'rrc', eventsInLoop: false, triggerTime: [10], pdnType: 'ipv4', defaultApn: '', cipherAlgorithm: ['eea0', 'eea1', 'eea2'], integrityAlgorithm: ['eia0', 'eia1', 'eia2'], cqi: 'auto', ri: 'auto', pmi: 'auto', preambleIndex: 0 }] } });
const upNoData = () => ({ userPlaneConfig: { profiles: [{ subscriberGroup: [0], dataType: 'no_data', pdnType: 'ipv4', apnName: '' }] } });
const pcDisable = () => ({ powerCycleConfig: { profiles: [{ subscriberGroup: [0], loopProfile: 'disable', attachType: 'bursty', attachRate: 1, attachDelay: 0, powerOnTime: 60, powerOffTime: 10 }] } });

// set a nested path "a.b[0].c" = value
function setPath(o: any, p: string, v: any) { const parts = p.replace(/\[(\d+)\]/g, '.$1').split('.'); let cur = o; for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]]; cur[parts[parts.length - 1]] = v; }
function delPath(o: any, p: string) { const parts = p.replace(/\[(\d+)\]/g, '.$1').split('.'); let cur = o; for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]]; delete cur[parts[parts.length - 1]]; }

interface Neg { section: 'cells' | 'subscribers' | 'user-plane' | 'power-cycle' | 'mobility' | 'settings'; field: string; label: string; mutate: (b: any) => void; }
const negs: Neg[] = [];
const add = (section: Neg['section'], field: string, value: any, label?: string) => negs.push({ section, field, label: label ?? `${field}=${JSON.stringify(value)}`, mutate: (b) => setPath(b, field, value) });
const addDel = (section: Neg['section'], field: string) => negs.push({ section, field, label: `${field}=<omitted>`, mutate: (b) => delPath(b, field) });

// ---------- CELLS negatives ----------
const C = 'cellConfig.cells[0].';
for (const v of ['999', 'n999', 'abc', '', 0, -1, 'n78abc']) add('cells', C + 'band', v, `band=${JSON.stringify(v)}`);
for (const v of ['7', '0', '13', 'abc', 999, -5, '', 1.4]) add('cells', C + 'bandwidth', v, `bandwidth=${JSON.stringify(v)}`);
for (const v of [-1, 0, 999999999, 'abc', null, 70000]) add('cells', C + 'EARFCN.dl', v, `EARFCN.dl=${JSON.stringify(v)}`);
for (const v of [-1, 'abc', 999999999]) add('cells', C + 'EARFCN.ul', v, `EARFCN.ul=${JSON.stringify(v)}`);
for (const v of [0, -1, 99, 3, 'abc']) add('cells', C + 'antennas.dl', v, `antennas.dl=${JSON.stringify(v)}`);
for (const v of [2, 4, 0, -1, 99]) add('cells', C + 'antennas.ul', v, `antennas.ul=${JSON.stringify(v)} (LTE ul must be 1)`);
for (const v of ['XDD', 'fdd', '', 5]) add('cells', C + 'duplexMode', v);
for (const v of ['6g', '3g', '', 4]) add('cells', C + 'cellType', v);
for (const v of [-1, 9999, 'abc']) add('cells', C + 'prach', v);
for (const v of ['foo', '', 5]) add('cells', 'cellConfig.master.ratType', v, `master.ratType=${JSON.stringify(v)}`);
addDel('cells', C + 'band'); addDel('cells', C + 'bandwidth'); addDel('cells', C + 'EARFCN'); addDel('cells', 'cellConfig.master.product');
add('cells', 'cellConfig.master.product', 'NOT-UE-SIM', 'master.product=bad');

// ---------- SUBSCRIBERS negatives ----------
const S = 'subsConfig.subs[0].';
for (const v of [123456789, 1234567, 0, -1, 'abc', '', 12.5]) add('subscribers', S + 'startingIMSI', v, `startingIMSI=${JSON.stringify(v)} (must be 15-digit uint)`);
add('subscribers', S + 'startingIMSI', '001010123456789', 'startingIMSI=string(15)');
for (const v of ['001122', '00112233445566778899aabbccddeeffAA', 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz', '', '00112233445566778899aabbccddee', 12345]) add('subscribers', S + 'sharedKey', v, `sharedKey(K)=${JSON.stringify(v)} (must be 32 hex)`);
for (const v of ['00010203', 'zz', '', '000102030405060708090A0B0C0D0E0FAA']) add('subscribers', S + 'op', v, `op=${JSON.stringify(v)}`);
for (const v of ['foo', '', 5, 'aes']) add('subscribers', S + 'algorithm', v);
for (const v of [99, 0, -1, 'abc', 12.5]) add('subscribers', S + 'asRelease', v);
for (const v of [0, -1, 'abc', 100000000, 1.5]) add('subscribers', S + 'ueCount', v);
for (const v of ['999', '', 'foo'] ) add('subscribers', S + 'ueCategory', v);
for (const v of ['ipvX', 'ipv5', '', 4]) add('subscribers', S + 'pdnType', v);
for (const v of [['xxx'], ['nea9'], 'nea0', []]) add('subscribers', S + 'cipherAlgorithm', v);
for (const v of [['yyy'], ['nia9']]) add('subscribers', S + 'integrityAlgorithm', v);
for (const v of [-1, 'abc', 99]) add('subscribers', S + 'preambleIndex', v);
for (const v of [-1, 0, 'abc']) add('subscribers', S + 'resLength', v);
addDel('subscribers', S + 'startingIMSI'); addDel('subscribers', S + 'sharedKey'); addDel('subscribers', S + 'algorithm'); addDel('subscribers', S + 'ueCount');

// ---------- USER-PLANE negatives ----------
const U = 'userPlaneConfig.profiles[0].';
for (const v of ['foo', '', 5, 'sms']) negs.push({ section: 'user-plane', field: U + 'dataType', label: `dataType=${JSON.stringify(v)}`, mutate: (b) => { b.userPlaneConfig.profiles[0] = { subscriberGroup: [0], dataType: v, pdnType: 'ipv4', apnName: '' }; } });
for (const v of ['sctp', 'foo', '']) negs.push({ section: 'user-plane', field: U + 'transportProtocol', label: `udp->transport=${JSON.stringify(v)}`, mutate: (b) => { b.userPlaneConfig.profiles[0] = { subscriberGroup: [0], dataType: 'iperf', transportProtocol: v, serverIpAddress: '192.168.2.1', portRange: 5000, pdnType: 'ipv4', apnName: '', sessionDuration: 60, dataDirection: 'both', dataBitrate: { dl: { unit: 'mbps', value: 100 }, ul: { unit: 'mbps', value: 50 } } }; } });
for (const v of [-1, 'abc']) negs.push({ section: 'user-plane', field: U + 'sessionDuration', label: `sessionDuration=${JSON.stringify(v)}`, mutate: (b) => { b.userPlaneConfig.profiles[0] = { subscriberGroup: [0], dataType: 'iperf', transportProtocol: 'udp', serverIpAddress: '192.168.2.1', portRange: 5000, pdnType: 'ipv4', apnName: '', sessionDuration: v, dataDirection: 'both', dataBitrate: { dl: { unit: 'mbps', value: 100 }, ul: { unit: 'mbps', value: 50 } } }; } });
for (const v of ['sideways', '', 5]) negs.push({ section: 'user-plane', field: U + 'dataDirection', label: `dataDirection=${JSON.stringify(v)}`, mutate: (b) => { b.userPlaneConfig.profiles[0] = { subscriberGroup: [0], dataType: 'iperf', transportProtocol: 'udp', serverIpAddress: '192.168.2.1', portRange: 5000, pdnType: 'ipv4', apnName: '', sessionDuration: 60, dataDirection: v, dataBitrate: { dl: { unit: 'mbps', value: 100 }, ul: { unit: 'mbps', value: 50 } } }; } });
for (const v of ['999.999.999.999', 'not-an-ip']) negs.push({ section: 'user-plane', field: U + 'serverIpAddress', label: `serverIp=${JSON.stringify(v)}`, mutate: (b) => { b.userPlaneConfig.profiles[0] = { subscriberGroup: [0], dataType: 'iperf', transportProtocol: 'udp', serverIpAddress: v, portRange: 5000, pdnType: 'ipv4', apnName: '', sessionDuration: 60, dataDirection: 'both', dataBitrate: { dl: { unit: 'mbps', value: 100 }, ul: { unit: 'mbps', value: 50 } } }; } });

// ---------- POWER-CYCLE negatives ----------
const P = 'powerCycleConfig.profiles[0].';
for (const v of ['foo', '', 5]) add('power-cycle', P + 'loopProfile', v);
for (const v of ['foo', '', 5]) add('power-cycle', P + 'attachType', v);
for (const v of [-1, 'abc']) add('power-cycle', P + 'powerOnTime', v);
for (const v of [-1, 'abc']) add('power-cycle', P + 'powerOffTime', v);

// ---------- MOBILITY negatives ----------
const M = 'mobilityConfig.profiles[0].';
for (const v of ['foo', '', 5]) add('mobility', M + 'tripType', v);
for (const v of ['foo', '', 'AWGN']) add('mobility', M + 'fadingProfile.fadingType', v, `fadingType=${JSON.stringify(v)}`);
for (const v of ['extreme', '', 5]) add('mobility', M + 'fadingProfile.mimoCorrelation', v, `mimoCorrelation=${JSON.stringify(v)}`);
for (const v of ['foo', 5]) add('mobility', M + 'loopProfile', v);

// ---------- SETTINGS negatives ----------
add('settings', 'settings.loggingProfileName', 'cf-nonexistent-log', 'loggingProfileName=nonexistent');
add('settings', 'settings.loggingProfileName', '', 'loggingProfileName=empty');
add('settings', 'settings.successCriteriaName', 'cf-nonexistent-sc', 'successCriteriaName=nonexistent');
add('settings', 'settings.successCriteriaName', '', 'successCriteriaName=empty');

async function main() {
  const dir = path.join(process.cwd(), 'data', 'cf-report', 'negative');
  fs.mkdirSync(dir, { recursive: true });
  const rows: string[] = ['#,section,field/case,httpStatus,verdict,response'];
  const gaps: string[] = [];
  const counts = { total: 0, rejected: 0, accepted: 0, error: 0 };

  // Prereq testcases per section (reused; negative POSTs 400 so sections aren't created).
  const mk = async (steps: string[]) => { const c = await call('POST', '/tests/cells', lteCells()); const id = JSON.parse(c.text).testCaseId; if (steps.includes('subs')) await call('POST', `/tests/${id}/subscribers`, lteSubs()); if (steps.includes('up')) await call('POST', `/tests/${id}/user-plane`, upNoData()); if (steps.includes('pc')) await call('POST', `/tests/${id}/power-cycle`, pcDisable()); return id; };
  const base: Record<string, string> = {};
  base.subscribers = await mk([]);                       // cells only
  base['user-plane'] = await mk(['subs']);               // cells+subs
  base['power-cycle'] = await mk(['subs', 'up']);        // cells+subs+up
  base.mobility = await mk(['subs', 'up', 'pc']);        // cells+subs+up+pc
  base.settings = await mk(['subs', 'up', 'pc']);        // cells+subs+up+pc

  let i = 0;
  for (const n of negs) {
    i++;
    let status = 0, text = '';
    if (n.section === 'cells') {
      const body = lteCells(); try { n.mutate(body); } catch {}
      const r = await call('POST', '/tests/cells', body); status = r.status; text = r.text;
      if (status === 200) { try { await del(JSON.parse(text).testCaseId); } catch {} } // clean up if wrongly accepted
    } else {
      const id = base[n.section];
      const bodyFn: any = { subscribers: lteSubs, 'user-plane': upNoData, 'power-cycle': pcDisable, mobility: () => ({ mobilityConfig: { profiles: [{ subscriberGroup: [0], tripType: 'roundTrip', loopProfile: 'time', startDelay: 5, duration: 120, tripCount: 1, waitTime: 0, uePosition: [0, 0], speed: 5, direction: 0, distance: 50, fadingProfile: { fadingType: 'epa', frequencyDoppler: 70, mimoCorrelation: 'low' }, noiseSpectralDensity: -174 }] } }), settings: () => ({ settings: { loggingProfileName: 'rrc_debug', successCriteriaName: 'BLER Success', testCaseName: `cf-neg-${i}`, test_name: `cf-neg-${i}` } }) }[n.section];
      const body = bodyFn(); try { n.mutate(body); } catch {}
      const r = await call('POST', `/tests/${id}/${n.section}`, body); status = r.status; text = r.text;
    }
    counts.total++;
    let verdict: string;
    if (status >= 400 && status < 500) { verdict = 'PASS'; counts.rejected++; }
    else if (status >= 200 && status < 300) { verdict = 'FAIL-accepted'; counts.accepted++; gaps.push(`[${n.section}] ${n.label}`); }
    else { verdict = 'ERROR'; counts.error++; }
    rows.push([i, n.section, '"' + n.label.replace(/"/g, "'") + '"', status, verdict, '"' + text.replace(/"/g, "'").replace(/[\r\n]+/g, ' ') + '"'].join(','));
    if (i % 25 === 0) console.log(`  ...${i}/${negs.length} (rejected ${counts.rejected}, gaps ${counts.accepted}, err ${counts.error})`);
  }
  for (const id of Object.values(base)) await del(id).catch(() => {});

  fs.writeFileSync(path.join(dir, 'negative.csv'), rows.join('\n'));
  console.log(`\n=== NEGATIVE TEST SUMMARY (${counts.total} cases) ===`);
  console.log(`  correctly REJECTED (4xx): ${counts.rejected}`);
  console.log(`  wrongly ACCEPTED (2xx) = validation gaps: ${counts.accepted}`);
  console.log(`  ERROR (5xx/network): ${counts.error}`);
  if (gaps.length) { console.log('  --- validation gaps (invalid input accepted) ---'); for (const g of gaps) console.log('   ', g); }
  console.log(`  report: ${path.join(dir, 'negative.csv')}`);
}
main().catch((e) => { console.error('fatal', e); process.exit(1); });

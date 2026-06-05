// Validate MAX/TEST DURATION → ue.cfg. Create a 1-UE LTE test with a distinctive
// max duration (powerCycle.powerOnTime) + traffic sessionDuration, execute,
// retrieve ue.cfg, and assert:
//   powerOnTime  -> ue_list[].sim_events power_off start_time   (overall max duration)
//   sessionDuration -> ue_list[].traffic[].iperf[].session_duration
// Writes testcase.json + ue.cfg to data/cf-report/duration/ for upload.
import * as fs from 'fs';
import * as path from 'path';
import { loadInventory } from '../src/lib/inventory';
import { createTestCase, deleteTestCase, type ApiOpts } from '../src/lib/configFidelity/testCreator';
import { generateAndRetrieveUeCfg } from '../src/lib/configFidelity/ueCfg';
import { ensureToken } from '../src/lib/uesimClient';
import type { Case } from '../src/lib/configFidelity/types';

const MAX_DURATION = Number(process.env.CF_MAXDUR ?? 654);   // overall max duration (powerOnTime)
const SESSION_DURATION = Number(process.env.CF_SESSION ?? 600);

const inv = loadInventory();
const apiSys = inv.systems.find((s) => s.id === 'simnovator-202')!;
const ueSim = inv.systems.find((s) => s.id === 'uesim-101')!;
const api: ApiOpts = { host: apiSys.host, username: apiSys.uesim?.username ?? 'admin', password: apiSys.uesim?.password ?? 'admin' };
const mob = { antennaType: 'isotropic', position: [4, 3], referencePower: -25, ulAttenuation: 60 };

async function main() {
  const name = `cf-maxdur-${Date.now().toString(36)}`;
  const cells = { cellConfig: { master: { product: 'UE-SIM', ratType: 'smartphone', carrierAggregation: false, channelSim: false, pdcchDecodeOpt: true, pdcchDecodeOptThreshold: 0.1, turboIteration: 14 }, cells: [{ cellType: '4g', syncId: 0, duplexMode: 'FDD', band: '1', EARFCN: { dl: 300, ul: 18300 }, bandwidth: '5', prach: 0, antennas: { dl: 1, ul: 1 }, rfCard: 0, rxToTxLatency: 4, txGain: [70], rxGain: [0], globalTimingAdvance: -1, mobility: mob }] } };
  const subscribers = { subsConfig: { subs: [{ ueCount: 1, servingCell: 0, startingIMSI: 1010123456789, nextIMSI: 1, algorithm: 'milenage', sharedKey: '00112233445566778899aabbccddeeff', op: '000102030405060708090A0B0C0D0E0F', resLength: 8, securityContext: true, asRelease: 13, redCap: false, ueCategoryType: 'combined', ueCategory: '6', imeisv: '4085780000000102', powerControl: false, attachType: 'normal', ueInitiatedEvents: 'rrc', eventsInLoop: false, triggerTime: [10], pdnType: 'ipv4', defaultApn: '', cipherAlgorithm: ['eea0', 'eea1', 'eea2'], integrityAlgorithm: ['eia0', 'eia1', 'eia2'], cqi: 'auto', ri: 'auto', pmi: 'auto', preambleIndex: 0 }] } };
  const userPlane = { userPlaneConfig: { profiles: [{ subscriberGroup: [0], dataType: 'iperf', transportProtocol: 'udp', serverIpAddress: '192.168.2.1', portRange: 5000, pdnType: 'ipv4', apnName: '', startDelay: 5, sessionDuration: SESSION_DURATION, dataLoop: false, loopCount: 0, interSessionGap: 5, dataDirection: 'both', dataBitrate: { dl: { unit: 'mbps', value: 100 }, ul: { unit: 'mbps', value: 50 } }, payloadLength: 1000, mtuSize: 1500 }] } };
  const powerCycle = { powerCycleConfig: { profiles: [{ subscriberGroup: [0], loopProfile: 'disable', attachType: 'bursty', attachRate: 1, attachDelay: 0, powerOnTime: MAX_DURATION, powerOffTime: 10 }] } };
  const settings = { settings: { loggingProfileName: 'rrc_debug', successCriteriaName: 'BLER Success', testCaseName: name, test_name: name } };
  const input = { cellConfig: cells.cellConfig, subsConfig: subscribers.subsConfig, userPlaneConfig: userPlane.userPlaneConfig, powerCycleConfig: powerCycle.powerCycleConfig, settings: settings.settings };
  const c: Case = { id: name, rat: 'lte', description: name, cells, subscribers, userPlane, powerCycle, settings, input, tags: [] };

  const dir = path.join(process.cwd(), 'data', 'cf-report', 'duration');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'testcase.json'), JSON.stringify(input, null, 2));

  let testCaseId: string | undefined;
  try {
    const created = await createTestCase(api, c); testCaseId = created.testCaseId;
    console.log('created', testCaseId, 'maxDuration(powerOnTime)=', MAX_DURATION, 'sessionDuration=', SESSION_DURATION);
    const gen = await generateAndRetrieveUeCfg({ api, ueSimSystem: ueSim as any, testCaseId, pollTimeoutMs: 75000, expectedName: name });
    if (!gen.ueCfg) { console.log('FAIL: no ue.cfg'); return; }
    fs.writeFileSync(path.join(dir, 'ue.cfg'), gen.rawUeCfg ?? JSON.stringify(gen.ueCfg, null, 2));
    const u0 = gen.ueCfg.ue_list?.[0] ?? {};
    const powerOff = (u0.sim_events ?? []).find((e: any) => e.event === 'power_off')?.start_time;
    const sessDur = u0.traffic?.[0]?.iperf?.[0]?.session_duration;
    console.log('ue.cfg power_off start_time =', powerOff, '(expected', MAX_DURATION + ')', powerOff === MAX_DURATION ? 'PASS' : 'MISMATCH');
    console.log('ue.cfg session_duration    =', sessDur, '(expected', SESSION_DURATION + ')', sessDur === SESSION_DURATION ? 'PASS' : 'MISMATCH');
    console.log('ue.cfg bytes:', (gen.rawUeCfg ?? '').length, '-> wrote', path.join(dir, 'ue.cfg'));
  } finally {
    if (testCaseId) await deleteTestCase(api, testCaseId).catch(() => {});
  }
}
main().catch((e) => { console.error('fatal', e); process.exit(1); });

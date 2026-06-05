// Apply + validate LOG PROFILES and SUCCESS CRITERIA (config stored).
//   Log profile:  for each profile in GET /v2/system/log-settings, create a
//     test case with settings.loggingProfileName=<profile>, execute, retrieve
//     ue.cfg, and assert ue.cfg.log_options matches the profile's per-layer
//     levels (NAS/RRC/PDCP/RLC/MAC/PHY/IP/SIP).
//   Success criteria: create with settings.successCriteriaName=<name>, then
//     GET /tests/{id}/settings and assert it is stored (config-stored-only).
import { loadInventory, uesimApiOptsForSystem } from '../src/lib/inventory';
import { ensureToken } from '../src/lib/uesimClient';
import { createTestCase, deleteTestCase, type ApiOpts } from '../src/lib/configFidelity/testCreator';
import { generateAndRetrieveUeCfg } from '../src/lib/configFidelity/ueCfg';
import type { Case } from '../src/lib/configFidelity/types';

const inv = loadInventory();
const apiSys = inv.systems.find((s) => s.id === 'simnovator-202')!;
const ueSim = inv.systems.find((s) => s.id === 'uesim-101')!;
const api: ApiOpts = { host: apiSys.host, username: apiSys.uesim?.username ?? 'admin', password: apiSys.uesim?.password ?? 'admin' };
const mob = { antennaType: 'isotropic', position: [4, 3], referencePower: -25, ulAttenuation: 60 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api2<T>(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const tok = await ensureToken(api.host, api.username, api.password);
  const r = await fetch(`http://${api.host}/v2${path}`, { method, headers: { Authorization: `Bearer ${tok}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let json: any; try { json = t ? JSON.parse(t) : undefined; } catch {}
  return { status: r.status, json };
}

function baseCase(name: string, loggingProfileName: string, successCriteriaName: string): Case {
  const cells = { cellConfig: { master: { product: 'UE-SIM', ratType: 'smartphone', carrierAggregation: false, channelSim: false, pdcchDecodeOpt: true, pdcchDecodeOptThreshold: 0.1, turboIteration: 14 }, cells: [{ cellType: '4g', syncId: 0, duplexMode: 'FDD', band: '1', EARFCN: { dl: 300, ul: 18300 }, bandwidth: '5', prach: 0, antennas: { dl: 1, ul: 1 }, rfCard: 0, rxToTxLatency: 4, txGain: [70], rxGain: [0], globalTimingAdvance: -1, mobility: mob }] } };
  const subscribers = { subsConfig: { subs: [{ ueCount: 1, servingCell: 0, startingIMSI: 1010123456789, nextIMSI: 1, algorithm: 'milenage', sharedKey: '00112233445566778899aabbccddeeff', op: '000102030405060708090A0B0C0D0E0F', resLength: 8, securityContext: true, asRelease: 13, redCap: false, ueCategoryType: 'combined', ueCategory: '6', imeisv: '4085780000000102', powerControl: false, attachType: 'normal', ueInitiatedEvents: 'rrc', eventsInLoop: false, triggerTime: [10], pdnType: 'ipv4', defaultApn: '', cipherAlgorithm: ['eea0', 'eea1', 'eea2'], integrityAlgorithm: ['eia0', 'eia1', 'eia2'], cqi: 'auto', ri: 'auto', pmi: 'auto', preambleIndex: 0 }] } };
  const userPlane = { userPlaneConfig: { profiles: [{ subscriberGroup: [0], dataType: 'no_data', pdnType: 'ipv4', apnName: '' }] } };
  const powerCycle = { powerCycleConfig: { profiles: [{ subscriberGroup: [0], loopProfile: 'disable', attachType: 'bursty', attachRate: 1, attachDelay: 0, powerOnTime: 2000, powerOffTime: 10 }] } };
  const settings = { settings: { loggingProfileName, successCriteriaName, testCaseName: name, test_name: name } };
  const input = { cellConfig: cells.cellConfig, subsConfig: subscribers.subsConfig, userPlaneConfig: userPlane.userPlaneConfig, powerCycleConfig: powerCycle.powerCycleConfig, settings: settings.settings };
  return { id: name, rat: 'lte', description: name, cells, subscribers, userPlane, powerCycle, settings, input, tags: [] };
}

/** Parse ue.cfg.log_options "rrc.level=debug,mac.level=none,..." -> {rrc:'debug',...} */
function parseLogOptions(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(s || '').split(',')) { const m = part.trim().match(/^([a-z0-9]+)\.level\s*=\s*(\w+)/i); if (m) out[m[1].toLowerCase()] = m[2].toLowerCase(); }
  return out;
}
const LAYER_KEY: Record<string, string> = { NAS: 'nas', RRC: 'rrc', PDCP: 'pdcp', RLC: 'rlc', MAC: 'mac', PHY: 'phy', IP: 'ip', SIP: 'sip' };

async function main() {
  const stamp = `${Date.now().toString(36)}`;
  const sims = await api2('GET', '/simulators'); const simulatorId = sims.json?.items?.[0]?.id;

  // ---- LOG PROFILES ----
  const ls = await api2('GET', '/system/log-settings');
  const profiles: Array<{ name: string; layers: Record<string, any> }> = ls.json?.items ?? [];
  console.log(`=== LOG PROFILES (${profiles.map((p) => p.name).join(', ')}) ===`);
  for (const prof of profiles) {
    const name = `cf-log-${prof.name}-${stamp}`;
    let testCaseId: string | undefined;
    try {
      const created = await createTestCase(api, baseCase(name, prof.name, 'BLER Success'));
      testCaseId = created.testCaseId;
      const gen = await generateAndRetrieveUeCfg({ api, ueSimSystem: ueSim as any, testCaseId, simulatorId, pollTimeoutMs: 75000, expectedName: name });
      if (!gen.ueCfg) { console.log(`  ${prof.name}: FAIL — no ue.cfg`); continue; }
      const got = parseLogOptions(gen.ueCfg.log_options);
      const diffs: string[] = [];
      for (const [LAYER, key] of Object.entries(LAYER_KEY)) {
        const exp = String(prof.layers?.[LAYER]?.level ?? '').toLowerCase();
        if (!exp) continue;
        // An omitted layer in log_options means that layer is not logged = none.
        const actual = got[key] ?? 'none';
        if (actual !== exp) diffs.push(`${key}: exp=${exp} got=${actual}`);
      }
      console.log(`  ${prof.name}: ${diffs.length === 0 ? 'PASS — log_options matches all layers' : 'FAIL — ' + diffs.join('; ')}`);
    } catch (e: any) { console.log(`  ${prof.name}: ERROR ${e?.message ?? e}`); }
    finally { if (testCaseId) await deleteTestCase(api, testCaseId).catch(() => {}); await sleep(1500); }
  }

  // ---- SUCCESS CRITERIA (config stored only) ----
  console.log('=== SUCCESS CRITERIA (stored check) ===');
  for (const crit of ['BLER Success', `cf-bogus-${stamp}`]) {
    const name = `cf-sc-${crit.replace(/[^A-Za-z0-9]/g, '_')}-${stamp}`;
    let testCaseId: string | undefined;
    try {
      const created = await createTestCase(api, baseCase(name, 'rrc_debug', crit));
      testCaseId = created.testCaseId;
      const got = await api2('GET', `/tests/${testCaseId}/settings`);
      const stored = got.json?.settings?.successCriteriaName;
      console.log(`  "${crit}": created=ok stored="${stored}" -> ${stored === crit ? 'STORED ✓' : 'MISMATCH (' + stored + ')'}`);
    } catch (e: any) {
      // A create rejection here means the box validates the criteria name.
      console.log(`  "${crit}": create rejected -> ${String(e?.message ?? e).slice(0, 120)}`);
    } finally { if (testCaseId) await deleteTestCase(api, testCaseId).catch(() => {}); await sleep(1000); }
  }
}
main().catch((e) => { console.error('fatal', e); process.exit(1); });

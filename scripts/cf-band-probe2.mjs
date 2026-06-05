const HOST = '192.168.10.202';
const T = await (await fetch(`http://${HOST}/v2/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin' }) })).json().then(j => j.access_token);
const H = { Authorization: `Bearer ${T}`, 'Content-Type': 'application/json' };
const mob = { antennaType: 'isotropic', position: [4, 3], referencePower: -25, ulAttenuation: 60 };
const post = async (p, b) => { const r = await fetch(`http://${HOST}/v2${p}`, { method: 'POST', headers: H, body: JSON.stringify(b) }); const t = await r.text(); return { s: r.status, t }; };
const del = (id) => fetch(`http://${HOST}/v2/testcases/${id}`, { method: 'DELETE', headers: H }).catch(() => {});

// ---- LTE band 2 (1.4MHz CSV → bw5) full chain, find which step 400s ----
console.log('=== LTE band 2 (bw5) ===');
let r = await post('/tests/cells', { cellConfig: { master: { product: 'UE-SIM', ratType: 'smartphone', carrierAggregation: false, channelSim: false, pdcchDecodeOpt: true, pdcchDecodeOptThreshold: 0.1, turboIteration: 14 }, cells: [{ cellType: '4g', syncId: 0, duplexMode: 'FDD', band: '2', EARFCN: { dl: 607, ul: 18607 }, bandwidth: '5', prach: 0, antennas: { dl: 1, ul: 1 }, rfCard: 0, rxToTxLatency: 4, txGain: [70], rxGain: [0], globalTimingAdvance: -1, mobility: mob }] } });
console.log('cells', r.s, r.t.slice(0, 200));
const id = JSON.parse(r.t).testCaseId;
if (id) {
  r = await post(`/tests/${id}/subscribers`, { subsConfig: { subs: [{ ueCount: 1, servingCell: 0, startingIMSI: 1010123456789, nextIMSI: 1, algorithm: 'milenage', sharedKey: '00112233445566778899aabbccddeeff', op: '000102030405060708090A0B0C0D0E0F', resLength: 8, securityContext: true, asRelease: 13, redCap: false, ueCategoryType: 'combined', ueCategory: '6', imeisv: '4085780000000102', powerControl: false, attachType: 'normal', ueInitiatedEvents: 'rrc', eventsInLoop: false, triggerTime: [10], pdnType: 'ipv4', defaultApn: '', cipherAlgorithm: ['eea0', 'eea1', 'eea2'], integrityAlgorithm: ['eia0', 'eia1', 'eia2'], cqi: 'auto', ri: 'auto', pmi: 'auto', preambleIndex: 0 }] } });
  console.log('subs', r.s, r.t.slice(0, 200));
  r = await post(`/tests/${id}/user-plane`, { userPlaneConfig: { profiles: [{ subscriberGroup: [0], dataType: 'no_data', pdnType: 'ipv4', apnName: '' }] } });
  console.log('uplane', r.s, r.t.slice(0, 120));
  r = await post(`/tests/${id}/power-cycle`, { powerCycleConfig: { profiles: [{ subscriberGroup: [0], loopProfile: 'disable', attachType: 'bursty', attachRate: 1, attachDelay: 0, powerOnTime: 2000, powerOffTime: 10 }] } });
  console.log('pcyc', r.s, r.t.slice(0, 120));
  r = await post(`/tests/${id}/settings`, { settings: { loggingProfileName: 'rrc_debug', successCriteriaName: 'BLER Success', testCaseName: 'cf-probe-lteb2', test_name: 'cf-probe-lteb2' } });
  console.log('settings', r.s, r.t.slice(0, 250));
  await del(id);
}

// ---- LTE band 2 with bw3 (does smaller bw fit the edge ARFCN?) ----
console.log('\n=== LTE band 2 (bw3) cells only ===');
r = await post('/tests/cells', { cellConfig: { master: { product: 'UE-SIM', ratType: 'smartphone', carrierAggregation: false, channelSim: false, pdcchDecodeOpt: true, pdcchDecodeOptThreshold: 0.1, turboIteration: 14 }, cells: [{ cellType: '4g', syncId: 0, duplexMode: 'FDD', band: '2', EARFCN: { dl: 607, ul: 18607 }, bandwidth: '3', prach: 0, antennas: { dl: 1, ul: 1 }, rfCard: 0, rxToTxLatency: 4, txGain: [70], rxGain: [0], globalTimingAdvance: -1, mobility: mob }] } });
console.log('cells bw3', r.s, r.t.slice(0, 200)); { const i = JSON.parse(r.t).testCaseId; if (i) { const sr = await post(`/tests/${i}/subscribers`, { subsConfig: { subs: [{ ueCount: 1, servingCell: 0, startingIMSI: 1010123456789, nextIMSI: 1, algorithm: 'milenage', sharedKey: '00112233445566778899aabbccddeeff', op: '000102030405060708090A0B0C0D0E0F', resLength: 8, securityContext: true, asRelease: 13, redCap: false, ueCategoryType: 'combined', ueCategory: '6', imeisv: '4085780000000102', powerControl: false, attachType: 'normal', ueInitiatedEvents: 'rrc', eventsInLoop: false, triggerTime: [10], pdnType: 'ipv4', defaultApn: '', cipherAlgorithm: ['eea0', 'eea1', 'eea2'], integrityAlgorithm: ['eia0', 'eia1', 'eia2'], cqi: 'auto', ri: 'auto', pmi: 'auto', preambleIndex: 0 }] } }); const up = await post(`/tests/${i}/user-plane`, { userPlaneConfig: { profiles: [{ subscriberGroup: [0], dataType: 'no_data', pdnType: 'ipv4', apnName: '' }] } }); const pc = await post(`/tests/${i}/power-cycle`, { powerCycleConfig: { profiles: [{ subscriberGroup: [0], loopProfile: 'disable', attachType: 'bursty', attachRate: 1, attachDelay: 0, powerOnTime: 2000, powerOffTime: 10 }] } }); const st = await post(`/tests/${i}/settings`, { settings: { loggingProfileName: 'rrc_debug', successCriteriaName: 'BLER Success', testCaseName: 'cf-probe-lteb2-bw3', test_name: 'cf-probe-lteb2-bw3' } }); console.log('  subs',sr.s,'up',up.s,'pcyc',pc.s,'settings',st.s, st.s!==200?st.t.slice(0,200):''); await del(i); } }

// ---- NBIOT band 1 subscriber: get full error ----
console.log('\n=== NBIOT band 1 subscriber ===');
r = await post('/tests/cells', { cellConfig: { master: { product: 'UE-SIM', ratType: 'nbiot', carrierAggregation: false, pdcchDecodeOpt: true, pdcchDecodeOptThreshold: 0.1, turboIteration: 14 }, cells: [{ cellType: '4g', syncId: 0, duplexMode: 'FDD', band: '1', EARFCN: { dl: 300, ul: 18300 }, bandwidth: '1.4', prach: 0, antennas: { dl: 1, ul: 1 }, rfCard: 0, rxToTxLatency: 4, txGain: [70], rxGain: [0], globalTimingAdvance: -1, mobility: mob }] } });
console.log('cells', r.s);
const nid = JSON.parse(r.t).testCaseId;
if (nid) {
  r = await post(`/tests/${nid}/subscribers`, { subsConfig: { subs: [{ ueCount: 1, servingCell: 0, startingIMSI: 1010123456789, nextIMSI: 1, algorithm: 'milenage', sharedKey: '00112233445566778899aabbccddeeff', op: '000102030405060708090A0B0C0D0E0F', resLength: 8, securityContext: true, asRelease: 13, redCap: false, ueCategoryType: 'combined', ueCategory: 'nbiot NB1', multiTone: true, multiCarrier: true, twoHarq: false, attachType: 'normal', ueInitiatedEvents: 'rrc', eventsInLoop: false, triggerTime: [10], pdnType: 'ipv4', defaultApn: '', preambleIndex: 0, CIOTOpt: true, halfDuplex: true, cipherAlgorithm: ['eea0', 'eea1', 'eea2'], integrityAlgorithm: ['eia0', 'eia1', 'eia2'], cqi: 'auto', ri: 'auto', pmi: 'auto' }] } });
  console.log('nbiot subs', r.s, r.t.slice(0, 400));
  await del(nid);
}

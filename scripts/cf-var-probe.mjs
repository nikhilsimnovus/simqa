// Probe variation bodies: every traffic type, plus mobility+fading(channelSim)
// and power-cycle loop=count. Create+delete only (no executions).
const HOST = '192.168.10.202';
const T = await (await fetch(`http://${HOST}/v2/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin' }) })).json().then(j => j.access_token);
const H = { Authorization: `Bearer ${T}`, 'Content-Type': 'application/json' };
const mob = { antennaType: 'isotropic', position: [4, 3], referencePower: -25, ulAttenuation: 60 };
const post = async (p, b) => { const r = await fetch(`http://${HOST}/v2${p}`, { method: 'POST', headers: H, body: JSON.stringify(b) }); return { s: r.status, t: await r.text() }; };
const del = (id) => fetch(`http://${HOST}/v2/testcases/${id}`, { method: 'DELETE', headers: H }).catch(() => {});

function lteCells(channelSim) {
  return { cellConfig: { master: { product: 'UE-SIM', ratType: 'smartphone', carrierAggregation: false, channelSim, pdcchDecodeOpt: true, pdcchDecodeOptThreshold: 0.1, turboIteration: 14 }, cells: [{ cellType: '4g', syncId: 0, duplexMode: 'FDD', band: '1', EARFCN: { dl: 300, ul: 18300 }, bandwidth: '5', prach: 0, antennas: { dl: 1, ul: 1 }, rfCard: 0, rxToTxLatency: 4, txGain: [70], rxGain: [0], globalTimingAdvance: -1, mobility: mob }] } };
}
const lteSubs = { subsConfig: { subs: [{ ueCount: 2, servingCell: 0, startingIMSI: 1010123456789, nextIMSI: 1, algorithm: 'milenage', sharedKey: '00112233445566778899aabbccddeeff', op: '000102030405060708090A0B0C0D0E0F', resLength: 8, securityContext: true, asRelease: 13, redCap: false, ueCategoryType: 'combined', ueCategory: '6', imeisv: '4085780000000102', powerControl: false, attachType: 'normal', ueInitiatedEvents: 'rrc', eventsInLoop: false, triggerTime: [10], pdnType: 'ipv4', defaultApn: '', cipherAlgorithm: ['eea0', 'eea1', 'eea2'], integrityAlgorithm: ['eia0', 'eia1', 'eia2'], cqi: 'auto', ri: 'auto', pmi: 'auto', preambleIndex: 0 }] } };

const TRAFFIC = {
  udp: { subscriberGroup: [0], dataType: 'iperf', transportProtocol: 'udp', serverIpAddress: '192.168.2.1', portRange: 5000, pdnType: 'ipv4', apnName: '', startDelay: 5, sessionDuration: 60, dataLoop: false, loopCount: 0, interSessionGap: 5, dataDirection: 'both', dataBitrate: { dl: { unit: 'mbps', value: 100 }, ul: { unit: 'mbps', value: 50 } }, payloadLength: 1000, mtuSize: 1500 },
  volte: { subscriberGroup: [0], dataType: 'volte', pcscfIpAddress: '192.168.4.1', pdnType: 'ipv4', apnName: 'ims', realm: 'ims.mnc001.mcc001.3gppnetwork.org', startDelay: 5, sessionDuration: 100, dataLoop: false, loopCount: 0, InterSessionGap: 0, callSetupDelay: 5, callDuration: 80, countryCode: '91', telephoneNumber: '1234567890', codec: 'AMR-WB', videoCodec: 'ALL', authentication: 'HTTP-Digest', userName: 'ims', password: 'sim', registrationExpiry: 3600, precondition: true, AMF: '0x800', mtuSize: 1500, payloadLength: 1000, registrationOnly: true },
  ftp: { subscriberGroup: [0], dataType: 'ftp', serverIpAddress: '192.168.1.46', pdnType: 'ipv4', apnName: '', startDelay: 5, sessionDuration: 500, dataLoop: false, loopCount: 0, InterSessionGap: 0, dataDirection: 'both', mtuSize: 1500, anonymous: false, uplinkFilename: 'file1.json', downlinkFilename: 'file2.json', username: 'user_name', password: 'pass_word' },
  rtsp: { subscriberGroup: [0], dataType: 'rtsp', transportProtocol: 'udp', serverIpAddress: '192.168.1.46', portRange: 8554, apnName: '', startDelay: 5, sessionDuration: 500, dataLoop: false, loopCount: 0, InterSessionGap: 0, dataDirection: 'downlink', downlinkFilename: 'sample_60sec.mp4', codec: 'AAC', videoCodec: 'H265' },
  ping: { subscriberGroup: [0], dataType: 'ping', serverIpAddress: '192.168.1.46', pdnType: 'ipv4', apnName: '', startDelay: 5, sessionDuration: 500, dataLoop: false, interval: 1, packetSize: 56, numberOfPackets: 100 },
  http: { subscriberGroup: [0], dataType: 'http', urlAddress: 'https://www.google.com', pdnType: 'ipv4', apnName: '', startDelay: 5, sessionDuration: 500, dataLoop: false },
  sms: { subscriberGroup: [0], dataType: 'sms', sendTo: '63726867236', startDelay: 5, dataLoop: false, loopCount: 0, InterSessionGap: 0, message: 'Hi' },
  external: { subscriberGroup: [0], dataType: 'external', pdnType: 'ipv4', apnName: '', startDelay: 5, sessionDuration: 1800, dataLoop: false, loopCount: 0, InterSessionGap: 0 },
};

console.log('=== traffic types (user-plane create) ===');
for (const [name, prof] of Object.entries(TRAFFIC)) {
  const c = await post('/tests/cells', lteCells(false)); const id = JSON.parse(c.t).testCaseId;
  await post(`/tests/${id}/subscribers`, lteSubs);
  const up = await post(`/tests/${id}/user-plane`, { userPlaneConfig: { profiles: [prof] } });
  console.log(`  ${name}: up=${up.s} ${up.s !== 200 ? up.t.slice(0, 150) : ''}`);
  await del(id);
}

console.log('=== mobility + fading (channelSim) + power-cycle loop=count ===');
{
  const c = await post('/tests/cells', lteCells(true)); const id = JSON.parse(c.t).testCaseId;
  const subs = await post(`/tests/${id}/subscribers`, lteSubs);
  const up = await post(`/tests/${id}/user-plane`, { userPlaneConfig: { profiles: [{ subscriberGroup: [0], dataType: 'no_data', pdnType: 'ipv4', apnName: '' }] } });
  const pc = await post(`/tests/${id}/power-cycle`, { powerCycleConfig: { profiles: [{ subscriberGroup: [0], loopProfile: 'count', noOfPowerOnCycles: 3, attachType: 'bursty', attachRate: 1, attachDelay: 0, powerOnTime: 2000, powerOffTime: 10 }] } });
  const mo = await post(`/tests/${id}/mobility`, { mobilityConfig: { profiles: [{ subscriberGroup: [0], tripType: 'roundTrip', loopProfile: 'time', startDelay: 5, duration: 380, tripCount: 1, waitTime: 0, uePosition: [0, 0], speed: 1, direction: 0, distance: 50, fadingProfile: { fadingType: 'epa', frequencyDoppler: 70, mimoCorrelation: 'low' }, noiseSpectralDensity: -174 } ] } });
  console.log(`  subs=${subs.s} up=${up.s} powercycle(count)=${pc.s} ${pc.s !== 200 ? pc.t.slice(0, 140) : ''}`);
  console.log(`  mobility(fading epa)=${mo.s} ${mo.s !== 200 ? mo.t.slice(0, 200) : ''}`);
  await del(id);
}

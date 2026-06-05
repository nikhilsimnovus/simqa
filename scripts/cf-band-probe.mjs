const HOST = '192.168.10.202';
const T = await (await fetch(`http://${HOST}/v2/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin' }) })).json().then(j => j.access_token);
const H = { Authorization: `Bearer ${T}`, 'Content-Type': 'application/json' };
const mob = { antennaType: 'isotropic', position: [4, 3], referencePower: -25, ulAttenuation: 60 };
async function probe(label, body) {
  try {
    const r = await fetch(`http://${HOST}/v2/tests/cells`, { method: 'POST', headers: H, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    console.log(`${label}: ${r.status} ${j.testCaseId ? 'OK' : (j.message || JSON.stringify(j)).slice(0, 150)}`);
    if (j.testCaseId) await fetch(`http://${HOST}/v2/testcases/${j.testCaseId}`, { method: 'DELETE', headers: H }).catch(() => {});
  } catch (e) { console.log(`${label}: ERR ${e.message}`); }
}
const nrMaster = { product: 'UE-SIM', ratType: 'sa', carrierAggregation: false, channelSim: false, pdcchDecodeOpt: true, pdcchDecodeOptThreshold: 0.1, ldpcIteration: 12 };
const nrCell = (o) => ({ cellType: '5g', syncId: 0, prach: 0, antennas: { dl: 1, ul: 1 }, rfCard: 0, rxToTxLatency: 4, txGain: [80], rxGain: [0], globalTimingAdvance: -1, NTN: false, mobility: mob, ...o });
// NR FDD b1: ul=dl
await probe('NR-FDD-b1 ul=dl', { cellConfig: { master: nrMaster, cells: [nrCell({ duplexMode: 'FDD', band: 'n1', NRARFCN: { dl: 428040, ssb: 427950, ul: 428040 }, scs: 15, ssbScs: 15, bandwidth: '5' })] } });
// NR FDD b1: no ul
await probe('NR-FDD-b1 no-ul', { cellConfig: { master: nrMaster, cells: [nrCell({ duplexMode: 'FDD', band: 'n1', NRARFCN: { dl: 428040, ssb: 427950 }, scs: 15, ssbScs: 15, bandwidth: '5' })] } });
// NR FDD b1: real ul arfcn (1950.2MHz -> 390040)
await probe('NR-FDD-b1 ul=390040', { cellConfig: { master: nrMaster, cells: [nrCell({ duplexMode: 'FDD', band: 'n1', NRARFCN: { dl: 428040, ssb: 427950, ul: 390040 }, scs: 15, ssbScs: 15, bandwidth: '5' })] } });
// NR TDD b40
await probe('NR-TDD-b40', { cellConfig: { master: nrMaster, cells: [nrCell({ duplexMode: 'TDD', band: 'n40', NRARFCN: { dl: 470040, ssb: 469950, ul: 470040 }, scs: 30, ssbScs: 30, bandwidth: '10' })] } });
// LTE FDD b3 bw5
const lteMaster = { product: 'UE-SIM', ratType: 'smartphone', carrierAggregation: false, channelSim: false, pdcchDecodeOpt: true, pdcchDecodeOptThreshold: 0.1, turboIteration: 14 };
const lteCell = (o) => ({ cellType: '4g', syncId: 0, prach: 0, antennas: { dl: 1, ul: 1 }, rfCard: 0, rxToTxLatency: 4, txGain: [70], rxGain: [0], globalTimingAdvance: -1, mobility: mob, ...o });
await probe('LTE-FDD-b3 bw5', { cellConfig: { master: lteMaster, cells: [lteCell({ duplexMode: 'FDD', band: '3', EARFCN: { dl: 1207, ul: 19207 }, bandwidth: '5' })] } });
// CATM b3 (LTE cell)
await probe('CATM-b3 as LTE', { cellConfig: { master: lteMaster, cells: [lteCell({ duplexMode: 'FDD', band: '3', EARFCN: { dl: 1207, ul: 19207 }, bandwidth: '5' })] } });
// NBIOT b3 bw1.4
const nbMaster = { product: 'UE-SIM', ratType: 'nbiot', carrierAggregation: false, pdcchDecodeOpt: true, pdcchDecodeOptThreshold: 0.1, turboIteration: 14 };
await probe('NBIOT-b3 bw1.4', { cellConfig: { master: nbMaster, cells: [lteCell({ duplexMode: 'FDD', band: '3', EARFCN: { dl: 1575, ul: 19575 }, bandwidth: '1.4' })] } });
await probe('NBIOT-b3 bw1.4 +opMode', { cellConfig: { master: nbMaster, cells: [lteCell({ duplexMode: 'FDD', band: '3', EARFCN: { dl: 1575, ul: 19575 }, bandwidth: '1.4', operationMode: 'standalone' })] } });

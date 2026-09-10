// node --test src/lib/liveFidelity/compare.test.ts
//
// The fixtures are cut down from two real files the lab produced: a testcase
// whose ue.cfg matched, and the same testcase after four values were edited.
// Those two cases are the feature — a clean capture must read PASSED, an edited
// one must surface exactly what moved.
//
// The tests that matter most, though, are the ones about DIRECTION. The table is
// driven from the testcase, so a parameter the box silently dropped has to show
// up and has to fail. An earlier version walked the cfg instead, and a dropped
// parameter simply produced no row.

import test from 'node:test';
import assert from 'node:assert/strict';

const { compareCapture, valuesEqual, pairCells } = await import('./compare.ts');

function ueCfg(over: any = {}) {
  return {
    cell_groups: [{
      group_type: 'lte', multi_ue: true, pdsch_max_its: 6, cpu_core_list: [16, 17],
      cells: [
        { bandwidth: 5, dl_earfcn: 3450, ul_earfcn: 21450, global_timing_advance: 2, n_antenna_dl: 1, n_antenna_ul: 1, prach_delay: 0, rf_port: 0, sync_id: 0 },
        { bandwidth: 5, dl_earfcn: 3450, ul_earfcn: 21450, global_timing_advance: -1, n_antenna_dl: 1, n_antenna_ul: 1, prach_delay: 0, rf_port: 1, sync_id: 1 },
      ],
    }],
    rx_gain: [10, 10], tx_gain: [80, 80],
    log_filename: '/tmp/LTE_Mohan_copy.log',
    global_traffic: { ping: [{ ping0: { dest_ip: '20.10.10.1', packet_count: 295, packet_size: 56, interval: 1 } }] },
    ue_list: [
      { traffic: [{ ping: [{ profile_id: 'ping0', session_duration: 300, start_time: 5 }] }], imsi: '001010123456789', K: '00112233445566778899AABBCCDDEEFF', imeisv: '4085780000000102', as_release: 12, sim_algo: 'xor', attach_pdn_type: 'ipv4', ue_category: 6, use_security_context_for_registration: true, power_control_enabled: false, cell_index: 0, cipher_algo_bitmap: 224, integ_algo_bitmap: 224, ue_id: 1 },
      { traffic: [{ ping: [{ profile_id: 'ping0', session_duration: 300, start_time: 6 }] }], imsi: '001010123456790', K: '00112233445566778899AABBCCDDEEFF', imeisv: '4085780000000102', as_release: 12, sim_algo: 'xor', attach_pdn_type: 'ipv4', ue_category: 6, use_security_context_for_registration: true, power_control_enabled: false, cell_index: 0, cipher_algo_bitmap: 224, integ_algo_bitmap: 224, ue_id: 2 },
    ],
    ...over,
  };
}

function exportOf(over: { cell0?: any; sub0?: any; io?: any } = {}) {
  const intermediate = {
    cellConfig: {
      master: { ratType: 'smartphone', turboIteration: 6, channelSim: false, pdcchDecodeOpt: false, product: 'UE-SIM' },
      cells: [
        { cellType: '4g', band: '8', bandwidth: '5', EARFCN: { dl: 3450, ul: 21450 }, antennas: { dl: 1, ul: 1 }, globalTimingAdvance: 2, prach: 0, rfCard: 0, rxGain: [10], txGain: [80], channelSimP: false },
        { cellType: '4g', band: '8', bandwidth: '5', EARFCN: { dl: 3450, ul: 21450 }, antennas: { dl: 1, ul: 1 }, globalTimingAdvance: -1, prach: 0, rfCard: 1, rxGain: [10], txGain: [80], channelSimP: false },
      ],
    },
    subsConfig: {
      subs: [{
        ueCount: 2, servingCell: 0, startingIMSI: 1010123456789, nextIMSI: 1,
        sharedKey: '00112233445566778899aabbccddeeff', imeisv: '4085780000000102',
        asRelease: 12, algorithm: 'xor', pdnType: 'ipv4', ueCategory: '6',
        securityContext: true, powerControl: false,
        cipherAlgorithm: ['eea0', 'eea1', 'eea2'], integrityAlgorithm: ['eia0', 'eia1', 'eia2'],
        networkSlicing: 'disable', cellsLen: 1,
        ...(over.sub0 ?? {}),
      }],
    },
    userPlaneConfig: { profiles: [{ dataType: 'ping', networkSlicingP: false, startDelay: 5, sessionDuration: 300 }] },
    settings: { test_name: 'LTE_Mohan_copy', successCriteriaName: 'Attach Success', description: '' },
    ...(over.io ?? {}),
  };
  Object.assign(intermediate.cellConfig.cells[0], over.cell0 ?? {});
  return { test_case_details: [{ Test_Name: 'LTE_Mohan_copy', Test_Config_Intermediate_Object: intermediate }] };
}

const find = (r: any, path: string) => r.rows.find((x: any) => x.testcasePath === path);

test('a faithful capture reads as passed', () => {
  const r = compareCapture(ueCfg(), exportOf());
  assert.equal(r.differences, 0,
    'a matching pair must not report differences: ' + JSON.stringify(r.rows.filter((x) => x.status === 'mismatch' || x.status === 'not-honoured'), null, 1));
  assert.equal(r.ok, true);
  assert.ok(r.counts.honoured > 20, 'should honour a meaningful number of parameters');
});

test('the first column is the TESTCASE parameter, not the cfg one', () => {
  const r = compareCapture(ueCfg(), exportOf());
  const row = find(r, 'cellConfig.cells[0].bandwidth');
  assert.ok(row, 'rows are addressed by their testcase path');
  assert.equal(row.testcaseValue, '5');
  assert.equal(row.ueCfgPath, 'cell_groups[0].cells[0].bandwidth');
  assert.equal(row.ueCfgValue, 5);
  assert.equal(row.status, 'honoured');
});

test('a parameter the cfg dropped is surfaced AND fails the capture', () => {
  // This is the case the old cfg-first direction could not see at all: the
  // testcase asks for a timing advance, the generated cfg simply has none.
  const cfg = ueCfg();
  delete (cfg.cell_groups[0].cells[0] as any).prach_delay;

  const r = compareCapture(cfg, exportOf());
  const row = find(r, 'cellConfig.cells[0].prach');
  assert.equal(row.status, 'not-honoured', 'prach has a known cfg field (prach_delay) so its absence is a dropped parameter');
  assert.equal(row.testcaseValue, 0);
  assert.equal(row.ueCfgValue, undefined);
  assert.equal(r.ok, false, 'a dropped parameter must fail the capture, not pass quietly');
  assert.ok(r.differences >= 1);
});

test('every authored parameter gets a row, including ones with no cfg destination', () => {
  const r = compareCapture(ueCfg(), exportOf());
  // The reported case: searching for network slicing found nothing, because the
  // parameter lives only in the testcase and the old direction never looked.
  const slicing = r.rows.filter((x) => /slicing/i.test(x.testcasePath));
  assert.ok(slicing.length >= 2, 'both slicing parameters must appear: ' + JSON.stringify(slicing));
  for (const s of slicing) {
    assert.equal(s.status, 'not-emitted');
    assert.match(s.note ?? '', /NAS/, 'and must say WHY it has no cfg value');
  }
  // Spot-check that the sweep is genuinely exhaustive.
  for (const p of ['subsConfig.subs[0].cellsLen', 'cellConfig.master.ratType', 'settings.successCriteriaName', 'userPlaneConfig.profiles[0].dataType']) {
    assert.ok(find(r, p), `${p} should have a row`);
  }
});

test('a parameter with no findable counterpart is reported, never passed', () => {
  const r = compareCapture(ueCfg(), exportOf({ io: { settings: { test_name: 'LTE_Mohan_copy', somethingBrandNew: 'x' } } }));
  const row = find(r, 'settings.somethingBrandNew');
  assert.equal(row.status, 'no-rule');
  assert.equal(r.counts.honoured > 0, true);
  assert.ok(r.notes.some((n) => /searched in the ue.cfg by name and by value/.test(n)), 'the gap must be stated, not hidden');
});

test('values the two sides encode differently still count as honoured', () => {
  const r = compareCapture(ueCfg(), exportOf());
  // GUI lowercase key vs cfg uppercase; a case-sensitive check would report a
  // critical Ki mismatch on every testcase ever run.
  assert.equal(find(r, 'subsConfig.subs[0].sharedKey').status, 'honoured');
  // number in the GUI, zero-padded 15-digit string in the cfg
  assert.equal(find(r, 'subsConfig.subs[0].startingIMSI').status, 'honoured');
  // ['eea0','eea1','eea2'] -> bitmap 224
  assert.equal(find(r, 'subsConfig.subs[0].cipherAlgorithm').status, 'honoured');
});

test('an LTE band and an off flag are explained, not reported as dropped', () => {
  const r = compareCapture(ueCfg(), exportOf());
  // LTE cells carry no band in the cfg — it is implied by dl_earfcn.
  const band = find(r, 'cellConfig.cells[0].band');
  assert.equal(band.status, 'not-emitted');
  assert.match(band.note ?? '', /dl_earfcn/);
  // The cfg omits channel_sim entirely when it is off.
  assert.equal(find(r, 'cellConfig.cells[0].channelSimP').status, 'honoured');
});

test('each edited value is surfaced with both sides', () => {
  const cfg = ueCfg();
  cfg.cell_groups[0].cells[0].bandwidth = 25;
  const r = compareCapture(cfg, exportOf());
  const row = find(r, 'cellConfig.cells[0].bandwidth');
  assert.equal(row.status, 'mismatch');
  assert.equal(row.testcaseValue, '5');
  assert.equal(row.ueCfgValue, 25);
  assert.equal(r.ok, false);
  assert.equal(r.rows[0].status, 'mismatch', 'differences sort to the top');
});

test('valuesEqual knows the encodings the two sides use', () => {
  assert.equal(valuesEqual('5', 5), true);
  assert.equal(valuesEqual('00112233AABB', '00112233aabb'), true);
  assert.equal(valuesEqual('non-ip', 'non_ip'), true);
  assert.equal(valuesEqual(55804.999999960004, 55805), true);
  assert.equal(valuesEqual(5, 25), false);
  assert.equal(valuesEqual(-1, 1), false);
  assert.equal(valuesEqual(undefined, 0), false, 'absent is not zero');
});

test('cells are paired by RAT, not by position', () => {
  const cfg = {
    cell_groups: [
      { group_type: 'nr', cells: [{ bandwidth: 10 }, { bandwidth: 100 }] },
      { group_type: 'lte', cells: [{ bandwidth: 20 }] },
    ],
  };
  const io = {
    cellConfig: {
      master: { ratType: 'multirat' },
      cells: [{ cellType: '5g', bandwidth: '10' }, { cellType: '4g', bandwidth: '20' }, { cellType: '5g', bandwidth: '100' }],
    },
  };
  assert.deepEqual(pairCells(io, cfg).map((p) => p.path), [
    'cell_groups[0].cells[0]', 'cell_groups[1].cells[0]', 'cell_groups[0].cells[1]',
  ]);
});

test('a missing ue.cfg is a stated failure, not a crash', () => {
  const r = compareCapture(undefined, exportOf());
  assert.equal(r.ok, false);
  assert.equal(r.rows.length, 0);
  assert.match(r.notes[0], /no ue\.cfg/);
});

// ───────────── traffic-profile pairing ─────────────
//
// From SA_2cell_32UEsEach_UDP_Ping on .102: the testcase authors profiles
// [iperf, ping]; the cfg buckets them by type, so the ping profile is
// global_traffic.ping[0] — not ping[1]. Indexing by the authored index found
// nothing, and every ping parameter (packet_count, packet_size, interval, …)
// reported "not honoured" with no counterpart because the object holding them
// was never in scope.

const { trafficRank } = await import('./compare.ts');

test('a profile is ranked among profiles of its own dataType', () => {
  const profiles = [{ dataType: 'iperf' }, { dataType: 'ping' }];
  assert.equal(trafficRank(profiles, 0), 0, 'first iperf is iperf[0]');
  assert.equal(trafficRank(profiles, 1), 0, 'the only ping is ping[0], not ping[1]');
});

test('repeated types rank densely, in authored order', () => {
  const profiles = [{ dataType: 'iperf' }, { dataType: 'ping' }, { dataType: 'iperf' }, { dataType: 'ping' }];
  assert.deepEqual([0, 1, 2, 3].map((i) => trafficRank(profiles, i)), [0, 0, 1, 1]);
});

test('a single-type testcase ranks exactly like the authored index', () => {
  const profiles = [{ dataType: 'iperf' }, { dataType: 'iperf' }, { dataType: 'iperf' }];
  assert.deepEqual([0, 1, 2].map((i) => trafficRank(profiles, i)), [0, 1, 2]);
});

test('a missing or typeless profile does not throw', () => {
  assert.equal(trafficRank([], 0), 0);
  assert.equal(trafficRank([{}, {}], 1), 1, 'two typeless profiles share the empty type and rank in order');
  assert.equal(trafficRank(undefined as any, 3), 0);
});

test('the ping profile of a mixed testcase resolves its cfg counterpart', () => {
  // The end-to-end shape of the bug: authored profile[1] is ping, and the cfg
  // holds one ping bucket at index 0 carrying packet_count.
  const cfg = {
    cell_groups: [],
    ue_list: [{ traffic: [{ ping: [{ session_duration: 605 }] }, { iperf: [{ session_duration: 100 }] }] }],
    global_traffic: {
      iperf: [{ iperf1: { bitrate_dl: 10 } }],
      ping: [{ ping0: { packet_count: 600, packet_size: 56, interval: 1 } }],
    },
  };
  const tc = {
    test_case_details: [{
      Test_Config_Intermediate_Object: {
        userPlaneConfig: {
          profiles: [
            { dataType: 'iperf', dataBitrate: { DL: 10 } },
            { dataType: 'ping', numberOfPackets: 600, packetSize: 56, interval: 1 },
          ],
        },
      },
    }],
  };
  const rows = compareCapture(cfg, tc).rows;
  const packets = rows.find((r: any) => r.testcasePath === 'userPlaneConfig.profiles[1].numberOfPackets');
  assert.ok(packets, 'the authored parameter must produce a row');
  assert.equal(packets.status, 'honoured', `expected honoured, got ${packets.status}`);
  assert.match(packets.ueCfgPath ?? '', /packet_count/);
  assert.equal(packets.ueCfgValue, 600);
});

// ───────────── traffic lives on its own subscriber group's UEs ─────────────

test('a profile whose traffic sits on a later UE is found, not reported dropped', () => {
  // SA_2cell_32UEsEach_UDP_Ping: 64 UEs, the first 32 running iperf and the
  // second 32 running ping. The ping profile's start_time is on ue_list[32].
  // Searching only ue_list[0] found nothing, and because startDelay has a known
  // cfg field (start_time) that read as a DROPPED parameter — a defect the box
  // had not committed.
  const cfg = {
    cell_groups: [],
    ue_list: [
      { traffic: [{ iperf: [{ start_time: 9 }] }] },
      { traffic: [{ ping: [{ start_time: 5 }] }] },
    ],
    global_traffic: { iperf: [{ iperf1: {} }], ping: [{ ping0: {} }] },
  };
  const tc = {
    test_case_details: [{
      Test_Config_Intermediate_Object: {
        userPlaneConfig: {
          profiles: [{ dataType: 'iperf', startDelay: 9 }, { dataType: 'ping', startDelay: 5 }],
        },
      },
    }],
  };
  const rows = compareCapture(cfg, tc).rows;
  const delay = rows.find((r: any) => r.testcasePath === 'userPlaneConfig.profiles[1].startDelay');
  assert.ok(delay, 'the authored parameter must produce a row');
  assert.equal(delay.status, 'honoured', `expected honoured, got ${delay.status} (${delay.note})`);
  assert.match(delay.ueCfgPath ?? '', /ue_list\[1\]\.traffic\.ping/);
  assert.equal(delay.ueCfgValue, 5);
});

test('scs on an LTE cell is a field that does not exist, not a dropped one', () => {
  // LTE fixes subcarrier spacing at 15 kHz and the cfg has no field for it, but
  // the GUI carries an scs value on every cell. Because scs has a known cfg
  // name (subcarrier_spacing) this was reported as dropped on every LTE capture.
  const cfg = { cell_groups: [{ group_type: 'lte', cells: [{ dl_earfcn: 3350 }] }], ue_list: [], global_traffic: {} };
  const tc = {
    test_case_details: [{
      Test_Config_Intermediate_Object: {
        cellConfig: { master: { ratType: 'smartphone' }, cells: [{ cellType: '4g', ratTypeP: 'smartphone', scs: 30 }] },
      },
    }],
  };
  const row = compareCapture(cfg, tc).rows.find((r: any) => r.testcasePath === 'cellConfig.cells[0].scs');
  assert.ok(row, 'scs must still produce a row');
  assert.equal(row.status, 'not-emitted', `expected not-emitted, got ${row.status}`);
  assert.match(row.note ?? '', /NR field/);
});

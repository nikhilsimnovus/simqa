import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMessages, messagesNamed, messageTally, normaliseName, splitHead, recordsBelongTo,
} from './otaParse.ts';

/** Records in the shape 192.168.1.102 actually serves, trimmed. */
const REC = (over: Record<string, unknown>) => ({
  executionId: '01a15f34-ba8c-79f3-8682-b5b210b6344c',
  testCaseId: 'SA_2cell_Mobility_MultiPDN_automation',
  cellId: 1, direction: 'DL', index: 4, timestamp: 1792598688420000, ueId: 61441,
  simulatorId: 'Simulator_test', sipIndex: -1,
  ...over,
});

const RRC_RECONF = 'DCCH-NR: RRC reconfiguration\n{\n  message c1: rrcReconfiguration: {\n    secondaryCellGroup \x270102\x27H,\n    reconfigurationWithSync {\n    }\n  }\n}';
const RRC_RECONF_COMPLETE = 'DCCH-NR: RRC reconfiguration complete\n{\n  message c1: rrcReconfigurationComplete: {\n  }\n}';
const REG_ACCEPT = '5GMM: Registration accept\n{\n  registrationResult 1,\n  guti ...\n}';

test('a logData entry is one message, with its name and body split', () => {
  const msgs = parseMessages([REC({ layer: 'RRC', logData: [RRC_RECONF] })]);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].name, 'RRC reconfiguration');
  assert.equal(msgs[0].channel, 'DCCH-NR');
  assert.match(msgs[0].body, /secondaryCellGroup/);
  assert.equal(msgs[0].layer, 'RRC');
  assert.equal(msgs[0].index, 4);
});

test('PHY, MAC, RLC, PDCP and IP records are not OTA messages', () => {
  // The same execution carried 1444 PHY records against 37 RRC ones.
  const msgs = parseMessages([
    REC({ layer: 'PHY', logData: ['n_id_cell=501'] }),
    REC({ layer: 'MAC', logData: ['UL grant'] }),
    REC({ layer: 'RLC', logData: ['x'] }),
    REC({ layer: 'PDCP', logData: ['x'] }),
    REC({ layer: 'IP', logData: ['x'] }),
    REC({ layer: 'RRC', logData: [RRC_RECONF] }),
  ]);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].layer, 'RRC');
});

test('events in the RRC/NAS stream are not counted as messages', () => {
  // All three of these are real logData entries from that execution.
  const msgs = parseMessages([REC({
    layer: 'NAS',
    logData: [
      'New state : 5GMM-REGISTERED-INITIATED   CM-IDLE',
      "IP addr=10.10.1.2 APN='default.mnc001.mcc001.gprs'",
      'NR cell change from PCI 500 to 501',
      REG_ACCEPT,
    ],
  })]);
  assert.equal(msgs.length, 1, 'only the Registration accept is a message');
  assert.equal(msgs[0].name, 'Registration accept');
});

test('a rule written in CamelCase finds the box’s spaced spelling', () => {
  // The requirement's examples say RRCReconfiguration; the box logs
  // "RRC reconfiguration". Both must select the same messages.
  const msgs = parseMessages([REC({ layer: 'RRC', logData: [RRC_RECONF] })]);
  for (const spelling of ['RRCReconfiguration', 'RRC reconfiguration', 'rrc_reconfiguration', 'RRC-Reconfiguration']) {
    assert.equal(messagesNamed(msgs, spelling).length, 1, spelling);
  }
});

test('a name match is the WHOLE name, so a pair is never double counted', () => {
  // The real execution had 6 of each. A containment match would report 12.
  const msgs = parseMessages([REC({
    layer: 'RRC', logData: [RRC_RECONF, RRC_RECONF_COMPLETE, RRC_RECONF],
  })]);
  assert.equal(messagesNamed(msgs, 'RRC reconfiguration').length, 2);
  assert.equal(messagesNamed(msgs, 'RRCReconfiguration').length, 2);
  assert.equal(messagesNamed(msgs, 'RRC reconfiguration complete').length, 1);
});

test('NAS messages are found alongside RRC ones', () => {
  const msgs = parseMessages([
    REC({ layer: 'RRC', logData: [RRC_RECONF] }),
    REC({ layer: 'NAS', logData: [REG_ACCEPT] }),
  ]);
  assert.equal(msgs.length, 2);
  assert.equal(messagesNamed(msgs, 'Registration Accept').length, 1, 'case-insensitive');
});

test('a message with no body is still a message', () => {
  const msgs = parseMessages([REC({ layer: 'RRC', logData: ['CCCH-NR: RRC setup request'] })]);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].name, 'RRC setup request');
  assert.equal(msgs[0].body, '');
});

test('splitHead refuses what is not a message head', () => {
  assert.equal(splitHead('New state : 5GMM-REGISTERED   CM-IDLE'), undefined);
  assert.equal(splitHead("IP addr=10.10.1.2 APN='x'"), undefined);
  assert.equal(splitHead('NR cell change from PCI 500 to 501'), undefined);
  assert.equal(splitHead(''), undefined);
  assert.deepEqual(splitHead('5GSM: PDU session establishment accept'),
    { channel: '5GSM', name: 'PDU session establishment accept' });
  assert.deepEqual(splitHead('BCCH-BCH-NR: MIB'), { channel: 'BCCH-BCH-NR', name: 'MIB' });
});

test('normaliseName collapses case and every separator', () => {
  const all = ['RRCReconfiguration', 'RRC reconfiguration', 'rrc-reconfiguration', 'RRC_Reconfiguration'];
  const n = all.map(normaliseName);
  assert.equal(new Set(n).size, 1, n.join(' / '));
  assert.notEqual(normaliseName('RRC reconfiguration'), normaliseName('RRC reconfiguration complete'));
});

test('a tally says what the log actually holds', () => {
  const msgs = parseMessages([REC({
    layer: 'RRC', logData: [RRC_RECONF, RRC_RECONF, RRC_RECONF_COMPLETE],
  })]);
  assert.deepEqual(messageTally(msgs), [
    { name: 'RRC reconfiguration', channel: 'DCCH-NR', count: 2 },
    { name: 'RRC reconfiguration complete', channel: 'DCCH-NR', count: 1 },
  ]);
});

test('logs from another execution are detected, not processed', () => {
  const mine = '01a15f34-ba8c-79f3-8682-b5b210b6344c';
  assert.deepEqual(recordsBelongTo([REC({ layer: 'RRC', logData: [] })], mine),
    { ok: true, checked: 1, foreign: [] });
  const mixed = recordsBelongTo(
    [REC({ layer: 'RRC' }), REC({ layer: 'RRC', executionId: 'someone-elses' })], mine);
  assert.equal(mixed.ok, false);
  assert.deepEqual(mixed.foreign, ['someone-elses']);
});

test('an empty or malformed log yields no messages rather than throwing', () => {
  assert.deepEqual(parseMessages([]), []);
  assert.deepEqual(parseMessages(undefined as never), []);
  assert.deepEqual(parseMessages([REC({ layer: 'RRC', logData: undefined })]), []);
  assert.deepEqual(parseMessages([REC({ layer: 'RRC', logData: [null, 42, {}] as never })]), []);
});

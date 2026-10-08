// What the cfg validator must and must not reject.
//
// The shapes here are cut down from the files actually linked on 192.168.1.106
// and 192.168.1.107 — scripts/probe-cfg-validate.ts runs the full ones, and all
// seventeen are accepted in their own role. These cover the judgement calls:
// the preprocessor, the tolerant value reader, and every rule that could refuse
// a config that works.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCfg, parseCfg, parseOts, preprocess, detectRole, dbIncludesOf, isRaw, withDbInclude } from './cfgValidate.ts';

const errs = (v: { issues: Array<{ severity: string; message: string }> }) =>
  v.issues.filter((i) => i.severity === 'error').map((i) => i.message);
const warns = (v: { issues: Array<{ severity: string; message: string }> }) =>
  v.issues.filter((i) => i.severity === 'warning').map((i) => i.message);
const anyMatch = (msgs: string[], re: RegExp) => msgs.some((m) => re.test(m));

const MME = `/* an mme */
{
  log_filename: "/tmp/mme.log",
  com_addr: "0.0.0.0:9000",
  gtp_addr: "127.0.1.100",
  plmn: "00101",
  mme_group_id: 32769,
  mme_code: 1,
  pdn_list: [ { pdn_type: "ipv4", access_point_name: "default" } ],
  include "ue_db_1000_xor.json",
}`;

const IMS = `{
  log_filename: "/tmp/ims.log",
  com_addr: "[::]:9003",
  sip_addr: [ {addr: "192.168.4.1", port_min: 10000} ],
  cx_server_addr: "127.0.1.100",
  domain: "simnovus.com",
}`;

const GNB = `{
  com_addr: "[::]:9001",
  amf_list: [ { amf_addr: "127.0.1.100" } ],
  rf_driver: { name: "sdr", args: "dev0=/dev/sdr0" },
  nr_cell_list: [ { cell_id: 1, n_id_cell: 500, dl_nr_arfcn: 632628, band: 78 } ],
}`;

const DB = `ue_db: [
  { sim_algo: "xor", imsi: "001010123456789", K: "00112233445566778899aabbccddeeff" },
  { sim_algo: "milenage", imsi: "001010000000001", opc: "000102030405060708090A0B0C0D0E0F", K: "00112233445566778899AABBCCDDEEFF" },
]`;

const OTS = `# a service config
COMPONENTS=""
COMPONENTS+=" MME"
MME_TYPE="MME"
MME_PATH="/root/mme"
MME_CONFIG_FILE="config/mme.cfg"
COMPONENTS+=" ENB"
ENB_TYPE="ENB"
ENB_CONFIG_FILE="config/enb.cfg"
`;

// ── the real files, in miniature, must all be accepted ─────────────────

test('each role accepts its own config', () => {
  for (const [role, text] of [['mme', MME], ['ims', IMS], ['gnb', GNB], ['db', DB], ['ots', OTS]] as const) {
    const v = validateCfg(role, `x-${role}.cfg`, text);
    assert.equal(v.ok, true, `${role} rejected: ${errs(v).join(' | ')}`);
  }
});

test('an mme config reports its PLMN and the database it includes', () => {
  const v = validateCfg('mme', 'demo-mme.cfg', MME);
  assert.equal(v.facts.PLMN, '00101');
  assert.deepEqual(v.includes, ['ue_db_1000_xor.json']);
  assert.deepEqual(dbIncludesOf(v.includes), ['ue_db_1000_xor.json']);
  assert.match(v.summary, /checks out as an MME core config/);
});

// ── the preprocessor ──────────────────────────────────────────────────

test('#if takes the branch the file defines, not both', () => {
  // ims.cfg's own shape: USE_N5 is 0, so the Rx branch is live and use_n5 is not.
  const src = `#define USE_N5 0
{
  com_addr: "[::]:9003",
  sip_addr: [ "a" ],
#if USE_N5 == 0
  rx_server_addr: "127.0.1.100",
#else
  use_n5: true,
#endif
}`;
  const { doc } = parseCfg(src);
  assert.equal(doc.rx_server_addr, '127.0.1.100');
  assert.equal(Object.prototype.hasOwnProperty.call(doc, 'use_n5'), false);
});

test('an #ifdef with nothing defined drops its body', () => {
  const { doc } = parseCfg(`{
  gtp_addr: "127.0.1.1",
#ifdef GTP_U_BUNDLING
  gtp_use_packet_bundling: true,
#endif
}`);
  assert.equal(Object.prototype.hasOwnProperty.call(doc, 'gtp_use_packet_bundling'), false);
});

test('an unclosed #if is reported as truncation', () => {
  const { issues } = preprocess(`#if 1
{ a: 1 }`);
  assert.ok(anyMatch(issues.map((i) => i.message), /never closed with #endif/));
});

// ── the tolerant value reader ─────────────────────────────────────────

test('macro and expression values are kept, not rejected', () => {
  // The live gnb.cfg is full of these; treating them as syntax errors would
  // refuse configs that run.
  const { doc, issues } = parseCfg(`#define N_ANTENNA_DL 2
{
  n_antenna_dl: N_ANTENNA_DL,
  n_prb: BANDWIDTH / 2,
  band: 78,
}`);
  assert.deepEqual(issues, []);
  assert.ok(isRaw(doc.n_antenna_dl));
  assert.ok(isRaw(doc.n_prb));
  assert.equal(doc.band, 78);
});

test('hex, negative and boolean values parse', () => {
  const { doc } = parseCfg(`{ amf: 0x9001, q_rx_lev_min: -70, cell_barred: false }`);
  assert.equal(doc.amf, 0x9001);
  assert.equal(doc.q_rx_lev_min, -70);
  assert.equal(doc.cell_barred, false);
});

test('a double slash inside a quoted string is not a comment', () => {
  const { doc } = parseCfg(`{ log_filename: "/tmp//mme.log", plmn: "00101" }`);
  assert.equal(doc.log_filename, '/tmp//mme.log');
  assert.equal(doc.plmn, '00101');
});

// ── structural breakage: the "wrong config" an operator needs told ────

test('a truncated config is refused, naming the line', () => {
  const v = validateCfg('mme', 'cut.cfg', MME.slice(0, MME.indexOf('pdn_list')));
  assert.equal(v.ok, false);
  assert.ok(anyMatch(errs(v), /never closed with \}/));
});

test('an unterminated string is refused', () => {
  const v = validateCfg('mme', 'q.cfg', `{\n  plmn: "00101,\n  com_addr: "x:1",\n}`);
  assert.equal(v.ok, false);
  assert.ok(anyMatch(errs(v), /quoted string is not closed/));
});

test('a missing colon is refused and names the parameter', () => {
  const v = validateCfg('ims', 'c.cfg', `{\n  com_addr "x:1",\n  sip_addr: [ "a" ],\n}`);
  assert.equal(v.ok, false);
  assert.ok(anyMatch(errs(v), /"com_addr" is not followed by ":"/));
});

test('an unclosed block comment is refused', () => {
  const v = validateCfg('mme', 'c.cfg', `{ plmn: "00101", /* oops\n  com_addr: "x:1" }`);
  assert.equal(v.ok, false);
  assert.ok(anyMatch(errs(v), /block comment is never closed/));
});

test('content after the closing brace is refused', () => {
  const v = validateCfg('ims', 'c.cfg', `${IMS}\n{ sip_addr: [ "b" ] }`);
  assert.equal(v.ok, false);
  assert.ok(anyMatch(errs(v), /after the closing \}/));
});

test('an empty file, and a file of only comments, are refused', () => {
  assert.equal(validateCfg('mme', 'e.cfg', '   ').ok, false);
  const v = validateCfg('mme', 'c.cfg', '/* nothing but this */\n// and this\n');
  assert.equal(v.ok, false);
  assert.ok(anyMatch(errs(v), /no configuration in this file/));
});

test('a binary blob is refused as not a text config', () => {
  const v = validateCfg('mme', 'x.tar.gz', 'MME\u0000\u0000plmn');
  assert.equal(v.ok, false);
  assert.ok(anyMatch(errs(v), /binary file/));
});

// ── the wrong slot ────────────────────────────────────────────────────

test('an ims config in the mme slot is refused, and says which slot it belongs in', () => {
  const v = validateCfg('mme', 'demo-ims.cfg', IMS);
  assert.equal(v.ok, false);
  assert.equal(v.looksLike, 'ims');
  assert.ok(anyMatch(errs(v), /looks like an IMS config, not an MME core config/));
  // And not also a pile of "an MME config must set plmn".
  assert.equal(errs(v).length, 1);
});

test('a radio config in the mme slot is refused', () => {
  const v = validateCfg('mme', 'SA-1cell.cfg', GNB);
  assert.equal(v.ok, false);
  assert.equal(v.looksLike, 'gnb');
});

test('an ots config in any cfg slot is refused', () => {
  const v = validateCfg('mme', 'ots.default.cfg', OTS);
  assert.equal(v.ok, false);
  assert.equal(v.looksLike, 'ots');
});

test('enb and gnb are one format in two slots, so neither is the wrong slot', () => {
  const v = validateCfg('enb', 'SA-1cell.cfg', GNB);
  assert.equal(v.ok, true);
  assert.equal(v.looksLike, undefined);
});

test('a config of no recognisable role is not accused of being another one', () => {
  // Nothing to go on: better silent than wrong.
  assert.equal(detectRole(`{ log_filename: "/tmp/x.log" }`), undefined);
  const v = validateCfg('mme', 'mystery.cfg', `{ log_filename: "/tmp/x.log" }`);
  assert.equal(v.looksLike, undefined);
  // Still refused — for what it lacks, not for what it is.
  assert.ok(anyMatch(errs(v), /must set plmn/));
});

// ── mme parameters ────────────────────────────────────────────────────

test('an mme config missing plmn, gtp_addr or com_addr is refused', () => {
  const v = validateCfg('mme', 'm.cfg', `{ mme_code: 1, mme_group_id: 2, pdn_list: [ { access_point_name: "a" } ] }`);
  assert.equal(v.ok, false);
  for (const k of ['plmn', 'gtp_addr', 'com_addr']) assert.ok(anyMatch(errs(v), new RegExp(`must set ${k}`)), k);
});

test('a plmn that is not 5 or 6 digits is refused', () => {
  const v = validateCfg('mme', 'm.cfg', MME.replace('"00101"', '"0010"'));
  assert.equal(v.ok, false);
  assert.ok(anyMatch(errs(v), /plmn "0010" is not 5 or 6 digits/));
});

test('mme_code and mme_group_id out of range are refused', () => {
  const a = validateCfg('mme', 'm.cfg', MME.replace('mme_code: 1', 'mme_code: 300'));
  assert.ok(anyMatch(errs(a), /mme_code 300 is outside 0–255/));
  const b = validateCfg('mme', 'm.cfg', MME.replace('mme_group_id: 32769', 'mme_group_id: 70000'));
  assert.ok(anyMatch(errs(b), /mme_group_id 70000 is outside 0–65535/));
});

test('an empty pdn_list is refused and a missing one warns', () => {
  const a = validateCfg('mme', 'm.cfg', MME.replace(/pdn_list: \[[^\]]*\]/, 'pdn_list: [ ]'));
  assert.equal(a.ok, false);
  assert.ok(anyMatch(errs(a), /pdn_list is empty/));
  const b = validateCfg('mme', 'm.cfg', MME.replace(/pdn_list: \[[^\]]*\],/, ''));
  assert.equal(b.ok, true);
  assert.ok(anyMatch(warns(b), /no pdn_list/));
});

// ── ims parameters ────────────────────────────────────────────────────

test('an ims config with no sip_addr is refused, and an empty one too', () => {
  const a = validateCfg('ims', 'i.cfg', `{ com_addr: "[::]:9003", cx_server_addr: "x", mms_server_bind_addr: "y" }`);
  assert.ok(anyMatch(errs(a), /must set sip_addr/));
  const b = validateCfg('ims', 'i.cfg', IMS.replace(/sip_addr: \[[^\]]*\]/, 'sip_addr: [ ]'));
  assert.equal(b.ok, false);
  assert.ok(anyMatch(errs(b), /sip_addr is an empty list/));
});

// ── radio parameters ──────────────────────────────────────────────────

test('a radio config with no cells is refused', () => {
  const v = validateCfg('gnb', 'g.cfg', `{ com_addr: "x:1", amf_list: [ { amf_addr: "a" } ], rf_driver: { name: "sdr" } }`);
  assert.equal(v.ok, false);
  assert.ok(anyMatch(errs(v), /defines no cells/));
});

test('a radio config whose every cell list is empty is refused', () => {
  const v = validateCfg('gnb', 'g.cfg', GNB.replace(/nr_cell_list: \[[^\]]*\]/, 'nr_cell_list: [ ]'));
  assert.equal(v.ok, false);
  assert.ok(anyMatch(errs(v), /every cell list in this config is empty/));
});

test('NB-IoT standalone is accepted: its cells are in nb_cell_list and cell_list is empty on purpose', () => {
  // .106's live enb.cfg, in miniature. Counting only LTE and NR cells called
  // this "no cells defined" and refused a config the box was running.
  const v = validateCfg('enb', 'nbiot.cfg', `{
  com_addr: "x:1",
  mme_list: [ { mme_addr: "127.0.1.100" } ],
  cell_list: [ ],
  nb_cell_list: [ { cell_id: 1, n_id_cell: 1, dl_earfcn: 2400 } ],
  include "rf_driver/config.cfg",
}`);
  assert.equal(v.ok, true, errs(v).join(' | '));
  assert.equal(v.facts['NB-IoT cells'], 1);
  // rf_driver arrives through the include, so no warning about it either.
  assert.equal(anyMatch(warns(v), /rf_driver/), false);
});

test('a radio config with no core to talk to is refused', () => {
  const v = validateCfg('gnb', 'g.cfg', GNB.replace(/amf_list: \[[^\]]*\],/, ''));
  assert.equal(v.ok, false);
  assert.ok(anyMatch(errs(v), /no mme_list and no amf_list/));
});

test('a missing rf_driver warns rather than refusing', () => {
  const v = validateCfg('gnb', 'g.cfg', GNB.replace(/rf_driver: \{[^}]*\},/, ''));
  assert.equal(v.ok, true);
  assert.ok(anyMatch(warns(v), /no rf_driver/));
});

// ── subscriber database ───────────────────────────────────────────────

test('a database counts its subscribers', () => {
  const v = validateCfg('db', 'ue_db.cfg', DB);
  assert.equal(v.facts.Subscribers, 2);
});

test('a database wrapped in braces is accepted as well as a bare fragment', () => {
  // Both shapes are on the boxes: the DBs mme.cfg includes are fragments,
  // while some are whole documents.
  assert.equal(validateCfg('db', 'd.cfg', `{ ${DB} }`).ok, true);
});

test('an empty or missing ue_db is refused', () => {
  const a = validateCfg('db', 'd.cfg', 'ue_db: [ ]');
  assert.equal(a.ok, false);
  assert.ok(anyMatch(errs(a), /ue_db is empty/));
  const b = validateCfg('db', 'd.cfg', 'log_filename: "/tmp/x"');
  assert.equal(b.ok, false);
  assert.ok(anyMatch(errs(b), /must define ue_db/));
});

test('a bad IMSI, a short K and an unknown sim_algo are each refused', () => {
  const v = validateCfg('db', 'd.cfg', `ue_db: [
    { sim_algo: "xor", imsi: "123", K: "00112233445566778899aabbccddeeff" },
    { sim_algo: "aes", imsi: "001010000000002", K: "00112233445566778899aabbccddeeff", opc: "0" },
    { sim_algo: "xor", imsi: "001010000000003", K: "deadbeef" },
  ]`);
  assert.equal(v.ok, false);
  assert.ok(anyMatch(errs(v), /no usable imsi/));
  assert.ok(anyMatch(errs(v), /sim_algo must be xor, milenage or tuak/));
  assert.ok(anyMatch(errs(v), /K must be 32 hex characters/));
});

test('milenage without an operator key is refused; xor without one is fine', () => {
  const v = validateCfg('db', 'd.cfg', `ue_db: [
    { sim_algo: "milenage", imsi: "001010000000001", K: "00112233445566778899aabbccddeeff" },
  ]`);
  assert.equal(v.ok, false);
  assert.ok(anyMatch(errs(v), /need opc or op/));
  assert.equal(validateCfg('db', 'd.cfg', DB).ok, true);
});

test('duplicate IMSIs are refused, because only the first takes effect', () => {
  const v = validateCfg('db', 'd.cfg', `ue_db: [
    { sim_algo: "xor", imsi: "001010000000001", K: "00112233445566778899aabbccddeeff" },
    { sim_algo: "xor", imsi: "001010000000001", K: "00112233445566778899aabbccddeeff" },
  ]`);
  assert.equal(v.ok, false);
  assert.ok(anyMatch(errs(v), /1 duplicate IMSI \(001010000000001\)/));
});

test('a systematic mistake in a 1000-UE database is one message, not a thousand', () => {
  const rows = Array.from({ length: 1000 }, (_, n) =>
    `{ sim_algo: "milenage", imsi: "0010100000${String(n).padStart(5, '0')}", K: "00112233445566778899aabbccddeeff" }`);
  const v = validateCfg('db', 'big.cfg', `ue_db: [ ${rows.join(',\n')} ]`);
  assert.equal(v.ok, false);
  assert.equal(errs(v).length, 1);
  assert.ok(anyMatch(errs(v), /…\(1000 total\)/));
});

// ── ots ───────────────────────────────────────────────────────────────

test('an ots config lists its components and their config files', () => {
  const v = validateCfg('ots', 'ots.cfg', OTS);
  assert.equal(v.ok, true);
  assert.equal(v.facts.Components, 'MME ENB');
  assert.equal(v.facts['MME config'], 'config/mme.cfg');
});

test('Windows line endings in an ots config are refused — the shell cannot source it', () => {
  const v = validateCfg('ots', 'ots.cfg', OTS.replace(/\n/g, '\r\n'));
  assert.equal(v.ok, false);
  assert.ok(anyMatch(errs(v), /Windows line endings/));
});

test('an ots config that starts no components is refused', () => {
  const v = validateCfg('ots', 'ots.cfg', `ERROR_DELAY="5"\nCOMPONENTS=""\n`);
  assert.equal(v.ok, false);
  assert.ok(anyMatch(errs(v), /COMPONENTS is empty/));
});

test('the documented "source the stock file and override" form is accepted', () => {
  // ots.default.cfg tells operators to do exactly this, so refusing it would
  // refuse the box's own instructions.
  const v = validateCfg('ots', 'my-ots.cfg', `source ots.default.cfg\nERROR_DELAY="10"\n`);
  assert.equal(v.ok, true);
  assert.ok(anyMatch(warns(v), /comes from the file this one sources/));
});

test('a component in COMPONENTS with no _TYPE is refused', () => {
  const v = validateCfg('ots', 'ots.cfg', `COMPONENTS+=" MME"\nMME_CONFIG_FILE="config/mme.cfg"\n`);
  assert.equal(v.ok, false);
  assert.ok(anyMatch(errs(v), /no MME_TYPE/));
});

test('parseOts accumulates += and strips trailing comments', () => {
  const p = parseOts(`COMPONENTS=""\nCOMPONENTS+=" MME" # the core\nMME_WIN="0"\n`);
  assert.deepEqual(p.components, ['MME']);
  assert.equal(p.vars.MME_WIN, '0');
});

// ── pointing an mme config at a different database ────────────────────

// .107's live mme.cfg, in miniature: one live include and four commented-out
// ones kept as history.
const MME_WITH_HISTORY = `{
  plmn: "00101",
  gtp_addr: "127.0.1.100",
  com_addr: "0.0.0.0:9000",
  pdn_list: [ { access_point_name: "default" } ],
  //include "1000UE.mme.cfg",
// include "demo-1000ue_db-ims-volte.cfg",
   include "ue_db_1000_xor.json",
//include "1-db.cfg",
}`;

test('the live database include is rewritten and the commented ones are left alone', () => {
  const r = withDbInclude(MME_WITH_HISTORY, 'my-db.cfg');
  assert.equal(r.changed, true);
  assert.deepEqual(r.replaced, ['ue_db_1000_xor.json']);
  assert.match(r.text, /^ {3}include "my-db\.cfg",$/m);
  // The history is untouched — uncommenting one would load a second database.
  assert.match(r.text, /\/\/include "1000UE\.mme\.cfg",/);
  assert.match(r.text, /\/\/include "1-db\.cfg",/);
  assert.equal(r.text.includes('ue_db_1000_xor.json'), false);
  // And it is still a valid mme config afterwards.
  const v = validateCfg('mme', 'copy.cfg', r.text);
  assert.equal(v.ok, true, errs(v).join(' | '));
  assert.deepEqual(v.includes, ['my-db.cfg']);
});

test('asking for the database it already includes changes nothing', () => {
  const r = withDbInclude(MME_WITH_HISTORY, 'ue_db_1000_xor.json');
  assert.equal(r.changed, false);
  assert.equal(r.text, MME_WITH_HISTORY);
});

test('a config that includes no database gets one, before the closing brace', () => {
  const r = withDbInclude(MME, 'only-db.cfg');
  assert.equal(r.changed, true);
  const v = validateCfg('mme', 'copy.cfg', r.text);
  assert.equal(v.ok, true, errs(v).join(' | '));
  assert.ok(v.includes.includes('only-db.cfg'));
  assert.ok(r.text.trimEnd().endsWith('}'));
});

test('non-database includes are not mistaken for the database', () => {
  const src = `{
  plmn: "00101",
  gtp_addr: "a",
  com_addr: "b",
  pdn_list: [ { access_point_name: "x" } ],
  include "rf_driver/config.cfg",
}`;
  const r = withDbInclude(src, 'd.cfg');
  assert.deepEqual(r.replaced, []);                   // nothing replaced…
  assert.match(r.text, /include "rf_driver\/config\.cfg",/);   // …and it survives
  assert.ok(validateCfg('mme', 'c.cfg', r.text).includes.includes('d.cfg'));
});

test('a second live database is disabled rather than loaded alongside the first', () => {
  const src = `{
  plmn: "00101",
  gtp_addr: "a",
  com_addr: "b",
  pdn_list: [ { access_point_name: "x" } ],
  include "first_db.cfg",
  include "second_db.cfg",
}`;
  const r = withDbInclude(src, 'chosen-db.cfg');
  assert.deepEqual(r.replaced, ['first_db.cfg', 'second_db.cfg']);
  const v = validateCfg('mme', 'c.cfg', r.text);
  assert.deepEqual(v.includes, ['chosen-db.cfg']);
  assert.match(r.text, /disabled by SimQA/);
});

// ── test case JSON ────────────────────────────────────────────────────

test('a test case must be JSON with a definition in it', () => {
  const bad = validateCfg('testcase', 't.json', '{ not json');
  assert.equal(bad.ok, false);
  assert.ok(anyMatch(errs(bad), /not valid JSON/));
  const empty = validateCfg('testcase', 't.json', '{"name":"x"}');
  assert.equal(empty.ok, false);
  assert.ok(anyMatch(errs(empty), /no test definition/));
  const good = validateCfg('testcase', 't.json', '{"name":"x","definition":{"cells":[]}}');
  assert.equal(good.ok, true);
  assert.equal(good.facts.Name, 'x');
});

// What counts as a test case file you can upload.
//
// People will drop in whatever the Simnovator gave them: the export pack, a
// single testcase object out of it, or a file that is simply something else.
// The first two have to work; the third has to say so in a way that names what
// was expected.
//
// The coercion lives in its own pure module so it can be tested directly: the
// route around it imports next/server, which node --test cannot load.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { toImportPack, definitionFromPack, definitionFromText } = await import('./importPack.ts');

const detail = (name: string) => ({
  Test_Id: '01a0f718-8d18-795d-b195-4fef7193d639',
  Test_Name: name,
  Config_File: { config: { cellConfig: {}, userPlaneConfig: { profiles: [] } } },
  Type: 'USER',
});

test('the box\'s own export pack goes through untouched', () => {
  const pack = { test_case_details: [detail('SA_1cell_4x2_1UEs_http')] };
  const r = toImportPack(pack);
  assert.equal(r.error, undefined);
  assert.deepEqual(r.pack, pack);
  assert.deepEqual(r.names, ['SA_1cell_4x2_1UEs_http']);
});

test('a single testcase object is wrapped rather than refused', () => {
  const r = toImportPack(detail('untitled_6'));
  assert.equal(r.error, undefined);
  assert.equal(r.pack?.test_case_details.length, 1);
  assert.deepEqual(r.names, ['untitled_6']);
});

test('a list of testcase objects is wrapped too', () => {
  const r = toImportPack([detail('one'), detail('two')]);
  assert.equal(r.error, undefined);
  assert.deepEqual(r.names, ['one', 'two']);
});

test('an empty pack is refused — importing nothing is not a success', () => {
  const r = toImportPack({ test_case_details: [] });
  assert.match(r.error ?? '', /empty/);
  assert.equal(r.pack, undefined);
});

test('something else entirely is named for what it is not', () => {
  for (const junk of [null, 42, 'a string', { hello: 'world' }]) {
    const r = toImportPack(junk);
    assert.ok(r.error, `${JSON.stringify(junk)} must be refused`);
    assert.equal(r.pack, undefined);
  }
  // And the message points at where a real file comes from.
  assert.match(toImportPack({ hello: 'world' }).error ?? '', /test_case_details|Export/);
});

// ── The definition inside the file ───────────────────────────────────

test('the definition comes out of the box\'s export pack', () => {
  const r = definitionFromPack({ test_case_details: [detail('SA_1cell_4x2_1UEs_http')] });
  assert.equal(r.error, undefined);
  assert.equal(r.name, 'SA_1cell_4x2_1UEs_http');
  assert.ok(r.definition.userPlaneConfig, 'the definition is the config inside Config_File');
});

test('a saved GET /v2/testcases/{id} file works too', () => {
  const r = definitionFromPack({ id: '01a0', name: 'untitled_6', testDefinition: { cellConfig: {}, userPlaneConfig: {} } });
  assert.equal(r.name, 'untitled_6');
  assert.ok(r.definition.cellConfig);
});

test('a bare definition is taken as one, with no name of its own', () => {
  const r = definitionFromPack({ cellConfig: {}, userPlaneConfig: { profiles: [] } });
  assert.equal(r.error, undefined);
  assert.equal(r.name, undefined);
  assert.ok(r.definition.userPlaneConfig);
});

test('an export with no config says so rather than yielding an empty test', () => {
  const r = definitionFromPack({ test_case_details: [{ Test_Name: 'x' }] });
  assert.match(r.error ?? '', /Config_File/);
  assert.equal(r.definition, undefined);
});

test('a ue.cfg picked by mistake is named, not called unrecognisable', () => {
  // The file four rows of the Subscriber suite were actually built from. It is
  // JSON, it is full of cells and UEs, and it lives beside the real thing.
  const ueCfg = {
    cell_groups: [{ cell_sync: false, cells: [{ band: 78, bandwidth: 20, dl_nr_arfcn: 632628 }] }],
    com_addr: '[::]:9002', log_filename: '/tmp/ue0.log', log_options: 'all.level=error',
    rf_driver: { name: 'sdr' }, rx_gain: 40, tx_gain: 0, ue_list: [{ imsi: '001010000000001' }],
  };
  const r = definitionFromPack(ueCfg);
  assert.equal(r.definition, undefined);
  assert.match(r.error ?? '', /this is a ue\.cfg/);
  assert.match(r.error ?? '', /Export button/);
});

test('an unrecognised file says what it actually contains', () => {
  const r = definitionFromPack({ alpha: 1, beta: 2, gamma: 3 });
  assert.equal(r.definition, undefined);
  assert.match(r.error ?? '', /top-level keys are: alpha, beta, gamma/);
});

// ── reading a saved copy an operator has edited ──────────────────────────

test('a line commented out with // is forgiven, and said out loud', () => {
  // AIO_Validation_of_IMEISV_automation's saved test.json, in miniature: a
  // hand edit that made the one file standing between the row and a deleted
  // test case unreadable.
  const text = `{
  "settings": { "test_name": "AIO_Validation_of_IMEISV" },
  "subsConfig": {
    "subs": [
      {
        "algorithm": "xor",
        // "algorithmKeyMode": "opc",
        "asRelease": 16
      }
    ]
  },
  "cellConfig": { "cells": [] }
}`;
  const r = definitionFromText(text);
  assert.ok(r.definition, r.error);
  assert.equal(r.repaired, 'comments');
  assert.equal(r.definition.subsConfig.subs[0].asRelease, 16);
  assert.equal('algorithmKeyMode' in r.definition.subsConfig.subs[0], false);
});

test('a block comment and a trailing comma are forgiven too', () => {
  const r = definitionFromText('{ /* kept for reference */ "cellConfig": { "cells": [] }, }');
  assert.ok(r.definition, r.error);
  assert.equal(r.repaired, 'comments and a trailing comma');
});

test('a double slash inside a string is not a comment', () => {
  const r = definitionFromText('{"cellConfig":{},"settings":{"log_filename":"/tmp//ue.log","url":"http://x/y"}}');
  assert.ok(r.definition, r.error);
  assert.equal(r.repaired, undefined);
  assert.equal(r.definition.settings.log_filename, '/tmp//ue.log');
  assert.equal(r.definition.settings.url, 'http://x/y');
});

test('clean JSON is not reported as repaired', () => {
  const r = definitionFromText('{"cellConfig":{"cells":[]}}');
  assert.ok(r.definition);
  assert.equal(r.repaired, undefined);
});

test('a file broken in any other way is still broken', () => {
  const r = definitionFromText('{"cellConfig": }');
  assert.equal(r.definition, undefined);
  assert.match(r.error ?? '', /not valid JSON/);
  // And a ue.cfg is still a ue.cfg, however it is punctuated.
  assert.match(definitionFromText('{ /* x */ "ue_list": [], "cell_groups": [] }').error ?? '', /this is a ue\.cfg/);
});

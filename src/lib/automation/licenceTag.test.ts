// Reading and rewriting the licence tag, in the shapes the lab's own configs
// are written in.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { licenceTagOf, withLicenceTag } = await import('./licenceTag.ts');

const SPACED = `{
  log_filename: "/tmp/enb.log",
  license_server: {server_addr: "192.168.0.11:9051", tag: "oran-enb"},
  com_addr: "[::]:9001",
}`;
// .106's gnb.cfg writes it without a space anywhere.
const TIGHT = `{license_server: {server_addr:"192.168.0.11:9051",tag:"oru-enb"},com_addr:"x"}`;

test('the tag is read from both spacings the lab uses', () => {
  assert.equal(licenceTagOf(SPACED), 'oran-enb');
  assert.equal(licenceTagOf(TIGHT), 'oru-enb');
});

test('a config that names no licence server has no tag', () => {
  assert.equal(licenceTagOf('{ com_addr: "x" }'), undefined);
  assert.equal(licenceTagOf(''), undefined);
});

test('rewriting changes the tag and nothing else', () => {
  const r = withLicenceTag(SPACED, 'rnd-enb');
  assert.equal(r.changed, true);
  assert.equal(r.from, 'oran-enb');
  assert.equal(licenceTagOf(r.text), 'rnd-enb');
  // Byte-identical apart from the tag.
  assert.equal(r.text, SPACED.replace('"oran-enb"', '"rnd-enb"'));
  assert.match(r.text, /server_addr: "192\.168\.0\.11:9051"/);
});

test('the tight spelling keeps its spelling', () => {
  const r = withLicenceTag(TIGHT, 'rnd-enb');
  assert.equal(r.text, TIGHT.replace('"oru-enb"', '"rnd-enb"'));
});

test('asking for the tag it already has changes nothing', () => {
  const r = withLicenceTag(SPACED, 'oran-enb');
  assert.equal(r.changed, false);
  assert.equal(r.from, 'oran-enb');
  assert.equal(r.text, SPACED);
});

test('a config with no licence server is left alone rather than given one', () => {
  // Inventing a license_server block would mean guessing a server address.
  const src = '{ com_addr: "x" }';
  const r = withLicenceTag(src, 'rnd-enb');
  assert.equal(r.changed, false);
  assert.equal(r.text, src);
});

test('a commented-out licence server is not the live one', () => {
  const src = `{
  //license_server: {server_addr: "10.0.0.1:9051", tag: "old-enb"},
  /* license_server: {server_addr: "10.0.0.2:9051", tag: "older-enb"}, */
  license_server: {server_addr: "192.168.0.11:9051", tag: "oran-enb"},
}`;
  assert.equal(licenceTagOf(src), 'oran-enb');
  const r = withLicenceTag(src, 'rnd-enb');
  assert.match(r.text, /\/\/license_server.*tag: "old-enb"/);
  assert.match(r.text, /tag: "rnd-enb"/);
  assert.equal(licenceTagOf(r.text), 'rnd-enb');
});

test('a tag key elsewhere in the file is not the licence tag', () => {
  // `tag` is a common enough key that a blind substitution would hit it.
  const src = `{
  cell_list: [{ tag: "not-the-licence", band: 78 }],
  license_server: {server_addr: "a:1", tag: "rnd-mme"},
  srs: { tag: "also-not" },
}`;
  assert.equal(licenceTagOf(src), 'rnd-mme');
  const r = withLicenceTag(src, 'mme-oran');
  assert.match(r.text, /tag: "not-the-licence"/);
  assert.match(r.text, /tag: "also-not"/);
  assert.match(r.text, /license_server: \{server_addr: "a:1", tag: "mme-oran"\}/);
});

test('a licence server inside a preprocessor block is skipped', () => {
  const src = `#define X 1
#  license_server: {server_addr: "a:1", tag: "directive"},
{
  license_server: {server_addr: "b:2", tag: "real"},
}`;
  assert.equal(licenceTagOf(src), 'real');
});

test('a server address that itself contains the word tag is not confused for one', () => {
  const src = '{ license_server: {server_addr: "tag.example:9051", tag: "rnd-mme"} }';
  assert.equal(licenceTagOf(src), 'rnd-mme');
});

test('an unterminated config does not hang or throw', () => {
  assert.equal(licenceTagOf('{ license_server: {server_addr: "a:1", tag: "x'), 'x');
  assert.equal(licenceTagOf('{ license_server: { '), undefined);
  assert.equal(licenceTagOf('{ /* never closed'), undefined);
});

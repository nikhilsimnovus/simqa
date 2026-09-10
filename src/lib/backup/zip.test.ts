// node --test src/lib/backup/zip.test.ts
//
// A hand-written ZIP writer is only worth having if the archives it produces are
// real archives, so these check the actual byte layout and round-trip the
// payloads back out — rather than asserting that buildZip returned "some bytes".
// The independent check that Windows Explorer can open one lives outside the
// unit tests, in the live verification.

import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';

const { buildZip, crc32 } = await import('./zip.ts');

/** Minimal reader: walk the central directory and pull every entry back out.
 *  Deliberately not sharing code with the writer — a bug mirrored in both would
 *  otherwise cancel itself out. */
function readZip(buf: Buffer): Array<{ name: string; data: Buffer; method: number }> {
  const eocdSig = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === eocdSig) { eocd = i; break; }
  }
  assert.notEqual(eocd, -1, 'no end-of-central-directory record');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, `entry ${i} central header signature`);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const rawSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');

    assert.equal(buf.readUInt32LE(localOff), 0x04034b50, `entry ${name} local header signature`);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const body = buf.subarray(start, start + compSize);
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body);

    assert.equal(data.length, rawSize, `entry ${name} uncompressed size`);
    assert.equal(crc32(data), crc, `entry ${name} crc`);
    out.push({ name, data, method });
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return out;
}

test('crc32 matches the known IEEE check value', () => {
  // The standard test vector: CRC-32 of "123456789" is 0xCBF43926.
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test('every entry round-trips out of the archive intact', () => {
  const entries = [
    { name: 'enb.cfg', data: Buffer.from('cell_list: [ { band: 78 } ]\n') },
    { name: 'big.json', data: Buffer.from(JSON.stringify({ x: 'y'.repeat(5000) })) },
    { name: 'empty.cfg', data: Buffer.alloc(0) },
    { name: 'binary.pem', data: Buffer.from([0, 1, 2, 255, 254, 0, 128]) },
  ];
  const read = readZip(buildZip(entries));

  assert.equal(read.length, entries.length);
  for (const e of entries) {
    const got = read.find((r) => r.name === e.name);
    assert.ok(got, `${e.name} missing from the archive`);
    assert.deepEqual(got.data, e.data, `${e.name} content differs`);
  }
});

test('a compressible file is deflated and an incompressible one is stored', () => {
  const read = readZip(buildZip([
    { name: 'repetitive.json', data: Buffer.from('a'.repeat(4000)) },
    { name: 'tiny.cfg', data: Buffer.from('x') },
  ]));
  assert.equal(read.find((r) => r.name === 'repetitive.json')?.method, 8, 'should deflate');
  // Deflating one byte produces more than one byte, so storing is correct here.
  assert.equal(read.find((r) => r.name === 'tiny.cfg')?.method, 0, 'should store');
});

test('names colliding only by case are both preserved', () => {
  // /root/ue/config on .101 really does hold UE.cfg and ue.cfg. Written into one
  // archive under the same name, extraction on Windows would keep only the last.
  const read = readZip(buildZip([
    { name: 'UE.cfg', data: Buffer.from('upper') },
    { name: 'ue.cfg', data: Buffer.from('lower') },
  ]));
  assert.equal(read.length, 2);
  assert.equal(new Set(read.map((r) => r.name.toLowerCase())).size, 2, 'names must not collide case-insensitively');
  assert.deepEqual(read.map((r) => r.data.toString()).sort(), ['lower', 'upper']);
});

test('an archive of one empty file is still a valid archive', () => {
  const read = readZip(buildZip([{ name: 'ims.cfg', data: Buffer.alloc(0) }]));
  assert.equal(read.length, 1);
  assert.equal(read[0].data.length, 0);
});

test('output is reproducible when mtimes are fixed', () => {
  const make = () => buildZip([{ name: 'a.cfg', data: Buffer.from('same'), mtime: new Date('2026-09-01T10:00:00Z') }]);
  assert.deepEqual(make(), make());
});

test('a selection too large for a 32-bit archive is refused, not truncated', () => {
  // An array of 70k real entries would cost a second and a lot of memory to
  // build; only .length and .reduce are read before the guard fires.
  const fake = { length: 70000, reduce: () => 0 } as unknown as Parameters<typeof buildZip>[0];
  assert.throws(() => buildZip(fake), /too many files/);
});

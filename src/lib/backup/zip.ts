// A minimal ZIP writer.
//
// Written rather than installed. The repo has been careful about dependencies
// (the tests use node's own runner for the same reason), and the archive this
// needs to produce is the simple case: a flat list of files, no directories, no
// encryption, no split volumes. That is about a hundred lines of well-specified
// header layout against a dependency, its transitive tree and its update
// cadence — and because it is node builtins only, it unit-tests directly under
// `node --test` like store.ts and status.ts.
//
// Format: PKZIP APPNOTE 6.3.2, the classic 32-bit structures —
//   [local header + data] per entry, then the central directory, then the EOCD.
// Deflate comes from node:zlib. No ZIP64, which is why buildZip refuses an
// archive that would need it rather than emitting one that silently truncates.

import { deflateRawSync } from 'node:zlib';

export interface ZipEntry {
  /** Name inside the archive. Stored as given (UTF-8 flagged). */
  name: string;
  data: Buffer;
  /** Modification time; defaults to the DOS epoch so output is reproducible. */
  mtime?: Date;
}

/** Beyond these the archive would need ZIP64 to stay readable. */
const MAX_ENTRIES = 0xffff;
const MAX_TOTAL_BYTES = 0xffffffff;

/** CRC-32 (IEEE 802.3), the checksum ZIP entries carry. */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS date/time, which is what the ZIP header format still carries.
 *  Two-second resolution, and nothing before 1980 is representable. */
function dosDateTime(d: Date): { time: number; date: number } {
  const year = d.getFullYear();
  if (year < 1980) return { time: 0, date: 0x21 };  // 1980-01-01, the floor
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * Make every name unique within the archive.
 *
 * Two sources here can legitimately produce colliding names: a Linux directory
 * holding both UE.cfg and ue.cfg (which collide once extracted on Windows), and
 * a selection that simply repeats a name. An archive with duplicate entries
 * extracts to whichever one was written last, silently losing the other — the
 * same class of data loss the store guards against on disk, so it is guarded
 * here too.
 */
function uniqueNames(entries: ZipEntry[]): string[] {
  const used = new Set<string>();
  return entries.map((e) => {
    const base = e.name.replace(/\\/g, '/').replace(/^\/+/, '');
    let name = base;
    if (used.has(name.toLowerCase())) {
      const dot = base.lastIndexOf('.');
      const stem = dot > 0 ? base.slice(0, dot) : base;
      const ext = dot > 0 ? base.slice(dot) : '';
      let n = 2;
      do { name = `${stem} (${n++})${ext}`; } while (used.has(name.toLowerCase()));
    }
    used.add(name.toLowerCase());
    return name;
  });
}

/**
 * Build a ZIP archive in memory.
 *
 * In memory because the alternative is streaming, and streaming buys nothing at
 * the sizes involved: the largest category in the lab is ~900 testcase JSONs at
 * roughly 60 KB each. The guards below are what keep that assumption honest —
 * if a selection ever does grow past what a 32-bit archive can address, this
 * throws a message the UI can show instead of producing a corrupt file.
 */
export function buildZip(entries: ZipEntry[]): Buffer {
  if (entries.length > MAX_ENTRIES) {
    throw new Error(`too many files for one archive (${entries.length}; limit ${MAX_ENTRIES}) — download in smaller selections`);
  }
  const total = entries.reduce((n, e) => n + e.data.length, 0);
  if (total > MAX_TOTAL_BYTES) {
    throw new Error(`selection is too large for one archive (${(total / 1073741824).toFixed(1)} GB) — download in smaller selections`);
  }

  const names = uniqueNames(entries);
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  entries.forEach((entry, i) => {
    const nameBuf = Buffer.from(names[i], 'utf8');
    const crc = crc32(entry.data);
    const { time, date } = dosDateTime(entry.mtime ?? new Date(0));

    // Deflate, unless it makes things bigger — which it does for tiny or
    // already-compressed files. Method 0 (stored) is then both smaller and
    // faster to extract.
    const deflated = entry.data.length ? deflateRawSync(entry.data, { level: 6 }) : Buffer.alloc(0);
    const useDeflate = deflated.length < entry.data.length;
    const body = useDeflate ? deflated : entry.data;
    const method = useDeflate ? 8 : 0;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);   // local file header signature
    lh.writeUInt16LE(20, 4);           // version needed (2.0)
    lh.writeUInt16LE(0x0800, 6);       // flags: bit 11 = names are UTF-8
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(entry.data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);           // no extra field
    local.push(lh, nameBuf, body);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);   // central directory header signature
    ch.writeUInt16LE(20, 4);           // version made by
    ch.writeUInt16LE(20, 6);           // version needed
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(entry.data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);           // extra length
    ch.writeUInt16LE(0, 32);           // comment length
    ch.writeUInt16LE(0, 34);           // disk number start
    ch.writeUInt16LE(0, 36);           // internal attributes
    ch.writeUInt32LE(0, 38);           // external attributes
    ch.writeUInt32LE(offset, 42);      // offset of this entry's local header
    central.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + body.length;
  });

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);          // end of central directory
  eocd.writeUInt16LE(0, 4);                   // this disk
  eocd.writeUInt16LE(0, 6);                   // disk with central directory
  eocd.writeUInt16LE(entries.length, 8);      // entries on this disk
  eocd.writeUInt16LE(entries.length, 10);     // entries total
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);             // central directory offset
  eocd.writeUInt16LE(0, 20);                  // comment length

  return Buffer.concat([...local, centralBuf, eocd]);
}

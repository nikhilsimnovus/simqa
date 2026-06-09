// POST /api/automation/callbox-configs/download
//   body: { systemId: string, filename: string }
//
// Reads the picked file from /root/enb/config on the callbox via SSH
// and returns its content base64-encoded. Used by the wizard at
// suite-save time: when a user picks an existing cfg from the box, we
// pull it down + store the bytes locally in the suite. At run-time the
// runner deploys from that local copy with a sanitized name —
// decouples the suite from the callbox's filesystem so a colleague
// renaming/deleting /root/enb/config files won't break our suite.

import { NextResponse } from 'next/server';
import { loadInventory, getSystem } from '@/lib/inventory';
import { withSsh } from '@/lib/configFidelity/ssh';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: Request) {
  let body: { systemId?: string; filename?: string } = {};
  try { body = await req.json(); } catch { /* empty */ }
  const systemId = body.systemId;
  const filename = body.filename;

  if (!systemId) return NextResponse.json({ ok: false, error: 'systemId required' }, { status: 400 });
  if (!filename) return NextResponse.json({ ok: false, error: 'filename required' }, { status: 400 });
  // Defensive: no traversal / weird chars in path on the callbox side.
  // We *do* allow special chars in the source filename (the box has
  // some), but disallow embedded slashes + null bytes — the file MUST
  // live directly under /root/enb/config.
  if (filename.includes('/') || filename.includes('\0') || filename.includes('..')) {
    return NextResponse.json({ ok: false, error: 'filename must be a plain basename under /root/enb/config' }, { status: 400 });
  }

  const inv = loadInventory();
  const sys = getSystem(inv, systemId);
  if (!sys) return NextResponse.json({ ok: false, error: `no inventory system "${systemId}"` }, { status: 404 });

  try {
    const { contentB64, size } = await withSsh(sys, async (ssh) => {
      const remotePath = `/root/enb/config/${filename}`;
      const sftp = await ssh.requestSFTP();
      // Stream the remote file into a buffer. The cfg files are small
      // (~10–20 KB typical, max we've seen ≈ 16 KB) so a single read
      // is fine — no need to chunk.
      const buf: Buffer = await new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        const rs = sftp.createReadStream(remotePath);
        rs.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
        rs.on('end', () => resolve(Buffer.concat(chunks)));
        rs.on('error', reject);
      });
      return { contentB64: buf.toString('base64'), size: buf.length };
    });
    return NextResponse.json({ ok: true, filename, size, contentBase64: contentB64 });
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    const status = /ENOENT|No such file/.test(msg) ? 404 : 500;
    return NextResponse.json({ ok: false, error: msg }, { status });
  }
}

// GET  /api/backup/gnb?systemId=<id> — backup /root/enb/config + /root/mme/config
//                                       from the named Simnovator system. Returns
//                                       a JSON download.
// POST /api/backup/gnb?systemId=<id> — restore from a previously-downloaded
//                                       backup (JSON body, same shape we emit on GET).
//
// Whitelist-strict — every path in the backup MUST be under /root/enb/config
// or /root/mme/config. Existing remote files are always preserved as
// <path>.bak-<timestamp> before overwriting. See src/lib/gnbBackup.ts.

import { NextResponse } from 'next/server';
import { backupGnb, restoreGnb, backupFilename, type GnbBackup } from '@/lib/gnbBackup';
import { loadInventory, getSystem } from '@/lib/inventory';

export const dynamic = 'force-dynamic';
// Backup walks the remote tree + base64-encodes every file. On a fast LAN this
// is well under 10s, but bump the cap so a slow link can complete.
export const maxDuration = 300;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const systemId = url.searchParams.get('systemId');
  if (!systemId) return NextResponse.json({ ok: false, error: 'systemId required' }, { status: 400 });
  const inv = loadInventory();
  const sys = getSystem(inv, systemId);
  if (!sys) return NextResponse.json({ ok: false, error: `system "${systemId}" not in inventory` }, { status: 404 });

  try {
    const backup = await backupGnb(sys);
    const filename = backupFilename(systemId);
    const body = JSON.stringify(backup, null, 2);
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
        // Surface the file count to the UI without forcing it to re-parse
        // the body.
        'X-Simqa-File-Count': String(backup.manifest.fileCount),
        'X-Simqa-Total-Bytes': String(backup.manifest.totalBytes),
      },
    });
  } catch (e: any) {
    const msg: string = e?.message ?? String(e);
    // Distinguish "this system isn't configured for SSH" (the caller's
    // mistake — they pointed at a system without SSH creds) from "the SSH
    // session failed mid-walk" (which IS server-side / network). The first
    // class is a 400; the second remains 500.
    const isConfigError =
      /no SSH username/i.test(msg) ||
      /no private key/i.test(msg) ||
      /authMode.*privateKey.*but no privateKey/i.test(msg);
    return NextResponse.json(
      { ok: false, error: msg, hint: isConfigError ? 'add SSH credentials (username + authMode + privateKey or password) to this system in inventory.yaml before calling /api/backup/gnb against it' : undefined },
      { status: isConfigError ? 400 : 500 },
    );
  }
}

export async function POST(req: Request) {
  const url = new URL(req.url);
  const systemId = url.searchParams.get('systemId');
  if (!systemId) return NextResponse.json({ ok: false, error: 'systemId required' }, { status: 400 });
  const inv = loadInventory();
  const sys = getSystem(inv, systemId);
  if (!sys) return NextResponse.json({ ok: false, error: `system "${systemId}" not in inventory` }, { status: 404 });

  let body: GnbBackup;
  try {
    body = await req.json();
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: 'request body is not valid JSON' }, { status: 400 });
  }

  try {
    const result = await restoreGnb(sys, body);
    const ok = result.errors.length === 0 && result.restoredFiles.length > 0;
    return NextResponse.json(
      { ok, ...result },
      { status: ok ? 200 : (result.errors.length > 0 ? 400 : 200) },
    );
  } catch (e: any) {
    return NextResponse.json({ ok: false, errors: [e?.message ?? String(e)] }, { status: 500 });
  }
}

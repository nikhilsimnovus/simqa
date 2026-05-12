// GET  /api/backup/config — download a JSON-encoded backup of inventory.yaml,
//                           .env.local, and data/ui-tests/baselines/*.json.
// POST /api/backup/config — restore from a previously-downloaded backup
//                           (JSON body, same shape we emit on GET).
//
// Restore is whitelist-strict and ALWAYS preserves existing files as
// <path>.bak-<timestamp> before overwriting. See src/lib/configBackup.ts.

import { NextResponse } from 'next/server';
import { createBackup, restoreBackup, backupFilename } from '@/lib/configBackup';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const backup = createBackup();
    const filename = backupFilename();
    const body = JSON.stringify(backup, null, 2);
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: 'request body is not valid JSON' }, { status: 400 });
  }
  const result = restoreBackup(body);
  const ok = result.errors.length === 0 && result.restoredFiles.length > 0;
  return NextResponse.json(
    { ok, ...result },
    { status: ok ? 200 : (result.errors.length > 0 ? 400 : 200) },
  );
}

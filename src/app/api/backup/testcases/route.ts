// GET /api/backup/testcases?systemId=<id> — pull every testcase from the
// Simnovator system named by systemId (must be UESIM-capable in inventory)
// and stream it back to the browser as a JSON download.
//
// Workaround for SIM40-2010 (bulk-export silently drops cases): paginates
// /v2/testcases/search ourselves rather than hitting the broken export.

import { NextResponse } from 'next/server';
import { loadInventory } from '@/lib/inventory';
import { exportTestcases, testcaseExportFilename } from '@/lib/testcaseBackup';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const systemId = q.get('systemId')?.trim();
  // WHICH login. Without it the export is the default account's catalogue and
  // silently none of the others' — see ExportOptions.boxUserId.
  const boxUserId = q.get('boxUserId')?.trim() || undefined;
  if (!systemId) {
    return NextResponse.json({ ok: false, error: 'systemId required' }, { status: 400 });
  }
  const inv = loadInventory();
  try {
    const exp = await exportTestcases(inv, systemId, { boxUserId });
    const filename = testcaseExportFilename(systemId, new Date(), exp.manifest.boxUser);
    const body = JSON.stringify(exp, null, 2);
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
        'X-Simqa-Pulled': String(exp.manifest.pulled),
        'X-Simqa-Server-Total': String(exp.manifest.serverTotal),
      },
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 502 });
  }
}

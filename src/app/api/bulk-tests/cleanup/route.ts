// POST /api/bulk-tests/cleanup
//   body: { systemId?: string }
//
// Deletes every testcase on the box that carries the qa-bulk tag OR whose
// name starts with qa-bulk- (defensive — matches the generator's naming
// convention). Returns the list of deleted ids + any failures.

import { NextResponse } from 'next/server';
import { loadInventory, uesimApiOptsForSystem } from '@/lib/inventory';
import { cleanupBulkTestcases } from '@/lib/bulkTests/generator';
import type { UesimApiOpts } from '@/lib/bulkTests/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 600;

export async function POST(req: Request) {
  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }
  const systemId: string = body.systemId ?? 'sys-6';

  const inv = loadInventory();
  const apiOpts = uesimApiOptsForSystem(inv, systemId);
  if (!apiOpts) return NextResponse.json({ ok: false, error: `system "${systemId}" not testable` }, { status: 404 });

  const opts: UesimApiOpts = {
    systemId: apiOpts.systemId,
    host: apiOpts.host,
    username: apiOpts.username,
    password: apiOpts.password,
  };

  try {
    const r = await cleanupBulkTestcases(opts);
    return NextResponse.json({
      ok: r.failed.length === 0,
      systemId,
      host: opts.host,
      deletedCount: r.deleted.length,
      failedCount: r.failed.length,
      deleted: r.deleted,
      failed: r.failed,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
  }
}

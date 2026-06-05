// GET /api/bulk-tests/manifest
//   Returns the persisted manifest of generated testcases.

import { NextResponse } from 'next/server';
import { readManifest } from '@/lib/bulkTests/state';

export const dynamic = 'force-dynamic';

export async function GET() {
  const m = readManifest();
  if (!m) return NextResponse.json({ ok: false, error: 'no manifest on disk yet — run generate first' }, { status: 404 });
  return NextResponse.json({
    ok: true,
    targetHost: m.targetHost,
    startedAt: m.startedAt,
    finishedAt: m.finishedAt,
    total: m.total,
    passed: m.passed,
    failed: m.failed,
    skipped: m.skipped,
    created: m.created,
    failures: m.failures,
    skips: m.skips,
  });
}

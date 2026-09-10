// GET /api/backup/auto/files?ip=192.168.1.106&category=enb_config
//
// What the automatic backup is holding for one system and one category. Rows
// are what the browser card lists; `missingFromSource` marks a file the last
// cycle no longer found on the box — kept deliberately, which is the whole
// point of never deleting.

import { NextResponse } from 'next/server';
import { listFiles, BACKUP_CATEGORIES, type BackupCategory } from '@/lib/backup/store';
import { readStatus } from '@/lib/backup/status';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const ip = (url.searchParams.get('ip') ?? '').trim();
  const category = (url.searchParams.get('category') ?? '').trim() as BackupCategory;

  if (!ip) return NextResponse.json({ ok: false, error: 'ip required' }, { status: 400 });
  // Whitelist rather than trust: the category becomes a path segment.
  if (!BACKUP_CATEGORIES.includes(category)) {
    return NextResponse.json(
      { ok: false, error: `unknown category "${category}" (expected ${BACKUP_CATEGORIES.join(' | ')})` },
      { status: 400 },
    );
  }

  try {
    const st = readStatus();
    const files = listFiles(ip, category, st.lastCycleStartedAt);
    return NextResponse.json({
      ok: true, ip, category, files,
      lastCycleStartedAt: st.lastCycleStartedAt,
      state: st.systems[ip]?.state ?? 'never-run',
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e), files: [] }, { status: 400 });
  }
}

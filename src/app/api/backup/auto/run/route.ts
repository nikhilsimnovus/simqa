// POST /api/backup/auto/run — run a backup cycle now.
//
// This JOINS a cycle already in progress rather than starting a second one
// (tick() holds the in-flight promise), so hitting the button twice cannot put
// two passes on the same lab boxes at once.
//
// maxDuration is generous because a first run has to transfer every config on
// every system; later runs are hash-compares and finish in seconds.

import { NextResponse } from 'next/server';
import { ensureBackupScheduler, tick } from '@/lib/backup/scheduler';

export const dynamic = 'force-dynamic';
export const maxDuration = 600;

export async function POST() {
  ensureBackupScheduler();
  try {
    const summary = await tick();
    return NextResponse.json({ ok: true, summary });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
  }
}

// POST /api/config-fidelity/live/scan — look for running executions now.
//
// The watcher already polls on its own; this is for the "Check now" button and
// for proving the wiring works without waiting for the next tick. It joins the
// in-flight poll rather than starting a second one.

import { NextResponse } from 'next/server';
import { ensureFidelityWatcher, tick, watcherStatus } from '@/lib/liveFidelity/watcher';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function POST() {
  ensureFidelityWatcher();
  try {
    await tick();
    return NextResponse.json({ ok: true, watcher: watcherStatus() });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
  }
}

// GET /api/config-fidelity/live/captures?ip=192.168.1.102
//
// Every execution captured for one Simnovator, newest first — the middle pane:
// the testcases that ran, each with its config-match verdict.

import { NextResponse } from 'next/server';
import { listCaptures, hasArtifact } from '@/lib/liveFidelity/store';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const ip = (new URL(req.url).searchParams.get('ip') ?? '').trim();
  if (!ip) return NextResponse.json({ ok: false, error: 'ip required' }, { status: 400 });

  try {
    const captures = listCaptures(ip).map((c) => ({
      ...c,
      // Recomputed rather than trusted: the summary records what we meant to
      // write, these say what is actually on disk and downloadable.
      hasTestcase: hasArtifact(ip, c.captureId, 'testcase.json'),
      hasUeCfg: hasArtifact(ip, c.captureId, 'ue.cfg'),
    }));
    return NextResponse.json({ ok: true, ip, captures });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e), captures: [] }, { status: 400 });
  }
}

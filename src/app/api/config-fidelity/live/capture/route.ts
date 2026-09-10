// GET /api/config-fidelity/live/capture?ip=…&id=…
//
// One capture's full comparison — the rows behind the table.

import { NextResponse } from 'next/server';
import { readCapture, readArtifact, hasArtifact } from '@/lib/liveFidelity/store';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const ip = (url.searchParams.get('ip') ?? '').trim();
  const id = (url.searchParams.get('id') ?? '').trim();
  if (!ip || !id) return NextResponse.json({ ok: false, error: 'ip and id required' }, { status: 400 });

  try {
    const summary = readCapture(ip, id);
    if (!summary) return NextResponse.json({ ok: false, error: `no capture ${id} for ${ip}` }, { status: 404 });

    let comparison: any = null;
    if (hasArtifact(ip, id, 'comparison.json')) {
      comparison = JSON.parse(readArtifact(ip, id, 'comparison.json').toString('utf8'));

      // Send only the rows worth looking at unless the caller asks for all of
      // them. A 512-UE testcase compares 16,419 parameters and the full set is
      // a 3.7 MB response — the table opens on the differences anyway, and the
      // complete comparison is downloadable as comparison.json.
      const want = (url.searchParams.get('rows') ?? 'notable').toLowerCase();
      const all: any[] = comparison.rows ?? [];
      comparison.totalRows = all.length;
      comparison.matched = all.filter((r: any) => r.status === 'honoured').length;
      if (want !== 'all') {
        // Everything except the honoured ones: the failures, plus the rows that
        // say why a parameter was not checked. Those are the coverage story and
        // are the second thing anyone looks at.
        comparison.rows = all.filter((r: any) => r.status !== 'honoured');
        comparison.truncated = comparison.rows.length < all.length;
      }
    }
    return NextResponse.json({
      ok: true, ip, summary, comparison,
      hasTestcase: hasArtifact(ip, id, 'testcase.json'),
      hasUeCfg: hasArtifact(ip, id, 'ue.cfg'),
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 400 });
  }
}

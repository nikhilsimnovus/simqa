// Baseline management endpoints.
// GET    /api/ui-tests/baselines              -> list all saved baselines
// POST   /api/ui-tests/baselines              -> save the latest run as a baseline
// DELETE /api/ui-tests/baselines/<id>         -> delete one (handled in [id]/route.ts)

import { NextResponse } from 'next/server';
import { listBaselines, saveBaseline } from '@/lib/uiTester';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ baselines: listBaselines() });
}

export async function POST(req: Request) {
  let body: { id?: string; runDir?: string } = {};
  try { body = await req.json(); } catch { /* empty body ok */ }
  if (!body.id) return NextResponse.json({ ok: false, message: 'missing baseline id' }, { status: 400 });
  if (!body.runDir) return NextResponse.json({ ok: false, message: 'missing runDir; pick a run to save as baseline' }, { status: 400 });

  // Load summary.json from the runDir (where simqa wrote it during the run)
  const summaryPath = path.join(body.runDir, 'summary.json');
  if (!fs.existsSync(summaryPath)) {
    return NextResponse.json({ ok: false, message: `no summary.json under ${body.runDir}` }, { status: 404 });
  }
  let summary: any;
  try { summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8')); }
  catch (e: any) { return NextResponse.json({ ok: false, message: `could not parse summary.json: ${e?.message ?? String(e)}` }, { status: 500 }); }

  const r = saveBaseline({
    id: body.id,
    runDir: summary.runDir ?? body.runDir,
    finishedAt: summary.finishedAt ?? new Date().toISOString(),
    results: summary.results ?? [],
  });
  return NextResponse.json(r, { status: r.ok ? 200 : 400 });
}

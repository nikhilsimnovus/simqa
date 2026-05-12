// POST /api/end-to-end/run
// Body: RunRequest (see src/lib/endToEnd/types.ts)
// Kicks off an end-to-end validation run against the selected Simnovator
// system. The run executes a real testcase (state-mutating!) and walks the
// check catalogue. Returns immediately with the runId; poll /status for
// progress.

import { NextResponse } from 'next/server';
import { startRun } from '@/lib/endToEnd/runner';
import type { RunRequest } from '@/lib/endToEnd/types';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  let body: RunRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'request body is not valid JSON' }, { status: 400 });
  }
  if (!body.systemId) return NextResponse.json({ ok: false, error: 'systemId required' }, { status: 400 });
  if (!body.testcaseId && !body.useLastExecution) {
    return NextResponse.json({ ok: false, error: 'either testcaseId or useLastExecution must be set' }, { status: 400 });
  }
  const r = await startRun(body);
  if (!r.ok) return NextResponse.json(r, { status: 400 });
  return NextResponse.json(r);
}

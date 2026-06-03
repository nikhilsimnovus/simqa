import { NextResponse } from 'next/server';
import { abortMatrixRun } from '@/lib/configFidelity/runner';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const { runId } = (await req.json().catch(() => ({}))) as { runId?: string };
  if (!runId) return NextResponse.json({ error: 'runId required' }, { status: 400 });
  return NextResponse.json({ aborted: abortMatrixRun(runId) });
}

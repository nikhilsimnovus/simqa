// GET /api/jobs/setups → the Simnovator setups a job can target, each with the
// UE and app server resolved from its topology profile and a preview of the
// exact ./install line that will run.

import { NextResponse } from 'next/server';
import { listSetups, previewInstallCommand } from '@/lib/jobTracker/setups';

export const dynamic = 'force-dynamic';

export async function GET() {
  const setups = listSetups().map((s) => ({ ...s, installPreview: previewInstallCommand(s) }));
  return NextResponse.json({ ok: true, setups });
}

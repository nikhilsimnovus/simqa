// GET  /api/e2e-testcases   list saved end-to-end test cases
// POST /api/e2e-testcases   capture a new one (pulls the testcase definition
//                           and the chosen config files, stores them locally)

import { NextResponse } from 'next/server';
import { loadInventory } from '@/lib/inventory';
import { listE2ETestcases, captureE2ETestcase, type CaptureRequest } from '@/lib/e2eTestcases';
import { userFromRequest } from '@/lib/identity';

export const dynamic = 'force-dynamic';
// Capture reads a testcase over REST and up to three files over SSH.
export const maxDuration = 300;

export async function GET() {
  return NextResponse.json({ ok: true, testcases: listE2ETestcases() });
}

export async function POST(req: Request) {
  let body: CaptureRequest;
  try { body = (await req.json()) as CaptureRequest; }
  catch { return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 }); }

  try {
    const inv = loadInventory();
    const r = await captureE2ETestcase(inv, { ...body, createdBy: userFromRequest(req) });
    return NextResponse.json(r, { status: r.ok ? 200 : 400 });
  } catch (e: any) {
    // Always JSON — the page parses the body, and an HTML 500 makes it choke.
    return NextResponse.json({ ok: false, error: e?.stack ?? e?.message ?? String(e) }, { status: 500 });
  }
}

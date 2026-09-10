// POST /api/build-validation      run the selected verification groups
// GET  /api/build-validation      list saved reports  (?id= for one)
//
// The run is synchronous. Reachability/login/sample-tests finish in seconds;
// the run-tests group executes two real testcases and can take many minutes,
// which is why maxDuration is raised — the client uses a long fetch timeout
// for that path and shows per-group progress from the returned report.

import { NextResponse } from 'next/server';
import { loadInventory } from '@/lib/inventory';
import {
  runBuildValidation, listReports, loadReport, observeInstallProgress, cancelRun,
  type BuildValidationRequest,
} from '@/lib/buildValidation';

export const dynamic = 'force-dynamic';
export const maxDuration = 3600;

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as BuildValidationRequest & { observeInstall?: { host: string; baselineBuild?: string } };

    // Install-progress poll: a cheap, separate mode so the page can watch the
    // box come back while the operator runs the installer in Cockpit.
    if (body?.observeInstall?.host) {
      const obs = await observeInstallProgress(body.observeInstall.host, body.observeInstall.baselineBuild);
      return NextResponse.json({ ok: true, observation: obs });
    }

    if (!body?.systemId) {
      return NextResponse.json({ ok: false, error: 'systemId is required — pick the Simnovator to validate' }, { status: 400 });
    }
    if (!Array.isArray(body.checks) || body.checks.length === 0) {
      return NextResponse.json({ ok: false, error: 'select at least one Build Verification check' }, { status: 400 });
    }

    const inv = loadInventory();
    const report = await runBuildValidation(inv, body);
    return NextResponse.json({ ok: true, report });
  } catch (e: any) {
    // Always answer JSON — the page parses the body, and an HTML 500 page
    // makes it choke with "Unexpected end of JSON input".
    return NextResponse.json({ ok: false, error: e?.stack ?? e?.message ?? String(e) }, { status: 500 });
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get('id');
  if (id) {
    const report = loadReport(id);
    if (!report) return NextResponse.json({ ok: false, error: `no report "${id}"` }, { status: 404 });
    return NextResponse.json({ ok: true, report });
  }

  // ?systemId=… → just the newest report for that box, as one report rather
  // than fifty. This is what the Build Check page asks for on load so a page
  // refresh puts the last verification back on screen instead of a blank card.
  const systemId = url.searchParams.get('systemId');
  if (systemId) {
    const report = listReports(50).find((r) => r.systemId === systemId) ?? null;
    return NextResponse.json({ ok: true, report });
  }

  return NextResponse.json({ ok: true, reports: listReports(50) });
}

/**
 * DELETE /api/build-validation?id=…
 *
 * Cancel a verification run. Writes a marker beside the report; the run checks
 * it between groups and inside the execution wait loop, where it also stops the
 * testcase on the box — cancelling has to stop the hardware, not just stop us
 * watching it.
 *
 * A file rather than an in-memory flag because the run is one long POST and
 * whoever cancels is a different request.
 */
export async function DELETE(req: Request) {
  const id = (new URL(req.url).searchParams.get('id') ?? '').trim();
  if (!cancelRun(id)) {
    return NextResponse.json({ ok: false, error: 'a valid run id is required' }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}

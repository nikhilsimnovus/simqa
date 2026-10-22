// POST /api/automation/suites/[id]/run
//
// Synchronous (small suites only — typical ≤ 30 testcases). Returns the
// SuiteRunResult JSON directly.
//
//   kind == 'uesim-only'    fires POST /v2/testcases/{id}/executions per
//                            testcaseId on the suite's UESIM.
//   kind == 'uesim+callbox' for each filename in testcaseIds:
//                            - if it's in suite.uploadedConfigs, scp
//                              the content to /root/enb/config/<file>
//                              on the callbox.
//                            - else: verify it's still present on the
//                              callbox (the user picked it earlier).
//                            (eNB restart is left to the operator.)

import { NextResponse } from 'next/server';
import { getSuite, updateSuite } from '@/lib/automation/store';
import {
  enteredLicences, effectiveLicences, licencesToSave, licenceKeyFor,
} from '@/lib/automation/licenceChoice';
import { runSuite } from '@/lib/automation/runner';
import { startProgress, markRunning, markStep, finishProgress } from '@/lib/automation/progress';
import { userFromRequest } from '@/lib/identity';
import { recordSystemUse } from '@/lib/systemUsage';
import { loadInventory, getSystem } from '@/lib/inventory';
import { syncSuiteToServer } from '@/lib/automation/syncServerConfigs';

export const dynamic = 'force-dynamic';
export const maxDuration = 900;


// Which licence this run writes, and remembering it for the next one.
//
// The ENB and MME values come from the Run dialog, which pre-fills them with
// whatever the last run against THIS callbox used. Pressing Run without
// touching them reuses those; changing one is remembered from then on. See
// licenceChoice.ts for the merge rule and for why MME covers ims.cfg too.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const suite = getSuite(id);
  if (!suite) return NextResponse.json({ ok: false, error: `no suite "${id}"` }, { status: 404 });

  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }

  // `itemIds` runs just those rows — the per-testcase Run button in the suite
  // list. Order follows the suite, not the order the ids arrive in, so a subset
  // still executes in the sequence the suite defines.
  let target = suite;
  if (Array.isArray(body.itemIds) && body.itemIds.length > 0) {
    const wanted = new Set(body.itemIds.map(String));
    const picked = (suite.items ?? []).filter(it => wanted.has(it.id));
    if (picked.length === 0) {
      return NextResponse.json({ ok: false, error: 'none of the given itemIds are in this suite' }, { status: 400 });
    }
    target = { ...suite, items: picked, testcaseIds: picked.map(it => it.simnovatorTcId) };
  }

  // Run it anywhere.
  //
  // The systems saved on a suite are where it was BUILT, not where it may run:
  // the same suite belongs on .95 as sruthi today and .102 as simuser
  // tomorrow, which is how campaigns have always worked. Anything the caller
  // names replaces the saved value for this run only; anything it leaves out
  // keeps the suite's own. Nothing here is written back.
  const pick = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const onBox = pick(body.uesimSystemId);
  const onCallbox = pick(body.callboxSystemId);
  const onUe = pick(body.ueSystemId);
  const asUser = body.boxUserId === null ? undefined : pick(body.boxUserId);
  if (onBox || onCallbox || onUe || asUser) {
    target = {
      ...target,
      uesimSystemId: onBox ?? target.uesimSystemId,
      boxUserId: asUser ?? target.boxUserId,
      callboxSystemId: onCallbox ?? target.callboxSystemId,
      ueSystemId: onUe ?? target.ueSystemId,
    };
    // A setup with no callbox cannot link cfgs; one with a callbox can. Said
    // here rather than left to fail row by row inside the runner.
    if (onCallbox) target.kind = 'uesim+callbox';
    else if (body.callboxSystemId === null) { target.kind = 'uesim-only'; target.callboxSystemId = undefined; }

    // Moving to another Simnovator without naming a login drops the saved one:
    // it is a login on the box this suite came FROM, and carrying it across
    // would either miss (falling back to the first login anyway) or, worse,
    // match a different person who happens to share the name.
    if (onBox && onBox !== suite.uesimSystemId && !asUser && !Array.isArray(body.users)) {
      target.boxUserId = undefined;
    }
  }

  // Moving to another setup runs entirely out of the server's own folder —
  // /root/automation_configs/<suite>/<row>/ — because nothing on the new boxes
  // knows about this suite: the test case is created from test.json and the
  // callbox gets enb/mme/ims (and whatever the MME includes) pushed under the
  // names the row picked.
  //
  // A run never reads a box to fill that folder.
  //
  // It used to: a short folder triggered a full sync that fetched the test
  // case from the Simnovator and the cfgs off the callbox. That is the one
  // path this is meant to close — it let a run execute a definition or a
  // config that came from a box rather than from here, which is the opposite
  // of the folder being the record of what the row runs.
  //
  // What still happens is local only: the suite's own uploads and uploaded
  // test cases are written into the folder, because those ARE the row's
  // files and are already in hand. A row whose folder is still short fails
  // naming the file, rather than quietly running the callbox's copy.
  //
  // To fill a folder FROM the boxes — building a suite from configs that
  // live on a callbox — use Sync on the suite, which is a deliberate act.
  try {
    await syncSuiteToServer(loadInventory(), suite, { structureOnly: true });
  } catch { /* the run reports what is still missing, row by row */ }

  // Which logins to run for. One pass each, in order — see RunOpts.asUsers.
  // Absent or empty means the login the suite is saved with.
  const asUsers: string[] = Array.isArray(body.users)
    ? body.users.map(String).map((u: string) => u.trim()).filter(Boolean)
    : [];

  const rows = target.items ?? [];
  // The controller is registered with the progress store so a Stop request can
  // reach this run: the runner checks the signal between rows, so stopping the
  // box's current execution also ends the suite instead of just letting the
  // next row start.
  const abort = new AbortController();
  startProgress(id, target.name, rows.length || target.testcaseIds.length, rows.map(r => r.name), abort);

  // Who submitted this job, and which lab systems it is about to use. Recorded
  // BEFORE the run rather than after, so a long run shows the box as in-use by
  // this person while it is still going — and a crashed run still leaves the
  // trail behind.
  const submittedBy = userFromRequest(req);
  const inv = loadInventory();
  const what = `automation suite "${target.name}"`;
  for (const sysId of [target.uesimSystemId, target.callboxSystemId]) {
    if (!sysId) continue;
    recordSystemUse({
      systemId: sysId,
      host: getSystem(inv, sysId)?.host,
      by: submittedBy,
      at: new Date().toISOString(),
      what,
    });
  }

  // The licences: what was entered, over what this callbox last ran with.
  //
  // Keyed by the callbox this run is actually targeting, which is not
  // necessarily the one the suite was built against — body.callboxSystemId
  // may have redirected it.
  const licenceKey = licenceKeyFor(getSystem(inv, target.callboxSystemId ?? '')?.host);
  const savedLicences = suite.licenceTags?.[licenceKey];
  const entered = enteredLicences(body.licenceTags);
  const licenceTags = effectiveLicences(savedLicences, entered);
  // Remember a changed choice before the run, not after: a run that is
  // interrupted or crashes still used these licences, and the next dialog
  // should say so.
  const toSave = licencesToSave(savedLicences, entered, new Date().toISOString());
  if (toSave) {
    try {
      updateSuite(id, { licenceTags: { ...(suite.licenceTags ?? {}), [licenceKey]: toSave } });
    } catch { /* remembering is a convenience — never fail a run over it */ }
  }

  try {
    const result = await runSuite(target, {
      asUsers,
      signal: abort.signal,
      submittedBy,
      // Which licence each config should ask for. Written into the copies
      // pushed to the callbox, and put back afterwards — the callbox keeps
      // the licence its operators set.
      licenceTags: Object.keys(licenceTags).length ? licenceTags : undefined,
      collectDiagnostics: !!body.collectDiagnostics,
      perfQaUrl: typeof body.perfQaUrl === 'string' ? body.perfQaUrl : undefined,
      perfQaProfile: typeof body.perfQaProfile === 'string' ? body.perfQaProfile : undefined,
      onProgress: (done, _total, current) => markRunning(id, done, current),
      // The box's own status and verdict ride along, so a finished row reads
      // the same live as it will once the run is saved.
      onStep: (step) => markStep(id, step.testcaseId, step.ok, {
        status: step.boxStatus, result: step.boxResult, verdict: step.verdict, stopped: step.stopped,
        post: step.postProcessing?.outcome, final: step.finalResult,
      }),
    });
    return NextResponse.json({ ok: true, result, runId: result.runId });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
  } finally {
    finishProgress(id);
  }
}

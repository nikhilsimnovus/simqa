// POST /api/automation/campaigns/[id]/run
//
// Execute a campaign on the setup chosen in the body — Simnovator, login, and
// the callbox and UE when the rows need them. None of that is stored on the
// campaign: the same campaign runs on 192.168.1.102 as sruthi today and
// 192.168.1.95 as mohan tomorrow.
//
// The run itself goes through the suite runner, unchanged: the campaign is
// turned into a suite-shaped object whose rows point back at the folders their
// configs were captured into. Progress and Stop are keyed by the campaign id,
// the same way a suite's are keyed by the suite id.

import { NextResponse } from 'next/server';
import { getCampaign, updateCampaign } from '@/lib/automation/campaignStore';
// A campaign runs on whatever box is picked, so its licences are remembered
// per callbox exactly as a suite's are.
import {
  enteredLicences, effectiveLicences, licencesToSave, licenceKeyFor,
} from '@/lib/automation/licenceChoice';
import { runCampaign } from '@/lib/automation/campaignRunner';
import { startProgress, markRunning, markStep, finishProgress } from '@/lib/automation/progress';
import { userFromRequest } from '@/lib/identity';
import { recordSystemUse } from '@/lib/systemUsage';
import { loadInventory, getSystem } from '@/lib/inventory';

export const dynamic = 'force-dynamic';
export const maxDuration = 900;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const campaign = getCampaign(id);
  if (!campaign) return NextResponse.json({ ok: false, error: `no campaign "${id}"` }, { status: 404 });

  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }

  const uesimSystemId = String(body.uesimSystemId ?? '').trim();
  if (!uesimSystemId) {
    return NextResponse.json({ ok: false, error: 'choose a Simnovator to run on' }, { status: 400 });
  }
  const target = {
    uesimSystemId,
    boxUserId: body.boxUserId ? String(body.boxUserId) : undefined,
    callboxSystemId: body.callboxSystemId ? String(body.callboxSystemId) : undefined,
    ueSystemId: body.ueSystemId ? String(body.ueSystemId) : undefined,
    defaultDurationSec: typeof body.defaultDurationSec === 'number' ? body.defaultDurationSec : undefined,
    stopOnFail: !!body.stopOnFail,
  };

  // Just those rows, when the page ran a subset.
  let rows = campaign.items ?? [];
  if (Array.isArray(body.itemIds) && body.itemIds.length > 0) {
    const wanted = new Set(body.itemIds.map(String));
    const picked = rows.filter(r => wanted.has(r.id));
    if (picked.length === 0) {
      return NextResponse.json({ ok: false, error: 'none of the given itemIds are in this campaign' }, { status: 400 });
    }
    rows = picked;
  }

  const abort = new AbortController();
  startProgress(id, campaign.name, rows.length, rows.map(r => r.name), abort);

  // Who pressed Run, and which machines this is about to occupy — recorded
  // before the run, so a long campaign shows the boxes as in use while it goes.
  const submittedBy = userFromRequest(req);
  const inv = loadInventory();
  for (const sysId of [target.uesimSystemId, target.callboxSystemId]) {
    if (!sysId) continue;
    recordSystemUse({
      systemId: sysId,
      host: getSystem(inv, sysId)?.host,
      by: submittedBy,
      at: new Date().toISOString(),
      what: `campaign "${campaign.name}"`,
    });
  }

  // The licences: what was entered, over what this callbox last ran with.
  // Keyed by the callbox chosen in THIS dialog, not by the one the campaign
  // happened to run on last — picking a different box must not hand it the
  // previous box's tag.
  const licenceKey = licenceKeyFor(getSystem(inv, target.callboxSystemId ?? '')?.host);
  const savedLicences = campaign.licenceTags?.[licenceKey];
  const entered = enteredLicences(body.licenceTags);
  const licenceTags = effectiveLicences(savedLicences, entered);
  // Remembered before the run, not after: a campaign that is interrupted still
  // used these licences, and the next dialog should say so.
  const toSave = licencesToSave(savedLicences, entered, new Date().toISOString());
  if (toSave) {
    try {
      updateCampaign(id, { licenceTags: { ...(campaign.licenceTags ?? {}), [licenceKey]: toSave } });
    } catch { /* remembering is a convenience — never fail a run over it */ }
  }

  try {
    const result = await runCampaign({ ...campaign, items: rows }, target, {
      signal: abort.signal,
      submittedBy,
      // Written into the configs pushed to the callbox, and put back when the
      // run ends — the callbox keeps the licence its operators set.
      licenceTags: Object.keys(licenceTags).length ? licenceTags : undefined,
      onProgress: (done, _total, current) => markRunning(id, done, current),
      // The box's own status and verdict ride along, so a finished row reads
      // the same live as it will once the run is saved.
      onStep: (step) => markStep(id, step.testcaseId, step.ok, {
        status: step.boxStatus, result: step.boxResult, verdict: step.verdict, stopped: step.stopped,
      }),
    });
    // Remembered only as the default the next Run dialog opens on.
    try {
      updateCampaign(id, {
        lastUesimSystemId: target.uesimSystemId,
        lastBoxUserId: target.boxUserId,
        lastCallboxSystemId: target.callboxSystemId,
        lastUeSystemId: target.ueSystemId,
      });
    } catch { /* the run is what matters */ }
    return NextResponse.json({ ok: true, result, runId: result.runId });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
  } finally {
    finishProgress(id);
  }
}

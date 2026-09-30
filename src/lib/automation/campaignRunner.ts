// Running a campaign.
//
// There is no second execution engine here, and there should not be one. A
// campaign is a running order; what a run needs is a suite-shaped thing with
// systems attached, so that is what this builds — from the campaign's rows and
// the setup chosen at Run time — and hands to runSuite. Everything the suite
// path already does then applies unchanged: the per-row testcase copy, the
// configs pushed from /root/automation_configs, the symlink and lte restart,
// the one-at-a-time sequencing, the attach gate, the snapshots, the history.
//
// The one thing that differs is where a row's configs come from. A campaign
// row carries `configSuite`, the suite it was taken from, and the runner reads
// that folder — so a test case built on 192.168.1.102 as sruthi can run on
// 192.168.1.95 as mohan using the files captured when its own suite ran.

import { runSuite, type RunOpts } from './runner';
import type { TestCampaign } from './campaignStore';
import type { AutomationSuite, SuiteItem } from '../inventory';

export interface CampaignRunTarget {
  /** The Simnovator to execute on, and the login to execute as. Chosen per
   *  run: a campaign is never bound to the setup its suites were built on. */
  uesimSystemId: string;
  boxUserId?: string;
  /** The callbox to bring up, when the rows need one. Without it the run is
   *  UESIM-only and no cfg is linked. */
  callboxSystemId?: string;
  /** The UE simulator whose log the attach check reads. Optional: the
   *  topology supplies it when the campaign does not. */
  ueSystemId?: string;
  /** Applies to rows that do not carry their own. */
  defaultDurationSec?: number;
  stopOnFail?: boolean;
}

/**
 * The suite a campaign run executes as.
 *
 * Built fresh for each run and never stored: its systems come from the Run
 * dialog, and its rows are the campaign's, each pointed back at the folder its
 * configs were captured into. The id is the campaign's, so progress and Stop
 * reach it by the same key the UI already polls.
 */
export function suiteForCampaign(campaign: TestCampaign, target: CampaignRunTarget): AutomationSuite {
  const items: SuiteItem[] = campaign.items.map(it => ({
    id: it.id,
    name: it.name,
    simnovatorTcId: it.simnovatorTcId,
    callboxCfg: it.callboxCfg,
    mmeCfg: it.mmeCfg,
    imsCfg: it.imsCfg,
    durationSec: it.durationSec,
    // Where this row's saved configs live — the suite it came from.
    configSuite: it.configSuite ?? it.sourceSuiteName,
  }));

  return {
    id: campaign.id,
    name: campaign.name,
    createdBy: campaign.createdBy,
    kind: target.callboxSystemId ? 'uesim+callbox' : 'uesim-only',
    uesimSystemId: target.uesimSystemId,
    boxUserId: target.boxUserId,
    callboxSystemId: target.callboxSystemId,
    ueSystemId: target.ueSystemId,
    items,
    testcaseIds: items.map(i => i.simnovatorTcId),
    defaultDurationSec: target.defaultDurationSec,
    stopOnFail: target.stopOnFail ?? false,
    createdAt: campaign.createdAt,
    updatedAt: campaign.updatedAt,
  } as AutomationSuite;
}

/** Execute a campaign on the chosen setup, through the suite runner. */
export async function runCampaign(campaign: TestCampaign, target: CampaignRunTarget, opts: RunOpts = {}) {
  if (!campaign.items?.length) throw new Error(`campaign "${campaign.name}" has no test cases`);
  if (!target.uesimSystemId) throw new Error('a Simnovator must be chosen before a campaign can run');
  return runSuite(suiteForCampaign(campaign, target), opts);
}

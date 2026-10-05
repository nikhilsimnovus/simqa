// Keeping /root/automation_configs equal to what a suite row would run with.
//
// The files live in three different places — the cfgs on the callbox, the
// subscriber DB inside an MME include line, the testcase only in the
// Simnovator's own database — so this gathers all of them and writes one
// folder per test case. Called when a suite is saved, and again before each
// row executes, so the folder is never behind the boxes.
//
// Best-effort throughout: a box that cannot be read leaves its file as it was.
// Blanking a config because a callbox was rebooting would be worse than
// serving yesterday's, and an unreachable box must never stop a suite being
// saved.

import { captureRowConfigs } from '../suiteConfigStore';
import { ensureSuiteTree, writeTestCaseFiles, automationRoot, dropStaleFile, type ServerFile } from './serverConfigs';
import { getSystem, uesimApiOptsForSystem, type AutomationSuite, type Inventory, type InventorySystem } from '../inventory';

export interface SyncResult {
  root: string;
  rows: Array<{ row: string; dir: string; written: string[]; error?: string }>;
}

/** The testcase definition as the box holds it, read through whoever owns it. */
async function testDefinitionJson(
  inv: Inventory,
  suite: AutomationSuite,
  sourceId: string,
  boxUserId?: string,
): Promise<string | undefined> {
  const opts = uesimApiOptsForSystem(inv, suite.uesimSystemId ?? '', boxUserId ?? suite.boxUserId);
  if (!opts) return undefined;
  try {
    const { getTestcase } = await import('../uesimClient');
    const td: any = await getTestcase(opts, sourceId);
    if (td?.testDefinition) return JSON.stringify(td.testDefinition, null, 2);
  } catch {
    // A testcase belongs to one login and is invisible to the others; read it
    // through whoever owns it, the same way the runner does when it copies one.
    try {
      const { findDefinition } = await import('../testcaseForUser');
      const sys = getSystem(inv, suite.uesimSystemId ?? '');
      const found = sys ? await findDefinition(sys, sourceId, opts.username) : null;
      if (found?.td) return JSON.stringify(found.td, null, 2);
    } catch { /* the box cannot be read at all */ }
  }
  return undefined;
}

/** What captureRowConfigs calls a file, against what the folder calls it.
 *
 *  The MME's included files are NOT in here: they keep the names their config
 *  uses, because those names are what has to exist on the callbox for the MME
 *  to start, and because "db" said nothing about which file it was. */
const AS_SERVER_NAME: Record<string, ServerFile> = {
  'enb.cfg': 'enb.cfg',
  'mme.cfg': 'mme.cfg',
  'ims.cfg': 'ims.cfg',
  'ots.cfg': 'ots.cfg',
  'ue.cfg': 'ue.cfg',
};

/** One row: read the boxes, read the testcase, write the folder. */
export async function syncRowToServer(
  inv: Inventory,
  suite: AutomationSuite,
  row: { name: string; simnovatorTcId: string; uploadedTestcase?: string; callboxCfg?: string; mmeCfg?: string; imsCfg?: string },
  callbox?: InventorySystem,
  ueSystem?: InventorySystem,
  boxUserId?: string,
): Promise<{ row: string; dir: string; written: string[]; error?: string }> {
  const files: Record<string, string | undefined> = {};

  // By the row's own names: the callbox's enb.cfg/mme.cfg/ims.cfg links point
  // at whatever ran last, which outside a run is usually another row's.
  const { contents, includes } = await captureRowConfigs(callbox, ueSystem, {
    enb: row.callboxCfg, mme: row.mmeCfg, ims: row.imsCfg,
  }).catch(() => ({ contents: {} as any, includes: {} as Record<string, string> }));
  for (const [from, to] of Object.entries(AS_SERVER_NAME)) {
    const text = (contents as any)[from];
    if (typeof text === 'string') files[to] = text;
  }
  // …and everything the MME config includes, under its own name.
  for (const [name, text] of Object.entries(includes ?? {})) files[name] = text;

  // Earlier versions saved the subscriber DB under the flat name "db", which
  // said nothing about which file it was — and, when the guess behind it was
  // wrong, hid that it was the wrong file. Now that the same content is
  // written under the name its config uses, the old one is stale: drop it
  // rather than leaving two copies and no way to tell which is current.
  if (Object.keys(includes ?? {}).length > 0) dropStaleFile(suite.name, row.name, 'db');

  // An uploaded row's definition comes from the file, not from a box: nothing
  // has been created on a Simnovator yet, and this folder is what the run will
  // build it from.
  const uploaded = row.uploadedTestcase ? suite.uploadedTestcases?.[row.uploadedTestcase] : undefined;
  const td = uploaded ?? await testDefinitionJson(inv, suite, row.simnovatorTcId, boxUserId);
  if (td) files['test.json'] = td;

  return { row: row.name, ...writeTestCaseFiles(suite.name, row.name, files) };
}

/**
 * A whole suite.
 *
 * `structureOnly` makes the folders without touching the boxes — what a save
 * does, so the tree appears the moment a suite exists and the slow part
 * (several SSH sessions per row) happens in the background or at run time.
 */
export async function syncSuiteToServer(
  inv: Inventory,
  suite: AutomationSuite,
  opts: { structureOnly?: boolean; boxUserId?: string } = {},
): Promise<SyncResult> {
  const rows = suite.items ?? [];
  ensureSuiteTree(suite.name, rows.map(r => r.name));
  if (opts.structureOnly) {
    return { root: automationRoot(), rows: rows.map(r => ({ row: r.name, dir: '', written: [] })) };
  }

  const callbox = suite.kind === 'uesim+callbox' && suite.callboxSystemId
    ? getSystem(inv, suite.callboxSystemId)
    : undefined;
  const ueSystem = suite.ueSystemId ? getSystem(inv, suite.ueSystemId) : undefined;

  // One row at a time: these are SSH sessions against one or two boxes, and a
  // burst of parallel connections is how a callbox starts refusing them.
  const out: SyncResult['rows'] = [];
  for (const row of rows) {
    out.push(await syncRowToServer(inv, suite, row, callbox, ueSystem, opts.boxUserId));
  }
  return { root: automationRoot(), rows: out };
}

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
// Which uploads land under which name — pure, and tested on its own.
import { carriedConfigs } from './carriedConfigs';
// The folder keeps its own licence -- see keepLicenceTags in syncRowToServer.
import { withLicenceTag } from './licenceTag';
import { ensureSuiteTree, writeTestCaseFiles, linkRoleToFile, automationRoot, dropStaleFile, type ServerFile } from './serverConfigs';
// Which name each file keeps, and which role names become links — pure, and
// tested on its own.
import { planFolderLayout, LINKED_ROLES } from './folderLayout';
// Rewriting the MME config's `include` line when the row picked its own
// subscriber database.
import { withDbInclude } from '../cfgValidate';
import { getSystem, uesimApiOptsForSystem, type AutomationSuite, type Inventory, type InventorySystem } from '../inventory';

export interface SyncResult {
  root: string;
  rows: Array<{
    row: string; dir: string; written: string[]; error?: string;
    /** "enb.cfg -> SA-1Cell.cfg_June2026", one per role name pointed at the
     *  config the row actually picked. */
    links?: string[];
    /** A name that could not be kept, or an include that was rewritten. */
    notes?: string[];
  }>;
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

/** Which file each linked slot picked. The folder keeps the real config under
 *  this name and makes the role name a link at it. */
type Picks = { callboxCfg?: string; mmeCfg?: string; imsCfg?: string; otsCfg?: string };
const picksOf = (row: Picks): Record<string, string | undefined> => ({
  'enb.cfg': row.callboxCfg, 'mme.cfg': row.mmeCfg, 'ims.cfg': row.imsCfg, 'ots.cfg': row.otsCfg,
});

export interface RowWrite { dir: string; written: string[]; links: string[]; notes: string[]; error?: string }

/**
 * Write one row's folder: real files under their own names, role names as
 * links at them.
 *
 * `files` arrives the way every caller here has always gathered it — the four
 * slots under their role names, everything else (test.json, the subscriber
 * database, the MME's other includes) under its own. This splits the two,
 * lets the planner decide the names, writes, and then points each role name
 * at its file.
 *
 * The MME config is rewritten first when the row picked its own database: the
 * saved copy is what a run on another setup is rebuilt from, so a folder whose
 * mme.cfg still includes the database the operator replaced would quietly run
 * the wrong subscribers. Only the include line changes; every other byte of
 * the config is left exactly as it was.
 */
export function writeRowFolder(
  suiteName: string,
  rowName: string,
  row: Picks & { dbCfg?: string },
  files: Record<string, string | undefined>,
): RowWrite {
  const roleText: Record<string, string | undefined> = {};
  const extra: Record<string, string | undefined> = {};
  for (const [name, text] of Object.entries(files)) {
    if (text === undefined) continue;
    if ((LINKED_ROLES as readonly string[]).includes(name)) roleText[name] = text;
    else extra[name] = text;
  }

  const notes: string[] = [];
  // The database the row chose, reflected in the config that includes it.
  if (row.dbCfg && typeof roleText['mme.cfg'] === 'string') {
    const bound = withDbInclude(roleText['mme.cfg'], row.dbCfg);
    if (bound.changed) {
      roleText['mme.cfg'] = bound.text;
      notes.push(bound.replaced.length
        ? `mme.cfg now includes ${row.dbCfg} instead of ${bound.replaced.join(', ')}`
        : `mme.cfg now includes ${row.dbCfg}`);
    }
  }

  const plan = planFolderLayout(roleText, picksOf(row), extra);
  notes.push(...plan.notes);

  const w = writeTestCaseFiles(suiteName, rowName, plan.files);
  const links: string[] = [];
  // After the write: a link must never be made before the file it points at.
  for (const [role, target] of Object.entries(plan.links)) {
    const r = linkRoleToFile(suiteName, rowName, role, target);
    if (r.how === 'symlink' || r.how === 'copy') links.push(`${role} -> ${target}`);
    if (r.how === 'copy') notes.push(`${role} is a copy of ${target} — this filesystem does not allow symlinks`);
    if (r.how === 'failed') notes.push(`${role} could not be pointed at ${target}: ${r.error ?? 'unknown'}`);
  }
  return { dir: w.dir, written: w.written, links, notes, ...(w.error ? { error: w.error } : {}) };
}

/**
 * Just the files the suite already holds — no box is contacted.
 *
 * What a save writes immediately: the configs and the test case the operator
 * uploaded. Everything else needs the callbox, the UE or the Simnovator, and
 * waits for the background pass or the run.
 */
function writeCarriedFiles(
  suite: AutomationSuite,
  row: { name: string; uploadedTestcase?: string; callboxCfg?: string; mmeCfg?: string; imsCfg?: string; dbCfg?: string; otsCfg?: string },
): RowWrite {
  const files: Record<string, string | undefined> = { ...carriedConfigs(suite, row) };
  const td = row.uploadedTestcase ? suite.uploadedTestcases?.[row.uploadedTestcase] : undefined;
  if (td) files['test.json'] = td;
  return writeRowFolder(suite.name, row.name, row, files);
}

/** One row: read the boxes, read the testcase, write the folder. */
export async function syncRowToServer(
  inv: Inventory,
  suite: AutomationSuite,
  row: {
    name: string; simnovatorTcId: string; uploadedTestcase?: string;
    callboxCfg?: string; mmeCfg?: string; imsCfg?: string; dbCfg?: string; otsCfg?: string;
  },
  callbox?: InventorySystem,
  ueSystem?: InventorySystem,
  boxUserId?: string,
  /**
   * Licence tags the folder must KEEP, by role, whatever the callbox now says.
   *
   * This sync reads the callbox after bring-up, which is after the run has
   * written its chosen licence into the configs there — so without this it
   * records that licence as the row's own. It did: one run of User_Plane with
   * ENB oran-enb left all ten rows' saved enb.cfg asking for oran-enb, nine of
   * which had said rnd-enb. The folder is the lasting copy and the Run dialog
   * promises it keeps its own licence, so the run's temporary choice must not
   * reach it.
   */
  keepLicenceTags?: { enb?: string; mme?: string; ims?: string },
): Promise<SyncResult['rows'][number]> {
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

  // The files the suite CARRIES, which no box has yet.
  //
  // captureRowConfigs reads the callbox by name, so a config the operator
  // uploaded rather than picked is invisible to it — and that is exactly the
  // file the row is going to run. Written here, under the role name, so the
  // folder holds the row's real configs from the moment the suite is saved
  // and not only after its first successful run. They win over anything the
  // box happens to have under the same name: the upload is the row's choice,
  // and the runner pushes it over the box's copy anyway.
  for (const [name, text] of Object.entries(carriedConfigs(suite, row))) files[name] = text;

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

  // Put the folder's own licence back over whatever the callbox was carrying.
  // See keepLicenceTags above.
  if (keepLicenceTags) {
    for (const [file, tag] of [
      ['enb.cfg', keepLicenceTags.enb],
      ['mme.cfg', keepLicenceTags.mme],
      ['ims.cfg', keepLicenceTags.ims],
    ] as const) {
      if (!tag) continue;                       // nothing was overridden for this role
      const text = files[file];
      if (typeof text !== 'string') continue;
      files[file] = withLicenceTag(text, tag).text;
    }
  }

  return { row: row.name, ...writeRowFolder(suite.name, row.name, row, files) };
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
    // "Don't touch the boxes" — not "don't write what is already in hand".
    // An uploaded config and an uploaded test case are local, instant and the
    // row's actual content, so a save puts them in the folder straight away
    // rather than leaving the row with nothing to run from until a box has
    // been reached.
    return { root: automationRoot(), rows: rows.map(r => ({ row: r.name, ...writeCarriedFiles(suite, r) })) };
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

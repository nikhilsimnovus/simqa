// Scenarios — a saved, named, one-click run of a SINGLE testcase.
//
// An Automation Suite is a campaign: an ordered list of testcases, cfg pushes,
// per-item durations, stop-on-fail. That is the right shape for a nightly
// sweep and the wrong shape for "run the Dish demo again" — which is one
// testcase, on one box, over and over.
//
// A Scenario is that: a name you recognise ("DishDemo"), the testcase behind
// it, and the box it last ran on so the next run is one click. It deliberately
// stores no schedule, no ordering and no cfg-push pipeline; when you need
// those, you want a suite.
//
// Stored in data/scenarios.json (gitignored, like settings.json and the run
// store). Unknown keys survive a save, so a file written by a newer build
// isn't silently truncated by an older one.

import * as fs from 'node:fs';
import * as path from 'node:path';

/** The callbox cfg slots a scenario can set. See normalizeCfgSelection for
 *  why there is no separate gNB slot. */
export interface ScenarioCfg { enb?: string; mme?: string; mme2?: string; ims?: string }

export interface Scenario {
  /** Stable slug-ish id, generated from the name on create. */
  id: string;
  /** Display name — what the card shows, e.g. "DishDemo". */
  name: string;
  /** Simnovator REST testcase id (the UUID from /v2/testcases). */
  testcaseId: string;
  /** Testcase name captured at save time, so the card stays readable even if
   *  the box is unreachable when the page loads. */
  testcaseName?: string;
  /** Inventory id of the box the testcase was picked from. A topology can bind
   *  more than one box that serves testcases; the run has to go to the one
   *  that actually holds this testcase id. */
  testcaseSystemId?: string;
  /**
   * What to run against is EITHER a topology OR a single system — never both.
   *
   * A topology is the end-to-end choice: it names the Simnovator that owns the
   * testcase AND the callbox whose configs get linked, so one choice settles
   * both.
   */
  topologyId?: string;
  /** Topology the last run actually used — the "same as last time" default.
   *  Cleared when the last run went to a single system instead. */
  lastTopologyId?: string;
  /**
   * The single-system choice: one Simnovator, its own testcases, run against
   * the box as it is. It binds no callbox, so cfgSelection is not applied.
   * Scenarios saved before topologies existed carry only this, and still run.
   */
  systemId?: string;
  /** Inventory id of the system the last run actually used. */
  lastSystemId?: string;
  /** ISO timestamp of the last run kicked off from this scenario. */
  lastRunAt?: string;
  /** Run id of the last run, so the card can deep-link into its report. */
  lastRunId?: string;
  /** Callbox config set to put in place before a TOPOLOGY run: each value is a
   *  basename already on the callbox, symlinked to the matching slot
   *  (enb.cfg / mme.cfg / mme2.cfg / ims.cfg) and followed by one `lte`
   *  restart. Omit for a REST-only run against whatever the box is wearing.
   *
   *  No ueDb field on purpose — the subscriber DB is an `include` inside the
   *  MME config, so it travels with `mme`. See CfgSelection in labCfgLink.ts.
   *  `gnb` may still appear in files saved by older builds; it is read as enb. */
  cfgSelection?: ScenarioCfg & { gnb?: string };
  /** Free-text note shown under the name. */
  notes?: string;
  /** Attribution only — see src/lib/identity.ts. */
  createdBy?: string;
  createdAt?: string;
  updatedBy?: string;
  updatedAt?: string;
}

interface ScenarioDoc {
  scenarios: Scenario[];
  [k: string]: unknown;
}

function filePath(): string {
  return path.join(process.cwd(), 'data', 'scenarios.json');
}

/** The raw document, including any keys this build doesn't know about. */
function loadDoc(): ScenarioDoc {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath(), 'utf8')) as Partial<ScenarioDoc>;
    return { ...parsed, scenarios: Array.isArray(parsed?.scenarios) ? parsed.scenarios : [] };
  } catch {
    // Missing or unparseable — behave as empty rather than throwing. The next
    // save rewrites it cleanly.
    return { scenarios: [] };
  }
}

function saveDoc(doc: ScenarioDoc): void {
  const p = filePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(doc, null, 2) + '\n', 'utf8');
}

/**
 * A cfg selection cleaned to the known slots, as non-empty trimmed strings —
 * anything else a client sends is dropped rather than stored and later fed to
 * a symlink.
 *
 * There used to be a fifth slot, `gnb`, shown in the editor as "gNB config"
 * beside "eNB / gNB config". It was a duplicate: OTS on the lab callboxes loads
 * exactly one radio config, ENB_CONFIG_FILE="config/enb.cfg", for LTE and NR
 * alike, so a gnb.cfg link is never read (checked on .122 and .107). A value
 * saved there is folded into `enb` when `enb` is empty, so an old scenario
 * keeps the radio config its author picked instead of silently losing it.
 *
 * Returns null for "nothing selected" and undefined for "not a selection at
 * all", so a PUT can tell "clear it" from "leave it alone".
 */
export function normalizeCfgSelection(raw: unknown): ScenarioCfg | null | undefined {
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const out: ScenarioCfg = {};
  const enb = str(r.enb) ?? str(r.gnb);
  if (enb) out.enb = enb;
  for (const k of ['mme', 'mme2', 'ims'] as const) {
    const v = str(r[k]);
    if (v) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

export function listScenarios(): Scenario[] {
  // Most-recently-run first, then never-run by creation order — the card you
  // want next is nearly always the one you just used.
  return loadDoc().scenarios.slice().sort((a, b) => {
    const ax = a.lastRunAt ?? '';
    const bx = b.lastRunAt ?? '';
    if (ax && bx) return bx.localeCompare(ax);
    if (ax) return -1;
    if (bx) return 1;
    return (a.createdAt ?? '').localeCompare(b.createdAt ?? '');
  });
}

export function getScenario(id: string): Scenario | undefined {
  return loadDoc().scenarios.find((s) => s.id === id);
}

/** URL/id-safe slug from a display name, uniquified against what exists. */
function makeId(name: string, taken: string[]): string {
  const base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'scenario';
  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

export function createScenario(input: Partial<Scenario> & { name: string; testcaseId: string }, by?: string): Scenario {
  const doc = loadDoc();
  const now = new Date().toISOString();
  const s: Scenario = {
    id: makeId(input.name, doc.scenarios.map((x) => x.id)),
    name: input.name.trim(),
    testcaseId: input.testcaseId,
    testcaseName: input.testcaseName,
    testcaseSystemId: input.testcaseSystemId,
    topologyId: input.topologyId,
    systemId: input.systemId,
    cfgSelection: input.cfgSelection,
    notes: input.notes,
    createdBy: by,
    createdAt: now,
  };
  doc.scenarios.push(s);
  saveDoc(doc);
  return s;
}

export function updateScenario(id: string, patch: Partial<Scenario>, by?: string): Scenario | undefined {
  const doc = loadDoc();
  const i = doc.scenarios.findIndex((s) => s.id === id);
  if (i < 0) return undefined;
  // id is identity — never let a patch rewrite it out from under a caller.
  const { id: _ignored, ...rest } = patch;
  doc.scenarios[i] = { ...doc.scenarios[i], ...rest, updatedBy: by ?? doc.scenarios[i].updatedBy, updatedAt: new Date().toISOString() };
  saveDoc(doc);
  return doc.scenarios[i];
}

export function deleteScenario(id: string): boolean {
  const doc = loadDoc();
  const before = doc.scenarios.length;
  doc.scenarios = doc.scenarios.filter((s) => s.id !== id);
  if (doc.scenarios.length === before) return false;
  saveDoc(doc);
  return true;
}

/** Where a run goes: a whole topology, or one system on its own. */
export type ScenarioTarget =
  | { kind: 'topology'; topologyId: string }
  | { kind: 'system'; systemId: string };

/**
 * Which target a run should use: an explicit choice wins, then what the
 * scenario pins (topology before system, matching how older files that carry
 * both have always run), then what it last ran on.
 *
 * The editor's "Last: …" label mirrors this order — keep them in step.
 */
export function resolveTarget(s: Scenario, explicit?: { topologyId?: string; systemId?: string }): ScenarioTarget | undefined {
  if (explicit?.topologyId) return { kind: 'topology', topologyId: explicit.topologyId };
  if (explicit?.systemId) return { kind: 'system', systemId: explicit.systemId };
  if (s.topologyId) return { kind: 'topology', topologyId: s.topologyId };
  if (s.systemId) return { kind: 'system', systemId: s.systemId };
  if (s.lastTopologyId) return { kind: 'topology', topologyId: s.lastTopologyId };
  if (s.lastSystemId) return { kind: 'system', systemId: s.lastSystemId };
  return undefined;
}

/** Record that a run fired, so the next one can default to the same target. */
export function recordRun(id: string, target: ScenarioTarget, systemId: string, runId: string): void {
  updateScenario(id, {
    lastSystemId: systemId,
    // Cleared after a single-system run: left in place, resolveTarget would
    // send the next one-click run back to the older topology.
    lastTopologyId: target.kind === 'topology' ? target.topologyId : undefined,
    lastRunAt: new Date().toISOString(),
    lastRunId: runId,
  });
}

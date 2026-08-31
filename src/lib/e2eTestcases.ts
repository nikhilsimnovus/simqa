// End-to-end test cases — a test case plus the configs it needs, captured once
// and replayable on any station.
//
// The Automation Suite binds config FILENAMES to a suite and expects those
// files to already exist on whichever callbox it runs against. That works
// while you stay on one lab, and falls apart the moment you want the same test
// somewhere else: the names resolve to different files, or to nothing.
//
// This captures the CONTENTS instead. Saving reads:
//
//   testcase   the full testDefinition from the Simnovator (GET /v2/testcases/<id>)
//   callbox    a cfg under /root/enb/config on the bound callbox
//   mme        a cfg under /root/mme/config
//   database   the subscriber db, also under /root/mme/config
//
// and writes them to data/e2e-testcases/<id>.json. From then on the record is
// self-contained: replaying it on another station recreates the testcase from
// the stored definition and pushes the stored cfg bytes, so it does not matter
// what that station happens to have lying around.
//
// Config files are stored base64 so a binary .db survives the round trip
// intact; text cfgs are unaffected by the encoding.

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Inventory, InventorySystem } from './inventory';
import { getSystem, uesimApiOptsForSystem } from './inventory';
import { getTestcase, ensureToken } from './uesimClient';
import { readCommand, writeRemoteFile } from './configFidelity/ssh';
import { createFromDefinition, sanitizeTestcaseName } from './automation/duplicateTestcase';

const ROOT = () => path.join(process.cwd(), 'data', 'e2e-testcases');

/** Which machine holds each captured file, and where. Fixed rather than taken
 *  from the caller: these run `cat` over SSH as root, so a caller-supplied
 *  path would be an arbitrary file read. */
export const CAPTURE_SLOTS = {
  callbox:  { role: 'callbox' as const, dir: '/root/enb/config', label: 'Callbox file' },
  mme:      { role: 'callbox' as const, dir: '/root/mme/config', label: 'MME file' },
  database: { role: 'callbox' as const, dir: '/root/mme/config', label: 'Database file' },
};
export type CaptureSlot = keyof typeof CAPTURE_SLOTS;

export interface CapturedFile {
  /** Filename as it was on the source machine. */
  name: string;
  /** Directory it came from, so a replay puts it back in the right place. */
  dir: string;
  /** Contents, base64. */
  content: string;
  bytes: number;
  /** Host it was read from — provenance, not a replay target. */
  sourceHost: string;
}

export interface E2ETestcase {
  id: string;
  name: string;
  description?: string;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
  /** Where this was captured from. A replay does NOT have to use these. */
  capturedFrom: {
    topologyId?: string;
    topologyName?: string;
    simnovatorSystemId: string;
    simnovatorHost: string;
    callboxSystemId?: string;
    callboxHost?: string;
  };
  /** The Simnovator test case: its name and full definition, enough to
   *  recreate it elsewhere without the source box being reachable. */
  testcase: {
    sourceId: string;
    name: string;
    definition: unknown;
  };
  files: Partial<Record<CaptureSlot, CapturedFile>>;
}

function ensureRoot(): void { fs.mkdirSync(ROOT(), { recursive: true }); }

function newId(): string {
  return `e2e-${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 7)}`;
}

export function listE2ETestcases(limit = 200): E2ETestcase[] {
  try {
    ensureRoot();
    return fs.readdirSync(ROOT())
      .filter((f) => f.endsWith('.json'))
      .sort().reverse().slice(0, limit)
      .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(ROOT(), f), 'utf8')); } catch { return null; } })
      .filter(Boolean) as E2ETestcase[];
  } catch { return []; }
}

export function loadE2ETestcase(id: string): E2ETestcase | null {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT(), `${id}.json`), 'utf8')); }
  catch { return null; }
}

export function deleteE2ETestcase(id: string): boolean {
  try { fs.unlinkSync(path.join(ROOT(), `${id}.json`)); return true; } catch { return false; }
}

function save(tc: E2ETestcase): void {
  ensureRoot();
  fs.writeFileSync(path.join(ROOT(), `${tc.id}.json`), JSON.stringify(tc, null, 2));
}

/** Read one file off a machine as base64.
 *
 *  base64 rather than `cat`: a subscriber .db is binary, and reading it as
 *  UTF-8 would silently corrupt it. The filename is validated against a plain
 *  basename so it cannot escape the fixed directory. */
async function readFileB64(sys: InventorySystem, dir: string, name: string): Promise<CapturedFile> {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`unsafe filename: ${name}`);
  const out = await readCommand(sys, `base64 -w0 ${dir}/${name} 2>/dev/null`);
  const content = out.trim();
  if (!content) throw new Error(`${sys.host}:${dir}/${name} is empty or unreadable`);
  return {
    name, dir, content,
    bytes: Math.floor((content.length * 3) / 4),
    sourceHost: sys.host,
  };
}

export interface CaptureRequest {
  name: string;
  description?: string;
  /** Topology that pins which Simnovator and callbox to read from. */
  topologyId?: string;
  simnovatorSystemId: string;
  /** Testcase on that Simnovator whose definition is captured. */
  testcaseId: string;
  /** Filename per slot. Omit a slot to skip capturing it. */
  files: Partial<Record<CaptureSlot, string>>;
  createdBy?: string;
}

export interface CaptureResult {
  ok: boolean;
  testcase?: E2ETestcase;
  error?: string;
  /** Slots that could not be read, with why. A partial capture still saves —
   *  a record with three of four files is more useful than none, as long as
   *  it says plainly what is missing. */
  warnings?: string[];
}

export async function captureE2ETestcase(inv: Inventory, req: CaptureRequest): Promise<CaptureResult> {
  const name = (req.name ?? '').trim();
  if (!name) return { ok: false, error: 'Give the end-to-end test case a name.' };

  const sim = getSystem(inv, req.simnovatorSystemId);
  if (!sim) return { ok: false, error: `No system "${req.simnovatorSystemId}" in inventory.` };
  const api = uesimApiOptsForSystem(inv, sim.id);
  if (!api) return { ok: false, error: `${sim.name} is not a testable Simnovator.` };

  // The callbox bound to this Simnovator by the topology profile — the same
  // lookup the rest of the app uses.
  const profile = req.topologyId
    ? inv.profiles.find((p) => p.id === req.topologyId)
    : inv.profiles.find((p) => p.simnovator === sim.id);
  const callbox = profile?.callbox ? getSystem(inv, profile.callbox) : undefined;

  // 1. The test case definition.
  let definition: unknown;
  let tcName = req.testcaseId;
  try {
    const full: any = await getTestcase(api, req.testcaseId);
    definition = full?.testDefinition ?? full;
    tcName = String(full?.testDefinition?.settings?.test_name ?? full?.name ?? req.testcaseId);
    if (!definition) throw new Error('box returned no testDefinition');
  } catch (e: any) {
    return { ok: false, error: `Could not read the test case from ${sim.host}: ${e?.message ?? e}` };
  }

  // 2. The config files.
  const warnings: string[] = [];
  const files: Partial<Record<CaptureSlot, CapturedFile>> = {};
  for (const slot of Object.keys(CAPTURE_SLOTS) as CaptureSlot[]) {
    const fname = req.files?.[slot]?.trim();
    if (!fname) continue;
    const spec = CAPTURE_SLOTS[slot];
    if (!callbox) { warnings.push(`${spec.label}: no callbox bound to this topology, skipped.`); continue; }
    try {
      files[slot] = await readFileB64(callbox, spec.dir, fname);
    } catch (e: any) {
      warnings.push(`${spec.label} (${fname}): ${e?.message ?? e}`);
    }
  }

  const now = new Date().toISOString();
  const tc: E2ETestcase = {
    id: newId(),
    name, description: req.description?.trim() || undefined,
    createdBy: req.createdBy,
    createdAt: now, updatedAt: now,
    capturedFrom: {
      topologyId: profile?.id,
      topologyName: profile?.name,
      simnovatorSystemId: sim.id,
      simnovatorHost: sim.host,
      callboxSystemId: callbox?.id,
      callboxHost: callbox?.host,
    },
    testcase: { sourceId: req.testcaseId, name: tcName, definition },
    files,
  };
  save(tc);
  return { ok: true, testcase: tc, warnings: warnings.length ? warnings : undefined };
}

// ───────────────────────── replay ─────────────────────────

export interface ReplayRequest {
  /** Captured record to replay. */
  id: string;
  /** Simnovator to build the test case on — any station, not necessarily the
   *  one it was captured from. That is the point of capturing contents. */
  simnovatorSystemId: string;
  /** Name for the recreated test case. Defaults to the captured name. */
  name?: string;
  /** Push the captured cfg files to the target's callbox. Off means "recreate
   *  the test case only" — useful when the target already has the radio set up
   *  the way you want it. */
  pushConfigs?: boolean;
}

export interface ReplayResult {
  ok: boolean;
  error?: string;
  /** Id of the test case created on the target box. */
  testCaseId?: string;
  name?: string;
  pushed?: string[];
  warnings?: string[];
}

/** Push one captured file back, preserving bytes exactly.
 *
 *  writeRemoteFile() writes UTF-8, which silently corrupts a binary subscriber
 *  .db. The base64 payload is staged to a temp path and decoded on the box, so
 *  what lands is byte-identical to what was captured. */
async function pushCaptured(sys: InventorySystem, f: CapturedFile): Promise<void> {
  const tmp = `/tmp/simqa-e2e-${Date.now().toString(36)}-${f.name}`;
  await writeRemoteFile(sys, tmp, f.content);
  const out = await readCommand(
    sys,
    `base64 -d ${tmp} > ${f.dir}/${f.name} && rm -f ${tmp} && echo OK`,
  );
  if (!/OK/.test(out)) throw new Error(`could not write ${f.dir}/${f.name}: ${out.trim().slice(0, 160)}`);
}

export async function replayE2ETestcase(inv: Inventory, req: ReplayRequest): Promise<ReplayResult> {
  const rec = loadE2ETestcase(req.id);
  if (!rec) return { ok: false, error: `No end-to-end test case "${req.id}".` };

  const sim = getSystem(inv, req.simnovatorSystemId);
  if (!sim) return { ok: false, error: `No system "${req.simnovatorSystemId}" in inventory.` };
  const api = uesimApiOptsForSystem(inv, sim.id);
  if (!api) return { ok: false, error: `${sim.name} is not a testable Simnovator.` };

  const warnings: string[] = [];
  const pushed: string[] = [];

  // 1. Configs first — the radio has to be right before the test runs.
  if (req.pushConfigs !== false && Object.keys(rec.files).length) {
    const profile = inv.profiles.find((p) => p.simnovator === sim.id);
    const callbox = profile?.callbox ? getSystem(inv, profile.callbox) : undefined;
    if (!callbox) {
      warnings.push(`No callbox bound to ${sim.host} in its topology, so the captured configs were not pushed.`);
    } else {
      for (const [slot, f] of Object.entries(rec.files) as Array<[CaptureSlot, CapturedFile]>) {
        try {
          await pushCaptured(callbox, f);
          pushed.push(`${CAPTURE_SLOTS[slot].label}: ${f.name} → ${callbox.host}:${f.dir}`);
        } catch (e: any) {
          warnings.push(`${CAPTURE_SLOTS[slot].label} (${f.name}): ${e?.message ?? e}`);
        }
      }
    }
  }

  // 2. Recreate the test case from the captured definition. Reuses the box's
  //    own 6-step create lifecycle rather than reimplementing it.
  const finalName = sanitizeTestcaseName(req.name?.trim() || rec.testcase.name);
  const td: any = JSON.parse(JSON.stringify(rec.testcase.definition));
  try {
    const token = await ensureToken(api.host, api.username, api.password);
    const r = await createFromDefinition(api, token, td, finalName);
    if (r.failedStep) {
      return { ok: false, error: `Create failed at "${r.failedStep}": ${r.error ?? 'unknown'}`, pushed, warnings };
    }
    return {
      ok: true, testCaseId: r.testCaseId, name: r.name,
      pushed, warnings: warnings.length ? warnings : undefined,
    };
  } catch (e: any) {
    return { ok: false, error: `Could not create the test case on ${sim.host}: ${e?.message ?? e}`, pushed, warnings };
  }
}

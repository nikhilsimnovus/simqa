// On-disk store for live config-fidelity captures.
//
// A capture is one execution: the testcase JSON as the Simnovator exported it,
// the ue.cfg the paired UE-sim generated for that run, and the comparison
// between them.
//
//   data/config-fidelity/live/
//     <simnovator-ip>/
//       index.json                     — every capture for this Simnovator, newest first
//       <captureId>/
//         testcase.json                — the GUI export, byte-for-byte
//         ue.cfg                       — as read from /root/ue/config
//         comparison.json              — the rows behind the table
//
// NOTHING HERE DELETES. The requirement is explicit that starting the next
// testcase must not cost you the last one, so there is no prune path, no
// retention window, and no overwrite of an existing captureId. That is the
// whole point: the interesting capture is usually the one from before you
// changed something.
//
// IMPORTS: node builtins only, so the rules can be unit-tested under
// `node --test` without a bundler — same discipline as src/lib/backup/store.ts.

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Where a capture's verdict can land. */
export type FidelityVerdict =
  /** Every compared parameter agrees. */
  | 'passed'
  /** At least one parameter differs between the testcase and the ue.cfg. */
  | 'failed'
  /** We could not prove which ue.cfg belonged to this execution, so no diff is
   *  shown. Deliberately NOT 'failed': an unattributable capture is a gap in
   *  our evidence, not a defect in the box's config. */
  | 'unattributed'
  /** The capture itself failed — box unreachable, SSH refused, export refused. */
  | 'error';

export interface CaptureSummary {
  /** Stable id: the box's execution/iteration id when we have one, else a
   *  timestamped fallback. Used as the directory name, so it is basename-safe. */
  captureId: string;
  simnovatorIp: string;
  simnovatorName?: string;
  /** The UE-sim the ue.cfg came from. */
  ueSimIp?: string;
  ueSimName?: string;
  testcaseId?: string;
  testcaseName?: string;
  executionId?: string;
  simulatorName?: string;
  /** When the execution was seen to start. */
  startedAt: string;
  /** When we finished capturing. */
  capturedAt: string;
  verdict: FidelityVerdict;
  /** Row counts behind the verdict. */
  compared: number;
  differences: number;
  /** Why, when the verdict is 'unattributed' or 'error'. Credential-free. */
  reason?: string;
  /** Which artefacts actually landed. */
  hasTestcase: boolean;
  hasUeCfg: boolean;
  /** Absolute source path of the ue.cfg on the UE-sim, for the detail view. */
  ueCfgPath?: string;
  /** mtime of that file, so a stale cfg is visible rather than implied. */
  ueCfgMtime?: string;
}

export interface CaptureIndex {
  simnovatorIp: string;
  updatedAt: string;
  captures: CaptureSummary[];
}

export function liveRoot(): string {
  return process.env.SIMQA_FIDELITY_ROOT
    || path.join(process.cwd(), 'data', 'config-fidelity', 'live');
}

/**
 * Reject anything that is not a plain path segment.
 *
 * Both the IP and the capture id become directory names and both arrive from
 * outside — the IP from inventory, the capture id from the box's execution
 * record — so neither may contain a separator or a traversal.
 */
export function isSafeSegment(s: string): boolean {
  if (!s || s.length > 128) return false;
  if (s === '.' || s === '..') return false;
  if (s.includes('/') || s.includes('\\') || s.includes('\0')) return false;
  return path.basename(s) === s;
}

function assertSafe(s: string, what: string): void {
  if (!isSafeSegment(s)) throw new Error(`unsafe ${what}: ${JSON.stringify(s)}`);
}

/** Make an arbitrary box identifier usable as a directory name. */
export function toCaptureId(raw: string | undefined, startedAt: string): string {
  const cleaned = (raw ?? '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(0, 100);
  if (cleaned) return cleaned;
  // No execution id from the box — fall back to the start time, which is still
  // unique per capture and still sorts correctly.
  return 'exec-' + startedAt.replace(/[:.]/g, '-');
}

export function systemDir(ip: string): string {
  assertSafe(ip, 'simnovator ip');
  return path.join(liveRoot(), ip);
}

export function captureDir(ip: string, captureId: string): string {
  assertSafe(captureId, 'capture id');
  return path.join(systemDir(ip), captureId);
}

function indexPath(ip: string): string {
  return path.join(systemDir(ip), 'index.json');
}

export function readIndex(ip: string): CaptureIndex {
  try {
    const idx = JSON.parse(fs.readFileSync(indexPath(ip), 'utf8')) as CaptureIndex;
    if (!Array.isArray(idx.captures)) idx.captures = [];
    return idx;
  } catch {
    return { simnovatorIp: ip, updatedAt: new Date(0).toISOString(), captures: [] };
  }
}

function writeIndex(idx: CaptureIndex): void {
  fs.mkdirSync(systemDir(idx.simnovatorIp), { recursive: true });
  idx.updatedAt = new Date().toISOString();
  // Write-then-rename: a half-written index would make every past capture
  // invisible, which for a store whose promise is "we never lose one" is the
  // worst possible failure.
  const tmp = indexPath(idx.simnovatorIp) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(idx, null, 2));
  fs.renameSync(tmp, indexPath(idx.simnovatorIp));
}

export interface CaptureFiles {
  /** Raw bytes of the testcase export, exactly as the box returned them. */
  testcaseJson?: string;
  /** Raw bytes of the ue.cfg, exactly as read from the UE-sim. */
  ueCfg?: string;
  /** The comparison rows; shape owned by compare.ts. */
  comparison?: unknown;
}

/**
 * Persist one capture. Returns the summary as stored.
 *
 * Refuses to overwrite an existing capture directory: an execution id is
 * supposed to be unique, and if the box ever reuses one we would rather keep
 * the first capture and record a suffixed second than silently replace
 * evidence the user may already have looked at.
 */
export function writeCapture(summary: CaptureSummary, files: CaptureFiles): CaptureSummary {
  let id = summary.captureId;
  assertSafe(id, 'capture id');
  if (fs.existsSync(captureDir(summary.simnovatorIp, id))) {
    let n = 2;
    while (fs.existsSync(captureDir(summary.simnovatorIp, `${id}-${n}`))) n++;
    id = `${id}-${n}`;
  }
  const stored: CaptureSummary = { ...summary, captureId: id };

  const dir = captureDir(stored.simnovatorIp, id);
  fs.mkdirSync(dir, { recursive: true });
  if (files.testcaseJson !== undefined) fs.writeFileSync(path.join(dir, 'testcase.json'), files.testcaseJson);
  if (files.ueCfg !== undefined) fs.writeFileSync(path.join(dir, 'ue.cfg'), files.ueCfg);
  if (files.comparison !== undefined) {
    fs.writeFileSync(path.join(dir, 'comparison.json'), JSON.stringify(files.comparison, null, 2));
  }
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(stored, null, 2));

  const idx = readIndex(stored.simnovatorIp);
  idx.captures = [stored, ...idx.captures.filter((c) => c.captureId !== id)];
  idx.captures.sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
  writeIndex(idx);
  return stored;
}

/** Every capture for one Simnovator, newest first. */
export function listCaptures(ip: string): CaptureSummary[] {
  return readIndex(ip).captures;
}

/** Every Simnovator we hold captures for — including ones no longer in System
 *  Management, because removing a system must not hide its history. */
export function listCapturedIps(): string[] {
  try {
    return fs.readdirSync(liveRoot(), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

export function readCapture(ip: string, captureId: string): CaptureSummary | undefined {
  return listCaptures(ip).find((c) => c.captureId === captureId);
}

/** One of a capture's three artefacts. The name is whitelisted rather than
 *  passed through, so the download route cannot be turned into a file read. */
export type ArtifactName = 'testcase.json' | 'ue.cfg' | 'comparison.json';
export const ARTIFACTS: ArtifactName[] = ['testcase.json', 'ue.cfg', 'comparison.json'];

export function readArtifact(ip: string, captureId: string, name: ArtifactName): Buffer {
  if (!ARTIFACTS.includes(name)) throw new Error(`unknown artifact ${JSON.stringify(name)}`);
  return fs.readFileSync(path.join(captureDir(ip, captureId), name));
}

export function hasArtifact(ip: string, captureId: string, name: ArtifactName): boolean {
  if (!ARTIFACTS.includes(name)) return false;
  try { return fs.statSync(path.join(captureDir(ip, captureId), name)).isFile(); } catch { return false; }
}

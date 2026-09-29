// What a suite row actually ran with, and whether that has changed since.
//
// A suite row executes against files that live on the lab boxes: the radio and
// core cfgs the row links, the DB the MME config includes, the box's ots.cfg,
// and the UE's ue.cfg. Those files are edited by hand between runs — that is
// what a lab is for — so "run the same suite again" quietly stops meaning the
// same thing, and a result is compared against a configuration nobody recorded.
//
// So each row's files are copied into
//
//   data/suite-configs/<suite>/<testcase>/v1/…   enb.cfg mme.cfg ims.cfg
//                                                db.cfg ots.cfg ue.cfg
//
// with a manifest of their hashes. Before the next run the same files are read
// again and compared; a difference is reported rather than run over, and when
// the operator goes ahead the new content is kept as v2 — the old version is
// never overwritten, so a result can always be read against the files it had.
//
// Pure, and imports only node:crypto, so node --test can load it directly.

import { createHash } from 'node:crypto';

/** The roles captured for a row, in the order they are shown. */
export const SNAPSHOT_FILES = ['enb.cfg', 'mme.cfg', 'ims.cfg', 'db.cfg', 'ots.cfg', 'ue.cfg'] as const;
export type SnapshotFile = typeof SNAPSHOT_FILES[number];

export interface SnapshotEntry {
  /** Name on the box this came from — "demo-mme.cfg" behind mme.cfg. */
  source?: string;
  sha256: string;
  bytes: number;
}

export interface SnapshotManifest {
  suiteId: string;
  suiteName: string;
  rowId: string;
  rowName: string;
  version: number;
  capturedAt: string;
  /** Who ran the suite that captured this. */
  capturedBy?: string;
  callboxHost?: string;
  ueHost?: string;
  /** The Simnovator the row executed on. The configs come off the callbox and
   *  the UE, but it is the box that ran the test, and a lab has several. */
  uesimHost?: string;
  files: Partial<Record<SnapshotFile, SnapshotEntry>>;
  /** Why this version exists: the row's first run, or a change since the one
   *  before it. Recorded when it is written, because it cannot be worked out
   *  afterwards without re-reading every earlier version. */
  reason?: 'original' | 'changed';
  /** The files that differed from the previous version, for 'changed'. */
  changedFiles?: SnapshotFile[];
}

export function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** One file's verdict when a saved version is compared with what is on the box now. */
export interface FileDiff {
  file: SnapshotFile;
  state: 'same' | 'changed' | 'added' | 'removed';
  /** The file it came from, when that is what moved (mme.cfg → a different cfg). */
  was?: string;
  now?: string;
}

export interface SnapshotDiff {
  same: boolean;
  files: FileDiff[];
  /** Just the ones that are not 'same' — what a message names. */
  changed: FileDiff[];
}

/**
 * Compare a saved manifest with the files as they are now.
 *
 * A file counts as changed when its CONTENT hash moved, or when the same role
 * is now served by a different file on the box (mme.cfg re-linked). Both are
 * "this row would run against something else than last time", which is the
 * question being asked.
 */
export function diffSnapshot(
  saved: Partial<Record<SnapshotFile, SnapshotEntry>>,
  current: Partial<Record<SnapshotFile, SnapshotEntry>>,
): SnapshotDiff {
  const files: FileDiff[] = [];
  for (const f of SNAPSHOT_FILES) {
    const a = saved[f];
    const b = current[f];
    if (!a && !b) continue;
    if (!a && b) { files.push({ file: f, state: 'added', now: b.source }); continue; }
    if (a && !b) { files.push({ file: f, state: 'removed', was: a.source }); continue; }
    if (a!.sha256 !== b!.sha256 || (a!.source && b!.source && a!.source !== b!.source)) {
      files.push({ file: f, state: 'changed', was: a!.source, now: b!.source });
      continue;
    }
    files.push({ file: f, state: 'same', now: b!.source });
  }
  const changed = files.filter((f) => f.state !== 'same');
  return { same: changed.length === 0, files, changed };
}

/** "v3" from ["v1","v2"] — versions are added, never overwritten. */
export function nextVersion(existing: string[]): string {
  const highest = existing
    .map((n) => /^v(\d+)$/.exec(n))
    .filter(Boolean)
    .map((m) => Number(m![1]))
    .reduce((a, b) => Math.max(a, b), 0);
  return `v${highest + 1}`;
}

/** The newest saved version, or undefined when a row has never run. */
export function latestVersion(existing: string[]): string | undefined {
  const sorted = existing
    .filter((n) => /^v\d+$/.test(n))
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  return sorted[sorted.length - 1];
}

/**
 * A folder name safe on every filesystem, from a suite or testcase name.
 *
 * Names come from the operator and the box, so they carry spaces, slashes and
 * the occasional colon. Kept readable — the folder is meant to be opened by a
 * person — but reduced to characters a path can hold.
 */
export function safeFolder(name: string): string {
  const cleaned = (name ?? '')
    .replace(/[^A-Za-z0-9._ -]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[. ]+|[. ]+$/g, '');
  return cleaned.slice(0, 80) || 'unnamed';
}

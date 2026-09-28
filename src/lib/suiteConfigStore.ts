// Reading a suite row's real configuration off the lab boxes, and keeping it.
//
// Layout, one folder per suite and one per row inside it, exactly as an
// operator would arrange it by hand:
//
//   data/suite-configs/<suite name>/<testcase name>/v1/enb.cfg
//                                                     mme.cfg
//                                                     ims.cfg
//                                                     db.cfg
//                                                     ots.cfg
//                                                     ue.cfg
//                                                     manifest.json
//
// v1 is what the row first ran with; v2 appears the next time the files differ
// — because somebody edited a cfg, or the row was pointed at another one. Old
// versions are never touched, so a run's result can always be read against the
// files it actually had.
//
// The capture is best-effort per file: a callbox with no SSH credentials, or a
// UE that is not registered, leaves that entry out rather than failing a run.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { readCommand } from './configFidelity/ssh';
import { ueDbFor } from './labCfgLink';
import type { InventorySystem } from './inventory';
import {
  SNAPSHOT_FILES, diffSnapshot, hashText, latestVersion, nextVersion, safeFolder,
  type SnapshotEntry, type SnapshotFile, type SnapshotManifest, type SnapshotDiff,
} from './suiteSnapshotCore';

export type { SnapshotDiff } from './suiteSnapshotCore';

const ROOT = () => path.join(process.cwd(), 'data', 'suite-configs');

const rowDir = (suiteName: string, rowName: string) =>
  path.join(ROOT(), safeFolder(suiteName), safeFolder(rowName));

/** Single-quoted shell arg. */
const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/** One file off a box: its content, and the name behind the symlink. */
async function readCfg(box: InventorySystem, dir: string, link: string): Promise<{ source?: string; text: string } | null> {
  try {
    // /root is 0700 on some callboxes and readable on others, so sudo first
    // with the unprivileged read as the fallback — same rule as every other
    // reader here.
    const target = (await readCommand(box, `sudo -n readlink ${q(`${dir}/${link}`)} 2>/dev/null || readlink ${q(`${dir}/${link}`)} 2>/dev/null || true`)).trim();
    const source = target.split('/').filter(Boolean).pop() || link;
    const text = await readCommand(box, `sudo -n cat ${q(`${dir}/${link}`)} 2>/dev/null || cat ${q(`${dir}/${link}`)}`);
    if (!text || /No such file|Permission denied/i.test(text)) return null;
    return { source, text };
  } catch {
    return null;
  }
}

/**
 * The six files this row runs against, read from the boxes as they are now.
 *
 * `callbox` carries the radio, core and ots configs; `ueSystem` carries
 * ue.cfg. The DB is whatever the live mme.cfg includes — it is not chosen
 * anywhere, so it is discovered rather than passed in.
 */
export async function captureRowConfigs(
  callbox?: InventorySystem,
  ueSystem?: InventorySystem,
): Promise<{ files: Partial<Record<SnapshotFile, SnapshotEntry>>; contents: Partial<Record<SnapshotFile, string>> }> {
  const files: Partial<Record<SnapshotFile, SnapshotEntry>> = {};
  const contents: Partial<Record<SnapshotFile, string>> = {};
  const put = (name: SnapshotFile, got: { source?: string; text: string } | null) => {
    if (!got) return;
    files[name] = { source: got.source, sha256: hashText(got.text), bytes: Buffer.byteLength(got.text) };
    contents[name] = got.text;
  };

  if (callbox) {
    put('enb.cfg', await readCfg(callbox, '/root/enb/config', 'enb.cfg'));
    const mme = await readCfg(callbox, '/root/mme/config', 'mme.cfg');
    put('mme.cfg', mme);
    put('ims.cfg', await readCfg(callbox, '/root/mme/config', 'ims.cfg'));
    put('ots.cfg', await readCfg(callbox, '/root/ots/config', 'ots.cfg'));
    // The DB travels inside the MME config as an `include` line.
    if (mme?.source) {
      const dbs = await ueDbFor(callbox, mme.source).catch(() => [] as string[]);
      if (dbs[0]) put('db.cfg', await readCfg(callbox, '/root/mme/config', dbs[0]));
    }
  }
  if (ueSystem) put('ue.cfg', await readCfg(ueSystem, '/root/ue/config', 'ue.cfg'));

  return { files, contents };
}

function versionsOf(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

/** The manifest of the newest saved version for a row, if it has ever run. */
export function latestManifest(suiteName: string, rowName: string): SnapshotManifest | null {
  const dir = rowDir(suiteName, rowName);
  const v = latestVersion(versionsOf(dir));
  if (!v) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, v, 'manifest.json'), 'utf8')) as SnapshotManifest;
  } catch {
    return null;
  }
}

/**
 * Compare a row's saved configuration with the boxes as they are now.
 *
 * `null` means the row has never been captured — the first run has nothing to
 * disagree with, and says so rather than reporting everything as new.
 */
export async function checkRowConfigs(
  suiteName: string,
  rowName: string,
  callbox?: InventorySystem,
  ueSystem?: InventorySystem,
): Promise<{ diff: SnapshotDiff | null; capturedAt?: string; version?: number }> {
  const saved = latestManifest(suiteName, rowName);
  if (!saved) return { diff: null };
  const { files } = await captureRowConfigs(callbox, ueSystem);
  return { diff: diffSnapshot(saved.files, files), capturedAt: saved.capturedAt, version: saved.version };
}

/**
 * Keep what this row just ran with.
 *
 * Writes a new version ONLY when the content differs from the newest saved one
 * — a suite re-run on untouched configs does not litter the folder with
 * identical copies, and a version therefore marks a real change.
 */
export async function saveRowConfigs(opts: {
  suiteId: string;
  suiteName: string;
  rowId: string;
  rowName: string;
  callbox?: InventorySystem;
  ueSystem?: InventorySystem;
  capturedBy?: string;
}): Promise<{ version: string; changed: boolean; files: SnapshotFile[] } | null> {
  const { files, contents } = await captureRowConfigs(opts.callbox, opts.ueSystem);
  if (Object.keys(files).length === 0) return null;   // nothing readable — nothing to claim

  const dir = rowDir(opts.suiteName, opts.rowName);
  const saved = latestManifest(opts.suiteName, opts.rowName);
  if (saved && diffSnapshot(saved.files, files).same) {
    return { version: `v${saved.version}`, changed: false, files: Object.keys(files) as SnapshotFile[] };
  }

  const version = nextVersion(versionsOf(dir));
  const out = path.join(dir, version);
  fs.mkdirSync(out, { recursive: true });
  for (const name of SNAPSHOT_FILES) {
    const text = contents[name];
    if (text != null) fs.writeFileSync(path.join(out, name), text, 'utf8');
  }
  const manifest: SnapshotManifest = {
    suiteId: opts.suiteId,
    suiteName: opts.suiteName,
    rowId: opts.rowId,
    rowName: opts.rowName,
    version: Number(version.slice(1)),
    capturedAt: new Date().toISOString(),
    capturedBy: opts.capturedBy,
    callboxHost: opts.callbox?.host,
    ueHost: opts.ueSystem?.host,
    files,
  };
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return { version, changed: !!saved, files: Object.keys(files) as SnapshotFile[] };
}

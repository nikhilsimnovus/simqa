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
import { withSsh } from './configFidelity/ssh';
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

/** One file, read over an ALREADY OPEN session.
 *
 *  A row's six files used to be a dozen `readCommand` calls, and each of those
 *  opens an SSH connection of its own — a dozen handshakes per row, on the
 *  same box, for reads that take milliseconds. They all share one session now.
 *
 *  /root is 0700 on some callboxes and readable on others, so sudo first with
 *  the unprivileged read as the fallback — the rule every reader here follows. */
async function readCfgOn(ssh: any, dir: string, link: string): Promise<{ source?: string; text: string } | null> {
  try {
    const p = q(`${dir}/${link}`);
    const t = await ssh.execCommand(`sudo -n readlink ${p} 2>/dev/null || readlink ${p} 2>/dev/null || true`);
    const target = String(t.stdout ?? '').trim();
    const source = target.split('/').filter(Boolean).pop() || link;
    const c = await ssh.execCommand(`sudo -n cat ${p} 2>/dev/null || cat ${p}`);
    const text = String(c.stdout ?? '');
    if (!text || /No such file|Permission denied/i.test(text)) return null;
    return { source, text };
  } catch {
    return null;
  }
}

/** Which subscriber DB an MME config pulls in, from its `include` lines — the
 *  same reading labCfgLink does, on the session already open. */
async function dbIncludedBy(ssh: any, mmeCfgName: string): Promise<string | undefined> {
  try {
    const p = q(`/root/mme/config/${mmeCfgName}`);
    const r = await ssh.execCommand(
      `sudo -n grep -E '^[[:space:]]*include' ${p} 2>/dev/null || grep -E '^[[:space:]]*include' ${p} 2>/dev/null || true`);
    return String(r.stdout ?? '')
      .split('\n')
      .map((l: string) => l.trim())
      .filter((l: string) => l.startsWith('include'))
      .map((l: string) => /include\s+"([^"]+)"/.exec(l)?.[1])
      .filter((n: unknown): n is string => !!n)
      // Only the subscriber/PLMN databases, not every include (configs also
      // pull in 1000UE.mme.cfg-style fragments).
      .find((n: string) => /db|subscriber|ue/i.test(n));
  } catch {
    return undefined;
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
    // One connection for all five — see readCfgOn.
    await withSsh(callbox, async (ssh) => {
      put('enb.cfg', await readCfgOn(ssh, '/root/enb/config', 'enb.cfg'));
      const mme = await readCfgOn(ssh, '/root/mme/config', 'mme.cfg');
      put('mme.cfg', mme);
      put('ims.cfg', await readCfgOn(ssh, '/root/mme/config', 'ims.cfg'));
      put('ots.cfg', await readCfgOn(ssh, '/root/ots/config', 'ots.cfg'));
      // The DB travels inside the MME config as an `include` line.
      if (mme?.source) {
        const db = await dbIncludedBy(ssh, mme.source);
        if (db) put('db.cfg', await readCfgOn(ssh, '/root/mme/config', db));
      }
    }).catch(() => { /* a box we cannot reach records nothing, and fails nothing */ });
  }
  if (ueSystem) {
    await withSsh(ueSystem, async (ssh) => {
      put('ue.cfg', await readCfgOn(ssh, '/root/ue/config', 'ue.cfg'));
    }).catch(() => { /* same */ });
  }

  return { files, contents };
}

function versionsOf(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

/** Every saved version of one row, newest first, each with its manifest and
 *  the files actually written. What the Saved configs panel lists. */
export function listRowVersions(suiteName: string, rowName: string): Array<{
  version: string;
  capturedAt?: string;
  capturedBy?: string;
  callboxHost?: string;
  ueHost?: string;
  reason?: 'original' | 'changed';
  changedFiles?: string[];
  files: Array<{ name: string; bytes: number; source?: string }>;
}> {
  const dir = rowDir(suiteName, rowName);
  return versionsOf(dir)
    .filter((v) => /^v\d+$/.test(v))
    .sort((x, y) => Number(y.slice(1)) - Number(x.slice(1)))
    .map((version) => {
      let m: SnapshotManifest | undefined;
      try { m = JSON.parse(fs.readFileSync(path.join(dir, version, 'manifest.json'), 'utf8')); } catch { /* no manifest */ }
      const files: Array<{ name: string; bytes: number; source?: string }> = [];
      for (const name of SNAPSHOT_FILES) {
        try {
          files.push({ name, bytes: fs.statSync(path.join(dir, version, name)).size, source: m?.files?.[name]?.source });
        } catch { /* a file this capture could not read is simply absent */ }
      }
      return {
        version,
        capturedAt: m?.capturedAt, capturedBy: m?.capturedBy,
        callboxHost: m?.callboxHost, ueHost: m?.ueHost,
        // Versions written before this was recorded: v1 is the original by
        // definition, and anything after it exists because something changed.
        reason: m?.reason ?? (version === 'v1' ? 'original' : 'changed'),
        changedFiles: m?.changedFiles,
        files,
      };
    });
}

/** One saved file's text. Names are checked against the fixed set rather than
 *  sanitised, so nothing outside a version folder can be reached. */
export function readSavedFile(suiteName: string, rowName: string, version: string, file: string): string | null {
  if (!/^v\d+$/.test(version)) return null;
  if (!(SNAPSHOT_FILES as readonly string[]).includes(file) && file !== 'manifest.json') return null;
  try {
    return fs.readFileSync(path.join(rowDir(suiteName, rowName), version, file), 'utf8');
  } catch {
    return null;
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
}): Promise<{ version: string; changed: boolean; changedFiles?: SnapshotFile[]; files: SnapshotFile[] } | null> {
  const { files, contents } = await captureRowConfigs(opts.callbox, opts.ueSystem);
  if (Object.keys(files).length === 0) return null;   // nothing readable — nothing to claim

  const dir = rowDir(opts.suiteName, opts.rowName);
  const saved = latestManifest(opts.suiteName, opts.rowName);
  if (saved && diffSnapshot(saved.files, files).same) {
    return { version: `v${saved.version}`, changed: false, files: Object.keys(files) as SnapshotFile[] };
  }

  // What moved since the previous version, kept with the version itself so
  // the panel can say "Configuration changed · enb.cfg, db.cfg" without
  // re-reading and re-comparing every earlier one.
  const changedFiles = saved
    ? diffSnapshot(saved.files, files).changed
        .filter((c) => c.state === 'changed' || c.state === 'added')
        .map((c) => c.file)
    : [];

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
    reason: saved ? 'changed' : 'original',
    changedFiles: saved ? changedFiles : undefined,
  };
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return { version, changed: !!saved, changedFiles, files: Object.keys(files) as SnapshotFile[] };
}

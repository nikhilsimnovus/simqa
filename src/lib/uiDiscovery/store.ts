// Where discovered UI maps live.
//
// One current map per (host, login) — the Simnovator scopes its pages per
// account, so a map read as sruthi is not a map of what simuser sees — plus a
// kept history, because the history IS the build-awareness: the diff that
// says "this build added SDR Management" needs the map taken on the previous
// build, and that map only exists if somebody kept it.
//
// Files, not a database, for the same reason the rest of this app uses files:
// a QA engineer can read, copy and attach one to a ticket.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { UiMap } from './types.ts';

const ROOT = process.env.SIMQA_UI_MAPS_DIR
  ?? path.join(process.cwd(), 'data', 'ui-maps');

function slug(s: string): string {
  return (s || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_');
}

function dirFor(host: string, username?: string): string {
  return path.join(ROOT, slug(host), slug(username || 'default'));
}

export function saveMap(map: UiMap): { latestPath: string; historyPath: string } {
  const dir = dirFor(map.host, map.username);
  fs.mkdirSync(path.join(dir, 'history'), { recursive: true });
  const latestPath = path.join(dir, 'latest.json');

  // Keep the map being replaced as history BEFORE overwriting, stamped with
  // the build it was taken on. Without this, the first discovery after a
  // build upgrade would have nothing to diff against and the upgrade's UI
  // changes would go unreported exactly when they matter most.
  const previous = readMap(map.host, map.username);
  const historyPath = path.join(
    dir, 'history',
    `${(previous?.discoveredAt ?? map.discoveredAt).replace(/[:.]/g, '-')}__${slug(previous?.build ?? map.build ?? 'nobuild')}.json`,
  );
  if (previous) {
    try { fs.writeFileSync(historyPath, JSON.stringify(previous, null, 2)); } catch { /* history is best-effort */ }
  }
  fs.writeFileSync(latestPath, JSON.stringify(map, null, 2));
  return { latestPath, historyPath };
}

export function readMap(host: string, username?: string): UiMap | undefined {
  const p = path.join(dirFor(host, username), 'latest.json');
  try {
    if (!fs.existsSync(p)) return undefined;
    return JSON.parse(fs.readFileSync(p, 'utf8')) as UiMap;
  } catch { return undefined; }
}

/** Every kept map for a setup, newest first — the build timeline. */
export function listHistory(host: string, username?: string): Array<{ file: string; discoveredAt: string; build?: string; pages: number }> {
  const dir = path.join(dirFor(host, username), 'history');
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try {
          const m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as UiMap;
          return { file: f, discoveredAt: m.discoveredAt, build: m.build, pages: m.nodes?.length ?? 0 };
        } catch {
          return { file: f, discoveredAt: '', pages: 0 };
        }
      })
      .sort((a, b) => (b.discoveredAt || '').localeCompare(a.discoveredAt || ''));
  } catch { return []; }
}

export function readHistoryFile(host: string, username: string | undefined, file: string): UiMap | undefined {
  // Only a plain file name from listHistory — never a path, so a crafted
  // name cannot read outside the setup's own folder.
  if (!/^[A-Za-z0-9._-]+\.json$/.test(file)) return undefined;
  try {
    const p = path.join(dirFor(host, username), 'history', file);
    if (!fs.existsSync(p)) return undefined;
    return JSON.parse(fs.readFileSync(p, 'utf8')) as UiMap;
  } catch { return undefined; }
}

/** The map taken on a different build than the current one — what a build
 *  upgrade should be compared against. Falls back to the newest kept map. */
export function previousBuildMap(host: string, username: string | undefined, currentBuild?: string): UiMap | undefined {
  const hist = listHistory(host, username);
  for (const h of hist) {
    if (currentBuild && h.build && h.build !== currentBuild) {
      const m = readHistoryFile(host, username, h.file);
      if (m) return m;
    }
  }
  const newest = hist[0];
  return newest ? readHistoryFile(host, username, newest.file) : undefined;
}

/** Every login whose UI has been read on this host, other than the one
 *  given. Role-based access can only be judged by comparison: what one
 *  account's UI offers and another's does not is the question. */
export function otherLoginMaps(host: string, exceptUsername?: string): Array<{ username: string; map: UiMap }> {
  const out: Array<{ username: string; map: UiMap }> = [];
  try {
    const hostDir = path.join(ROOT, slug(host));
    if (!fs.existsSync(hostDir)) return out;
    for (const u of fs.readdirSync(hostDir)) {
      if (exceptUsername && slug(exceptUsername) === u) continue;
      const f = path.join(hostDir, u, 'latest.json');
      if (!fs.existsSync(f)) continue;
      try {
        const map = JSON.parse(fs.readFileSync(f, 'utf8')) as UiMap;
        out.push({ username: map.username ?? u, map });
      } catch { /* a map we cannot read is a map we cannot compare */ }
    }
  } catch { /* no history on this host yet */ }
  return out;
}

export function discoveryRunDir(host: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(process.cwd(), 'data', 'ui-discovery', `disc-${ts}__${slug(host)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

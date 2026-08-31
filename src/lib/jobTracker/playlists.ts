// Test playlists for the Job Tracker.
//
// A playlist is a named, ordered list of testcase NAMES to run on the selected
// Simnovator. Names rather than ids: ids are per-box UUIDs, so a playlist keyed
// by id would only ever work on the box it was written against, while the same
// testcase name exists on every station.
//
// Built-in playlists live here. User-defined ones live in
// data/job-playlists.json and are merged on top, so a new playlist is a file
// edit — or a future UI — rather than a code change.

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface Playlist {
  id: string;
  name: string;
  /** One-line description shown under the name in the picker. */
  description: string;
  /** Radio technology this playlist targets — shown as a chip. */
  rat: 'SA' | 'LTE' | 'NB-IoT' | 'Mixed';
  /** Testcase names, executed in this order. */
  testcases: string[];
  /** Built-ins cannot be edited away by a bad JSON file. */
  builtIn?: boolean;
}

// These names were checked against the testcase catalogue on 192.168.1.95 —
// an earlier draft shipped invented names like "LTE_TC" and "1UDP" that exist
// on no box, so every run skipped its whole playlist and reported failure.
// A playlist is only useful if its names resolve; the wizard now also verifies
// them against the SELECTED station before you can continue, because a name
// present on one box is not guaranteed on another.
// Chosen from the INTERSECTION of both stations' catalogues (.102 has 215
// testcases, .95 has 862, and only 16 names are common), so the defaults run
// wherever you point them. Anything richer belongs in a per-station playlist —
// see data/job-playlists.json below.
const BUILT_IN: Playlist[] = [
  {
    id: 'sa',
    name: 'SA Playlist',
    description: '5G standalone attach on FDD and TDD, plus VoNR.',
    rat: 'SA',
    testcases: [
      '5G_Single_Cell_Attach_FDD_Single_UE',
      '5G_Single_Cell_Attach_TDD_Single_UE',
      'vonr',
    ],
    builtIn: true,
  },
  {
    id: 'lte',
    name: 'LTE Playlist',
    description: 'LTE attach, bidirectional data and handover.',
    rat: 'LTE',
    testcases: [
      '4G_Single_Cell_Attach_TDD_Single_UE',
      '4G_Single_Cell_Attach_TDD_64_UE_UDP_Bidirectional',
      'LTE_Handover_Scenario',
    ],
    builtIn: true,
  },
];

const FILE = () => path.join(process.cwd(), 'data', 'job-playlists.json');

/** User-defined playlists, if the file exists and parses. A malformed file is
 *  ignored rather than crashing the page — the built-ins still work. */
function readCustom(): Playlist[] {
  try {
    const j = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    const arr = Array.isArray(j) ? j : Array.isArray(j?.playlists) ? j.playlists : [];
    return arr
      .filter((p: any) => p && typeof p.id === 'string' && Array.isArray(p.testcases))
      .map((p: any) => ({
        id: String(p.id),
        name: String(p.name ?? p.id),
        description: String(p.description ?? ''),
        rat: (['SA', 'LTE', 'NB-IoT', 'Mixed'].includes(p.rat) ? p.rat : 'Mixed') as Playlist['rat'],
        testcases: p.testcases.map((t: any) => String(t)).filter(Boolean),
        builtIn: false,
      }));
  } catch {
    return [];
  }
}

/** Built-ins plus anything in data/job-playlists.json. A custom entry reusing a
 *  built-in id replaces it, which is how you retune SA/LTE without code. */
export function listPlaylists(): Playlist[] {
  const custom = readCustom();
  const merged = new Map<string, Playlist>();
  for (const p of BUILT_IN) merged.set(p.id, p);
  for (const p of custom) merged.set(p.id, p);
  return [...merged.values()];
}

export function getPlaylist(id: string): Playlist | undefined {
  return listPlaylists().find((p) => p.id === id);
}

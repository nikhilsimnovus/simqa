// Cross-surface run history.
//
// Every test surface (bulk-tests generate/validate/execute, API sweeps,
// UI sweeps, config-fidelity, automation-suite, …) writes a HistoryEntry
// here when a run completes. The /runs page reads from this single
// store so QA gets ONE timeline of every test that's ever fired
// against any lab, with click-through to the surface's own full result.
//
// On-disk layout:
//   data/history/<startedAt-iso>-<id>.json    one file per run
//
// Each file is a self-contained summary header — the full per-surface
// result lives elsewhere (e.g. data/bulk-tests/validation-*.json,
// data/ui-tests/run-*/results.json) and is referenced by detailPath.
//
// Append-only by design. To prune, just delete old files from disk —
// the listing endpoint just globs the directory.

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Every surface that writes runs. Keep this in sync with the test
 *  catalog so /runs can filter by surface. */
export type Surface =
  | 'bulk-generate'      // bulk-tests: matrix expansion + create-lifecycle sweep
  | 'bulk-validate'      // bulk-tests: API validator (full lifecycle assertion)
  | 'bulk-validate-ui'   // bulk-tests: Playwright UI validator
  | 'bulk-execute'       // bulk-tests: real testcase executions + ue.cfg pull
  | 'api-tests'          // /api/api-tests sweep
  | 'ui-tests'           // /api/ui-tests sweep (Playwright across catalog)
  | 'config-fidelity'    // /api/config-fidelity end-to-end
  | 'automation-suite'   // /automation-suite runner
  | 'end-to-end'         // legacy data/runs/*.json from the original runner
  | 'build-check'        // /validate page (deploy gate)
  | 'perf-qa';           // perf-qa collection runs (when wired)

export interface HistoryEntry {
  /** Unique id within the history store. Format: <startedAt epoch>-<rand>. */
  id: string;
  surface: Surface;
  /** Short human-readable label for the row, e.g. "API sweep — 74 tests"
   *  or "Bulk validate — 544 tests · 543 pass · 1 fail". */
  label: string;
  startedAt: string;
  finishedAt: string;
  /** Inventory system id the run targeted (lab-uesim / sys-2 / sys-6 …). */
  targetSystemId?: string;
  /** The system's network host (192.168.x.x), surfaced for filtering. */
  targetHost?: string;
  /** Box's reported build version at run time (Simnovator: 4.0.0_…). */
  buildVersion?: string;
  /** Roll-up counts — surface-defined semantics but always: total ≥
   *  passed + failed + (skipped ?? 0). */
  total: number;
  passed: number;
  failed: number;
  skipped?: number;
  /** Path relative to the project root of the surface's own full result
   *  artifact (file or directory). The /runs page links here for the
   *  surface-specific deep dive. */
  detailPath?: string;
  /** Surface-specific extras. Free-form so callers can stash whatever
   *  they want (sweep tier, suite id, ui-tests runDir, etc). */
  meta?: Record<string, any>;
}

const HISTORY_DIR = path.join(process.cwd(), 'data', 'history');

function ensureDir(): void {
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function appendHistoryEntry(entry: Omit<HistoryEntry, 'id'> & { id?: string }): HistoryEntry {
  ensureDir();
  const id = entry.id ?? newId();
  const full: HistoryEntry = { ...entry, id };
  // Filename sorts naturally by startedAt — we glob+sort by name in the
  // list endpoint so newer entries always appear first without needing
  // an index file.
  const safeStarted = full.startedAt.replace(/[:.]/g, '-');
  const file = path.join(HISTORY_DIR, `${safeStarted}-${id}.json`);
  try {
    fs.writeFileSync(file, JSON.stringify(full, null, 2));
  } catch (e) {
    // Never throw out of appendHistoryEntry — it's a side-channel and
    // shouldn't break the underlying surface's response.
    console.error('[historyStore] write failed:', file, e);
  }
  return full;
}

export interface ListOpts {
  surface?: Surface | Surface[];
  /** Filter by inventory system id. */
  targetSystemId?: string;
  /** ISO timestamp lower bound (inclusive). Pass to scope to "today" etc. */
  since?: string;
  /** Newest-N cap (defaults to 200). */
  limit?: number;
}

export function listHistoryEntries(opts: ListOpts = {}): HistoryEntry[] {
  let entries: HistoryEntry[] = [];
  try {
    if (!fs.existsSync(HISTORY_DIR)) return [];
    const files = fs.readdirSync(HISTORY_DIR).filter(f => f.endsWith('.json'));
    // Sort by filename descending (= startedAt descending since the
    // filename leads with the ISO timestamp).
    files.sort((a, b) => b.localeCompare(a));
    const wantedSurfaces = Array.isArray(opts.surface) ? new Set<string>(opts.surface) : (opts.surface ? new Set<string>([opts.surface]) : null);
    const limit = opts.limit ?? 200;
    for (const f of files) {
      if (entries.length >= limit) break;
      try {
        const e: HistoryEntry = JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, f), 'utf8'));
        if (wantedSurfaces && !wantedSurfaces.has(e.surface)) continue;
        if (opts.targetSystemId && e.targetSystemId !== opts.targetSystemId) continue;
        if (opts.since && e.startedAt < opts.since) continue;
        entries.push(e);
      } catch {
        // skip malformed files — they shouldn't block the rest
      }
    }
  } catch (e) {
    console.error('[historyStore] list failed:', e);
  }
  return entries;
}

/** Read one specific entry by id (returns null if missing). */
export function loadHistoryEntry(id: string): HistoryEntry | null {
  try {
    if (!fs.existsSync(HISTORY_DIR)) return null;
    const files = fs.readdirSync(HISTORY_DIR).filter(f => f.endsWith('.json') && f.includes(id));
    if (files.length === 0) return null;
    return JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, files[0]), 'utf8'));
  } catch { return null; }
}

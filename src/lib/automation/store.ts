// File-backed store for saved Automation Suites.
//
// Inventory's `AutomationSuite` shape is the canonical type — this module
// just persists a flat list under `data/automation-suites.json` so the
// suites survive restarts and don't pollute `inventory.yaml` (which is
// for systems + topology profiles only).

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AutomationSuite } from '../inventory';

const STORE_DIR = () => path.join(process.cwd(), 'data');
const STORE_FILE = () => path.join(STORE_DIR(), 'automation-suites.json');

interface StoreShape {
  suites: AutomationSuite[];
}

function read(): StoreShape {
  try {
    const text = fs.readFileSync(STORE_FILE(), 'utf8');
    const j = JSON.parse(text);
    if (Array.isArray(j?.suites)) return { suites: j.suites };
  } catch { /* file may not exist yet */ }
  return { suites: [] };
}

function write(s: StoreShape): void {
  fs.mkdirSync(STORE_DIR(), { recursive: true });
  fs.writeFileSync(STORE_FILE(), JSON.stringify(s, null, 2));
}

/**
 * Mirror a suite onto the Automation Server — /root/automation_configs/
 * <suite>/<test case>/ — with its configs and testcase definition inside.
 *
 * The folders appear at once: that part is local and instant. The files
 * follow in the background, because gathering them means several SSH sessions
 * per row against the callbox and the UE, and nobody should wait for a lab
 * box to answer before a save returns. A run re-syncs the row it is about to
 * execute, so a background pass that fails costs nothing but a delay.
 */
function mirrorToServer(suite: AutomationSuite): void {
  void (async () => {
    try {
      const { syncSuiteToServer } = await import('./syncServerConfigs');
      const { loadInventory } = await import('../inventory');
      const inv = loadInventory();
      await syncSuiteToServer(inv, suite, { structureOnly: true });
      await syncSuiteToServer(inv, suite);
    } catch { /* rebuilt before every run; a save must never fail over it */ }
  })();
}

export function listSuites(): AutomationSuite[] {
  // Newest first. The file keeps suites in the order they were appended, so
  // the list used to open on whatever was created first — and the suite
  // somebody had just saved sat at the bottom, past everything older.
  // Suites saved before createdAt existed have no timestamp; they keep their
  // file order at the end rather than jumping to the top.
  return [...read().suites].sort((x, y) => (y.createdAt ?? '').localeCompare(x.createdAt ?? ''));
}

export function getSuite(id: string): AutomationSuite | undefined {
  return read().suites.find(s => s.id === id);
}

/** Insert (no id collision allowed). Returns the persisted suite. */
export function createSuite(input: Omit<AutomationSuite, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): AutomationSuite {
  const s = read();
  const id = input.id ?? `suite-${Date.now().toString(36)}-${Math.floor(Math.random() * 1000).toString(36)}`;
  if (s.suites.some(x => x.id === id)) throw new Error(`suite id "${id}" already exists`);
  const now = new Date().toISOString();
  const suite: AutomationSuite = { ...input, id, createdAt: now, updatedAt: now };
  s.suites.push(suite);
  write(s);
  mirrorToServer(suite);
  return suite;
}

/** Patch — only known keys overwritten. */
export function updateSuite(id: string, patch: Partial<AutomationSuite>): AutomationSuite {
  const s = read();
  const i = s.suites.findIndex(x => x.id === id);
  if (i < 0) throw new Error(`no suite with id "${id}"`);
  const merged: AutomationSuite = { ...s.suites[i], ...patch, id, updatedAt: new Date().toISOString() };
  s.suites[i] = merged;
  write(s);
  // A renamed suite or an added row changes the tree; an edited duration does
  // not, but working that out is more code than simply re-laying it.
  mirrorToServer(merged);
  return merged;
}

export function deleteSuite(id: string): boolean {
  const s = read();
  const before = s.suites.length;
  s.suites = s.suites.filter(x => x.id !== id);
  if (s.suites.length === before) return false;
  write(s);
  return true;
}

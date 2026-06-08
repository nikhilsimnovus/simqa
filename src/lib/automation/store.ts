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

export function listSuites(): AutomationSuite[] {
  return read().suites;
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

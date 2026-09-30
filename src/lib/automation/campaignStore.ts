// Test Campaigns: a running order assembled from test cases that live in
// other suites.
//
// A suite is tied to the machines it was built on — its Simnovator, its
// callbox, the login it runs as. That is right for a suite and wrong for a
// campaign: the point of a campaign is to take five test cases out of two
// suites built on two different setups and run them somewhere else entirely,
// as somebody else. So a campaign stores WHICH test cases and in what order,
// and nothing about where they came from except the name of the suite that
// holds their configs. The setup and the login are chosen when Run is pressed.
//
// Nothing here copies or edits a suite. A campaign row points at the source
// suite's saved configuration folder; delete the campaign and the suites are
// untouched.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SuiteItem } from '../inventory';

/** One test case in a campaign: the suite row itself, plus where it came from. */
export interface CampaignItem extends SuiteItem {
  /** The suite this row was taken from — shown beside the test case, and the
   *  folder under /root/automation_configs its configs are read from. */
  sourceSuiteId: string;
  sourceSuiteName: string;
}

export interface TestCampaign {
  id: string;
  name: string;
  createdBy?: string;
  updatedBy?: string;
  createdAt: string;
  updatedAt: string;
  /** Execution order, top to bottom. */
  items: CampaignItem[];
  /** Remembered from the last run, only as the default the Run dialog opens
   *  on. A campaign is never BOUND to a setup: every run chooses again. */
  lastUesimSystemId?: string;
  lastBoxUserId?: string;
  lastCallboxSystemId?: string;
  lastUeSystemId?: string;
}

const STORE_DIR = () => path.join(process.cwd(), 'data');
const STORE_FILE = () => path.join(STORE_DIR(), 'automation-campaigns.json');
const BACKUP_DIR = () => path.join(STORE_DIR(), 'automation-campaign-backups');
const KEEP_BACKUPS = 20;

interface StoreShape { campaigns: TestCampaign[] }

function read(): StoreShape {
  try {
    const j = JSON.parse(fs.readFileSync(STORE_FILE(), 'utf8'));
    if (Array.isArray(j?.campaigns)) return { campaigns: j.campaigns };
  } catch { /* not created yet */ }
  return { campaigns: [] };
}

/** Same dated backups the suites file keeps — for the same reason. */
function backupCurrent(): void {
  try {
    const current = fs.readFileSync(STORE_FILE(), 'utf8');
    if (!current.trim() || !JSON.parse(current)?.campaigns?.length) return;
    fs.mkdirSync(BACKUP_DIR(), { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(BACKUP_DIR(), `automation-campaigns-${stamp}.json`), current);
    const old = fs.readdirSync(BACKUP_DIR()).filter(n => n.endsWith('.json')).sort();
    for (const name of old.slice(0, Math.max(0, old.length - KEEP_BACKUPS))) {
      try { fs.unlinkSync(path.join(BACKUP_DIR(), name)); } catch { /* gone already */ }
    }
  } catch { /* nothing to back up */ }
}

function write(s: StoreShape): void {
  fs.mkdirSync(STORE_DIR(), { recursive: true });
  backupCurrent();
  fs.writeFileSync(STORE_FILE(), JSON.stringify(s, null, 2));
}

/** Newest first, as the suites list does. */
export function listCampaigns(): TestCampaign[] {
  return [...read().campaigns].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
}

export function getCampaign(id: string): TestCampaign | undefined {
  return read().campaigns.find(c => c.id === id);
}

export function createCampaign(input: Omit<TestCampaign, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): TestCampaign {
  const s = read();
  const id = input.id ?? `camp-${Date.now().toString(36)}-${Math.floor(Math.random() * 1000).toString(36)}`;
  if (s.campaigns.some(c => c.id === id)) throw new Error(`campaign id "${id}" already exists`);
  const now = new Date().toISOString();
  const campaign: TestCampaign = { ...input, id, createdAt: now, updatedAt: now };
  s.campaigns.push(campaign);
  write(s);
  return campaign;
}

export function updateCampaign(id: string, patch: Partial<TestCampaign>): TestCampaign {
  const s = read();
  const i = s.campaigns.findIndex(c => c.id === id);
  if (i < 0) throw new Error(`no campaign with id "${id}"`);
  const merged: TestCampaign = { ...s.campaigns[i], ...patch, id, updatedAt: new Date().toISOString() };
  // An explicit null clears a field, as it does for suites.
  for (const [k, v] of Object.entries(patch)) if (v === null) delete (merged as any)[k];
  s.campaigns[i] = merged;
  write(s);
  return merged;
}

export function deleteCampaign(id: string): boolean {
  const s = read();
  const before = s.campaigns.length;
  s.campaigns = s.campaigns.filter(c => c.id !== id);
  if (s.campaigns.length === before) return false;
  write(s);
  return true;
}

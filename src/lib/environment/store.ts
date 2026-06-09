// File-backed store for GOLD-config Environments.
//
// Mirrors src/lib/automation/store.ts exactly: a flat list persisted under
// data/environments.json so Environments survive restarts and stay out of
// inventory.yaml (which is reserved for systems + topology profiles).

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Environment, EnvironmentStore } from './types';

const STORE_DIR = () => path.join(process.cwd(), 'data');
const STORE_FILE = () => path.join(STORE_DIR(), 'environments.json');

function read(): EnvironmentStore {
  try {
    const text = fs.readFileSync(STORE_FILE(), 'utf8');
    const j = JSON.parse(text);
    if (Array.isArray(j?.environments)) return { environments: j.environments };
  } catch { /* file may not exist yet */ }
  return { environments: [] };
}

function write(s: EnvironmentStore): void {
  fs.mkdirSync(STORE_DIR(), { recursive: true });
  fs.writeFileSync(STORE_FILE(), JSON.stringify(s, null, 2));
}

export function listEnvironments(): Environment[] {
  return read().environments;
}

export function getEnvironment(id: string): Environment | undefined {
  return read().environments.find(e => e.id === id);
}

/** Insert (no id collision allowed). Returns the persisted Environment. */
export function createEnvironment(input: Omit<Environment, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): Environment {
  const s = read();
  const id = input.id ?? `env-${Date.now().toString(36)}-${Math.floor(Math.random() * 1000).toString(36)}`;
  if (s.environments.some(x => x.id === id)) throw new Error(`environment id "${id}" already exists`);
  const now = new Date().toISOString();
  const env: Environment = { ...input, id, createdAt: now, updatedAt: now };
  s.environments.push(env);
  write(s);
  return env;
}

/** Patch — only supplied keys overwritten. */
export function updateEnvironment(id: string, patch: Partial<Environment>): Environment {
  const s = read();
  const i = s.environments.findIndex(x => x.id === id);
  if (i < 0) throw new Error(`no environment with id "${id}"`);
  const merged: Environment = { ...s.environments[i], ...patch, id, updatedAt: new Date().toISOString() };
  s.environments[i] = merged;
  write(s);
  return merged;
}

export function deleteEnvironment(id: string): boolean {
  const s = read();
  const before = s.environments.length;
  s.environments = s.environments.filter(x => x.id !== id);
  if (s.environments.length === before) return false;
  write(s);
  return true;
}

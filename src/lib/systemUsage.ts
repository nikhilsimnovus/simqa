// "Who last used this box, and when."
//
// Kept in its own small JSON file rather than written back into inventory.yaml:
// inventory.yaml is hand-edited configuration under the user's control, and a
// background run rewriting it on every execution would churn their file, fight
// concurrent edits, and risk mangling comments. Usage is derived data, so it
// lives beside the other derived state in data/.
//
// Attribution only — see src/lib/identity.ts. `by` is absent when the run was
// triggered outside a browser session.

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface SystemUsage {
  /** Inventory system id. */
  systemId: string;
  /** Host at the time of use, so the record still reads sensibly if the
   *  system is later renamed or re-addressed. */
  host?: string;
  /** Signed-in user who triggered the work, when known. */
  by?: string;
  /** ISO timestamp of that use. */
  at: string;
  /** What was done — e.g. "automation suite \"SA\"" or "validation run". */
  what?: string;
}

const FILE = () => path.join(process.cwd(), 'data', 'system-usage.json');

type Shape = Record<string, SystemUsage>;

function read(): Shape {
  try {
    const j = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};   // no file yet, or unreadable — usage is best-effort
  }
}

/** Record that `systemId` was just used. Last write wins: the question is
 *  "who used it most recently", not a full audit trail. */
export function recordSystemUse(u: SystemUsage): void {
  if (!u?.systemId) return;
  try {
    const all = read();
    all[u.systemId] = { ...u, at: u.at || new Date().toISOString() };
    fs.mkdirSync(path.dirname(FILE()), { recursive: true });
    fs.writeFileSync(FILE(), JSON.stringify(all, null, 2));
  } catch {
    // Never let bookkeeping break a run.
  }
}

export function getSystemUsage(systemId: string): SystemUsage | undefined {
  return read()[systemId];
}

export function listSystemUsage(): Shape {
  return read();
}

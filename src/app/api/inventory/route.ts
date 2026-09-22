import { NextResponse } from 'next/server';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadInventoryRaw, saveInventory, inventoryPath, type Inventory } from '@/lib/inventory';

export const dynamic = 'force-dynamic';

// RAW on purpose. Every other consumer wants loadInventory(), which merges the
// lab-wide SSH defaults into each system — but the editor must be able to tell
// an inherited value from one the system overrides. If this returned the
// resolved view, opening and saving the page would bake the defaults into
// every system and silently destroy the inheritance.
export async function GET() {
  return NextResponse.json(loadInventoryRaw());
}

/** Keep the last few versions of the file beside it, newest last. */
const BACKUP_KEEP = 10;

/**
 * Copy the current file aside before it is replaced.
 *
 * PUT is a whole-document replace, and this file is the only record of every
 * box in the lab — it is deliberately gitignored, so a bad write has nothing
 * to restore from. It has been emptied twice by a client racing its own load.
 * A timestamped copy costs nothing and turns "the systems are gone" into a
 * one-command recovery.
 */
function backupCurrent(): void {
  try {
    const src = inventoryPath();
    if (!fs.existsSync(src)) return;
    const dir = path.join(path.dirname(src), 'data', 'inventory-backups');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(src, path.join(dir, `inventory-${stamp}.yaml`));
    const old = fs.readdirSync(dir).filter((f) => f.startsWith('inventory-')).sort();
    for (const f of old.slice(0, Math.max(0, old.length - BACKUP_KEEP))) {
      fs.rmSync(path.join(dir, f), { force: true });
    }
  } catch {
    // A backup that cannot be written must not block the save the user asked
    // for — the refusal below is the real protection.
  }
}

export async function PUT(req: Request) {
  const body = (await req.json()) as Inventory;
  if (!body || !Array.isArray(body.systems)) {
    return NextResponse.json({ error: 'invalid inventory' }, { status: 400 });
  }

  // Refuse to erase every system.
  //
  // Nothing in the app legitimately goes from "boxes registered" to "none" in
  // one write: removing the last system is a deliberate act, and a client that
  // sends an empty list has almost always raced its own GET and is about to
  // overwrite the lab with its blank initial state. That is not a hypothetical
  // — it is how a 12-system inventory was lost, twice.
  //
  // ?allowEmpty=1 is the escape hatch for the one real case.
  const current = loadInventoryRaw();
  const wipe = (current.systems?.length ?? 0) > 0 && body.systems.length === 0;
  if (wipe && new URL(req.url).searchParams.get('allowEmpty') !== '1') {
    return NextResponse.json(
      {
        error:
          `refusing to replace ${current.systems.length} registered system(s) with an empty list. `
          + 'If you really meant to remove every system, repeat the request with ?allowEmpty=1.',
      },
      { status: 409 },
    );
  }

  backupCurrent();
  saveInventory(body);
  return NextResponse.json({ ok: true });
}

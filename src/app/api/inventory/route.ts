import { NextResponse } from 'next/server';
import { loadInventoryRaw, saveInventory, type Inventory } from '@/lib/inventory';

export const dynamic = 'force-dynamic';

// RAW on purpose. Every other consumer wants loadInventory(), which merges the
// lab-wide SSH defaults into each system — but the editor must be able to tell
// an inherited value from one the system overrides. If this returned the
// resolved view, opening and saving the page would bake the defaults into
// every system and silently destroy the inheritance.
export async function GET() {
  return NextResponse.json(loadInventoryRaw());
}

export async function PUT(req: Request) {
  const body = (await req.json()) as Inventory;
  if (!body || !Array.isArray(body.systems)) {
    return NextResponse.json({ error: 'invalid inventory' }, { status: 400 });
  }
  saveInventory(body);
  return NextResponse.json({ ok: true });
}

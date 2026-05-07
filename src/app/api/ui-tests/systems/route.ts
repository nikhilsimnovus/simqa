// GET /api/ui-tests/systems - list testable systems from inventory.yaml
// so the page can show a Target picker for multi-user / multi-box setups.

import { NextResponse } from 'next/server';
import { loadInventory, listTestableSystems } from '@/lib/inventory';

export const dynamic = 'force-dynamic';

export async function GET() {
  const inv = loadInventory();
  return NextResponse.json({ systems: listTestableSystems(inv) });
}

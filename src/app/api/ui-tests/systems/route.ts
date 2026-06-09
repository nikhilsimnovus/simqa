// GET /api/ui-tests/systems - list testable systems from inventory.yaml
// so the page can show a Target picker for multi-user / multi-box setups.

import { NextResponse } from 'next/server';
import { loadInventory, listTestableSystems, duplicateSystemIds } from '@/lib/inventory';

export const dynamic = 'force-dynamic';

export async function GET() {
  const inv = loadInventory();
  // Surface duplicate system ids — inventory.yaml is hand-edited and a reused
  // id silently shadows the later system (getSystem returns the first match),
  // which otherwise shows up downstream as a confusing "not a CALLBOX" error.
  const warnings = duplicateSystemIds(inv).map((d) => ({
    kind: 'duplicate-system-id' as const,
    id: d.id,
    message: `Duplicate system id "${d.id}" in inventory.yaml — ${d.count} systems share it (${d.entries.map((e) => `${e.type} ${e.host}`).join(', ')}). Ids must be unique; only the first is used and the rest are ignored.`,
  }));
  return NextResponse.json({ systems: listTestableSystems(inv), warnings });
}

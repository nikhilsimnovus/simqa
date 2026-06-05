import { NextResponse } from 'next/server';
import { listMatrixRuns } from '@/lib/configFidelity/runner';
import { loadInventory, isUesimLike } from '@/lib/inventory';

export const dynamic = 'force-dynamic';

/** GET -> recent runs + the systems usable as targets (for the UI dropdown). */
export async function GET() {
  const inv = loadInventory();
  const systems = inv.systems
    .filter((s) => isUesimLike(s) || s.type === 'UESIM')
    .map((s) => ({ id: s.id, name: s.name, host: s.host, type: s.type, hasSsh: !!s.username }));
  return NextResponse.json({ runs: listMatrixRuns(), systems });
}

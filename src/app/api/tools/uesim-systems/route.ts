// GET /api/tools/uesim-systems
// Returns the UESIM-typed systems from inventory that have SSH credentials
// configured, with a brief readiness check so the Tools page can show
// "ready" vs "missing creds" without us having to expose the full inventory.

import { NextResponse } from 'next/server';
import { loadInventory, isUesimLike } from '@/lib/inventory';

export const dynamic = 'force-dynamic';

export async function GET() {
  const inv = loadInventory();
  const systems = inv.systems.filter(isUesimLike).map((s) => {
    const reasons: string[] = [];
    if (!s.username) reasons.push('username');
    if (s.authMode === 'privateKey') {
      if (!s.privateKey) reasons.push('privateKey');
    } else if (!s.password) {
      reasons.push('password (or set authMode: privateKey + privateKey)');
    }
    return {
      id: s.id,
      name: s.name,
      host: s.host,
      type: s.type,
      authMode: s.authMode ?? 'password',
      hasUsername: !!s.username,
      ready: reasons.length === 0,
      missing: reasons,
    };
  });
  return NextResponse.json({ systems });
}

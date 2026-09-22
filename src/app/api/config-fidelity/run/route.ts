import { NextResponse } from 'next/server';
import { userFromRequest } from '@/lib/identity';
import { loadInventory } from '@/lib/inventory';
import { startMatrixRun, type CfRunRequest } from '@/lib/configFidelity/runner';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as CfRunRequest;
  const inv = loadInventory();
  // Attribution from the signed session, not the body.
  const r = await startMatrixRun(inv, { ...(body ?? {}), user: userFromRequest(req) || undefined });
  return NextResponse.json(r, { status: 'error' in r ? 400 : 200 });
}

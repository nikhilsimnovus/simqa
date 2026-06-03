import { NextResponse } from 'next/server';
import { loadInventory } from '@/lib/inventory';
import { startMatrixRun, type CfRunRequest } from '@/lib/configFidelity/runner';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as CfRunRequest;
  const inv = loadInventory();
  const r = startMatrixRun(inv, body ?? {});
  return NextResponse.json(r, { status: 'error' in r ? 400 : 200 });
}

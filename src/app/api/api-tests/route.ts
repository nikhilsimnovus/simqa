import { NextResponse } from 'next/server';
import { runApiTests, type ApiTesterRequest } from '@/lib/apiTester';
import { loadInventory } from '@/lib/inventory';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as ApiTesterRequest;
  const inv = loadInventory();
  const r = await runApiTests(inv, body ?? {});
  return NextResponse.json(r);
}

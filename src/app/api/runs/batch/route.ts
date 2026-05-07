import { NextResponse } from 'next/server';
import { executeBatch, type BatchRunRequest } from '@/lib/runner';
import { loadInventory } from '@/lib/inventory';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const body = (await req.json()) as BatchRunRequest;
  if (!body || !Array.isArray(body.testcaseIds) || body.testcaseIds.length === 0) {
    return NextResponse.json({ error: 'testcaseIds (non-empty) required' }, { status: 400 });
  }
  const inv = loadInventory();
  const r = await executeBatch(inv, body);
  return NextResponse.json(r);
}

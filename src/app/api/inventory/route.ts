import { NextResponse } from 'next/server';
import { loadInventory, saveInventory, type Inventory } from '@/lib/inventory';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(loadInventory());
}

export async function PUT(req: Request) {
  const body = (await req.json()) as Inventory;
  if (!body || !Array.isArray(body.systems)) {
    return NextResponse.json({ error: 'invalid inventory' }, { status: 400 });
  }
  saveInventory(body);
  return NextResponse.json({ ok: true });
}

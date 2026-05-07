// DELETE /api/ui-tests/baselines/<id>
import { NextResponse } from 'next/server';
import { deleteBaseline } from '@/lib/uiTester';

export const dynamic = 'force-dynamic';

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ok = deleteBaseline(id);
  if (!ok) return NextResponse.json({ ok: false, message: 'baseline not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}

// GET /api/api-validation/schema/<operationId>
//
// The request schema with $refs inlined, for "View schema" beside an API's
// body editor.

import { NextResponse } from 'next/server';
import { activeSpec } from '@/lib/apiValidation/store';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ opId: string[] }> }) {
  const { opId } = await params;
  const spec = activeSpec();
  const op = spec.byId[opId.join('/')];
  if (!op || !op.body) {
    return NextResponse.json({ error: 'no request body for this API' }, { status: 404 });
  }
  return NextResponse.json(spec.expand(op.body.schema));
}

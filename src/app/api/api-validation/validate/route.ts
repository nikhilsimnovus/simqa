// POST /api/api-validation/validate
//
// Check one API's edited inputs against the document, live, so anything the
// document does not allow is rejected before a run can start.

import { NextResponse } from 'next/server';
import { activeSpec } from '@/lib/apiValidation/store';
import { checkInputs } from '@/lib/apiValidation/service';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({} as any));
  const spec = activeSpec();
  const op = spec.byId[body.op_id];
  if (!op) return NextResponse.json({ error: 'unknown API' }, { status: 404 });
  const { errors, warnings } = checkInputs(spec, op, body.params, body.body);
  return NextResponse.json({ errors, warnings });
}

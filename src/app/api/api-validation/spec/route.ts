// GET /api/api-validation/spec
//
// The catalogue the page renders: every section, every API, its documented
// parameters and example bodies, what it needs from earlier APIs and what it
// produces for later ones.

import { NextResponse } from 'next/server';
import { specView } from '@/lib/apiValidation/service';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return NextResponse.json(specView());
  } catch (e: any) {
    return NextResponse.json({ error: `could not read the API document: ${e?.message ?? e}` }, { status: 500 });
  }
}

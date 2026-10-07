// GET /api/api-validation/document
//
// Which API document is in force — title, version, how many APIs, and the
// fingerprint that is printed on every report — plus the documents it can be
// rolled back to.

import { NextResponse } from 'next/server';
import { activeSpec } from '@/lib/apiValidation/store';
import { summary, history } from '@/lib/apiValidation/docs';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return NextResponse.json({ ...summary(activeSpec()), history: history() });
  } catch (e: any) {
    return NextResponse.json({ error: `could not read the API document: ${e?.message ?? e}` }, { status: 500 });
  }
}

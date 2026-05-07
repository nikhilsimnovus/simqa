// Read-only catalog endpoint: returns the static list of UI tests defined
// in the framework, without running any of them. The /ui-tests page uses
// this to render the numbered catalog before the user clicks Run.

import { NextResponse } from 'next/server';
import { getUiTestCatalog } from '@/lib/uiTester';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ tests: getUiTestCatalog() });
}

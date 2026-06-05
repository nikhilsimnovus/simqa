// GET /api/bulk-tests/status
//   Returns: current generation progress + result + current validation
//   progress + result. Polled by the /bulk-tests page.

import { NextResponse } from 'next/server';
import { getState, readManifest } from '@/lib/bulkTests/state';

export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getState();
  // If in-memory generation state is empty (e.g. HMR reset the module
  // mid-run), fall back to the on-disk manifest so the page can still
  // show the most recent generation result without losing visibility.
  const fileBackup = (!s.generation.progress && !s.generation.result) ? readManifest() : null;
  return NextResponse.json({
    ok: true,
    generation: {
      progress: s.generation.progress ?? null,
      result:   s.generation.result   ?? fileBackup ?? null,
    },
    validation: {
      progress: s.validation.progress ?? null,
      result:   s.validation.result   ?? null,
    },
    uiValidation: {
      progress: s.uiValidation.progress ?? null,
      result:   s.uiValidation.result   ?? null,
    },
    execution: {
      progress: s.execution?.progress ?? null,
      result:   s.execution?.result   ?? null,
    },
  }, { headers: { 'Cache-Control': 'no-store' } });
}

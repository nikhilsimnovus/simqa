// GET /api/jobs/playlists → the selectable test playlists and their testcases.

import { NextResponse } from 'next/server';
import { listPlaylists } from '@/lib/jobTracker/playlists';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ ok: true, playlists: listPlaylists() });
}

// POST /api/environments/upload
//   body: either raw JSON of the GOLD config, OR { json, filename }.
//
// Parses an uploaded GOLD-config testcase JSON into an Environment DRAFT
// (not yet persisted) + extraction warnings. The page reviews the draft,
// lets the user tweak the name, then POSTs to /api/environments to save.

import { NextResponse } from 'next/server';
import { parseEnvironmentUpload, EnvironmentParseError } from '@/lib/environment/parse';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(req: Request) {
  let raw: any;
  try { raw = await req.json(); } catch {
    return NextResponse.json({ ok: false, error: 'body is not valid JSON' }, { status: 400 });
  }
  // Accept both { json, filename } wrapper and a bare GOLD config.
  const json = (raw && typeof raw === 'object' && 'json' in raw) ? raw.json : raw;
  const filename = (raw && typeof raw === 'object' && typeof raw.filename === 'string') ? raw.filename : 'upload.json';

  try {
    const draft = parseEnvironmentUpload(json, filename);
    return NextResponse.json({ ok: true, draft });
  } catch (e: any) {
    const status = e instanceof EnvironmentParseError ? 400 : 500;
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status });
  }
}

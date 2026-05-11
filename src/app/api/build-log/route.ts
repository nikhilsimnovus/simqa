// GET /api/build-log?buildId=<id>&file=<name>
//
// Streams a file from a build directory (data/builds/<buildId>/) back as a
// download. Used by the Build Check UI's "Download log" button after an
// install completes. Files we expose:
//
//   install.log       - timestamped transcript of the install run
//   events.ndjson     - every log/step/screenshot event as raw JSON
//   request.json      - the original install request body
//
// Strict path guard: the file param is matched against a fixed allowlist
// so an attacker can't traverse out of the build dir.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const ALLOWED = new Set(['install.log', 'events.ndjson', 'request.json']);

const CONTENT_TYPES: Record<string, string> = {
  'install.log':   'text/plain; charset=utf-8',
  'events.ndjson': 'application/x-ndjson; charset=utf-8',
  'request.json':  'application/json; charset=utf-8',
};

export async function GET(req: Request) {
  const url = new URL(req.url);
  const buildId = url.searchParams.get('buildId')?.trim();
  const file    = url.searchParams.get('file')?.trim();
  if (!buildId || !file) return NextResponse.json({ error: 'missing buildId or file' }, { status: 400 });
  if (!/^build-[\w-]+$/i.test(buildId)) return NextResponse.json({ error: 'invalid buildId' }, { status: 400 });
  if (!ALLOWED.has(file)) return NextResponse.json({ error: `file must be one of: ${[...ALLOWED].join(', ')}` }, { status: 400 });

  const buildDir = path.resolve(process.cwd(), 'data', 'builds', buildId);
  const filePath = path.join(buildDir, file);
  // Belt-and-braces: confirm filePath is still inside buildDir after resolve.
  if (!filePath.startsWith(buildDir + path.sep)) return NextResponse.json({ error: 'invalid path' }, { status: 400 });
  if (!fs.existsSync(filePath))                  return NextResponse.json({ error: 'file not found' }, { status: 404 });

  const body = fs.readFileSync(filePath);
  return new Response(body, {
    headers: {
      'Content-Type': CONTENT_TYPES[file] ?? 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${buildId}-${file}"`,
      'Cache-Control': 'no-cache',
    },
  });
}

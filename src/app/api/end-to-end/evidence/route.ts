// GET /api/end-to-end/evidence?runId=…&file=…
//
// Serves one artifact a check saved under data/end-to-end/<runId>/ — today the
// UE-summary screenshot taken by during-all-ues-attach.
//
// The files live outside /public deliberately: they are run artifacts, not
// static assets, and a run directory should not become browsable by guessing
// URLs. Both parameters are validated and the resolved path is re-checked
// against the run directory, so a crafted `file` cannot escape it.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
};

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const runId = (q.get('runId') ?? '').trim();
  const file = (q.get('file') ?? '').trim();

  // A runId is a directory name; a file is a relative path of plain segments.
  if (!/^[\w.-]{1,120}$/.test(runId)) {
    return NextResponse.json({ error: 'bad runId' }, { status: 400 });
  }
  // Segment by segment rather than one clever pattern: every part must be a
  // plain name, which rules out "..", absolute paths, backslashes and empty
  // segments without depending on an escape being right.
  const parts = file.split('/');
  const fileOk = !!file
    && file.length <= 200
    && parts.length <= 4
    && parts.every((p) => p !== '' && p !== '.' && p !== '..' && /^[A-Za-z0-9._-]+$/.test(p));
  if (!fileOk) {
    return NextResponse.json({ error: 'bad file' }, { status: 400 });
  }

  const root = path.resolve(process.cwd(), 'data', 'end-to-end', runId);
  const target = path.resolve(root, file);
  // Belt and braces: even with the pattern above, only serve what is genuinely
  // inside this run's directory.
  if (target !== root && !target.startsWith(root + path.sep)) {
    return NextResponse.json({ error: 'bad file' }, { status: 400 });
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const body = fs.readFileSync(target);
  return new Response(new Uint8Array(body), {
    headers: {
      'Content-Type': TYPES[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
      // Artifacts of a finished run never change.
      'Cache-Control': 'private, max-age=3600',
    },
  });
}

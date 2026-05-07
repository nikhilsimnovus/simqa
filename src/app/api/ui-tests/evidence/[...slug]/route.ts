// Serve evidence files from data/ui-tests/<runDir>/<testId>/<file>.
// The slug is the path under data/ui-tests, segment-encoded by the page.

import { NextResponse } from 'next/server';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.join(process.cwd(), 'data', 'ui-tests');

function safe(p: string): string {
  return p.replace(/\.\.\\/g, '').replace(/\.\.\//g, '').replace(/[<>:"|?*\x00-\x1F]/g, '_');
}

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  const rel = slug.map(safe).join('/');
  const full = path.join(ROOT, rel);
  if (!full.startsWith(ROOT)) return NextResponse.json({ error: 'bad path' }, { status: 400 });
  if (!fs.existsSync(full)) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const buf = fs.readFileSync(full);
  const ext = path.extname(full).toLowerCase();
  const ct =
    ext === '.png'  ? 'image/png' :
    ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
    ext === '.json' ? 'application/json' :
    ext === '.txt'  ? 'text/plain; charset=utf-8' :
    'application/octet-stream';
  return new NextResponse(buf, { headers: { 'Content-Type': ct, 'Cache-Control': 'no-store' } });
}

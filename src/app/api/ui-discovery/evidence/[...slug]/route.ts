// Serve a discovery run's screenshots from data/ui-discovery/<run>/shots/<file>.

import { NextResponse } from 'next/server';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.join(process.cwd(), 'data', 'ui-discovery');

function safe(p: string): string {
  return p.replace(/\.\./g, '').replace(/[<>:"|?*\x00-\x1F]/g, '_');
}

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  const full = path.join(ROOT, slug.map(safe).join('/'));
  if (!full.startsWith(ROOT)) return NextResponse.json({ error: 'bad path' }, { status: 400 });
  if (!fs.existsSync(full)) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const ext = path.extname(full).toLowerCase();
  // The recording has to arrive as a video or the browser downloads it
  // instead of playing it, which makes the proof a file in Downloads.
  const ct = ext === '.png' ? 'image/png'
    : ext === '.webm' ? 'video/webm'
    : ext === '.mp4' ? 'video/mp4'
    : ext === '.zip' ? 'application/zip'
    : ext === '.json' ? 'application/json'
    : ext === '.txt' ? 'text/plain; charset=utf-8'
    : 'application/octet-stream';
  return new NextResponse(fs.readFileSync(full), {
    headers: { 'Content-Type': ct, 'Cache-Control': 'no-store' },
  });
}

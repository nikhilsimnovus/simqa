// Serve one ticket's evidence from data/jira-ui/<slug>.
//
// Videos and screenshots, by the path the run record carries — so a result
// row links straight to the recording of that one ticket.

import { NextResponse } from 'next/server';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = () => path.join(process.cwd(), 'data', 'jira-ui');

function safe(p: string): string {
  return p.replace(/\.\.[\/]/g, '').replace(/[<>:"|?*\x00-\x1F]/g, '_');
}

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await ctx.params;
  const root = ROOT();
  const full = path.join(root, slug.map(safe).join('/'));
  if (!path.resolve(full).startsWith(path.resolve(root))) {
    return NextResponse.json({ error: 'bad path' }, { status: 400 });
  }
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  const ext = path.extname(full).toLowerCase();
  const ct = ext === '.webm' ? 'video/webm'
    : ext === '.mp4' ? 'video/mp4'
    : ext === '.png' ? 'image/png'
    : ext === '.json' ? 'application/json'
    : 'application/octet-stream';
  return new NextResponse(new Uint8Array(fs.readFileSync(full)), {
    headers: { 'content-type': ct, 'cache-control': 'private, max-age=600' },
  });
}

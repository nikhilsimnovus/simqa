// GET /api/bulk-tests/report               — list all per-build reports
// GET /api/bulk-tests/report?slug=v…&format=html|md|json
//                                            — serve a specific report file
//
// Per-build reports live under dist/build-reports/<build-slug>/{report.html,
// report.md, report.json}. The slug is derived from the Simnovator build
// version captured at generation time (e.g. "4.0.0_260602" → "v4_0_0_260602").

import { NextResponse } from 'next/server';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildReportsRoot, writeBuildReport } from '@/lib/bulkTests/reportBuilder';
import { getState, readManifest } from '@/lib/bulkTests/state';

export const dynamic = 'force-dynamic';

const FORMATS = { html: 'text/html', md: 'text/markdown', json: 'application/json' } as const;
type Format = keyof typeof FORMATS;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const slug = url.searchParams.get('slug');
  const format = (url.searchParams.get('format') ?? 'html') as Format;

  // No slug → return the inventory of available reports.
  if (!slug) {
    const root = buildReportsRoot();
    let entries: Array<{ slug: string; mtime: string; hasHtml: boolean; hasMd: boolean; hasJson: boolean }> = [];
    try {
      for (const d of fs.readdirSync(root, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        const dir = path.join(root, d.name);
        const files = fs.readdirSync(dir);
        const stat = fs.statSync(dir);
        entries.push({
          slug: d.name,
          mtime: stat.mtime.toISOString(),
          hasHtml: files.includes('report.html'),
          hasMd:   files.includes('report.md'),
          hasJson: files.includes('report.json'),
        });
      }
      entries.sort((a, b) => b.mtime.localeCompare(a.mtime));
    } catch { /* root may not exist yet — return empty list */ }
    return NextResponse.json({ ok: true, reports: entries });
  }

  if (!(format in FORMATS)) {
    return NextResponse.json({ ok: false, error: `format must be one of: ${Object.keys(FORMATS).join(', ')}` }, { status: 400 });
  }

  // Defensive: only allow slugs that match our own naming convention.
  if (!/^[a-z0-9_-]+$/i.test(slug)) {
    return NextResponse.json({ ok: false, error: 'invalid slug' }, { status: 400 });
  }

  const file = path.join(buildReportsRoot(), slug, `report.${format}`);
  if (!fs.existsSync(file)) {
    return NextResponse.json({ ok: false, error: `no ${format} report for slug "${slug}"` }, { status: 404 });
  }

  const body = fs.readFileSync(file);
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': FORMATS[format] + '; charset=utf-8',
      // Make HTML/MD inline-viewable; JSON downloadable.
      'Content-Disposition': format === 'json' ? `attachment; filename="${slug}-report.json"` : 'inline',
      'Cache-Control': 'no-store',
    },
  });
}

/** POST /api/bulk-tests/report — rebuild the report from the current
 *  manifest + last validation summary in memory (or from disk fallback).
 *  Useful if you want to refresh the artifact without re-running validation. */
export async function POST() {
  const state = getState();
  const generation = state.generation.result ?? readManifest();
  if (!generation || generation.created.length === 0) {
    return NextResponse.json({ ok: false, error: 'no manifest to build a report from' }, { status: 400 });
  }
  const paths = writeBuildReport({ generation, validation: state.validation.result });
  return NextResponse.json({ ok: true, slug: paths.buildSlug, ...paths });
}

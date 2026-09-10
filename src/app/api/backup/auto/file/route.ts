// GET /api/backup/auto/file?ip=…&category=…&name=…
//
// Download one stored file. `name` arrives from a query string, so it is passed
// to store.ts's readFile(), which rejects anything that is not a plain basename
// — without that guard this route would be an arbitrary file read on the SimQA
// host. The category is whitelisted here for the same reason.

import { listFiles, readFile, BACKUP_CATEGORIES, type BackupCategory } from '@/lib/backup/store';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const ip = (url.searchParams.get('ip') ?? '').trim();
  const category = (url.searchParams.get('category') ?? '').trim() as BackupCategory;
  const name = (url.searchParams.get('name') ?? '').trim();

  const bad = (msg: string, status = 400) =>
    new Response(JSON.stringify({ ok: false, error: msg }), { status, headers: { 'Content-Type': 'application/json' } });

  if (!ip) return bad('ip required');
  if (!name) return bad('name required');
  if (!BACKUP_CATEGORIES.includes(category)) return bad(`unknown category "${category}"`);

  // Only serve something the listing actually offered — belt and braces on top
  // of readFile()'s basename guard.
  if (!listFiles(ip, category).some((f) => f.name === name)) {
    return bad(`no backup of "${name}" for ${ip} / ${category}`, 404);
  }

  try {
    const buf = readFile(ip, category, name);
    return new Response(new Uint8Array(buf), {
      headers: {
        // Deliberately not guessing a MIME type — these are cfg files and JSON
        // meant to be saved, not rendered.
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(buf.length),
        'Content-Disposition': `attachment; filename="${name.replace(/"/g, '')}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e: any) {
    return bad(e?.message ?? String(e), 404);
  }
}

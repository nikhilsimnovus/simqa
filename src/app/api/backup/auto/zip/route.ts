// POST /api/backup/auto/zip  { ip, category, names[] }  ->  one .zip
//
// The alternative offered alongside this is one download per file, which the
// browser handles as a burst of separate saves. Both are useful: a handful of
// cfgs is easier to work with loose, and 900 testcases is only sane as an
// archive.
//
// POST rather than GET because the selection can run to hundreds of names, which
// no URL should be asked to carry. The names are still validated one by one —
// only files the listing actually offers are archived, so a crafted name cannot
// reach outside the category directory.

import { listFiles, readFile, BACKUP_CATEGORIES, type BackupCategory } from '@/lib/backup/store';
import { buildZip, type ZipEntry } from '@/lib/backup/zip';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(req: Request) {
  const bad = (msg: string, status = 400) =>
    new Response(JSON.stringify({ ok: false, error: msg }), { status, headers: { 'Content-Type': 'application/json' } });

  let body: any;
  try { body = await req.json(); } catch { return bad('body must be JSON'); }

  const ip = String(body?.ip ?? '').trim();
  const category = String(body?.category ?? '').trim() as BackupCategory;
  const names: string[] = Array.isArray(body?.names) ? body.names.map((n: unknown) => String(n)) : [];

  if (!ip) return bad('ip required');
  if (!BACKUP_CATEGORIES.includes(category)) return bad(`unknown category "${category}"`);
  if (!names.length) return bad('names required');

  // The listing is the whitelist. Anything not in it is not archived, and the
  // caller is told which — quietly dropping a name would produce an archive that
  // looks complete and is not.
  const available = new Set(listFiles(ip, category).map((f) => f.name));
  const missing = names.filter((n) => !available.has(n));
  if (missing.length) {
    return bad(`not held for ${ip} / ${category}: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` (+${missing.length - 5} more)` : ''}`, 404);
  }

  try {
    const entries: ZipEntry[] = names.map((name) => ({ name, data: readFile(ip, category, name) }));
    const zip = buildZip(entries);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `${category}-${ip}-${stamp}.zip`;

    return new Response(new Uint8Array(zip), {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Length': String(zip.length),
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
        // So the card can report what it actually got without parsing the body.
        'X-Simqa-Zip-Files': String(entries.length),
      },
    });
  } catch (e: any) {
    return bad(e?.message ?? String(e), 500);
  }
}

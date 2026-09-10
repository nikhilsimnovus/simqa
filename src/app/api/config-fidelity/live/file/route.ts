// GET /api/config-fidelity/live/file?ip=…&id=…&name=testcase.json|ue.cfg|comparison.json
//
// Download one of a capture's artefacts. `name` is checked against a fixed
// whitelist in the store rather than passed through, so this cannot become an
// arbitrary file read; ip and id are basename-guarded for the same reason.

import { readCapture, readArtifact, hasArtifact, ARTIFACTS, type ArtifactName } from '@/lib/liveFidelity/store';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const ip = (url.searchParams.get('ip') ?? '').trim();
  const id = (url.searchParams.get('id') ?? '').trim();
  const name = (url.searchParams.get('name') ?? '').trim() as ArtifactName;

  const bad = (msg: string, status = 400) =>
    new Response(JSON.stringify({ ok: false, error: msg }), { status, headers: { 'Content-Type': 'application/json' } });

  if (!ip || !id) return bad('ip and id required');
  if (!ARTIFACTS.includes(name)) return bad(`unknown artifact "${name}"`);
  if (!hasArtifact(ip, id, name)) return bad(`${name} was not captured for ${id}`, 404);

  try {
    const buf = readArtifact(ip, id, name);
    const summary = readCapture(ip, id);
    // Name the download after the testcase, so a folder of them is readable.
    const stem = (summary?.testcaseName ?? id).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
    const filename = name === 'ue.cfg' ? `${stem}-ue.cfg` : `${stem}-${name}`;
    return new Response(new Uint8Array(buf), {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(buf.length),
        'Content-Disposition': `attachment; filename="${filename.replace(/"/g, '')}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e: any) {
    return bad(e?.message ?? String(e), 404);
  }
}

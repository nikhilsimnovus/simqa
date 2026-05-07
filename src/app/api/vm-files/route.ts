// POST /api/vm-files
//
// Lists .tar.gz / .tgz files found on a Simnovator VM. Drives Cockpit
// Terminal under the hood (no SSH from this app). Used by the
// /validate Build Check page when the user picks "File already on VM"
// as the source mode.
//
// Body: { systemId: string, searchDirs?: string[], maxDepth?: number }
// Returns: { ok, files: [{ path, size, mtime }], searchedDirs, error? }

import { NextResponse } from 'next/server';
import { loadInventory } from '@/lib/inventory';
import { listVmFiles, type ListVmFilesRequest } from '@/lib/cockpitFiles';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function POST(req: Request) {
  let body: ListVmFilesRequest;
  try { body = (await req.json()) as ListVmFilesRequest; }
  catch { return NextResponse.json({ ok: false, error: 'invalid JSON' }, { status: 400 }); }
  if (!body?.systemId) return NextResponse.json({ ok: false, error: 'missing systemId' }, { status: 400 });
  const inv = loadInventory();
  const r = await listVmFiles(inv, body);
  return NextResponse.json(r, { status: r.ok ? 200 : 502 });
}

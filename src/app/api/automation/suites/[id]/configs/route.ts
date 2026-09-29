// GET /api/automation/suites/[id]/configs
//   What was kept for this suite: one entry per testcase, each with its saved
//   versions, newest first, and the six files inside them.
//
// GET /api/automation/suites/[id]/configs?row=<name>&version=v2&file=enb.cfg
//   That one file, as text — the config the row actually ran with, not the one
//   on the box now.
//
// The store is a plain folder tree (data/suite-configs/<suite>/<testcase>/v1/…)
// so it can also be read straight off the disk. This is the same thing through
// the app, so nobody has to.

import { NextResponse } from 'next/server';
import { getSuite } from '@/lib/automation/store';
import { listRowVersions, readSavedFile } from '@/lib/suiteConfigStore';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const suite = getSuite(id);
  if (!suite) return NextResponse.json({ ok: false, error: `no suite "${id}"` }, { status: 404 });

  const u = new URL(req.url);
  const row = u.searchParams.get('row');
  const version = u.searchParams.get('version');
  const file = u.searchParams.get('file');
  // ?download=1 saves it instead of showing it — a 300 KB subscriber DB is
  // not something anyone reads in a browser tab.
  const download = u.searchParams.get('download') === '1';

  // One file's contents.
  if (row && version && file) {
    const text = readSavedFile(suite.name, row, version, file);
    if (text == null) return NextResponse.json({ ok: false, error: 'no such saved file' }, { status: 404 });
    // Named for where it came from, so a folder of downloads still says which
    // row and which version each file belongs to.
    const asName = `${row}_${version}_${file}`.replace(/[^A-Za-z0-9._-]+/g, '_');
    return new NextResponse(text, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${download ? asName : file}"`,
      },
    });
  }

  // The tree.
  const rows = (suite.items ?? []).map(it => ({
    row: it.name,
    versions: listRowVersions(suite.name, it.name),
  }));
  return NextResponse.json({ ok: true, suite: suite.name, rows });
}

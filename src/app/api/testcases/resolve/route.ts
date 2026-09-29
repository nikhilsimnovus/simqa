// GET /api/testcases/resolve?systemId=&boxUserId=&name=
//
// The box id of a testcase, given its NAME.
//
// An Automation Suite row runs a COPY the runner creates under the row's
// display name, and a report has to open that copy — opening the source shows
// a different testcase's executions, which is what a suite row used to link
// to. The run records the copy's id from now on, but rows that ran before it
// did have only the name, and the name is what identifies it on the box
// (testcase names are unique box-wide).
//
// Scoped by login: a testcase belongs to one operator and is invisible to the
// others, so the same name resolves through the account that owns it.

import { NextResponse } from 'next/server';
import { resolveTestcaseIdByName } from '@/lib/uesimClient';
import { uesimApiOptsForSystem, loadInventory } from '@/lib/inventory';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const u = new URL(req.url);
  const name = (u.searchParams.get('name') ?? '').trim();
  const systemId = u.searchParams.get('systemId') ?? '';
  const boxUserId = u.searchParams.get('boxUserId') ?? undefined;
  if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });

  const opts = uesimApiOptsForSystem(loadInventory(), systemId, boxUserId);
  if (!opts) return NextResponse.json({ ok: false, error: `system "${systemId}" is not testable` }, { status: 400 });

  try {
    const id = await resolveTestcaseIdByName(opts, name);
    // Not found is a normal answer — the copy may have been deleted from the
    // box since the run — so it is not an error, just no id.
    return NextResponse.json({ ok: true, name, id: id ?? null, host: opts.host });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
  }
}

// GET /api/automation/uesim-testcases/power-on?systemId=…&boxUserId=…&id=…
//
// What power-on duration does this test case actually hold?
//
// The suite's picker lists hundreds of test cases from GET /v2/testcases, which
// returns names and execution metadata but no definition — so the wizard knew
// nothing about how long a test case runs for, and a row added from a 605s test
// case showed the suite's 20s default. Picking one test case is the moment the
// figure is wanted, and the moment it is cheap to fetch, so it is fetched then.
//
// Separate from the listing route on purpose: a definition is tens of
// kilobytes, and the listing serves 768 of them on .94. This returns the
// numbers the picker needs and nothing else.

import { NextResponse } from 'next/server';
import { getTestcase } from '@/lib/uesimClient';
import { loadInventory, uesimApiOptsForSystem } from '@/lib/inventory';
// Read the same way the wizard reads an uploaded definition in the browser.
import { powerOnOf } from '@/lib/automation/durationFit';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const systemId = url.searchParams.get('systemId');
  const id = url.searchParams.get('id');
  if (!systemId || !id) {
    return NextResponse.json({ ok: false, error: 'systemId and id are required' }, { status: 400 });
  }
  // The login matters here as much as in the listing: a test case belongs to
  // one operator, and reading it as another is a 404.
  const boxUserId = url.searchParams.get('boxUserId') ?? undefined;
  const opts = uesimApiOptsForSystem(loadInventory(), systemId, boxUserId);
  if (!opts) return NextResponse.json({ ok: false, error: `system "${systemId}" is not a testable UESIM` }, { status: 404 });

  try {
    const tc: any = await getTestcase(opts, id);
    const td = tc?.testDefinition ?? {};
    return NextResponse.json({ ok: true, name: tc?.name, boxUser: opts.boxUser, ...powerOnOf(td) });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 502 });
  }
}


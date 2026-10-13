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
import { getTestcase, listSimulators } from '@/lib/uesimClient';
import { loadInventory, uesimApiOptsForSystem } from '@/lib/inventory';
// Read the same way the wizard reads an uploaded definition in the browser.
import { powerOnOf } from '@/lib/automation/durationFit';
// A cell runs on a radio card, and the simulator has to own one per cell.
import { cardsOf, fitCards } from '@/lib/automation/rfCards';

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

    // Can this login's simulator even run it?
    //
    // Cells sit on radio cards, one each, and a box splits its cards between
    // its simulators — .95 gives two of its six to each of three. A 3-cell
    // test case therefore needs a simulator owning three cards, and picking
    // one that needs more than the login has is worth knowing when the row is
    // added rather than when the run reports that the box refused it.
    let cardFit: { ok: boolean; reason?: string; note?: string } | undefined;
    let simulator: { name?: string; cards: number[] } | undefined;
    const cards = cardsOf(td);
    try {
      const sims: any = await listSimulators(opts);
      const s = (sims?.items ?? [])[0];
      if (s) {
        const owned: number[] = (s?.nodes?.rfCards ?? []).map(Number).filter(Number.isFinite);
        simulator = { name: s.name ? String(s.name) : undefined, cards: owned };
        const fit = fitCards(cards, owned, simulator.name ?? opts.boxUser);
        cardFit = { ok: fit.ok, reason: fit.reason, note: fit.note };
      }
    } catch { /* the picker is still useful without this */ }

    return NextResponse.json({
      ok: true, name: tc?.name, boxUser: opts.boxUser,
      cells: cards.length, cards, simulator, cardFit,
      ...powerOnOf(td),
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 502 });
  }
}


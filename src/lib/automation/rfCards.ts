// Which radio card each cell runs on, and whether the chosen simulator owns it.
//
// A Simnovator's radio cards are split between its simulators, one set each.
// On 192.168.1.95:
//
//   sim 58 "sruthi"   cards 2, 3
//   sim 60 "simuser"  cards 0, 1
//   sim 68 "mohan"    cards 4, 5
//
// A testcase names a card per cell (`cellConfig.cells[].rfCard`), and the box
// refuses to START one that names a card the simulator does not own — HTTP
// 200, `{"status":"Failure","message":"The test uses sdr4, which is not
// assigned to this simulator"}`. Card 4 is sdr4.
//
// Two separate rules, both measured against the box:
//
//   ownership     every cell's card must belong to the simulator the trigger
//                 names, or the box refuses to start.
//   exclusivity   two cells may not share a card. Writing [0,1,0] is rejected
//                 at save time: "CellConfig: Cell 2: RF Card slot 0 is
//                 already occupied by another cell".
//
// Together they mean a definition needs one card per distinct card it asks
// for, and the simulator must own that many. The 3-cell definitions in
// /root/automation_configs want cards 0, 2 and 4 — one from each simulator —
// so no simulator on that box can run them, and the honest thing is to say so
// before triggering rather than wait out a poll window and call it a timeout.
//
// When the cards merely belong to another simulator (a definition captured
// under a different login, which is the normal case for the automation
// server's folders) they are remapped one-to-one onto the cards this
// simulator owns. That is what makes "pick it from the server and insert it"
// work across logins.
//
// Pure, imports nothing, so node --test loads it directly.

/** Just the part of a testcase definition this needs. */
export interface HasCells {
  cellConfig?: { cells?: Array<{ rfCard?: number | string } & Record<string, unknown>> };
}

export interface CardFit {
  /** Can this definition run on that simulator, with remapping if needed? */
  ok: boolean;
  /** Old card -> new card, only for the cards that have to move. */
  remap: Array<{ from: number; to: number }>;
  /** Why not, in words meant for the operator. */
  reason?: string;
  /** One line describing the remap, for the row detail. */
  note?: string;
}

/** The card each cell names, in cell order. Missing or non-numeric reads as 0,
 *  which is what the box itself defaults to. */
export function cardsOf(td: HasCells | null | undefined): number[] {
  const cells = td?.cellConfig?.cells ?? [];
  return cells.map((c) => {
    const n = Number(c?.rfCard);
    return Number.isFinite(n) ? n : 0;
  });
}

/**
 * Can `wanted` (the card per cell, in cell order) run on a simulator owning
 * `owned`?
 *
 * An empty `owned` means the simulator's cards could not be read — then
 * nothing is claimed and nothing is changed, because refusing a run over a
 * failed lookup would be worse than letting the box decide.
 */
export function fitCards(
  wanted: number[],
  owned: number[],
  simName?: string,
): CardFit {
  if (!wanted.length || !owned.length) return { ok: true, remap: [] };

  const distinct = [...new Set(wanted)];
  const who = simName ? `simulator "${simName}"` : 'that simulator';

  if (distinct.length > owned.length) {
    // Say what to do about it. "Cannot run on it" is true and leaves an
    // operator with nowhere to go — and the usual next thought, that the test
    // case must be missing from the box, sends them looking in the wrong
    // place entirely. The fix is on the Simnovator: a simulator's rfCards are
    // assigned to it, and a box's cards are split between its simulators, so
    // a third card for this one has to come from another.
    const short = distinct.length - owned.length;
    return {
      ok: false,
      remap: [],
      reason: `${wanted.length} cells need ${distinct.length} different RF cards`
        + ` (${distinct.join(', ')}) and ${who} owns ${owned.length} (${owned.join(', ')});`
        + ' two cells cannot share a card. Nothing is missing from the automation server —'
        + ` this test case needs ${short} more RF card${short === 1 ? '' : 's'} assigned to`
        + ` ${simName ? `"${simName}"` : 'this simulator'} on the Simnovator, or a simulator that already has`
        + ` ${distinct.length}`,
    };
  }

  if (distinct.every((c) => owned.includes(c))) return { ok: true, remap: [] };

  // Remap one-to-one: the cards wanted, in first-seen order, onto the cards
  // owned, in ascending order. Leaving an already-owned card where it is would
  // be tidier, but it needs a matching pass to stay collision-free, and the
  // box cares only that every cell gets its own owned card.
  const free = [...owned].sort((a, b) => a - b);
  const remap: Array<{ from: number; to: number }> = [];
  distinct.forEach((from, i) => {
    const to = free[i];
    if (to !== from) remap.push({ from, to });
  });
  return {
    ok: true,
    remap,
    note: `RF cards remapped for ${who}: ` + remap.map((r) => `${r.from} -> ${r.to}`).join(', '),
  };
}

/**
 * Rewrite the cells' cards in place. Returns the cards afterwards, so a caller
 * can report what it did.
 */
export function applyCardFit(td: HasCells, fit: CardFit): number[] {
  if (!fit.remap.length) return cardsOf(td);
  const map = new Map(fit.remap.map((r) => [r.from, r.to]));
  for (const cell of td?.cellConfig?.cells ?? []) {
    const n = Number(cell?.rfCard);
    const from = Number.isFinite(n) ? n : 0;
    if (map.has(from)) cell.rfCard = map.get(from)!;
  }
  return cardsOf(td);
}

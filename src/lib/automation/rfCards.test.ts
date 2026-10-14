import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardsOf, fitCards, applyCardFit } from './rfCards.ts';

// Numbers below are the real ones: 192.168.1.95 splits six cards across three
// simulators, and NSA_3cell_Mobility_UDP_1UEs_automation asks for 0, 2 and 4.

test('the cards a definition asks for, in cell order', () => {
  const td = { cellConfig: { cells: [{ rfCard: 0 }, { rfCard: 2 }, { rfCard: 4 }] } };
  assert.deepEqual(cardsOf(td), [0, 2, 4]);
  assert.deepEqual(cardsOf({}), []);
  assert.deepEqual(cardsOf({ cellConfig: { cells: [{}] } }), [0]);
});

test('3 cells cannot run on a simulator owning 2 cards', () => {
  const fit = fitCards([0, 2, 4], [0, 1], 'simuser');
  assert.equal(fit.ok, false);
  assert.match(fit.reason!, /3 cells need 3 different RF cards \(0, 2, 4\)/);
  assert.match(fit.reason!, /simulator "simuser" owns 2 \(0, 1\)/);
  assert.match(fit.reason!, /two cells cannot share a card/);
  // It has to say what to DO, and rule out the wrong suspicion: an operator
  // whose test case will not run assumes it is missing from the box.
  assert.match(fit.reason!, /Nothing is missing from the automation server/);
  assert.match(fit.reason!, /needs 1 more RF card assigned to "simuser"/);
});

test('cards the simulator already owns are left alone', () => {
  const fit = fitCards([0, 1], [0, 1], 'simuser');
  assert.equal(fit.ok, true);
  assert.deepEqual(fit.remap, []);
  assert.equal(fit.note, undefined);
});

test("another login's cards are remapped one-to-one", () => {
  // Captured under sruthi (cards 2, 3), run as simuser (cards 0, 1).
  const fit = fitCards([2, 3], [0, 1], 'simuser');
  assert.equal(fit.ok, true);
  assert.deepEqual(fit.remap, [{ from: 2, to: 0 }, { from: 3, to: 1 }]);
  assert.match(fit.note!, /RF cards remapped for simulator "simuser": 2 -> 0, 3 -> 1/);

  const td = { cellConfig: { cells: [{ rfCard: 2 }, { rfCard: 3 }] } };
  assert.deepEqual(applyCardFit(td, fit), [0, 1]);
});

test('remapping never puts two cells on one card', () => {
  // Every distinct card gets its own owned card, so the result stays unique —
  // the box rejects a save otherwise ("RF Card slot 0 is already occupied").
  for (const [wanted, owned] of [
    [[4, 2, 0], [0, 1, 2]],
    [[2, 3], [0, 1]],
    [[5], [1]],
    [[3, 2], [1, 0]],
  ] as Array<[number[], number[]]>) {
    const fit = fitCards(wanted, owned, 'sim');
    assert.equal(fit.ok, true, JSON.stringify({ wanted, owned }));
    const td = { cellConfig: { cells: wanted.map((c) => ({ rfCard: c })) } };
    const after = applyCardFit(td, fit);
    assert.equal(new Set(after).size, after.length, 'cards collided: ' + JSON.stringify(after));
    assert.ok(after.every((c) => owned.includes(c)), 'card not owned: ' + JSON.stringify(after));
  }
});

test('cells sharing a card in the source stay sharing nothing new', () => {
  // A definition that already asks for one card twice needs only one card.
  const fit = fitCards([2, 2], [0, 1], 'simuser');
  assert.equal(fit.ok, true);
  const td = { cellConfig: { cells: [{ rfCard: 2 }, { rfCard: 2 }] } };
  assert.deepEqual(applyCardFit(td, fit), [0, 0]);
});

test('unknown simulator cards change nothing', () => {
  // A failed lookup must not block a run the box might well accept.
  const fit = fitCards([0, 2, 4], [], 'simuser');
  assert.equal(fit.ok, true);
  assert.deepEqual(fit.remap, []);
  const td = { cellConfig: { cells: [{ rfCard: 0 }, { rfCard: 2 }, { rfCard: 4 }] } };
  assert.deepEqual(applyCardFit(td, fit), [0, 2, 4]);
});

test('applying a fit touches only the cards that move', () => {
  const td: any = {
    cellConfig: { cells: [{ rfCard: 2, EARFCN: { dl: 2850 } }, { rfCard: 3 }] },
  };
  applyCardFit(td, fitCards([2, 3], [0, 1]));
  assert.deepEqual(td.cellConfig.cells[0].EARFCN, { dl: 2850 });
});

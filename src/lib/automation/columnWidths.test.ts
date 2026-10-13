import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_FRACTION, evenWidths, resizeColumns, normaliseWidths, asPercents,
} from './columnWidths.ts';

const sum = (xs: number[]) => xs.reduce((t, x) => t + x, 0);
const near = (a: number, b: number, why?: string) =>
  assert.ok(Math.abs(a - b) < 1e-9, why ?? `${a} !== ${b}`);

test('even widths fill the table exactly', () => {
  for (const n of [1, 2, 6, 11]) {
    const w = evenWidths(n);
    assert.equal(w.length, n);
    near(sum(w), 1, `n=${n}`);
  }
  assert.deepEqual(evenWidths(0), []);
});

test('a drag moves space between two columns and nowhere else', () => {
  const before = evenWidths(6);
  const after = resizeColumns(before, 1, 0.05);
  near(sum(after), 1, 'the table still fits');
  near(after[1], before[1] + 0.05);
  near(after[2], before[2] - 0.05);
  // Everything else untouched — otherwise the whole table shifts under one drag.
  for (const i of [0, 3, 4, 5]) near(after[i], before[i], `column ${i} moved`);
});

test('dragging the other way works the same', () => {
  const before = evenWidths(6);
  const after = resizeColumns(before, 1, -0.05);
  near(sum(after), 1);
  near(after[1], before[1] - 0.05);
  near(after[2], before[2] + 0.05);
});

test('no column can be dragged away to nothing', () => {
  const before = evenWidths(6);
  // A drag far past what the neighbour has.
  const after = resizeColumns(before, 0, 10);
  near(sum(after), 1, 'still fits');
  near(after[1], MIN_FRACTION, 'the neighbour stops at the minimum');
  assert.ok(after[0] > before[0]);
  // And the other direction.
  const back = resizeColumns(before, 0, -10);
  near(back[0], MIN_FRACTION);
  near(sum(back), 1);
});

test('the last column has no handle', () => {
  const before = evenWidths(6);
  assert.equal(resizeColumns(before, 5, 0.1), before);
  assert.equal(resizeColumns(before, 6, 0.1), before);
  assert.equal(resizeColumns(before, -1, 0.1), before);
});

test('nonsense deltas change nothing', () => {
  const before = evenWidths(6);
  assert.equal(resizeColumns(before, 1, Number.NaN), before);
  assert.equal(resizeColumns(before, 1, 0), before);
});

test('many drags in a row never break the sum', () => {
  let w = evenWidths(6);
  let seed = 7;
  for (let i = 0; i < 400; i++) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const handle = seed % 5;
    const delta = ((seed >> 8) % 2001 - 1000) / 1000;      // -1 .. 1
    w = resizeColumns(w, handle, delta);
    near(sum(w), 1, `after ${i + 1} drags`);
    assert.ok(w.every((x) => x >= MIN_FRACTION - 1e-9), `a column went too thin after ${i + 1} drags`);
  }
});

test('a saved set from a table with a different column count is discarded', () => {
  // The Build column was removed; a browser holding seven widths must not
  // paint six columns of data under them.
  assert.deepEqual(normaliseWidths([0.2, 0.2, 0.1, 0.1, 0.2, 0.1, 0.1], 6), evenWidths(6));
  assert.deepEqual(normaliseWidths(undefined, 6), evenWidths(6));
  assert.deepEqual(normaliseWidths('nonsense', 6), evenWidths(6));
  assert.deepEqual(normaliseWidths([], 6), evenWidths(6));
});

test('a saved set is rescaled to fit, and thin columns lifted', () => {
  const w = normaliseWidths([200, 300, 100, 100, 200, 100], 6);
  near(sum(w), 1);
  assert.ok(w.every((x) => x >= MIN_FRACTION - 1e-9));
  // Proportions kept: the second column was the widest and still is.
  assert.equal(w.indexOf(Math.max(...w)), 1);

  const thin = normaliseWidths([1000, 1, 1, 1, 1, 1], 6);
  near(sum(thin), 1);
  assert.ok(thin.every((x) => x >= MIN_FRACTION - 1e-9), 'every column stayed visible');
});

test('garbage inside a saved set does not poison the row', () => {
  const w = normaliseWidths([0.3, 'x', -4, Number.NaN, 0.3, 0.4], 6);
  near(sum(w), 1);
  assert.ok(w.every((x) => Number.isFinite(x) && x >= MIN_FRACTION - 1e-9));
});

test('percent strings are what a colgroup wants', () => {
  const p = asPercents(evenWidths(4));
  assert.deepEqual(p, ['25.0000%', '25.0000%', '25.0000%', '25.0000%']);
});

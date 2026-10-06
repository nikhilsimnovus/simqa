// What changed in the UI between two builds.
//
// This is the half of build-awareness that discovery alone cannot give you.
// Discovery says what is there now; a diff against the map taken on the
// previous build says what is NEW — which is exactly the part a QA engineer
// has to look at, and the part a hand-maintained test list never mentions
// because nobody had written a test for it yet.
//
// A page that moved or was renamed is reported as a rename rather than as one
// removal and one addition, because "Manage Simulators is now Simulator
// Inventory" and "Manage Simulators is gone" call for different work. The
// pairing is evidence-based: same parent, and most of the same controls
// inside. Where that evidence is absent it stays an add and a remove, which
// is the honest answer.
//
// Pure: types only.

import type { UiMap, UiNode, UiMapDiff } from './types.ts';

function keysOf(node: UiNode): Set<string> {
  return new Set(node.elements.map(e => e.key));
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const k of a) if (b.has(k)) shared += 1;
  return shared / Math.max(a.size, b.size);
}

/** A page is "the same page, renamed" when it hangs off the same parent and
 *  still holds most of the same controls. Three controls is the floor: below
 *  that, an overlap ratio is noise. */
function pairRenames(removed: UiNode[], added: UiNode[]): Array<{ from: UiNode; to: UiNode }> {
  const pairs: Array<{ from: UiNode; to: UiNode }> = [];
  const takenAdded = new Set<string>();
  for (const from of removed) {
    let best: { to: UiNode; score: number } | undefined;
    for (const to of added) {
      if (takenAdded.has(to.id)) continue;
      if ((from.parentId ?? '') !== (to.parentId ?? '')) continue;
      const fk = keysOf(from);
      const tk = keysOf(to);
      if (fk.size < 3 || tk.size < 3) continue;
      const score = overlap(fk, tk);
      if (score >= 0.6 && (!best || score > best.score)) best = { to, score };
    }
    if (best) {
      takenAdded.add(best.to.id);
      pairs.push({ from, to: best.to });
    }
  }
  return pairs;
}

export function diffMaps(previous: UiMap | undefined, current: UiMap): UiMapDiff {
  const diff: UiMapDiff = {
    previousBuild: previous?.build,
    previousDiscoveredAt: previous?.discoveredAt,
    currentBuild: current.build,
    addedPages: [], removedPages: [], renamedPages: [],
    addedElements: [], removedElements: [], changedElements: [],
  };
  if (!previous) return diff;

  const prevById = new Map(previous.nodes.map(n => [n.id, n]));
  const currById = new Map(current.nodes.map(n => [n.id, n]));

  const addedNodes = current.nodes.filter(n => !prevById.has(n.id));
  const removedNodes = previous.nodes.filter(n => !currById.has(n.id));

  const renames = pairRenames(removedNodes, addedNodes);
  const renamedFrom = new Set(renames.map(r => r.from.id));
  const renamedTo = new Set(renames.map(r => r.to.id));

  for (const r of renames) {
    diff.renamedPages.push({ id: r.to.id, from: r.from.path.join(' → '), to: r.to.path.join(' → ') });
  }
  for (const n of addedNodes) {
    if (renamedTo.has(n.id)) continue;
    diff.addedPages.push({ id: n.id, page: n.path.join(' → ') });
  }
  for (const n of removedNodes) {
    if (renamedFrom.has(n.id)) continue;
    diff.removedPages.push({ id: n.id, page: n.path.join(' → ') });
  }

  // Elements, for pages that exist in both maps (including the renamed ones,
  // compared across their old and new names).
  const pairsToCompare: Array<{ before: UiNode; after: UiNode }> = [];
  for (const n of current.nodes) {
    const before = prevById.get(n.id);
    if (before) pairsToCompare.push({ before, after: n });
  }
  for (const r of renames) pairsToCompare.push({ before: r.from, after: r.to });

  for (const { before, after } of pairsToCompare) {
    const page = after.path.join(' → ');
    const beforeByKey = new Map(before.elements.map(e => [e.key, e]));
    const afterByKey = new Map(after.elements.map(e => [e.key, e]));

    for (const e of after.elements) {
      if (!beforeByKey.has(e.key)) {
        diff.addedElements.push({ id: `${after.id}::${e.key}`, page, element: e.label || e.key, kind: e.kind });
      }
    }
    for (const e of before.elements) {
      if (!afterByKey.has(e.key)) {
        diff.removedElements.push({ id: `${before.id}::${e.key}`, page, element: e.label || e.key, kind: e.kind });
      }
    }
    for (const e of after.elements) {
      const was = beforeByKey.get(e.key);
      if (!was) continue;
      const notes: string[] = [];
      if (!!was.disabled !== !!e.disabled) notes.push(e.disabled ? 'now disabled' : 'no longer disabled');
      if (!!was.required !== !!e.required) notes.push(e.required ? 'now mandatory' : 'no longer mandatory');
      const wasOpts = was.options?.length ?? 0;
      const nowOpts = e.options?.length ?? 0;
      if (wasOpts !== nowOpts) notes.push(`options ${wasOpts} → ${nowOpts}`);
      const wasCols = (was.columns ?? []).join(',');
      const nowCols = (e.columns ?? []).join(',');
      if (wasCols !== nowCols) notes.push(`columns "${wasCols}" → "${nowCols}"`);
      if (notes.length) {
        diff.changedElements.push({ id: `${after.id}::${e.key}`, page, element: e.label || e.key, what: notes.join('; ') });
      }
    }
  }

  return diff;
}

/** True when the diff has nothing in it — the UI is the one we mapped before. */
export function diffIsEmpty(d: UiMapDiff): boolean {
  return d.addedPages.length === 0 && d.removedPages.length === 0 && d.renamedPages.length === 0
    && d.addedElements.length === 0 && d.removedElements.length === 0 && d.changedElements.length === 0;
}

/** One line for the top of the page: what a new build brought. */
export function describeDiff(d: UiMapDiff): string {
  if (diffIsEmpty(d)) return 'No UI changes since the last discovery.';
  const bits: string[] = [];
  if (d.addedPages.length) bits.push(`${d.addedPages.length} new page(s)`);
  if (d.removedPages.length) bits.push(`${d.removedPages.length} page(s) gone`);
  if (d.renamedPages.length) bits.push(`${d.renamedPages.length} renamed`);
  if (d.addedElements.length) bits.push(`${d.addedElements.length} new control(s)`);
  if (d.removedElements.length) bits.push(`${d.removedElements.length} control(s) gone`);
  if (d.changedElements.length) bits.push(`${d.changedElements.length} changed`);
  return bits.join(', ');
}

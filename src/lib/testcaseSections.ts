// Which sections of an edited testcase actually changed.
//
// The Simnovator edits a testcase IN PLACE, one section at a time: its own GUI
// saves with PUT v2/tests/<id>/<section> (cells, subscribers, user-plane,
// power-cycle, mobility, settings) — read from the box's web bundle, and
// verified on 192.168.1.95: the id is unchanged and the edit is kept.
//
// So an edited testcase.json is saved by sending only the sections that
// differ. Untouched sections are not rewritten, which keeps a one-field edit a
// one-request edit and leaves nothing half-applied to the rest.
//
// Pure, imports nothing, so node --test can load it directly.

export type SectionName = 'cells' | 'subscribers' | 'user-plane' | 'power-cycle' | 'mobility' | 'settings';

/** Section → the key it lives under in a testDefinition, in the order the box
 *  applies them. Settings last: it names and finalises the case. */
export const SECTIONS: ReadonlyArray<readonly [SectionName, string]> = [
  ['cells', 'cellConfig'],
  ['subscribers', 'subsConfig'],
  ['user-plane', 'userPlaneConfig'],
  ['power-cycle', 'powerCycleConfig'],
  ['mobility', 'mobilityConfig'],
  ['settings', 'settings'],
];

/** The two fields a testcase's name lives in. GET never returns testCaseName,
 *  though a settings write requires it — so they are compared separately. */
const NAME_KEYS = new Set(['test_name', 'testCaseName']);

/** JSON with keys sorted, so equal content compares equal whatever the order. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object).sort()
      .filter((k) => (v as any)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableJson((v as any)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

function withoutName(settings: any): any {
  if (!settings || typeof settings !== 'object') return settings;
  return Object.fromEntries(Object.entries(settings).filter(([k]) => !NAME_KEYS.has(k)));
}

export interface SectionChange {
  section: SectionName;
  key: string;
  /** 'update' → PUT the section. 'add' → it never existed on this testcase,
   *  so it has to be created (POST) rather than edited. */
  kind: 'update' | 'add';
}

export interface SectionDiff {
  changes: SectionChange[];
  /** The edited name, when it differs from the current one. */
  rename?: string;
  /** Things an in-place edit cannot do, said rather than silently ignored. */
  warnings: string[];
}

/**
 * Compare the testcase as it is on the box with the edited definition.
 *
 * `currentName` is the testcase's name as the box lists it — the settings the
 * box returns may not carry it.
 */
export function diffSections(current: any, edited: any, currentName?: string): SectionDiff {
  const changes: SectionChange[] = [];
  const warnings: string[] = [];
  const cur = current ?? {};
  const next = edited ?? {};

  const editedName = String(next.settings?.test_name ?? next.settings?.testCaseName ?? '').trim();
  const oldName = String(currentName ?? cur.settings?.test_name ?? cur.settings?.testCaseName ?? '').trim();
  const rename = editedName && editedName !== oldName ? editedName : undefined;

  for (const [section, key] of SECTIONS) {
    const had = cur[key] != null;
    const has = next[key] != null;
    if (!has) {
      // Removing a section is not something the box's edit endpoints do.
      if (had && section === 'mobility') {
        warnings.push('mobility was removed from the JSON, but a testcase\'s mobility cannot be deleted by editing — it was left as it is');
      }
      continue;
    }
    if (section === 'settings') {
      const differs = stableJson(withoutName(cur[key])) !== stableJson(withoutName(next[key]));
      if (differs || rename) changes.push({ section, key, kind: had ? 'update' : 'add' });
      continue;
    }
    if (!had) { changes.push({ section, key, kind: 'add' }); continue; }
    if (stableJson(cur[key]) !== stableJson(next[key])) changes.push({ section, key, kind: 'update' });
  }
  return { changes, rename, warnings };
}

// ── Keeping a cell self-consistent after a hand edit ─────────────────────────
//
// A cell's gain arrays are per antenna: rxGain has one entry per DL antenna and
// txGain one per UL antenna (true of every one of 79 cells on .95), and the box
// rejects a mismatch outright — "rxGain array size (4) must match DL antenna
// count (2)". Its own GUI never lets that happen because changing the antenna
// count rewrites the arrays (read from the box's web bundle):
//
//   antennas.dl → rxGain = dl × (O-RU ? 40 : 10); O-RU also ruAntennaConfig
//                 and eAxCIDConfig.dlEAxCIDs.sectionType1 = [0..dl-1]
//   antennas.ul → txGain = ul × (O-RU ? -40 : 80); O-RU also ruAntennaConfig
//                 and ulEAxCIDs = { sectionType1: [0..ul-1], sectionType3: [ul..2ul-1] }
//   a SUL second cell mirrors cell 0's antennas and gains
//
// Editing the JSON by hand skips all of that, so a one-number change of DL 4
// → 2 was refused. This applies the same rules, but keeps the gains the cell
// already had rather than resetting them to defaults.

/** Resize to n entries, keeping what is there and padding with the last value. */
function fitArray(arr: unknown, n: number, fallback: number): number[] {
  const src = Array.isArray(arr) ? arr.map(Number).filter((x) => Number.isFinite(x)) : [];
  const pad = src.length ? src[src.length - 1] : fallback;
  return Array.from({ length: n }, (_, i) => (i < src.length ? src[i] : pad));
}

const range = (from: number, n: number) => Array.from({ length: n }, (_, i) => from + i);

/**
 * Make each cell's per-antenna arrays match its antenna counts, in place.
 * Returns what was changed, for the save result — nothing is changed silently.
 */
export function reconcileCellArrays(cellConfig: any): string[] {
  const notes: string[] = [];
  const cells: any[] = Array.isArray(cellConfig?.cells) ? cellConfig.cells : [];

  cells.forEach((cell, i) => {
    if (!cell || typeof cell !== 'object') return;
    const dl = Number(cell.antennas?.dl);
    const ul = Number(cell.antennas?.ul);
    const oru = cell.oruConfig?.ru?.[0];

    if (Number.isInteger(dl) && dl > 0 && (!Array.isArray(cell.rxGain) || cell.rxGain.length !== dl)) {
      const was = Array.isArray(cell.rxGain) ? cell.rxGain.length : 0;
      cell.rxGain = fitArray(cell.rxGain, dl, oru ? 40 : 10);
      notes.push(`cell ${i}: rxGain resized ${was} → ${dl} to match ${dl} DL antenna${dl === 1 ? '' : 's'}`);
    }
    if (Number.isInteger(ul) && ul > 0 && (!Array.isArray(cell.txGain) || cell.txGain.length !== ul)) {
      const was = Array.isArray(cell.txGain) ? cell.txGain.length : 0;
      cell.txGain = fitArray(cell.txGain, ul, oru ? -40 : 80);
      notes.push(`cell ${i}: txGain resized ${was} → ${ul} to match ${ul} UL antenna${ul === 1 ? '' : 's'}`);
    }

    // O-RU cells carry the antenna counts a second time, plus one eAxC id per antenna.
    if (oru && Number.isInteger(dl) && Number.isInteger(ul) && dl > 0 && ul > 0) {
      const cfg = oru.ruAntennaConfig;
      if (!cfg || cfg.dl !== dl || cfg.ul !== ul) {
        oru.ruAntennaConfig = { ul, dl };
        oru.eAxCIDConfig = oru.eAxCIDConfig ?? {};
        oru.eAxCIDConfig.dlEAxCIDs = { sectionType1: range(0, dl) };
        oru.eAxCIDConfig.ulEAxCIDs = { sectionType1: range(0, ul), sectionType3: range(ul, ul) };
        notes.push(`cell ${i}: O-RU antenna config and eAxC ids set to ${dl} DL / ${ul} UL`);
      }
    }
  });

  // A SUL second cell shares cell 0's radio: same antennas, same gains.
  const [c0, c1] = cells;
  if (c0 && c1 && c1.duplexMode === 'SUL') {
    const before = stableJson([c1.antennas, c1.rxGain, c1.txGain]);
    c1.antennas = { ...(c1.antennas ?? {}), dl: c0.antennas?.dl, ul: c0.antennas?.ul };
    if (Array.isArray(c0.rxGain)) c1.rxGain = [...c0.rxGain];
    if (Array.isArray(c0.txGain)) c1.txGain = [...c0.txGain];
    if (stableJson([c1.antennas, c1.rxGain, c1.txGain]) !== before) notes.push('cell 1 (SUL): antennas and gains copied from cell 0');
  }
  return notes;
}

// ── RF cards belong to a simulator, not to a testcase ────────────────────────
//
// Each simulator on a multi-user box owns its own radio cards — on .95:
// UE-Simulator-1 has 0,1 (simuser), -2 has 2,3 (sruthi), -3 has 4,5 (mohan) —
// and every cell names the card it runs on. So a testcase copied to another
// user still asks for the original's cards, and the box refuses to start it:
// "The test uses sdr2, which is not assigned to this simulator".
//
// The cards are remapped by position: the cells' first distinct card becomes
// the target's first card, the second becomes its second, and so on. Position
// rather than arithmetic because the sets are per simulator and need not be
// contiguous or ordered the same way.

/** Rewrite each cell's rfCard onto `targetCards`, in place. */
export function remapRfCards(cellConfig: any, targetCards: number[]): string[] {
  const cells: any[] = Array.isArray(cellConfig?.cells) ? cellConfig.cells : [];
  const targets = (targetCards ?? []).map(Number).filter((n) => Number.isFinite(n));
  if (!cells.length || !targets.length) return [];

  const used = [...new Set(cells.map((c) => Number(c?.rfCard)).filter((n) => Number.isFinite(n)))].sort((a, b) => a - b);
  if (!used.length) return [];
  // Already on the target's cards — nothing to say, nothing to change.
  if (used.every((c) => targets.includes(c))) return [];

  const map = new Map<number, number>();
  used.forEach((card, i) => {
    // More distinct cards than the target simulator has: the last one is
    // reused rather than leaving a card the simulator does not own.
    map.set(card, targets[Math.min(i, targets.length - 1)]);
  });

  const notes: string[] = [];
  for (const cell of cells) {
    const from = Number(cell?.rfCard);
    if (!Number.isFinite(from)) continue;
    const to = map.get(from);
    if (to === undefined || to === from) continue;
    cell.rfCard = to;
    notes.push(`rfCard ${from} → ${to}`);
  }
  if (used.length > targets.length) {
    notes.push(`the testcase uses ${used.length} radio cards but this simulator has ${targets.length}`);
  }
  return [...new Set(notes)];
}

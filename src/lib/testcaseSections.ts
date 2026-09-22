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

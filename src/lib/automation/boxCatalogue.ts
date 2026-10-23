// Whose test case is it?
//
// The Simnovator does not record an owner on a test case. Measured on 4.1.0
// (192.168.1.102 and .95, 2026-10-23): a row is {id, name, description,
// metadata} and nothing in it names a person, and BOTH admin and a plain user
// are served the same catalogue — 35 rows each on .102, 274 each on .95. So
// "admin sees everyone's test cases" is true in the sense that matters: the
// catalogue IS everyone's, and admin is the login that should be shown it as
// such.
//
// What the box does record is the SIMULATOR each execution ran on, and
// /v2/users says which simulators a login holds. That is the whole of the
// ownership signal, and it is honest about its limits:
//
//   * a test case that has never run belongs to nobody yet;
//   * a simulator held by two logins attributes to both, rather than picking;
//   * a simulator held only by admin (192.168.1.102's Simulator_test) says
//     exactly that, which is how an orphan shows up as an orphan.
//
// Pure, imports nothing, so node --test loads it directly.

export interface CatalogueEntry {
  id: string;
  name: string;
  /** The simulator its last execution ran on, when it has run. */
  simulatorId?: string;
  simulatorName?: string;
  result?: string;
  status?: string;
  executedOn?: string;
  durationSeconds?: number;
  /** Logins holding that simulator. Empty when it has never run. */
  owners: string[];
}

export interface CatalogueCounts {
  total: number;
  neverRun: number;
  /** Test cases per login, by the simulator their last run used. */
  byUser: Array<{ username: string; count: number }>;
  /** Ran on a simulator no login holds — nothing can pick it up again. */
  unowned: number;
}

const str = (v: unknown) => (v === undefined || v === null ? undefined : String(v));

/**
 * Read the box's catalogue into rows that say who each test case belongs to.
 *
 * `users` is readBoxUsers() output; with none, the rows still carry the
 * simulator and simply claim no owner.
 */
export function attributeCatalogue(
  rows: any[],
  users: Array<{ username: string; simulators: Array<{ id: string; name?: string }> }> = [],
): CatalogueEntry[] {
  const byId = new Map<string, string[]>();
  const byName = new Map<string, string[]>();
  for (const u of users) {
    for (const s of u.simulators) {
      if (s.id) byId.set(s.id, [...(byId.get(s.id) ?? []), u.username]);
      if (s.name) byName.set(s.name, [...(byName.get(s.name) ?? []), u.username]);
    }
  }

  const out = new Map<string, CatalogueEntry>();
  for (const t of rows ?? []) {
    const id = str(t?.id);
    if (!id) continue;
    const le = t?.metadata?.lastExecution ?? {};
    const simId = str(le.simulatorId);
    const simName = str(le.simulatorName);
    const entry: CatalogueEntry = {
      id,
      name: String(t?.name ?? ''),
      simulatorId: simId,
      simulatorName: simName,
      result: str(le.result),
      status: str(le.status),
      executedOn: str(le.executedOn),
      durationSeconds: typeof le.durationSeconds === 'number' ? le.durationSeconds : undefined,
      owners: (simId ? byId.get(simId) : undefined) ?? (simName ? byName.get(simName) : undefined) ?? [],
    };
    // The box returns one row per simulator a test case has run on. Keep the
    // newest, the same rule the single-testcase read follows.
    const had = out.get(id);
    const when = (e?: CatalogueEntry) => (e?.executedOn ? Date.parse(e.executedOn) : 0);
    if (!had || when(entry) > when(had)) out.set(id, entry);
  }
  return [...out.values()].sort((a, b) => (b.executedOn ?? '').localeCompare(a.executedOn ?? '')
    || a.name.localeCompare(b.name));
}

export function catalogueCounts(entries: CatalogueEntry[]): CatalogueCounts {
  const byUser = new Map<string, number>();
  let neverRun = 0;
  let unowned = 0;
  for (const e of entries) {
    if (!e.executedOn && !e.simulatorName && !e.simulatorId) { neverRun += 1; continue; }
    if (e.owners.length === 0) { unowned += 1; continue; }
    for (const u of e.owners) byUser.set(u, (byUser.get(u) ?? 0) + 1);
  }
  return {
    total: entries.length,
    neverRun,
    unowned,
    byUser: [...byUser.entries()]
      .map(([username, count]) => ({ username, count }))
      .sort((a, b) => b.count - a.count || a.username.localeCompare(b.username)),
  };
}

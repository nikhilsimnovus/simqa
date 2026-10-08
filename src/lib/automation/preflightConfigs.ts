// Can this row run here, from what the server holds?
//
// A suite is meant to be a portable package: everything a row needs lives in
// /root/automation_configs/<suite>/<row>/, and a run on any Simnovator takes
// the test case from test.json and gives the callbox the row's enb/mme/ims
// (plus whatever the MME includes) under the names the row picked. The boxes
// are not expected to hold anything in advance.
//
// This decides, BEFORE any box is touched, whether that is actually true for
// each row — so an operator gets one list naming the rows and files rather
// than discovering them one failed row at a time, several minutes apart, as
// "no UEs attached" from a core that never started.
//
// What counts as satisfied, per file:
//   • the server folder has it                      — the portable case
//   • the suite carries it as an upload             — same thing, not yet synced
//   • the target callbox already has that filename  — nothing to provide
//
// The last one is why this is not simply "is the folder complete": a suite
// built and run on one setup has always worked off the callbox's own files,
// and refusing those would break every existing suite to satisfy a rule about
// portability they never needed.
//
// Pure, imports nothing, so node --test can load it directly.

export interface RowNeeds {
  /** Display name — what the operator sees, and the folder name. */
  name: string;
  callboxCfg?: string;
  mmeCfg?: string;
  imsCfg?: string;
  /** Subscriber database override, and the ots.cfg to bind. Both optional, and
   *  both have to be providable from somewhere before the row can run — the
   *  same question as the other three, asked of the two slots that were only
   *  reported before they could be chosen. */
  dbCfg?: string;
  otsCfg?: string;
}

export interface RowCheck {
  row: string;
  /** Human-ready lines: what is missing and what it was wanted for. */
  missing: string[];
}

export interface PreflightInput {
  rows: RowNeeds[];
  /** Files present in each row's server folder, keyed by row name. */
  folder: Record<string, Record<string, string>>;
  /** Names the suite carries as uploads. */
  uploads?: Set<string>;
  /** Filenames on the target callbox: /root/enb/config and /root/mme/config. */
  onCallboxRadio?: Set<string>;
  onCallboxCore?: Set<string>;
  /** Filenames in /root/ots/config, for a row that binds its own ots.cfg. */
  onCallboxOts?: Set<string>;
  /** False for a uesim-only run: no callbox, so no cfg files are needed. */
  withCallbox: boolean;
}

/** Everything an MME config pulls in by name — subscriber DBs and fragments.
 *  The core will not start with one of them missing. */
export function includesOf(mmeCfgText: string): string[] {
  const out: string[] = [];
  for (const line of (mmeCfgText ?? '').split(String.fromCharCode(10))) {
    const m = /^\s*include\s+"([^"]+)"/.exec(line);
    if (m) out.push(m[1].split('/').pop() as string);
  }
  return [...new Set(out)];
}

export function preflightRows(input: PreflightInput): RowCheck[] {
  const uploads = input.uploads ?? new Set<string>();
  const radio = input.onCallboxRadio ?? new Set<string>();
  const core = input.onCallboxCore ?? new Set<string>();
  const out: RowCheck[] = [];

  for (const row of input.rows) {
    const have = input.folder[row.name] ?? {};
    const missing: string[] = [];

    const check = (picked: string | undefined, roleFile: string, where: Set<string>) => {
      if (!picked) return;
      if (have[roleFile]) return;                 // the server has it
      if (uploads.has(picked)) return;            // the suite carries it
      if (where.has(picked)) return;              // the callbox already has it
      missing.push(`${roleFile} ("${picked}")`);
    };

    if (input.withCallbox) {
      check(row.callboxCfg, 'enb.cfg', radio);
      check(row.mmeCfg, 'mme.cfg', core);
      check(row.imsCfg, 'ims.cfg', core);
      // The DB is kept in the row's folder under its OWN name, because that is
      // the name the MME config includes it by — the same way every other
      // include is saved. ots.cfg is kept under the role name, like the three
      // above, whatever the file on the box is called.
      check(row.dbCfg, row.dbCfg ?? 'db', core);
      check(row.otsCfg, 'ots.cfg', input.onCallboxOts ?? new Set<string>());

      // What the row's own MME config includes — the subscriber DB and any
      // fragments. Only checkable when the server holds the mme.cfg; when it
      // does, every include must be in the folder or already on the box.
      for (const inc of includesOf(have['mme.cfg'] ?? '')) {
        if (have[inc] || core.has(inc)) continue;
        missing.push(`${inc} (included by mme.cfg)`);
      }
    }

    if (missing.length) out.push({ row: row.name, missing });
  }
  return out;
}

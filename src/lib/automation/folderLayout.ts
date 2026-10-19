// What a row's folder is CALLED, file by file.
//
// /root/automation_configs/<suite>/<row>/ used to keep every config under its
// role name — enb.cfg, mme.cfg, ims.cfg, ots.cfg — whatever the operator had
// actually picked or uploaded. So a suite built on "SA-1Cell.cfg_June2026"
// showed a folder holding "enb.cfg", and an upload the operator had named
// themselves lost that name the moment it was saved. Two files, two names,
// and no way to tell from the folder which config a row runs.
//
// The callbox has never worked that way. /root/enb/config holds the real file
// under its own name and enb.cfg is a symlink at it, which is how operators
// write it by hand and how it reads in a terminal:
//
//     enb.cfg -> SA-1Cell.cfg_June2026
//
// The folder now mirrors that. The real file keeps the name it was picked or
// uploaded under, and the role name is a link to it — so one name shows, it
// is the operator's own, and `ls -la` answers "what does this row run" the
// same way on the automation server as on the callbox.
//
// Pure, imports nothing, so node --test can load it directly.

/** The four slots whose role name becomes a link. The subscriber database is
 *  not one: there is no `db.cfg` convention on a callbox — an MME config names
 *  its database in an `include` line — so it has only ever had its own name. */
export const LINKED_ROLES = ['enb.cfg', 'mme.cfg', 'ims.cfg', 'ots.cfg'] as const;
export type LinkedRole = typeof LINKED_ROLES[number];

export interface FolderPlan {
  /** Name on disk → contents. The real files, under the names they keep. */
  files: Record<string, string>;
  /** Role name → the file it links to. Only roles whose pick differs. */
  links: Record<string, string>;
  /** Why a role did NOT get its own name, when that is worth saying. */
  notes: string[];
}

/** One path component, no dot-files, nothing that climbs out of the folder.
 *  These names come from a config file and from an upload, so neither is
 *  trusted to be a bare filename. */
function isPlainName(name: string | undefined): name is string {
  if (!name) return false;
  if (name !== name.trim() || name === '' || name.startsWith('.')) return false;
  return !/[\\/]/.test(name) && name !== '.' && name !== '..';
}

/**
 * Decide what to write and what to link.
 *
 * `roleText` is the content of each slot, keyed by its role name — which is
 * how every reader here has always gathered it. `picks` says what the row
 * chose for each slot. `extra` is everything that already has its own name:
 * test.json, the subscriber database, the MME's other includes.
 *
 * A pick is only honoured when it is a safe single filename that no other
 * slot in this row has already claimed for different content. Anything else
 * falls back to the old behaviour — the role name, written plainly — because
 * a row that saves under a surprising name is worse than one that saves under
 * a dull one, and the note says which happened.
 */
export function planFolderLayout(
  roleText: Record<string, string | undefined>,
  picks: Record<string, string | undefined>,
  extra: Record<string, string | undefined> = {},
): FolderPlan {
  const files: Record<string, string> = {};
  const links: Record<string, string> = {};
  const notes: string[] = [];

  // Names already spoken for, so a second slot cannot overwrite the first.
  const claimed = new Map<string, string>();        // filename → role that took it

  for (const role of LINKED_ROLES) {
    const text = roleText[role];
    if (typeof text !== 'string') continue;         // this slot has no content
    const pick = picks[role];

    const plain = () => { files[role] = text; };

    if (!isPlainName(pick)) { plain(); continue; }  // nothing picked, or not a filename
    if (pick === role) { plain(); continue; }       // picked file IS the role name
    // Picking a file literally called another slot's role name would make
    // enb.cfg a link to mme.cfg. Keep the role name instead.
    if ((LINKED_ROLES as readonly string[]).includes(pick)) {
      plain();
      notes.push(`${role} kept its own name — "${pick}" is a role name, not a config to link at`);
      continue;
    }
    // Another slot already wrote this name. Same content is fine — two slots
    // genuinely sharing a file — but different content is not.
    const owner = claimed.get(pick);
    if (owner !== undefined && files[pick] !== text) {
      plain();
      notes.push(`${role} kept its own name — ${owner} already saved a different "${pick}"`);
      continue;
    }
    // An include or the database already uses this name for other content.
    if (extra[pick] !== undefined && extra[pick] !== text) {
      plain();
      notes.push(`${role} kept its own name — "${pick}" is already an included file here`);
      continue;
    }

    files[pick] = text;
    links[role] = pick;
    claimed.set(pick, role);
  }

  for (const [name, text] of Object.entries(extra)) {
    if (typeof text !== 'string') continue;
    if (!isPlainName(name)) continue;
    // A slot's real file wins: it is the same content under the same name.
    if (files[name] !== undefined) continue;
    files[name] = text;
  }

  return { files, links, notes };
}

/**
 * The names a row's folder should hold, given what it picked.
 *
 * Used by the checks that ask "is this row saved" — they looked for the role
 * name, which is now a link and may be absent on a filesystem that could not
 * make one. Either name counts.
 */
export function namesFor(role: LinkedRole, pick: string | undefined): string[] {
  return isPlainName(pick) && pick !== role ? [pick, role] : [role];
}

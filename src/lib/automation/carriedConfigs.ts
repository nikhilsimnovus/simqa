// The config files a suite CARRIES, and the names the server folder keeps
// them under.
//
// /root/automation_configs/<suite>/<row>/ is what lets a row run on a box that
// has never held its configs: the runner pushes what is there and symlinks it.
// Those files are normally captured FROM the callbox, by name — which cannot
// see a file the operator uploaded instead of picking, because that file is on
// no box yet, and it is exactly the one the row is going to run.
//
// So the uploads are written too, and they win over anything the box happens
// to have under the same name: the upload is the row's choice, and the runner
// pushes it over the box's copy anyway.
//
// Pure, imports nothing — the suite and row are taken structurally so
// node --test can load this directly.

/** Just the part of a suite this needs: the blobs, base64 as stored. */
export interface CarriesConfigs {
  uploadedConfigs?: Record<string, string>;
}

/** Just the part of a row this needs: which file each slot picked. */
export interface PicksConfigs {
  callboxCfg?: string;
  mmeCfg?: string;
  imsCfg?: string;
  dbCfg?: string;
  otsCfg?: string;
}

/**
 * What to write into this row's folder from the suite's own uploads.
 *
 * Keyed by the folder's name for each file: the role name for the four
 * symlink slots, and its OWN name for the subscriber database — that is the
 * name the MME config includes it by, and the name it has to exist under on
 * the callbox for the core to start. Calling it "db" hid which file it was.
 */
export function carriedConfigs(suite: CarriesConfigs, row: PicksConfigs): Record<string, string> {
  const out: Record<string, string> = {};
  const text = (name?: string): string | undefined => {
    const b64 = name ? suite?.uploadedConfigs?.[name] : undefined;
    return b64 === undefined ? undefined : Buffer.from(b64, 'base64').toString('utf8');
  };
  for (const [role, picked] of [
    ['enb.cfg', row.callboxCfg],
    ['mme.cfg', row.mmeCfg],
    ['ims.cfg', row.imsCfg],
    ['ots.cfg', row.otsCfg],
  ] as const) {
    const t = text(picked);
    if (t !== undefined) out[role] = t;
  }
  const db = text(row.dbCfg);
  if (db !== undefined && row.dbCfg) out[row.dbCfg] = db;
  return out;
}

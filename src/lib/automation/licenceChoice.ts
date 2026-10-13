// Which licence a run writes into the callbox configs, and what it remembers.
//
// Two values are entered, ENB and MME, and they land in three files:
//
//   ENB  -> enb.cfg (or gnb.cfg)
//   MME  -> mme.cfg AND ims.cfg
//
// mme and ims share the core licence on the real boxes — User_Plane's
// Mohan_mme.cfg and Mohan_ims.cfg both ask for `rnd-mme` — so one MME value
// covering both is what an operator means by "the MME licence". (demo-mme.cfg
// carries an empty tag while demo-ims.cfg asks for mme-oran, which is an
// inconsistency in the files rather than a third thing to choose.)
//
// The values are remembered per SUITE AND PER CALLBOX. A suite built against
// one setup gets executed against another, and the licence that makes it work
// belongs to the callbox, not to the suite: remembering one tag per suite
// would hand a suite moved from .106 to .107 the licence of the box it is no
// longer running on.
//
// Entered beats remembered, remembered beats leaving the config alone. A run
// where the operator changes nothing reuses what the last run used, which is
// the point — the dialog shows it, they press Run.
//
// Pure, imports nothing, so node --test loads it directly.

/** What gets written, by config role. Absent = leave that config's tag alone. */
export interface LicenceChoice {
  enb?: string;
  mme?: string;
  ims?: string;
}

/** What is remembered for one callbox. Only the two values an operator enters
 *  are stored; `ims` is derived, never stored, so it cannot drift from `mme`. */
export interface SavedLicences {
  enb?: string;
  mme?: string;
  /** When this was last chosen, for the "saved from the last run" line. */
  updatedAt?: string;
}

/**
 * A licence tag is one short word: the lab's are rnd-enb, oran-enb, oru-enb,
 * rnd-mme, mme-oran, oru-mme.
 *
 * Anything else is dropped rather than written into a config and sent to
 * hardware. An empty string is not a tag — but note that a config legitimately
 * CARRYING an empty tag is a different matter, which licenceTagOf reports as
 * '' and this never produces.
 */
export function cleanTag(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const tag = v.trim();
  return tag && /^[A-Za-z0-9._-]{1,64}$/.test(tag) ? tag : undefined;
}

/** The key the suite remembers a callbox's licences under.
 *
 *  Keyed by host, not by system id, because the host is what the licence
 *  server sees and what survives an inventory entry being recreated. */
export function licenceKeyFor(callboxHost: string | undefined): string {
  const host = (callboxHost ?? '').trim();
  return host ? `callbox:${host}` : 'callbox:unknown';
}

/** Validate a submitted {enb, mme} pair, dropping anything malformed. */
export function enteredLicences(raw: unknown): SavedLicences {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const out: SavedLicences = {};
  const enb = cleanTag(r.enb);
  const mme = cleanTag(r.mme);
  if (enb) out.enb = enb;
  if (mme) out.mme = mme;
  return out;
}

/**
 * What this run should write: whatever was just entered, else what the last
 * run against this callbox used.
 *
 * `ims` is always the MME value — see the file header.
 */
export function effectiveLicences(
  saved: SavedLicences | undefined,
  entered: SavedLicences | undefined,
): LicenceChoice {
  // Both sides are re-validated here rather than trusted. These values reach
  // a config file on hardware, and a stored suite is as capable of holding
  // something malformed as a request body is.
  const enb = cleanTag(entered?.enb) ?? cleanTag(saved?.enb);
  const mme = cleanTag(entered?.mme) ?? cleanTag(saved?.mme);
  const out: LicenceChoice = {};
  if (enb) out.enb = enb;
  if (mme) { out.mme = mme; out.ims = mme; }
  return out;
}

/**
 * What to remember after this run, or undefined when there is nothing new to
 * remember.
 *
 * Returning undefined for an unchanged choice keeps a run from rewriting the
 * suite — and from moving `updatedAt`, which would claim the operator chose
 * something they merely accepted.
 */
export function licencesToSave(
  saved: SavedLicences | undefined,
  entered: SavedLicences | undefined,
  now: string,
): SavedLicences | undefined {
  const next: SavedLicences = {};
  const wasEnb = cleanTag(saved?.enb);
  const wasMme = cleanTag(saved?.mme);
  const enb = cleanTag(entered?.enb) ?? wasEnb;
  const mme = cleanTag(entered?.mme) ?? wasMme;
  if (enb) next.enb = enb;
  if (mme) next.mme = mme;
  if (!next.enb && !next.mme) return undefined;
  if (next.enb === wasEnb && next.mme === wasMme) return undefined;
  next.updatedAt = now;
  return next;
}

/** The tag a given config role should be given, or undefined to leave it. */
export function tagForRole(choice: LicenceChoice | undefined, role: string | undefined): string | undefined {
  if (!choice || !role) return undefined;
  if (role === 'enb' || role === 'gnb') return choice.enb;
  if (role === 'mme') return choice.mme;
  if (role === 'ims') return choice.ims;
  return undefined;
}

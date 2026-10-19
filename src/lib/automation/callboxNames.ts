// What a row's config is called ON THE CALLBOX.
//
// A run used to push the row's config to /root/enb/config or /root/mme/config
// under the lab's own filename — Mohan_mme.cfg, SA-1cell.cfg — overwriting a
// file other setups share. So running a suite silently rewrote configs that
// nothing in the suite owned, and the only way to find out was that somebody
// else's test started behaving differently.
//
// The copy a run deploys now carries "_automation" in its name:
//
//   /root/automation_configs/Subscriber/<row>/Mohan_mme.cfg   the row's own,
//                                                             keeps its name
//   /root/mme/config/Mohan_mme_automation.cfg                 what the run
//                                                             pushes
//   /root/mme/config/mme.cfg -> Mohan_mme_automation.cfg      what runs
//
// So SimQA only ever writes files it owns, the lab's originals are left
// alone, and a stale copy from a previous run can be deleted before this one
// without risking anything of anybody's.
//
// Idempotent on purpose: a re-run must not produce
// Mohan_mme_automation_automation.cfg, and after that
// _automation_automation_automation. The name is stable across every run of
// the same row, which is what lets the stale copy be found and replaced.
//
// Pure, imports nothing, so node --test can load this directly.

/** The marker appended to every file a run deploys. */
export const AUTOMATION_SUFFIX = '_automation';

/** One path component, nothing that climbs out of a directory. The names
 *  here come from config files and from uploads, so neither is trusted. */
function isPlainName(name: string): boolean {
  if (name !== name.trim() || name === '' || name.startsWith('.')) return false;
  return !/[\\/]/.test(name) && name !== '.' && name !== '..';
}

/**
 * The name this file is deployed under.
 *
 * The suffix goes before the extension, because the callbox and the operators
 * reading its directories both go by extension: Mohan_mme.cfg becomes
 * Mohan_mme_automation.cfg, not Mohan_mme.cfg_automation.
 *
 * A name that already carries the suffix is returned unchanged, so this can
 * be applied to a name that has been through it before without the name
 * growing a word per run.
 *
 * A name that is not a plain filename is returned unchanged: the caller
 * refuses it elsewhere, and quietly inventing a different path here would be
 * worse than passing it through to be rejected.
 */
export function automationName(file: string): string {
  const name = (file ?? '').trim();
  if (!isPlainName(name)) return file;

  const dot = name.lastIndexOf('.');
  // A leading dot is a hidden file, not an extension — and isPlainName has
  // already refused those, so dot > 0 here means a real extension.
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';

  if (stem.endsWith(AUTOMATION_SUFFIX)) return name;
  return `${stem}${AUTOMATION_SUFFIX}${ext}`;
}

/** True when this is a name a run deployed, and so a file SimQA may delete.
 *  Nothing without the marker is ever removed from a callbox. */
export function isAutomationName(file: string): boolean {
  const name = (file ?? '').trim();
  if (!isPlainName(name)) return false;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return stem.endsWith(AUTOMATION_SUFFIX);
}

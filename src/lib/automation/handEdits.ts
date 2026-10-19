// A file edited by hand in /root/automation_configs stays edited.
//
// The folder is meant to be the thing a row runs: the runner builds the test
// case from <row>/test.json and gives the callbox the configs next to it. But
// every save, and every run, re-synced that folder FROM the app and the boxes
// — test.json from the Simnovator or the suite's stored upload, the cfgs from
// the callbox — so opening test.json in vi, fixing it and pressing Run gave
// you the unedited version back. The folder looked like the source of truth
// and behaved like a cache.
//
// So SimQA now remembers the hash of what IT wrote, file by file. On the next
// sync a file whose contents still match is refreshed as before; one that has
// changed underneath was changed by a person, and a person's edit outranks a
// re-sync. It is left exactly as it is, and the row says so.
//
// A kept file stays the operator's until it is deleted. That is deliberate:
// "my edit survived once" and "my edit survives every run from now on" are
// different promises, and only the second is any use for a config you are
// iterating on. Deleting the file hands it back to SimQA, which rewrites it
// on the next sync.
//
// Pure, imports nothing — the hash is passed in — so node --test can load
// this directly.

/** File name → hash of the contents SimQA last wrote there. */
export type WrittenHashes = Record<string, string>;

export interface KeepResult {
  /** What to actually write: the incoming set, minus what a person edited. */
  files: Record<string, string | undefined>;
  /** Names left alone, because the copy on disk is not the one SimQA wrote. */
  kept: string[];
  /** One line per kept file, for the row's detail. */
  notes: string[];
}

/**
 * Drop from `incoming` anything that has been edited on disk.
 *
 * `written` is the manifest from the last sync. A file with no entry in it is
 * refreshed: either SimQA has never written it, or the folder predates the
 * manifest, and in both cases overwriting is the behaviour that has always
 * applied. The manifest is filled in on that same pass, so a folder is
 * protected from the first sync after this ships onwards.
 */
export function keepHandEdits(
  incoming: Record<string, string | undefined>,
  onDisk: Record<string, string>,
  written: WrittenHashes,
  hash: (text: string) => string,
): KeepResult {
  const files: Record<string, string | undefined> = {};
  const kept: string[] = [];
  const notes: string[] = [];

  for (const [name, text] of Object.entries(incoming)) {
    if (text === undefined) continue;
    const have = onDisk[name];
    if (have === undefined) { files[name] = text; continue; }     // not there yet
    const mine = written[name];
    if (mine === undefined) { files[name] = text; continue; }     // never recorded — refresh
    if (hash(have) === mine) { files[name] = text; continue; }    // untouched since SimQA wrote it
    // Changed underneath. Writing over it would throw away someone's work,
    // and silently: the run would then use a config nobody had seen.
    if (have === text) continue;             // edited INTO what we were going to write anyway
    kept.push(name);
    notes.push(`${name} was edited in the folder — keeping your version, not the one from the box`);
  }
  return { files, kept, notes };
}

/**
 * The manifest to save after writing.
 *
 * Files SimQA wrote get the hash of what it wrote. A kept file keeps its OLD
 * entry, so it still reads as edited next time — otherwise recording the
 * hand-edited contents as SimQA's own would hand control straight back and
 * the next sync would overwrite them.
 *
 * Entries for files that are no longer in the folder are dropped, so a row
 * whose config was deleted starts clean rather than carrying a hash for
 * something that is not there.
 */
export function nextManifest(
  previous: WrittenHashes,
  wrote: Record<string, string | undefined>,
  onDiskNames: string[],
  hash: (text: string) => string,
): WrittenHashes {
  const out: WrittenHashes = {};
  const present = new Set(onDiskNames);
  for (const [name, h] of Object.entries(previous)) {
    if (present.has(name)) out[name] = h;
  }
  for (const [name, text] of Object.entries(wrote)) {
    if (typeof text === 'string') out[name] = hash(text);
  }
  return out;
}

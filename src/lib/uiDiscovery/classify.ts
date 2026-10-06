// Naming and risk, decided from labels alone.
//
// Discovery runs against live lab hardware that other people are using, so
// the most important decision here is which controls may be operated. A
// crawler that clicks everything it finds will eventually delete somebody's
// test case, stop a running execution or reboot a callbox — and it will do it
// with nobody watching. The policy is therefore conservative and decided by
// label:
//
//   mutate — Delete, Save, Start, Stop, Install, Reboot, Reset, Apply,
//            Upload, Enable/Disable, Logout. NEVER operated. The checks
//            establish that the control is there, labelled and in the
//            expected enabled state, which is what a UI regression breaks.
//   open   — Add, New, Create, Edit, Configure, Details. Opened and then
//            cancelled: an open form has committed nothing, and opening it is
//            the only way to see the fields inside.
//   read   — everything else: tabs, search, filters, sort, pagination.
//
// Anything ambiguous is pushed up to 'mutate' rather than down. A check that
// reports "present, not exercised" is a small loss; clicking Reboot is not.
//
// Pure, no imports, so node --test loads it directly.

const MUTATE = [
  'delete', 'remove', 'destroy', 'erase', 'purge', 'clear',
  'save', 'apply', 'submit', 'confirm', 'ok',
  'start', 'run', 'execute', 'launch', 'stop', 'abort', 'kill', 'terminate',
  'restart', 'reboot', 'shutdown', 'power',
  'install', 'uninstall', 'upgrade', 'update', 'patch', 'flash',
  'upload', 'import', 'restore',
  'enable', 'disable', 'activate', 'deactivate',
  'reset', 'revert', 'rollback',
  'logout', 'log out', 'sign out',
];

const OPEN = [
  'add', 'new', 'create', 'edit', 'modify', 'configure', 'config',
  'settings', 'details', 'view', 'manage', 'open', 'select',
];

/** Collapse whitespace and strip the decorations SPA controls carry (icons,
 *  counts, trailing punctuation) so the same control keeps its name across
 *  discoveries even when a badge beside it changes. */
export function normaliseLabel(raw: string): string {
  return (raw ?? '')
    .replace(/[ -⁯←-⯿︀-️]/g, ' ')
    .replace(/[\u{1f000}-\u{1ffff}]/gu, ' ')
    .replace(/\((\d+)\)\s*$/, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s:*•·-]+/, '')
    .replace(/[\s:*•·-]+$/, '')
    .trim();
}

/** Breadcrumb to stable node id. Two builds that keep a page keep its id, so
 *  a diff can tell "renamed" from "added and removed". */
export function slugOf(path: string[]): string {
  return path
    .map(p => normaliseLabel(p).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').replace(/-+$/, ''))
    .filter(Boolean)
    .join('/');
}

/** What operating this control would do. Matched on whole words, so
 *  "Readdress" is not "add" and "Updates" is "update". */
export function riskOf(label: string, kind?: string): 'read' | 'open' | 'mutate' {
  const l = normaliseLabel(label).toLowerCase();
  // An unlabelled button is an unknown action, so it is untouchable. An
  // unlabelled field is just a field.
  if (!l) return kind === 'button' ? 'mutate' : 'read';
  const words = l.split(/[^a-z]+/).filter(Boolean);
  const hasWord = (needle: string) => {
    if (needle.includes(' ')) return l.includes(needle);
    return words.includes(needle) || words.includes(needle + 's') || words.includes(needle + 'd');
  };
  for (const m of MUTATE) if (hasWord(m)) return 'mutate';
  for (const o of OPEN) if (hasWord(o)) return 'open';
  return 'read';
}

/** Stable identity for an element inside its page: what it is plus what it is
 *  called. Collisions (three unlabelled inputs) are broken by the ordinal the
 *  caller passes, which is why a renamed field reads as one add and one
 *  remove rather than silently matching something else. */
export function elementKey(kind: string, label: string, ordinal: number): string {
  const name = normaliseLabel(label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').replace(/-+$/, '');
  return name ? kind + ':' + name : kind + ':#' + ordinal;
}

/** Is this text the page's own empty state rather than data? Tells "the table
 *  is empty because there is nothing" from "the table is broken". */
export function looksLikeEmptyState(text: string): boolean {
  return /no\s+(data|records?|results?|rows?|items?|entries)|nothing\s+to\s+show|empty|not\s+found/i.test(text ?? '');
}

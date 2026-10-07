// Role-based access, judged by comparing what two logins are shown.
//
// Discovery already answers "what is this account's UI" for each login on a
// box. Set two of those side by side and the interesting question appears on
// its own: admin's map has a Users page, simuser's does not — so is that page
// hidden from simuser, or merely unlinked while the box still serves it to
// anyone who types the URL?
//
// That second case is the one worth catching. A page that is absent from the
// navigation but served on request is not access control; it is a menu.
//
// Honesty matters more here than anywhere else in this module, because the
// claim is a security claim. A page missing from a login's map can mean two
// things — the account cannot reach it, or the crawl of that account ran out
// of budget before it did — so a check that cannot tell them apart must not
// assert the first. The wording below says exactly what was observed and
// names the other reading, and the check only exists when the comparison has
// something solid to stand on.
//
// Pure: types only.

import type { GeneratedCheck, UiMap } from './types.ts';

export interface AccessCandidate {
  /** The login whose UI contains this page. */
  heldBy: string;
  nodeId: string;
  page: string;
  url: string;
}

/** Pages another login's UI has that this one's does not, and that can be
 *  reached by URL — the only ones that can be asked for directly. */
export function pagesOnlyOthersHave(mine: UiMap, others: Array<{ username: string; map: UiMap }>): AccessCandidate[] {
  // Identity here is the URL, not the breadcrumb: what is being asked is
  // "will the box serve this address to this account". Matching on the
  // breadcrumb instead hid admin's Tools page behind simuser's dashboard,
  // because both are called Home.
  const ownUrls = new Set<string>();
  for (const n of mine.nodes) {
    if (n.url) ownUrls.add(n.url.replace(/\/$/, ''));
    if (n.reach.via === 'url') ownUrls.add(n.reach.url.replace(/\/$/, ''));
  }
  const seen = new Set<string>();
  const out: AccessCandidate[] = [];

  for (const other of others) {
    if (other.username === mine.username) continue;
    for (const n of other.map.nodes) {
      if (n.unreachable) continue;
      if (n.reach.via !== 'url') continue;           // only a URL can be asked for
      const url = n.reach.url;
      if (!url || ownUrls.has(url.replace(/\/$/, ''))) continue;   // this login reaches it too
      // A dialog or panel is not a page; it has no URL of its own to request.
      if (n.kind === 'section') continue;
      if (seen.has(url)) continue;
      seen.add(url);
      out.push({ heldBy: other.username, nodeId: n.id, page: n.path.join(' → '), url });
    }
  }
  return out;
}

export function accessChecks(mine: UiMap, others: Array<{ username: string; map: UiMap }>): GeneratedCheck[] {
  const me = mine.username ?? 'this login';
  return pagesOnlyOthersHave(mine, others).map(a => ({
    id: `access::${a.nodeId}`,
    kind: 'access-not-offered' as const,
    severity: 'normal' as const,
    section: 'Access',
    page: a.page,
    nodeId: `access::${a.nodeId}`,
    element: a.heldBy,
    test: `Ask for ${a.page} as ${me} — a page ${a.heldBy}'s UI offers and ${me}'s does not`,
    expected: `the box refuses it or sends ${me} elsewhere; serving the page to an account whose own UI never offers it means the menu is the only thing keeping anyone out`,
    target: { url: a.url },
  }));
}

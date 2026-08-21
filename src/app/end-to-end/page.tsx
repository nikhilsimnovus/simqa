// /end-to-end — retired 2026-08-21, now a redirect.
//
// This page used to host two tabs:
//   • "Topology Setups" — a second editor for inventory.yaml's profiles[],
//     which contradicted the one on /inventory (this screen required
//     `simnovator`, that one required `uesim`, and neither showed all the
//     roles). Same data, two incompatible ideas of valid. It has been merged
//     into /inventory?tab=topology, with the rules living once in
//     lib/topology.ts.
//   • "Run & validate" — already promoted to its own page at /run-validate,
//     which renders the same RunValidateTab component. Nothing was lost.
//
// The /api/end-to-end/* routes are the RUNNER behind Run & Validate and are
// untouched — only this UI shell went away. Kept as a redirect rather than
// deleted so old bookmarks and links still land somewhere useful.

import { redirect } from 'next/navigation';

export default function EndToEndPage(): never {
  redirect('/inventory?tab=topology');
}

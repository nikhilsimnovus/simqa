// /end-to-end retired 2026-08-24.
//
// It held two tabs: "Test setups" (an inventory.yaml `profiles` editor) and
// "Run & validate" (RunValidateTab). Both were duplicates of functionality
// that now lives elsewhere:
//   - Run & validate  → promoted to its own page at /run-validate.
//   - Test setups     → Systems Management's Topology Setup section edits the
//                        SAME `profiles` array, with a superset of roles (it
//                        also offers eNB/gNB, which this page never did).
//
// Nothing unique was lost, so rather than a bare 404 for anyone with an old
// bookmark or muscle-memoried URL, this redirects to where the same data is
// now edited.

import { redirect } from 'next/navigation';

export default function EndToEndRedirect() {
  redirect('/inventory#topology');
}

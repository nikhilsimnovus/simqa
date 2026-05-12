'use client';

// /run-validate — top-level Run & Validate page.
//
// This is the primary execution surface for customer-style installs where
// the testcase already lives on the Simnovator box and you just want to:
//   trigger → poll → get stats → get verdict → done.
//
// Was previously buried as the second tab on /end-to-end. Promoted here so
// it's discoverable as the default "run a testcase" path. Topology Setups
// (the OLD primary tab on /end-to-end) is only useful when you also want
// to generate cfgs locally and SSH-push them to a distributed lab — that
// stays at /end-to-end for now and is marked "advanced" in the sidebar.
//
// The actual implementation is the existing RunValidateTab component —
// no duplication, just relocated.

import { Header } from '@/components/Header';
import { RunValidateTab } from '../end-to-end/RunValidateTab';

export default function RunValidatePage() {
  return (
    <>
      <Header
        title="Run & Validate"
        subtitle="Execute a testcase end-to-end and report every check that passed or failed — no topology required, REST-driven"
      />
      <RunValidateTab />
    </>
  );
}

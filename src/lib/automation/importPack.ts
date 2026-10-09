// What counts as a test case file you can upload, and what to send the box.
//
// People drop in whatever the Simnovator gave them. The box's Export button
// produces the pack:
//
//   { test_case_details: [ { Test_Id, Test_Name, Config_File: { config }, … } ] }
//
// …but a file saved from GET /v2/testcases/{id} is a single object, and
// someone will paste a list of them. The first is what the import endpoint
// wants; the others are the same thing differently wrapped, so they are
// wrapped rather than refused. Anything else is named for what it is not.
//
// Pure, imports nothing, so node --test can load it directly.

export interface ImportPack {
  pack?: { test_case_details: any[] };
  error?: string;
  /** The names in the file, for the message when the box does not echo them. */
  names: string[];
}

export function toImportPack(raw: unknown): ImportPack {
  if (!raw || typeof raw !== 'object') return { error: 'the file is not a JSON object', names: [] };
  const any = raw as any;

  // Already the export pack.
  if (Array.isArray(any.test_case_details)) {
    if (!any.test_case_details.length) return { error: 'the file has an empty test_case_details list', names: [] };
    const names = any.test_case_details.map((d: any) => String(d?.Test_Name ?? '')).filter(Boolean);
    return { pack: any, names };
  }

  // A single detail object, or a list of them.
  const list = Array.isArray(any) ? any : [any];
  if (list.length > 0 && list.every((d) => d && typeof d === 'object' && ('Test_Name' in d || 'Config_File' in d))) {
    const names = list.map((d: any) => String(d?.Test_Name ?? '')).filter(Boolean);
    return { pack: { test_case_details: list }, names };
  }

  return {
    error: 'this does not look like a Simnovator testcase export — expected test_case_details, '
      + "which is what the box's Export button produces",
    names: [],
  };
}

/**
 * The test DEFINITION inside an uploaded file, and what it is called.
 *
 * An uploaded test case is not put on a Simnovator when you choose the file —
 * it is kept with the suite, written into the row's folder under
 * /root/automation_configs as test.json, and created on whichever box the
 * suite runs on, under the row's display name, at execution time. That is how
 * the enb/mme/ims files already work, and it is the only way one file can run
 * on any box as any user.
 *
 * Three shapes arrive in practice:
 *   • the box's export pack      test_case_details[0].Config_File.config
 *   • a saved GET /v2/testcases/{id}   { id, name, testDefinition }
 *   • a bare definition          { cellConfig, userPlaneConfig, … }
 */
export function definitionFromPack(raw: unknown): { name?: string; definition?: any; error?: string } {
  if (!raw || typeof raw !== 'object') return { error: 'the file is not a JSON object' };
  const any = raw as any;

  const first = Array.isArray(any.test_case_details) ? any.test_case_details[0] : undefined;
  if (first) {
    const def = first?.Config_File?.config ?? first?.Config_File ?? first?.config;
    if (!def || typeof def !== 'object') {
      return { error: 'the export has no Config_File.config to build a test case from' };
    }
    return { name: String(first.Test_Name ?? '').trim() || undefined, definition: def };
  }

  if (any.testDefinition && typeof any.testDefinition === 'object') {
    return { name: String(any.name ?? '').trim() || undefined, definition: any.testDefinition };
  }

  if (any.cellConfig || any.userPlaneConfig || any.subsConfig) {
    return { name: undefined, definition: any };
  }

  // The near miss, named.
  //
  // A ue.cfg is JSON, it is full of cells and UEs, and it sits in the same
  // folders as everything else — so it is the obvious wrong file to pick, and
  // four rows of the Subscriber suite on .102 were built from one. The generic
  // "this does not look like a Simnovator test case" left nothing to act on,
  // and the row went on to fail much later with the box's own complaint that
  // the cell section was missing.
  if (any.ue_list || any.cell_groups) {
    return {
      error: 'this is a ue.cfg — the UE simulator’s own config, not a Simnovator test case. '
        + 'Use the Simnovator’s Export button on the test case itself.',
    };
  }

  return {
    error: 'this does not look like a Simnovator test case — expected an export '
      + '(test_case_details), a saved testcase, or a test definition. '
      + `This file's top-level keys are: ${Object.keys(any).slice(0, 8).join(', ') || '(none)'}.`,
  };
}

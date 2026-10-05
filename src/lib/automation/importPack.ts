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

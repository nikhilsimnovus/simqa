// What a suite row is called on the box.
//
// A suite row creates its OWN testcase on the Simnovator (names are unique
// there), so it needs a name of its own -- one that says where it came from
// and that a suite made it, rather than a bare copy of the original sitting
// beside it.
//
// A row is named "<test case>_automation" because that is the copy the run
// creates on the Simnovator, leaving the operator's original untouched.
//
// The trap: once a run has created "5G_1cell_UDP_64UEs_automation", the box
// HOLDS a test case by that name, and it appears in the picker like any
// other. Choosing it as the source for a new row appended the suffix again,
// giving "5G_1cell_UDP_64UEs_automation_automation" -- and the run then
// created a testcase under that name on the box, so the next re-use added a
// third. Seen in the field.
//
// Pure, imports nothing, so node --test can load this directly.

export const AUTOMATION_SUFFIX = '_automation';

/** The row name a test case should default to. Idempotent. */
export function defaultRowNameFor(testcaseName?: string): string {
  const base = String(testcaseName ?? '').trim();
  if (!base) return '';
  return /_automation$/i.test(base) ? base : `${base}${AUTOMATION_SUFFIX}`;
}

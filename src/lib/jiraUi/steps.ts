// Turning a Jira ticket into UI steps — or saying why it cannot be.
//
// The SIM40 tickets are written to a house style:
//
//   **Step 1:** Log in to Simnovator using any valid user account.
//   **Step 2:** Navigate to the **My Test** page and start any long test.
//   **Step 5:** Check whether any option is available to stop it.
//
// 824 of the 996 carry steps in that shape, which is what makes this possible
// at all. 140 state an expected result. Those two numbers are the honest
// ceiling on automation here, and this module's job is as much to recognise
// the tickets that fall outside it as to convert the ones that do not.
//
// The rule that matters: an expected result is never invented. A ticket whose
// steps can be walked but which never says what SHOULD happen cannot pass or
// fail — only be reported as needing review. Guessing would turn a reporting
// tool into a fabrication.
//
// Pure, imports nothing, so node --test can load this directly.

export interface TicketStep {
  /** 1-based, as the ticket numbers them. */
  n: number;
  /** The step text, with the markdown emphasis stripped. */
  text: string;
  /** The Simnovator page this step navigates to, when it names one. */
  page?: string;
  /** True when the step is an observation rather than an action — "check
   *  whether", "verify that", "observe". Those are where a check belongs. */
  isCheck: boolean;
}

export type Runnability =
  | { runnable: true }
  | { runnable: false; reason: string };

export interface TicketPlan {
  key: string;
  steps: TicketStep[];
  /** What should happen. Either quoted from the ticket or its defect summary
   *  turned round — `expectedSource` says which, and it is never invented. */
  expected: string;
  expectedSource: ExpectedSource;
  /** What the reporter saw at the time, when the ticket says. The baseline for
   *  "is this still reproducible". */
  observed: string;
  /** The pages the steps walk through, in order, de-duplicated. */
  pages: string[];
  /** Whether this can be executed as a test, and if not, exactly why. */
  runnability: Runnability;
}

/**
 * The Simnovator's pages, as the tickets name them.
 *
 * Keyed by the canonical page and matched on the aliases the reporters
 * actually use — "My Test", "My Tests" and "MyTest" are all the same screen,
 * and a ticket that says "Tools → Manage Simulator" is naming two.
 */
export const PAGE_ALIASES: Record<string, string[]> = {
  'Dashboard': ['dashboard'],
  'My Tests': ['my test', 'my tests', 'mytest', 'mytests'],
  'Sample Tests': ['sample test', 'sample tests'],
  'Test Cases': ['test case page', 'test cases page', 'testcases page'],
  'Statistics': ['statistics', 'stats view', 'unified statistics', 'global statistics'],
  'Logs': ['logs page', 'log page', 'log settings', 'logs'],
  'Tools': ['tools'],
  'Manage Simulator': ['manage simulator', 'simulator management'],
  'Users': ['user management', 'manage user', 'users page'],
  'Settings': ['settings page', 'simnovator settings', 'settings'],
  'Login': ['login page', 'log in to simnovator', 'login'],
};

/** Strip the markdown the house style uses, so steps read as sentences. */
function plain(s: string): string {
  return s
    .replace(/\*\*/g, '')
    .replace(/[`_]/g, '')
    .replace(/\s*→\s*/g, ' → ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Which page a step names, if any. Longest alias first, so "manage
 *  simulator" is not eaten by "tools" when a step mentions both. */
export function pageOf(text: string): string | undefined {
  const hay = text.toLowerCase();
  let best: { page: string; at: number; len: number } | undefined;
  for (const [page, aliases] of Object.entries(PAGE_ALIASES)) {
    for (const a of aliases) {
      const at = hay.indexOf(a);
      if (at < 0) continue;
      if (!best || a.length > best.len) best = { page, at, len: a.length };
    }
  }
  return best?.page;
}

const CHECK = /\b(check|verify|verif(y|ied)|observe|ensure|confirm|validate|should|expected|note\s+that)\b/i;

/** The numbered steps a ticket carries, in order. */
export function parseSteps(description: string): TicketStep[] {
  const text = String(description ?? '');
  const out: TicketStep[] = [];
  // Both spellings the tickets use: "**Step 1:**" and a bare "Step 1:".
  const re = /(?:^|\n)\s*\**\s*Step\s*(\d+)\s*\**\s*[:.]\s*/gi;
  const marks: Array<{ n: number; from: number; to: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    marks.push({ n: Number(m[1]), from: m.index + m[0].length, to: text.length });
  }
  for (let i = 0; i < marks.length; i++) {
    if (i + 1 < marks.length) marks[i].to = marks[i + 1].from - 0;
  }
  for (const mark of marks) {
    // Cut at the next "Step" marker, and drop the marker itself.
    let body = text.slice(mark.from, mark.to);
    body = body.replace(/\n\s*\**\s*Step\s*\d+\s*\**\s*[:.].*$/is, '');
    const t = plain(body);
    if (!t) continue;
    out.push({ n: mark.n, text: t, page: pageOf(t), isCheck: CHECK.test(t) });
  }
  return out;
}

/**
 * The expected result, quoted from the ticket.
 *
 * Only from a place the ticket actually declares one: an "Expected" heading,
 * or a sentence saying what should happen. Never assembled from the steps,
 * because "what the steps do" and "what should happen" are different claims
 * and only the ticket can make the second.
 */
export function parseExpected(description: string): string {
  const text = String(description ?? '');
  const heading = /(?:^|\n)\s*\**\s*(?:expected(?:\s+(?:result|behaviou?r|output))?|acceptance\s+criteria)\s*\**\s*[:.]?\s*([\s\S]{0,600}?)(?=\n\s*\**\s*(?:actual|step\s*\d|observed|note)\b|$)/i.exec(text);
  if (heading && plain(heading[1])) return plain(heading[1]);

  // A "should" sentence is the other way the house style states it.
  for (const line of text.split('\n')) {
    const p = plain(line);
    if (/\bshould\b/i.test(p) && p.length > 15) return p;
  }
  return '';
}

/**
 * What the ticket says actually happened when it was reported.
 *
 * The house style records this far more often than it records an expectation:
 * of 764 tickets with steps but no "Expected" heading, 92 have "Actual
 * Result", 55 "Observed Behaviour", 43 "Observed Result". It is the baseline
 * for the only question a bug ticket really asks — is this still happening?
 */
export function parseObserved(description: string): string {
  const text = String(description ?? '');
  const m = /(?:^|\n)\s*\**\s*(?:actual(?:\s+result)?|observed(?:\s+(?:result|behaviou?r))?|observation|current\s+behaviou?r)\s*\**\s*[:.]?\s*([\s\S]{0,600}?)(?=\n\s*\**\s*(?:expected|step\s*\d|note|impacted|comment)\b|$)/i.exec(text);
  return m && plain(m[1]) ? plain(m[1]) : '';
}

/**
 * The expectation a defect summary implies.
 *
 * "Simnovator GUI fails to display installed version on GUI dashboard" is the
 * reporter stating a defect; the behaviour they expected is its negation — the
 * version IS displayed. Turning that round is reading the ticket, not
 * inventing an expectation, and it is the only expectation most of these
 * tickets carry.
 *
 * Reported separately from a quoted one (see ExpectedSource) so the UI can
 * show which tickets were asserted against the reporter's own words and which
 * against a defect turned round.
 */
export function deriveExpected(summary: string): string {
  const s = plain(String(summary ?? '')).replace(/^Failed\s*:\s*/i, '');
  if (!s) return '';
  const patterns: Array<[RegExp, (m: RegExpExecArray) => string]> = [
    [/^(.*?)\s+fails?\s+to\s+(.*)$/i, (m) => `${m[1]} should ${m[2]}`],
    [/^(.*?)\s+(?:does|do)\s+not\s+(.*)$/i, (m) => `${m[1]} should ${m[2]}`],
    [/^(.*?)\s+(?:is|are)\s+not\s+(.*)$/i, (m) => `${m[1]} should be ${m[2]}`],
    [/^(.*?)\s+(?:cannot|can\s*not|can't|unable\s+to)\s+(.*)$/i, (m) => `${m[1]} should be able to ${m[2]}`],
    [/^missing\s+(.*)$/i, (m) => `${m[1]} should be present`],
    [/^(.*?)\s+missing\s*(.*)$/i, (m) => `${m[1]} ${m[2]}`.trim() + ' should be present'],
    [/^incorrect\s+(.*)$/i, (m) => `${m[1]} should be correct`],
    [/^(.*?)\s+incorrectly\s+(.*)$/i, (m) => `${m[1]} should not ${m[2]}`],
    [/^duplicate\s+(.*)$/i, (m) => `${m[1]} should appear once`],
    [/^(.*?)\s+not\s+(?:available|visible|displayed|shown|working|refreshed|saved)\b(.*)$/i,
      (m) => `${m[1]} should be available${m[2] ? ` ${m[2]}` : ''}`.trim()],
  ];
  for (const [re, make] of patterns) {
    const m = re.exec(s);
    if (m) {
      const out = plain(make(m));
      if (out.length > 12) return out;
    }
  }
  return '';
}

/** Where a ticket's expectation came from. Shown, so an assertion against a
 *  defect turned round is never mistaken for the reporter's own words. */
export type ExpectedSource = 'stated' | 'derived' | 'none';

/**
 * Can this ticket be executed as a UI test?
 *
 * Three ways it cannot, and each is reported rather than guessed around:
 *   • no steps at all — there is nothing to walk;
 *   • steps that name no page — nowhere to start;
 *   • no stated expected result — a walk with no assertion is not a test,
 *     and inventing the assertion is not an option.
 */
export function runnabilityOf(steps: TicketStep[], expected: string, category?: string): Runnability {
  if (category === 'Installation, Services and Infrastructure') {
    return {
      runnable: false,
      reason: 'this is an installation or service issue — podman, reboots, disk space — '
        + 'and names no UI screen, so a browser test cannot speak to it',
    };
  }
  if (steps.length === 0) {
    return { runnable: false, reason: 'the ticket carries no numbered steps to walk' };
  }
  if (!steps.some((s) => s.page)) {
    return {
      runnable: false,
      reason: 'the steps name no Simnovator page, so there is nowhere to start',
    };
  }
  if (!expected) {
    return {
      runnable: false,
      reason: 'the ticket neither states an expected result nor describes a defect that implies '
        + 'one, so there is nothing to assert and it would have to be invented',
    };
  }
  return { runnable: true };
}

/** A ticket's plan: its steps, its pages, its expected result and where that
 *  came from, what it looked like when reported, and whether it can honestly
 *  be run. */
export function planTicket(t: {
  key: string; summary?: string; description?: string; category?: string;
}): TicketPlan {
  const steps = parseSteps(t.description ?? '');
  const stated = parseExpected(t.description ?? '');
  // A quoted expectation always wins; the summary is only turned round when
  // the ticket states none, which is most of them.
  const derived = stated ? '' : deriveExpected(t.summary ?? '');
  const expected = stated || derived;
  const expectedSource: ExpectedSource = stated ? 'stated' : derived ? 'derived' : 'none';
  const pages: string[] = [];
  for (const s of steps) if (s.page && !pages.includes(s.page)) pages.push(s.page);
  return {
    key: t.key, steps, expected, expectedSource,
    observed: parseObserved(t.description ?? ''),
    pages,
    runnability: runnabilityOf(steps, expected, t.category),
  };
}

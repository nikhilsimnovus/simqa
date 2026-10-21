// Which part of the Simnovator a Jira ticket is about.
//
// 996 tickets from SIM40 (Jay, Mohanraj, Sruthi, all dates) have to become a
// set of categories you can pick one of and run. The categories are derived
// from the tickets, not written down in advance — so a refresh that brings in
// new tickets re-derives them, and a category only exists because tickets
// put it there.
//
// Three signals, in order of how much they are trusted:
//
//   1. labels      — the QA team's own filing. "logs", "Statistics",
//                    "tools-page", "Test_Creation", "Dashboard" are theirs,
//                    and they mean it.
//   2. summary     — what the reporter called the problem.
//   3. description — the steps, which name the pages walked through.
//
// Labels win because they are deliberate; a word in a description may just be
// part of a navigation step ("go to Dashboard, then open My Tests"), which is
// why the description is scored lowest and the summary in between.
//
// Nothing is assigned on the title alone, and nothing is silently dropped: a
// ticket matching no rule lands in "Unclassified", which is reported as a
// real category so it can be looked at rather than quietly lost.
//
// Pure, imports nothing, so node --test can load this directly.

export interface CategorisableTicket {
  key: string;
  summary?: string;
  description?: string;
  labels?: string[];
  components?: string[];
}

export interface CategoryRule {
  /** Shown in the UI. */
  name: string;
  /** Jira labels that place a ticket here outright. Compared lower-case. */
  labels?: string[];
  /** Words in the SUMMARY. Weighted above description, below labels. */
  summary?: RegExp;
  /** Words anywhere in summary+description. The weakest signal. */
  body?: RegExp;
}

/** Where a ticket with no signal at all goes. Named, counted and shown. */
export const UNCLASSIFIED = 'Unclassified';

/**
 * The rules, most specific first.
 *
 * Order matters only for ties: a ticket about "UE statistics not updating
 * during execution" should be UE Statistics rather than Test Execution, so
 * the statistics rules come first and a tie is broken towards the earlier
 * rule.
 */
export const CATEGORY_RULES: CategoryRule[] = [
  {
    name: 'UE Statistics',
    summary: /\bue\s*(stat|statistic|summary|list|table|count)|per[- ]ue\b|ue\s*info/i,
    body: /\bue\s*statistic|ue\s*summary\s*(page|tab|table)/i,
  },
  {
    name: 'Cell Statistics',
    summary: /\bcell\s*(stat|statistic|summary|throughput|table)|per[- ]cell\b/i,
    body: /\bcell\s*statistic|cell\s*summary\s*(page|tab|table)/i,
  },
  {
    name: 'Dashboard and Global Statistics',
    labels: ['dashboard', 'statistics'],
    summary: /\bdashboard\b|global\s*stat|unified\s*statistic|stats\s*view|message\s*counter/i,
    body: /\bdashboard\s*(page|screen|tab)|global\s*statistic|unified\s*statistic|stats\s*view/i,
  },
  {
    name: 'Logs and Reports',
    labels: ['logs'],
    summary: /\blog(s|ging)?\b|\breport\b|\bpcap\b|\bdownload\b|\bexport\b/i,
    body: /\blog\s*(file|page|setting|profile)|download\s*(the\s*)?(log|report)|pcap/i,
  },
  {
    name: 'Test Case Configuration and Validation',
    labels: ['test_creation', 'usertplane', 'userplane'],
    summary: /\b(config|configuration|validat|band|bandwidth|arfcn|subscriber|user\s*plane|power\s*cycle|mobility|slice|slicing|codec|apn)\b/i,
    body: /\bcell\s*config|subs\s*config|user\s*plane\s*config|power\s*cycle\s*config|validation\s*(error|message|failed)/i,
  },
  {
    name: 'Test Execution and Verdict',
    labels: ['test-execution'],
    summary: /\b(execut|verdict|run(ning)?\s*test|start\s*test|stop\s*test|abort|pass\/fail|in\s*progress)\b/i,
    body: /\b(start|stop|abort)\s*(the\s*)?test|verdict\s*(is|shows|column)|execution\s*(status|result)/i,
  },
  {
    name: 'My Tests and Test Case Management',
    labels: ['testcases'],
    summary: /\bmy\s*test|sample\s*test|test\s*case\s*(list|page|name|count|widget|view|duplicate|clone|copy|delete|deletion|edit|import|export|restart|identification)|\bplaylist\b|\btag(s|ging)?\b|\bzip\b|\bimport\b/i,
    body: /\bmy\s*test\s*(page|screen|tab)|sample\s*tests?\s*(page|section)|test\s*case\s*(list|table)/i,
  },
  {
    name: 'Tools, Simulator and User Management',
    labels: ['tools-page', 'admin'],
    summary: /\b(tool|simulator\s*manage|manage\s*simulator|licen[cs]e|user\s*manage|admin|rf\s*card|system\s*setting)\b/i,
    body: /\btools\s*(page|menu|tab)|manage\s*simulator|licen[cs]e\s*(server|key|expire)/i,
  },
  {
    name: 'Data Display, Sorting and Filtering',
    summary: /\b(sort|filter|search|pagination|paginat|column|table\s*(view|header)|order\s*by)\b/i,
    body: /\b(sort(ing|ed)?|filter(ing|ed)?)\s*(is|not|does|option)|pagination|search\s*(box|field|bar)/i,
  },
  {
    name: 'Error Handling and Recovery',
    summary: /\b(error|exception|crash|hang|freeze|stuck|fail(ed|ure)?\s*to|unable\s*to|not\s*responding|500|404)\b/i,
    body: /\b(internal\s*server\s*error|unhandled|stack\s*trace|error\s*message\s*(is|shown|displayed))/i,
  },
  {
    // Not a UI page at all.
    //
    // Fifteen or so tickets are about the product not starting: podman
    // containers that do not come up after a reboot, services exiting after
    // a fresh install, "No Space Left on Device", installation failing when
    // switching container mode. They were landing in Unclassified because
    // they name no screen — and they should never be run as UI tests, which
    // is a good reason for them to have a category of their own.
    name: 'Installation, Services and Infrastructure',
    summary: /\b(podman|container|reboot|fresh\s*(install|build)|installation|service(s)?\s*(exit|fail|status|start)|no\s*space\s*left|cockpit|uptime|cpu\s*usage|openobserve|timescale|pod\b)/i,
    body: /\b(podman|systemctl|container\s*(id|health)|after\s*(a\s*)?reboot|fresh\s*installation)/i,
  },
  {
    name: 'Settings and Persistence',
    summary: /\b(not\s*(saved|stored|retained|restored|persist)|does\s*not\s*save|setting(s)?\b|after\s*(switch|chang|refresh|reload|re-?login)|revert(s|ed)?\b|default\s*value)/i,
    body: /\b(not\s*saved|not\s*retained|value(s)?\s*(are|is)\s*(lost|reset)|after\s*(a\s*)?(refresh|reload|re-?login))/i,
  },
  {
    // LAST, and without the QA_GUI_User_Exp label.
    //
    // That label was on 375 of the 996 and it put every one of them here —
    // 362 tickets in a bucket nobody could usefully run. It is not a feature
    // area at all: QA_GUI_Functional (485) and QA_GUI_User_Exp (375) are how
    // the team records the KIND of test, functional against user-experience,
    // and both span every page in the product. So they are reported as a
    // facet (see TEST_TYPE_LABELS) and the ticket is placed by its content,
    // which is what it is actually about.
    name: 'UI Navigation and Controls',
    summary: /\b(navigat|button|tooltip|tool\s*tip|scroll|align|layout|placeholder|spelling|typo|capitali[sz]|nomenclature|label+ing|overlap|truncat|greyed|disabled\s*mode|cursor|hover|footer|widget|floating|progress\s*bar|dark\s*mode|popup|pop-?up|notification|icon\s*displayed|not\s*(clearly\s*)?visible|dropdown)\b/i,
    body: /\b(tool\s*tip|scroll\s*bar|mis\s*align|overlapping|cut\s*off|not\s*clickable|floating\s*widget)/i,
  },
];

/**
 * Labels that say what KIND of test a ticket is, not which part of the UI.
 *
 * Kept out of the category rules deliberately — see UI Navigation above — and
 * surfaced separately so a category can still be filtered to, say, only its
 * regression tickets.
 */
export const TEST_TYPE_LABELS = [
  'qa_gui_functional', 'qa_gui_user_exp', 'regression', 'enhancement',
  'spacex', 'apex', 'apex_tier1_merge', 'viettel', 'customer-lab',
  'release_1st_drop', 'edgeq', 'o-ru', '4.0',
];

/** The test-type facets a ticket carries, in the labels' own spelling. */
export function testTypesOf(t: CategorisableTicket): string[] {
  return (t.labels ?? []).filter((l) => TEST_TYPE_LABELS.includes(lower(l)));
}

/** Label weight is highest: it is the QA team's own filing. */
const W_LABEL = 100;
const W_SUMMARY = 10;
const W_BODY = 1;

const lower = (s: string | undefined) => String(s ?? '').toLowerCase();

/** The score a rule gets for a ticket, and why — the reason is kept so a
 *  category assignment can be explained rather than taken on trust. */
export function scoreRule(t: CategorisableTicket, rule: CategoryRule): { score: number; why: string[] } {
  const why: string[] = [];
  let score = 0;

  const labels = (t.labels ?? []).map(lower);
  for (const want of rule.labels ?? []) {
    if (labels.includes(lower(want))) { score += W_LABEL; why.push(`label "${want}"`); }
  }
  const summary = String(t.summary ?? '');
  if (rule.summary) {
    const m = rule.summary.exec(summary);
    if (m) { score += W_SUMMARY; why.push(`summary matches "${m[0]}"`); }
  }
  if (rule.body) {
    const m = rule.body.exec(`${summary}\n${String(t.description ?? '')}`);
    if (m) { score += W_BODY; why.push(`description matches "${m[0]}"`); }
  }
  return { score, why };
}

export interface Assignment {
  key: string;
  category: string;
  /** Why this category — shown so an assignment can be challenged. */
  why: string[];
  /** The runners-up, for the ones that are genuinely borderline. */
  alternatives: Array<{ category: string; score: number }>;
}

/** One ticket's category. Every ticket gets one; none is skipped. */
export function categoriseTicket(
  t: CategorisableTicket,
  rules: CategoryRule[] = CATEGORY_RULES,
): Assignment {
  const scored = rules
    .map((r, i) => ({ rule: r, order: i, ...scoreRule(t, r) }))
    .filter((s) => s.score > 0)
    // Highest score wins; an earlier rule wins a tie, which is what puts
    // "UE statistics during execution" under UE Statistics.
    .sort((a, b) => b.score - a.score || a.order - b.order);

  if (scored.length === 0) {
    return {
      key: t.key, category: UNCLASSIFIED,
      why: ['no label, summary or description signal matched any category'],
      alternatives: [],
    };
  }
  return {
    key: t.key,
    category: scored[0].rule.name,
    why: scored[0].why,
    alternatives: scored.slice(1, 4).map((s) => ({ category: s.rule.name, score: s.score })),
  };
}

export interface CategorySummary {
  name: string;
  total: number;
  keys: string[];
}

/** Every ticket assigned, and the categories that actually have tickets.
 *  A rule nothing matched does not become an empty category in the UI. */
export function categoriseAll(
  tickets: CategorisableTicket[],
  rules: CategoryRule[] = CATEGORY_RULES,
): { assignments: Assignment[]; categories: CategorySummary[] } {
  const assignments = tickets.map((t) => categoriseTicket(t, rules));
  const byName = new Map<string, string[]>();
  for (const a of assignments) {
    if (!byName.has(a.category)) byName.set(a.category, []);
    (byName.get(a.category) as string[]).push(a.key);
  }
  const categories = [...byName.entries()]
    .map(([name, keys]) => ({ name, total: keys.length, keys }))
    // Biggest first, with Unclassified last however big it is: it is a
    // backlog to triage, not a category to run.
    .sort((a, b) => (a.name === UNCLASSIFIED ? 1 : b.name === UNCLASSIFIED ? -1 : b.total - a.total));
  return { assignments, categories };
}

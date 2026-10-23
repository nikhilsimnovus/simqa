// What a row's Status and Verdict are actually saying, broken out for the
// hover card.
//
// A step's `detail` is the whole narrative of one test case, joined with
// " · ": where its definition came from, every config pushed, every symlink
// made, the restart, the attach check, the box's own verdict, and — now —
// what post-processing checked. It is exactly what someone wants when they
// ask "what did it verify?", and completely unreadable as a single line in a
// tooltip.
//
// So it is parsed back into the steps it was built from, each labelled by
// what it was doing, with the box's own words and the reason it failed kept
// separately. Nothing is invented here: every line comes from the run record.
//
// Pure, imports nothing, so node --test loads it directly.

export type StepKind =
  | 'testcase' | 'config' | 'licence' | 'attach' | 'post' | 'box' | 'note';

export interface ExplainedStep {
  kind: StepKind;
  /** A short word for the left column of the card. */
  label: string;
  /** The segment itself, with its machine prefix removed where it had one. */
  text: string;
  /** False where the segment reports something that did not go well. */
  ok: boolean;
}

export interface RowExplanation {
  /** One sentence: what happened to this row. */
  headline: string;
  /** Why it is not a pass. Absent when it is. */
  why?: string;
  /** Everything the run did for this row, in the order it did it. */
  steps: ExplainedStep[];
  /** The Simnovator's own fields, as it spelled them. */
  box: Array<{ label: string; value: string }>;
}

const PREFIXES: Array<[RegExp, StepKind, string]> = [
  [/^cfg-cleanup:\s*/i, 'config', 'cleanup'],
  [/^cfg-source:\s*/i, 'config', 'config'],
  [/^cfg-push:\s*/i, 'config', 'config'],
  [/^cfg-link:\s*/i, 'config', 'link'],
  [/^cfg-db:\s*/i, 'config', 'database'],
  [/^cfg-[a-z]+:\s*/i, 'config', 'config'],
  [/^server-configs:\s*/i, 'config', 'configs'],
  [/^configs:\s*/i, 'config', 'configs'],
  [/^testcase:\s*/i, 'testcase', 'test case'],
  [/^licence[^:]*:\s*/i, 'licence', 'licence'],
  [/^attach:\s*/i, 'attach', 'attach'],
  [/^post-processing:\s*/i, 'post', 'post-processing'],
];

/** Segments that report a problem rather than work done. */
const BAD = /\b(fail|failed|error|could not|cannot|no UE attached|refused|timed out|timeout|aborted|never started|not started|unreadable|FAIL)\b/i;

/** A `verdict=PASS status=COMPLETED result=PASS dur=100s` tail. */
const VERDICT_TAIL = /^verdict=/i;

/**
 * Break one step's detail into the things it says.
 *
 * Segments are kept in order and in full: this is the record of what ran, and
 * shortening it here would be the same mistake as showing it as one line.
 */
export function explainSteps(detail?: string): ExplainedStep[] {
  const parts = String(detail ?? '').split(' · ').map((s) => s.trim()).filter(Boolean);
  const out: ExplainedStep[] = [];
  for (const part of parts) {
    if (VERDICT_TAIL.test(part)) {
      // The box's own summary line — reported separately, as its own fields.
      out.push({ kind: 'box', label: 'box', text: part, ok: !/result=(FAIL|ERROR|INCOMPLETE)/i.test(part) });
      continue;
    }
    const hit = PREFIXES.find(([re]) => re.test(part));
    if (hit) {
      const [re, kind, label] = hit;
      const text = part.replace(re, '');
      out.push({ kind, label, text, ok: !BAD.test(text) });
      continue;
    }
    out.push({ kind: 'note', label: 'note', text: part, ok: !BAD.test(part) });
  }
  return out;
}

/** The Simnovator's own fields, only those it actually gave. */
export function boxFields(o: {
  boxStatus?: string; boxResult?: string; verdict?: string; stopped?: boolean;
}): Array<{ label: string; value: string }> {
  const out: Array<{ label: string; value: string }> = [];
  if (o.boxStatus) out.push({ label: 'Execution status', value: o.boxStatus });
  if (o.boxResult) out.push({ label: 'Execution result', value: o.boxResult });
  // Only when it says something the two above do not: verdict folds the
  // status in, so repeating it under a third name helps nobody.
  if (o.verdict && o.verdict !== o.boxResult) out.push({ label: 'Verdict', value: o.verdict });
  if (o.stopped) out.push({ label: 'Stopped by SimQA', value: 'after the duration window' });
  return out;
}

/**
 * The whole explanation for one row.
 *
 * `status` and `verdict` are the labels the two columns show, so the headline
 * says the same thing the cells do rather than a second opinion about it.
 */
export function explainRow(o: {
  status?: string;
  verdictLabel?: string;
  detail?: string;
  boxStatus?: string;
  boxResult?: string;
  verdict?: string;
  stopped?: boolean;
  /** The reason line, already worked out by failureReason(). */
  reason?: string;
}): RowExplanation {
  const steps = explainSteps(o.detail);
  const box = boxFields(o);
  const status = o.status ?? '';
  const vd = o.verdictLabel ?? '';

  const headline = !status || status === '—'
    ? 'This row has not been judged yet.'
    : status === 'In Progress'
      ? 'Executing now — the Simnovator has not reported an outcome yet.'
      : status === 'Not Executed'
        ? 'The box never executed this row.'
        : vd
          ? `${status} — the Simnovator reported ${vd}.`
          : `${status}.`;

  // A pass needs no explanation; everything else does, and the reason line is
  // the best one available. Where there is none, the last unhappy step is
  // better than silence.
  const passed = vd === 'Passed' || o.boxResult === 'PASS' || o.verdict === 'PASS';
  const why = passed
    ? undefined
    : o.reason
      ?? [...steps].reverse().find((s) => !s.ok)?.text
      ?? undefined;

  return { headline, why, steps, box };
}

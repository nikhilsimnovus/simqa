'use client';

// The summary report behind one row's Result.
//
// The column says PASS or FAIL. Clicking it opens this: what was checked,
// what each rule expected against what the log actually held, and every OTA
// message that was counted. A verdict without its evidence is an accusation,
// and the first question anyone asks a failing rule is "how many did you
// find, then?" — so that number is on the screen, not in a tooltip.
//
// It reads the RUN RECORD through /api/post-process/report, not the box: the
// report was produced when the execution finished, and the Simnovator does
// not keep its logs forever. A report opened a month later still shows the
// counts it was decided on.

import React, { useEffect, useState } from 'react';

interface CountCheck {
  label: string; expected: number; actual: number;
  comparison: 'eq' | 'min' | 'max' | 'gt' | 'lt'; pass: boolean;
}

interface RuleResult {
  ruleId: string;
  messageName: string;
  mode: 'count' | 'content' | 'countAndContent';
  pass: boolean;
  checks: CountCheck[];
  actualMessageCount: number;
  actualMatchingCount?: number;
  actualOccurrenceCount?: number;
  expectedCondition?: string;
  failure?: string;
  messageIndexes?: number[];
}

interface Report {
  outcome: string;
  rulesConfigured: number;
  passedRules: number;
  results: RuleResult[];
  tally: Array<{ name: string; channel: string; count: number }>;
  log: { records: number; messages: number; perLayer: Record<string, number>; requests: number; complete: boolean };
  problem?: string;
  executionResult?: string;
  finalResult?: string;
}

interface Picked {
  found: boolean;
  row: string;
  runId?: string;
  finishedAt?: string;
  executionId?: string;
  verdict?: string;
  boxStatus?: string;
  boxResult?: string;
  finalResult?: string;
  report?: Report;
}

const MODE_LABEL: Record<string, string> = {
  count: 'Message count only',
  content: 'Message content validation',
  countAndContent: 'Message count and content',
};

const CMP: Record<string, string> = { eq: '=', min: '>=', max: '<=', gt: '>', lt: '<' };

const outcomeCls = (o?: string) =>
  o === 'PASS' ? 'text-emerald-700' : o === 'FAIL' ? 'text-red-700' : 'text-amber-700';

/**
 * One in-flight (or finished) fetch per row, shared by the hover card and the
 * dialog.
 *
 * Hovering a column of twenty rows must not be twenty requests, and opening
 * the dialog for a row already hovered must not be a twenty-first. The report
 * is a finished run record, so it cannot go stale while the page is open —
 * and a run that finishes meanwhile replaces the whole page state anyway.
 */
const cache = new Map<string, Promise<Picked>>();

function loadReport(suiteId: string, row: string): Promise<Picked> {
  const key = `${suiteId}\u0000${row}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const p = fetch(`/api/post-process/report?suite=${encodeURIComponent(suiteId)}&row=${encodeURIComponent(row)}`)
    .then((r) => r.json())
    .then((j) => {
      if (!j?.ok) throw new Error(j?.error ?? 'could not load the report');
      return j as Picked;
    })
    .catch((e) => { cache.delete(key); throw e; });
  cache.set(key, p);
  return p;
}

/** The compact "expected N, detected M" line a rule reduces to. */
function ruleLine(r: RuleResult): string {
  const c = r.checks?.find((x) => !x.pass) ?? r.checks?.[0];
  if (!c) return `${r.messageName}: nothing to compare`;
  return `${r.messageName}: expected ${CMP[c.comparison] ?? ''} ${c.expected}, detected ${c.actual}`;
}

/**
 * The Result cell: the value, a hover summary, and the full report on
 * double-click.
 *
 * Hover gives the answer most questions stop at — which rule failed and by how
 * much — without a click. Double-click opens everything, including the
 * messages no rule asked about. A single click is deliberately not used: the
 * cell sits in a table people select text in and drag rows around.
 */
export function PostResultCell({ suiteId, row, text, cls, title, hasResult, onOpen }: {
  suiteId: string;
  row: string;
  text: string;
  cls: string;
  title?: string;
  /** False for an em dash — nothing to hover, nothing to open. */
  hasResult: boolean;
  onOpen: () => void;
}) {
  const [hover, setHover] = useState(false);
  const [peek, setPeek] = useState<Picked | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!hover || !hasResult || peek || failed) return;
    let cancelled = false;
    loadReport(suiteId, row)
      .then((j) => { if (!cancelled) setPeek(j); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [hover, hasResult, peek, failed, suiteId, row]);

  const rep = peek?.found ? peek.report : undefined;

  return (
    <td className={`relative px-2 py-1 whitespace-nowrap ${hasResult ? 'cursor-pointer' : 'cursor-help'} ${cls}`}
      // The native tooltip only where there is no card to show, so the two
      // never appear on top of each other.
      title={hasResult ? undefined : title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onDoubleClick={() => { if (hasResult) onOpen(); }}>
      {text}
      {hover && hasResult && (
        <div className="absolute right-0 top-full z-40 mt-1 w-[360px] cursor-default whitespace-normal
                        rounded-lg border border-line bg-surface p-3 text-left shadow-xl"
          onDoubleClick={(e) => { e.stopPropagation(); onOpen(); }}>
          {!peek && !failed && <p className="text-[11px] text-slate-500">Loading the report…</p>}
          {failed && <p className="text-[11px] text-slate-500">The report could not be loaded.</p>}
          {peek && !peek.found && (
            <p className="text-[11px] text-slate-600">
              No post-processing was recorded for this row&rsquo;s last run.
            </p>
          )}
          {rep && (
            <>
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                  Post-execution processing
                </span>
                <span className={`ml-auto text-xs font-semibold ${outcomeCls(rep.outcome)}`}>{rep.outcome}</span>
              </div>
              <p className="mt-0.5 text-[11px] text-slate-500">
                {rep.passedRules}/{rep.rulesConfigured} rule{rep.rulesConfigured === 1 ? '' : 's'} passed ·{' '}
                {rep.log.messages} OTA message{rep.log.messages === 1 ? '' : 's'} in {rep.log.records} log records
              </p>
              <ul className="mt-2 space-y-1">
                {rep.results.slice(0, 6).map((r, i) => (
                  <li key={r.ruleId || i}
                    className={`text-[11px] ${r.pass ? 'text-emerald-700' : 'text-red-700'}`}>
                    {r.pass ? '✓' : '✗'} {ruleLine(r)}
                  </li>
                ))}
                {rep.results.length > 6 && (
                  <li className="text-[11px] text-slate-500">+{rep.results.length - 6} more</li>
                )}
              </ul>
              {rep.problem && <p className="mt-1.5 text-[11px] text-amber-700">{rep.problem}</p>}
              <p className="mt-2 text-[10px] text-slate-400">
                Double-click for the full report, with every message counted.
              </p>
            </>
          )}
        </div>
      )}
    </td>
  );
}

export default function PostReport({ suiteId, row, onClose }: {
  suiteId: string; row: string; onClose: () => void;
}) {
  const [data, setData] = useState<Picked | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setData(null); setError('');
    fetch(`/api/post-process/report?suite=${encodeURIComponent(suiteId)}&row=${encodeURIComponent(row)}`)
      .then((r) => r.json())
      .then((j) => { if (!cancelled) { if (j?.ok) setData(j); else setError(j?.error ?? 'could not load the report'); } })
      .catch((e) => { if (!cancelled) setError(String(e?.message ?? e)); });
    return () => { cancelled = true; };
  }, [suiteId, row]);

  const rep = data?.report;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4"
      onClick={onClose}>
      <div className="bg-surface rounded-xl shadow-xl border border-line max-w-3xl w-full max-h-[85vh] overflow-auto p-5"
        onClick={(e) => e.stopPropagation()}>

        <div className="flex items-start gap-3">
          <div>
            <h3 className="text-base font-semibold text-slate-900">Post-execution processing</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              <span className="font-mono">{row}</span>
              {data?.finishedAt ? <> · ran {new Date(data.finishedAt).toLocaleString()}</> : null}
              {data?.executionId ? <> · execution <span className="font-mono">{data.executionId}</span></> : null}
            </p>
          </div>
          <button onClick={onClose}
            className="ml-auto rounded border border-slate-300 hover:bg-slate-100 text-xs px-2 py-1">Close</button>
        </div>

        {error && <p className="mt-4 text-sm text-red-700">{error}</p>}
        {!error && !data && <p className="mt-4 text-sm text-slate-500">Loading…</p>}

        {data && !data.found && (
          <p className="mt-4 text-sm text-slate-600">
            This row has not been post-processed. Either no rules are configured for it, or it has not
            run since they were added — the rules are checked when an execution finishes.
          </p>
        )}

        {rep && (
          <>
            {/* The three values, side by side and never merged. */}
            <div className="mt-4 grid grid-cols-3 gap-2 text-center">
              {[
                { k: 'Execution verdict', v: data?.boxResult || data?.verdict || '–', cls: 'text-slate-800',
                  hint: 'the Simnovator’s own result for this execution' },
                { k: 'Post-processing', v: rep.outcome, cls: outcomeCls(rep.outcome),
                  hint: `${rep.passedRules}/${rep.rulesConfigured} rules passed` },
                { k: 'Result', v: data?.finalResult ?? rep.finalResult ?? '–', cls: outcomeCls(data?.finalResult ?? rep.finalResult),
                  hint: 'the two above, combined' },
              ].map((c) => (
                <div key={c.k} className="rounded-lg border border-line bg-slate-50/60 px-3 py-2" title={c.hint}>
                  <div className="text-[10px] uppercase tracking-wider text-slate-500">{c.k}</div>
                  <div className={`text-sm font-semibold ${c.cls}`}>{c.v}</div>
                  <div className="text-[10px] text-slate-400">{c.hint}</div>
                </div>
              ))}
            </div>

            {rep.problem && (
              <p className="mt-3 text-xs rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-amber-800">
                {rep.problem}
              </p>
            )}

            {/* What was read. The counts below are only as good as this. */}
            <p className="mt-3 text-[11px] text-slate-500">
              Read {rep.log.records} log record{rep.log.records === 1 ? '' : 's'} in {rep.log.requests} request
              {rep.log.requests === 1 ? '' : 's'}
              {Object.keys(rep.log.perLayer ?? {}).length
                ? <> ({Object.entries(rep.log.perLayer).map(([l, n]) => `${l} ${n}`).join(', ')})</> : null}
              {' · '}{rep.log.messages} OTA message{rep.log.messages === 1 ? '' : 's'} found
              {rep.log.complete ? '' : ' · the log was NOT read whole, so no rule may pass on it'}
            </p>

            {/* Rule by rule: what was asked, and what the log gave. */}
            <h4 className="mt-4 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              What was checked
            </h4>
            <div className="mt-1.5 space-y-2">
              {rep.results.map((r, i) => (
                <div key={r.ruleId || i}
                  className={`rounded-md border p-2.5 ${r.pass ? 'border-emerald-200 bg-emerald-50/40' : 'border-red-200 bg-red-50/40'}`}>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[11px] font-semibold text-slate-500 tabular-nums">#{i + 1}</span>
                    <span className="font-mono text-xs text-slate-800">{r.messageName}</span>
                    <span className="text-[10px] text-slate-500">{MODE_LABEL[r.mode] ?? r.mode}</span>
                    {r.expectedCondition
                      ? <span className="text-[10px] text-slate-500">· {r.expectedCondition}</span> : null}
                    <span className={`ml-auto text-xs font-semibold ${r.pass ? 'text-emerald-700' : 'text-red-700'}`}>
                      {r.pass ? 'PASS' : 'FAIL'}
                    </span>
                  </div>

                  {/* Expected beside actual — the whole point of the report. */}
                  <table className="mt-2 w-full text-[11px]">
                    <thead className="text-slate-500">
                      <tr>
                        <th className="text-left font-medium py-0.5">Count</th>
                        <th className="text-right font-medium py-0.5">Expected</th>
                        <th className="text-right font-medium py-0.5">Detected</th>
                        <th className="text-right font-medium py-0.5"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200/70">
                      {r.checks.map((c, n) => (
                        <tr key={n}>
                          <td className="py-0.5 text-slate-700">{c.label}</td>
                          <td className="py-0.5 text-right font-mono text-slate-600">{CMP[c.comparison] ?? ''} {c.expected}</td>
                          <td className={`py-0.5 text-right font-mono font-semibold ${c.pass ? 'text-emerald-700' : 'text-red-700'}`}>
                            {c.actual}
                          </td>
                          <td className={`py-0.5 text-right ${c.pass ? 'text-emerald-700' : 'text-red-700'}`}>
                            {c.pass ? '✓' : '✗'}
                          </td>
                        </tr>
                      ))}
                      {/* Always shown, even when no rule compared it: "how many
                          of this message are there" is the question people
                          actually arrive with. */}
                      <tr className="text-slate-500">
                        <td className="py-0.5">messages of this name in the log</td>
                        <td className="py-0.5" />
                        <td className="py-0.5 text-right font-mono">{r.actualMessageCount}</td>
                        <td />
                      </tr>
                    </tbody>
                  </table>

                  {r.failure && <p className="mt-1.5 text-[11px] text-red-700">{r.failure}</p>}
                </div>
              ))}
            </div>

            {/* Everything the log held, whether a rule asked about it or not. */}
            <h4 className="mt-4 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              OTA messages detected ({rep.tally?.length ?? 0} kinds)
            </h4>
            {rep.tally?.length ? (
              <table className="mt-1.5 w-full text-[11px]">
                <thead className="text-slate-500">
                  <tr>
                    <th className="text-left font-medium py-0.5">Message</th>
                    <th className="text-left font-medium py-0.5">Channel</th>
                    <th className="text-right font-medium py-0.5">Count</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rep.tally.map((t) => (
                    <tr key={`${t.channel}-${t.name}`}>
                      <td className="py-0.5 font-mono text-slate-700">{t.name}</td>
                      <td className="py-0.5 text-slate-500">{t.channel}</td>
                      <td className="py-0.5 text-right font-mono tabular-nums text-slate-700">{t.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="mt-1.5 text-[11px] text-slate-500">
                No OTA messages were found in this execution&rsquo;s log.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

'use client';

// The Status and Verdict cells, with the whole story behind them on hover.
//
// Both columns are one word, and one word is the wrong size for the question
// people actually have: a row that says "Not Executed · Error" sends someone
// to the callbox to find out what SimQA already knows, and a row that says
// "Completed · PASS" never says what it did to get there.
//
// The run record holds all of it — the test case it created, every config it
// pushed and linked, the attach check, the box's own fields, and what
// post-processing checked. explainRow.ts breaks that back into steps; this
// shows them.
//
// Nothing here is new information. It is the same `detail` the run has always
// stored, shown at a size you can read.

import React from 'react';
import { explainRow, type ExplainedStep } from '@/lib/automation/explainRow';
// Outside the table's scroll box, or the card cannot be seen -- see FloatingCard.tsx.
import FloatingCard, { useHoverAnchor } from './FloatingCard';

const KIND_CLS: Record<string, string> = {
  testcase: 'text-sky-700',
  config: 'text-slate-500',
  licence: 'text-violet-700',
  attach: 'text-teal-700',
  post: 'text-indigo-700',
  box: 'text-slate-700',
  note: 'text-slate-500',
};

function StepLine({ s }: { s: ExplainedStep }) {
  return (
    <li className="flex gap-1.5">
      <span className={`shrink-0 w-[78px] text-right text-[10px] uppercase tracking-wide ${KIND_CLS[s.kind] ?? 'text-slate-500'}`}>
        {s.label}
      </span>
      <span className={`flex-1 break-words text-[11px] ${s.ok ? 'text-slate-600' : 'text-red-700'}`}>
        {s.text}
      </span>
    </li>
  );
}

export default function WhyCell({
  className, title, children, status, verdictLabel, detail, reason,
  boxStatus, boxResult, verdict, stopped, extra,
}: {
  className?: string;
  /** Kept for the rows that have nothing to explain. */
  title?: string;
  children: React.ReactNode;
  status?: string;
  verdictLabel?: string;
  detail?: string;
  reason?: string;
  boxStatus?: string;
  boxResult?: string;
  verdict?: string;
  stopped?: boolean;
  /** Anything the caller wants under the steps — the Result cell's rules. */
  extra?: React.ReactNode;
}) {
  const { anchor, cellProps, cardProps } = useHoverAnchor();
  // Nothing recorded means nothing to show: an empty card over a row that has
  // not run is worse than no card.
  const has = !!(detail || reason || boxStatus || boxResult || verdict);

  const e = has
    ? explainRow({ status, verdictLabel, detail, reason, boxStatus, boxResult, verdict, stopped })
    : undefined;

  return (
    <td className={`${className ?? ''} ${has ? 'cursor-help' : ''}`}
      title={has ? undefined : title}
      {...cellProps}>
      {children}
      {e && (
        <FloatingCard anchor={anchor} width={460} {...cardProps}>
          <p className="text-[11px] font-semibold text-slate-800">{e.headline}</p>

          {e.why && (
            <p className="mt-1.5 rounded border border-red-200 bg-red-50 px-2 py-1 text-[11px] text-red-800">
              <span className="font-semibold">Why: </span>{e.why}
            </p>
          )}

          {e.box.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
              {e.box.map((b) => (
                <span key={b.label} className="text-[10px] text-slate-500">
                  {b.label} <span className="font-mono text-slate-800">{b.value}</span>
                </span>
              ))}
            </div>
          )}

          {e.steps.length > 0 && (
            <>
              <p className="mt-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                What this run did
              </p>
              <ul className="mt-1 space-y-0.5">
                {e.steps.map((s, i) => <StepLine key={i} s={s} />)}
              </ul>
            </>
          )}

          {extra}
        </FloatingCard>
      )}
    </td>
  );
}

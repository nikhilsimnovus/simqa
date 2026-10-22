'use client';

// Post-Execution Processing: the rules a row is checked against once its
// execution finishes.
//
// Sits in the Add a TestCase panel because that is when you know what the
// test is supposed to do. Each rule asks one question of one OTA RRC/NAS
// message in that execution's own log.
//
// Two things the UI has to get right, both learned from the real logs:
//
//   * The message name is free text, because the names belong to the box,
//     not to us — it logs "RRC reconfiguration", "Registration accept",
//     "PDU session establishment accept". A rule written as
//     "RRCReconfiguration" finds the same messages: the processor compares
//     with case and separators removed.
//
//   * Only the fields the chosen mode actually uses are shown. Asking for an
//     expected string when the mode is Message Count Only is how a form
//     teaches people to type something meaningless to get past it.

import React from 'react';

export type ValidationMode = 'count' | 'content' | 'countAndContent';
export type StringCondition = 'ALL' | 'ANY' | 'NONE';
export type Comparison = 'eq' | 'min' | 'max' | 'gt' | 'lt';

export interface PostRuleDraft {
  id: string;
  messageName: string;
  mode: ValidationMode;
  expectedStrings?: string[];
  condition?: StringCondition;
  matchMode?: 'contains' | 'exact';
  comparison?: Comparison;
  expectedMessageCount?: number;
  expectedMatchingCount?: number;
  expectedOccurrenceCount?: number;
}

const MODES: Array<{ id: ValidationMode; label: string; hint: string }> = [
  { id: 'count', label: 'Message Count Only', hint: 'how many of this message are in the log' },
  { id: 'content', label: 'Message Content Validation', hint: 'how many contain the expected string' },
  { id: 'countAndContent', label: 'Message Count and Content Validation', hint: 'both, and both must hold' },
];

/** Names seen in real Simnovator logs — offered as a hint, never a limit. */
const SEEN = [
  'RRC reconfiguration', 'RRC reconfiguration complete', 'RRC setup', 'RRC setup request',
  'RRC setup complete', 'RRC release', 'Measurement report', 'UE capability enquiry',
  'Security mode command', 'Security mode complete', 'DL information transfer',
  'UL information transfer', 'Registration request', 'Registration accept',
  'Registration complete', 'Authentication request', 'Authentication response',
  'PDU session establishment request', 'PDU session establishment accept',
  'UL NAS transport', 'DL NAS transport', 'SIB1', 'MIB',
];

export const newRuleId = () => `pr-${Math.random().toString(36).slice(2, 9)}`;

export function emptyRule(): PostRuleDraft {
  return { id: newRuleId(), messageName: '', mode: 'count', comparison: 'eq', expectedMessageCount: 1 };
}

const num = (v: string): number | undefined => {
  const n = Number(v);
  return v.trim() === '' || !Number.isFinite(n) ? undefined : Math.max(0, Math.floor(n));
};

export default function PostRules({ rules, onChange, compact }: {
  rules: PostRuleDraft[];
  onChange: (next: PostRuleDraft[]) => void;
  /** Tighter spacing for the per-row editor. */
  compact?: boolean;
}) {
  const set = (id: string, patch: Partial<PostRuleDraft>) =>
    onChange(rules.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const drop = (id: string) => onChange(rules.filter((r) => r.id !== id));
  const add = () => onChange([...rules, emptyRule()]);

  return (
    <div className={compact ? 'space-y-2' : 'space-y-2'}>
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
          Post-Execution Processing
        </span>
        <span className="text-[11px] text-slate-400">
          {rules.length === 0
            ? 'no rules — the execution result stands on its own'
            : `${rules.length} rule${rules.length === 1 ? '' : 's'} checked against this row’s OTA log`}
        </span>
        <button type="button" onClick={add}
          className="ml-auto rounded-md border border-slate-300 hover:bg-slate-50 text-[11px] px-2 py-1">
          + Add rule
        </button>
      </div>

      {rules.map((r, i) => {
        const wantsContent = r.mode === 'content' || r.mode === 'countAndContent';
        const wantsTotal = r.mode === 'count' || r.mode === 'countAndContent';
        return (
          <div key={r.id} className="rounded-md border border-line bg-surface p-2 space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-semibold text-slate-500 tabular-nums">#{i + 1}</span>
              <button type="button" onClick={() => drop(r.id)}
                className="ml-auto text-[11px] text-red-600 hover:underline">remove</button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <label className="flex flex-col text-[11px] text-slate-600">
                OTA message (RRC or NAS)
                <input
                  list={`ota-${r.id}`}
                  value={r.messageName}
                  onChange={(e) => set(r.id, { messageName: e.target.value })}
                  placeholder="e.g. RRCReconfiguration"
                  className="mt-0.5 border border-slate-300 rounded px-2 py-1 text-xs" />
                {/* A hint, not a restriction: any name the log carries works. */}
                <datalist id={`ota-${r.id}`}>
                  {SEEN.map((n) => <option key={n} value={n} />)}
                </datalist>
                <span className="mt-0.5 text-[10px] text-slate-400">
                  spelling does not matter — RRCReconfiguration finds &quot;RRC reconfiguration&quot;
                </span>
              </label>

              <label className="flex flex-col text-[11px] text-slate-600">
                Validation mode
                <select value={r.mode}
                  onChange={(e) => set(r.id, { mode: e.target.value as ValidationMode })}
                  className="mt-0.5 border border-slate-300 rounded px-2 py-1 text-xs">
                  {MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>
                <span className="mt-0.5 text-[10px] text-slate-400">
                  {MODES.find((m) => m.id === r.mode)?.hint}
                </span>
              </label>
            </div>

            {/* Only what this mode uses. */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {wantsTotal && (
                <label className="flex flex-col text-[11px] text-slate-600">
                  Expected total message count
                  <input type="number" min={0} value={r.expectedMessageCount ?? ''}
                    onChange={(e) => set(r.id, { expectedMessageCount: num(e.target.value) })}
                    className="mt-0.5 border border-slate-300 rounded px-2 py-1 text-xs" />
                  <span className="mt-0.5 text-[10px] text-slate-400">instances of the message</span>
                </label>
              )}
              {wantsContent && (
                <label className="flex flex-col text-[11px] text-slate-600">
                  Expected matching message count
                  <input type="number" min={0} value={r.expectedMatchingCount ?? ''}
                    onChange={(e) => set(r.id, { expectedMatchingCount: num(e.target.value) })}
                    className="mt-0.5 border border-slate-300 rounded px-2 py-1 text-xs" />
                  <span className="mt-0.5 text-[10px] text-slate-400">
                    messages containing it — one containing it twice counts once
                  </span>
                </label>
              )}
              {wantsContent && (
                <label className="flex flex-col text-[11px] text-slate-600">
                  Expected string occurrences
                  <input type="number" min={0} value={r.expectedOccurrenceCount ?? ''}
                    onChange={(e) => set(r.id, { expectedOccurrenceCount: num(e.target.value) })}
                    placeholder="optional"
                    className="mt-0.5 border border-slate-300 rounded px-2 py-1 text-xs" />
                  <span className="mt-0.5 text-[10px] text-slate-400">
                    every appearance — leave blank to skip
                  </span>
                </label>
              )}
              <label className="flex flex-col text-[11px] text-slate-600">
                Count must be
{/* The symbols a requirement is written in, not words for them. */}
                <select value={r.comparison ?? 'eq'}
                  onChange={(e) => set(r.id, { comparison: e.target.value as Comparison })}
                  className="mt-0.5 border border-slate-300 rounded px-2 py-1 text-xs">
                  <option value="eq">=  (exactly)</option>
                  <option value="min">&gt;=  (at least)</option>
                  <option value="max">&lt;=  (at most)</option>
                  <option value="gt">&gt;  (more than)</option>
                  <option value="lt">&lt;  (fewer than)</option>
                </select>
              </label>
            </div>

            {wantsContent && (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <label className="sm:col-span-2 flex flex-col text-[11px] text-slate-600">
                  Expected string(s) inside the message
                  <input
                    value={(r.expectedStrings ?? []).join(', ')}
                    onChange={(e) => set(r.id, {
                      expectedStrings: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                    })}
                    placeholder="e.g. reconfigurationWithSync, secondaryCellGroup"
                    className="mt-0.5 border border-slate-300 rounded px-2 py-1 text-xs font-mono" />
                  <span className="mt-0.5 text-[10px] text-slate-400">
                    comma separated · matched inside this message only, never across the log
                  </span>
                  {/* The box prints ASN.1 value notation, people write the
                      spec's spelling. Saying so here is cheaper than a rule
                      that reports 0 and gives no reason. */}
                  <span className="mt-0.5 text-[10px] text-slate-400">
                    quotes and colons are ignored — <span className="font-mono">supportOfRedCap-r17: &quot;supported&quot;</span>{' '}
                    finds the log&rsquo;s <span className="font-mono">supportOfRedCap-r17 supported</span>
                  </span>
                </label>
                <label className="flex flex-col text-[11px] text-slate-600">
                  Condition
                  <select value={r.condition ?? 'ALL'}
                    onChange={(e) => set(r.id, { condition: e.target.value as StringCondition })}
                    className="mt-0.5 border border-slate-300 rounded px-2 py-1 text-xs">
                    <option value="ALL">ALL must be present</option>
                    <option value="ANY">ANY may be present</option>
                    <option value="NONE">NONE may be present</option>
                  </select>
                </label>
              </div>
            )}

            {!r.messageName.trim() && (
              <p className="text-[10px] text-amber-700">
                name the OTA message, or this rule cannot be checked
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

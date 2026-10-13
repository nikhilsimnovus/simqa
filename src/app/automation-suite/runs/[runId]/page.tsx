'use client';

// One run, opened from the Automation Suite's History.
//
// What happened, in the order someone asks it: where it ran and on what
// build, what each test case came to, why, and the configs it ran with —
// the ones in /root/automation_configs, which are what was actually deployed.
//
// Modelled on the Job Tracker's job detail, which answers the same questions
// for a build and a playlist.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { cn } from '@/lib/cn';
import { statusStyle, verdictClass, statusLabel, verdictLabel, type StatusLabel, type VerdictLabel } from '@/lib/automation/outcome';
import { elapsed } from '../../SuiteHistory';
// The box's own account of an execution: its status, its result, and the
// checks behind them.
import { boxExecutionsOf, type BoxExecution } from '@/lib/boxExecutions';

interface Step {
  testcaseId: string;
  ok?: boolean;
  verdict?: string;
  boxStatus?: string;
  boxResult?: string;
  stopped?: boolean;
  detail?: string;
  durationMs?: number;
  boxTestcaseId?: string;
  executionId?: string;
}
interface Run {
  runId: string;
  suiteId: string;
  suiteName: string;
  kind?: string;
  uesimHost?: string;
  boxUser?: string;
  callboxHost?: string;
  startedAt: string;
  finishedAt?: string;
  total: number;
  passed: number;
  failed: number;
  buildVersion?: string;
  submittedBy?: string;
  steps: Step[];
}

/** The files a row is deployed from, in the order they matter. */
const CONFIG_ORDER = ['test.json', 'ue.cfg', 'enb.cfg', 'mme.cfg', 'ims.cfg', 'ots.cfg'];

/** What the box said about one execution, or why it could not be asked. */
type BoxResultState =
  | { state: 'loading' }
  | { state: 'error'; error: string }
  | { state: 'ok'; exec: BoxExecution };

/**
 * The Simnovator's own account of an execution: the two words it reports, and
 * the checks it measured them from.
 *
 * Every number here is the box's. Nothing is recomputed — a verdict SimQA
 * worked out for itself is a different claim, and this panel exists precisely
 * so the box's can be read without one.
 */
function BoxValidation({ state }: { state?: BoxResultState }) {
  if (!state || state.state === 'loading') {
    return <div className="mt-1 text-[11px] text-slate-400">Asking the Simnovator…</div>;
  }
  if (state.state === 'error') {
    return <div className="mt-1 text-[11px] text-amber-700">{state.error}</div>;
  }

  const { exec } = state;
  return (
    <div className="mt-1.5 space-y-1.5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
        <span className="text-slate-500">
          Status <span className="font-mono text-slate-800">{exec.status ?? '–'}</span>
        </span>
        <span className="text-slate-500">
          Verdict <span className="font-mono text-slate-800">{exec.result ?? '–'}</span>
        </span>
        {exec.simulatorName
          ? <span className="text-slate-500">on <span className="font-mono text-slate-700">{exec.simulatorName}</span></span>
          : null}
        {exec.durationSec !== undefined
          ? <span className="text-slate-500">took <span className="font-mono text-slate-700">{exec.durationSec}s</span></span>
          : null}
      </div>

      {/* A run still in flight has no measurements, and "no failures" must not
          read as "passed" — see BoxExecution.running. */}
      {exec.running
        ? <div className="text-[11px] text-amber-700">Still executing on the box — no measurements yet.</div>
        : exec.parseError
          ? <div className="text-[11px] text-amber-700">{exec.parseError}</div>
          : exec.checks.length === 0
            ? <div className="text-[11px] text-slate-400">The box recorded no checks for this execution.</div>
            : (
              <table className="w-full text-[11px]">
                <thead className="text-slate-500">
                  <tr>
                    <th className="text-left font-medium py-0.5 pr-3">Check</th>
                    <th className="text-left font-medium py-0.5 pr-3">Condition</th>
                    <th className="text-right font-medium py-0.5 pr-3">Needed</th>
                    <th className="text-right font-medium py-0.5 pr-3">Got</th>
                    <th className="text-right font-medium py-0.5">Verdict</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {exec.checks.map((c, n) => (
                    <tr key={`${c.group}-${c.name}-${n}`}>
                      <td className="py-0.5 pr-3 text-slate-700 break-words">{c.name}</td>
                      <td className="py-0.5 pr-3 font-mono text-slate-500 break-all">{c.condition || '–'}</td>
                      <td className="py-0.5 pr-3 text-right font-mono text-slate-600">{c.demand ?? '–'}</td>
                      <td className="py-0.5 pr-3 text-right font-mono text-slate-800">{c.achieved ?? '–'}</td>
                      <td className={cn('py-0.5 text-right font-medium',
                        c.verdict ? 'text-emerald-700' : 'text-red-700')}>
                        {c.verdict ? 'PASS' : 'FAIL'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
    </div>
  );
}

const stamp = (iso?: string) =>
  iso ? new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '–';

export default function RunDetailPage({ params }: { params: Promise<{ runId: string }> }) {
  const [runId, setRunId] = useState('');
  const [run, setRun] = useState<Run | null>(null);
  const [err, setErr] = useState('');
  /**
   * The test case the History's Preview was clicked on, from `?tc=`.
   *
   * The run id already pins WHICH execution — so a test case that has been
   * run five times, or edited between runs, opens on the one that was
   * clicked rather than on the latest. This picks the row within it: it is
   * highlighted and scrolled to, which is what matters in a run of ten.
   */
  const [focus, setFocus] = useState<string | null>(null);
  /** Where the run executed, as ids the testcase route can resolve credentials
   *  from. Null when neither the suite nor the recorded host still names a
   *  registered system. */
  const [box, setBox] = useState<{ systemId: string; boxUserId: string | null } | null>(null);
  /** The Simnovator's own account of each execution, by test case name. */
  const [boxResults, setBoxResults] = useState<Record<string, BoxResultState>>({});
  /** Which row's configs are open, and what the server holds for it. */
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [files, setFiles] = useState<Record<string, Array<{ name: string; bytes: number }>>>({});
  const [shown, setShown] = useState<{ row: string; file: string; text: string } | null>(null);

  useEffect(() => { void params.then(p => setRunId(p.runId)); }, [params]);

  // Read on mount rather than with useSearchParams, which would put this
  // whole page behind a Suspense boundary for one optional string.
  useEffect(() => {
    try {
      const tc = new URLSearchParams(window.location.search).get('tc');
      if (tc) setFocus(tc);
    } catch { /* no focus is fine — the whole run is still shown */ }
  }, []);

  /**
   * Ask the Simnovator what it made of one execution.
   *
   * By executionId, not "the latest": a row's test case may have run many
   * times, and this page is about the run it is opened on. An execution the
   * box no longer lists says so rather than falling back to a newer one.
   *
   * Loaded when the Validation disclosure is opened, so a run of ten rows
   * costs one box call rather than ten.
   */
  const loadBoxResult = useCallback(async (st: Step) => {
    if (!st.executionId || !st.boxTestcaseId) return;
    if (boxResults[st.testcaseId]) return;                      // already asked
    if (!box?.systemId) {
      setBoxResults(p => ({
        ...p,
        [st.testcaseId]: {
          state: 'error',
          error: 'The Simnovator this ran on is no longer registered, so its own record cannot be read.',
        },
      }));
      return;
    }
    setBoxResults(p => ({ ...p, [st.testcaseId]: { state: 'loading' } }));
    try {
      const qs = new URLSearchParams({ systemId: box.systemId });
      if (box.boxUserId) qs.set('boxUserId', box.boxUserId);
      // That route answers with the testcase spread at the top level and no
      // `ok` flag — a failure is an `error` field. Reading it as ok/not-ok
      // would have made every successful call look like a failure.
      const r = await fetch(`/api/testcases/${encodeURIComponent(st.boxTestcaseId)}?${qs}`,
        { cache: 'no-store' }).then(x => x.json());
      if (r?.error) throw new Error(String(r.error));
      const exec = boxExecutionsOf(r?.metadata)
        .find(x => x.executionId === st.executionId);
      setBoxResults(p => ({
        ...p,
        [st.testcaseId]: exec
          ? { state: 'ok', exec }
          : {
              state: 'error',
              error: `The box no longer lists execution ${String(st.executionId).slice(0, 8)} for this test case.`,
            },
      }));
    } catch (e: unknown) {
      setBoxResults(p => ({
        ...p,
        [st.testcaseId]: { state: 'error', error: (e as Error)?.message ?? String(e) },
      }));
    }
  }, [box, boxResults]);

  // Scroll the clicked test case into view once the run has painted.
  useEffect(() => {
    if (!focus || !run) return;
    const el = document.getElementById(`tc-${encodeURIComponent(focus)}`);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [focus, run]);

  useEffect(() => {
    if (!runId) return;
    void (async () => {
      try {
        const r = await fetch(`/api/automation/runs/${encodeURIComponent(runId)}`, { cache: 'no-store' }).then(x => x.json());
        if (!r?.ok) throw new Error(r?.error ?? 'that run is not on file');
        setRun(r.run);
        setBox(r.box ?? null);
      } catch (e: unknown) { setErr((e as Error)?.message ?? String(e)); }
    })();
  }, [runId]);

  /** What the automation server holds for one row of this run's suite. */
  const loadFiles = useCallback(async (row: string) => {
    if (!run) return;
    if (files[row]) return;
    try {
      const r = await fetch(
        `/api/automation/suites/${encodeURIComponent(run.suiteId)}/files?row=${encodeURIComponent(row)}`,
        { cache: 'no-store' }).then(x => x.json());
      setFiles(prev => ({ ...prev, [row]: r?.ok ? (r.rows?.[0]?.files ?? []) : [] }));
    } catch { setFiles(prev => ({ ...prev, [row]: [] })); }
  }, [run, files]);

  const showFile = useCallback(async (row: string, file: string) => {
    if (!run) return;
    setShown({ row, file, text: 'reading…' });
    try {
      const r = await fetch(
        `/api/automation/suites/${encodeURIComponent(run.suiteId)}/files?row=${encodeURIComponent(row)}&file=${encodeURIComponent(file)}`,
        { cache: 'no-store' }).then(x => x.json());
      setShown({ row, file, text: r?.ok ? r.text : (r?.error ?? 'could not be read') });
    } catch (e: unknown) {
      setShown({ row, file, text: (e as Error)?.message ?? String(e) });
    }
  }, [run]);

  if (err) {
    return (
      <div className="min-h-screen bg-slate-50 px-6 py-8">
        <Link href="/automation-suite" className="text-sm text-primary-700 hover:underline">← Automation Suites</Link>
        <p className="mt-4 text-sm text-red-700">{err}</p>
      </div>
    );
  }
  if (!run) {
    return <div className="min-h-screen bg-slate-50 px-6 py-8 text-sm text-slate-500">Reading the run…</div>;
  }

  const rows = run.steps ?? [];

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="max-w-6xl mx-auto px-6 py-8">
        <Link href="/automation-suite" className="text-sm text-primary-700 hover:underline">← Automation Suites</Link>
        <h1 className="mt-2 text-2xl font-bold text-slate-900">{run.suiteName}</h1>
        <p className="text-xs text-slate-500 font-mono">{run.runId}</p>

        {/* ── Details ─────────────────────────────────────────────── */}
        <section className="mt-5 bg-surface border border-line rounded-xl p-5">
          <h2 className="text-sm font-semibold text-slate-900 mb-3">Details</h2>
          <dl className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-3 text-sm">
            <div>
              <dt className="text-slate-500 text-xs">Suite</dt>
              <dd className="text-slate-900">
                <Link href="/automation-suite" className="hover:underline">{run.suiteName}</Link>
              </dd>
            </div>
            <div>
              <dt className="text-slate-500 text-xs">Simnovator</dt>
              <dd className="font-mono text-slate-900">{run.uesimHost ?? '–'}</dd>
            </div>
            <div>
              <dt className="text-slate-500 text-xs">User</dt>
              <dd className="text-slate-900">{run.boxUser ?? '–'}</dd>
            </div>
            <div>
              <dt className="text-slate-500 text-xs">Execution time</dt>
              <dd className="text-slate-900">
                {elapsed(run.startedAt, run.finishedAt)}
                <span className="ml-1.5 text-xs text-slate-500">{stamp(run.startedAt)}</span>
              </dd>
            </div>
            {/* The build the Simnovator was on, read from it when the run
                started. Here rather than in a panel of its own: it is a fact
                about this execution, like the host and the login. */}
            <div>
              <dt className="text-slate-500 text-xs">Build</dt>
              <dd className="text-slate-900">{run.buildVersion ?? '–'}</dd>
            </div>
            {run.callboxHost && (
              <div>
                <dt className="text-slate-500 text-xs">Callbox</dt>
                <dd className="font-mono text-slate-900">{run.callboxHost}</dd>
              </div>
            )}
            {run.submittedBy && (
              <div>
                <dt className="text-slate-500 text-xs">Started by</dt>
                <dd className="text-slate-900">{run.submittedBy}</dd>
              </div>
            )}
            <div>
              <dt className="text-slate-500 text-xs">Result</dt>
              <dd className="text-slate-900">{run.passed} passed · {run.failed} failed of {run.total}</dd>
            </div>
          </dl>
        </section>

        {/* ── Test cases ──────────────────────────────────────────── */}
        <section className="mt-5 bg-surface border border-line rounded-xl overflow-hidden">
          <h2 className="text-sm font-semibold text-slate-900 px-5 py-3 border-b border-line">
            Test cases ({rows.length})
          </h2>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">Test case</th>
                  <th className="text-left px-4 py-2 font-medium whitespace-nowrap">Status</th>
                  <th className="text-left px-4 py-2 font-medium whitespace-nowrap">Verdict</th>
                  <th className="text-left px-4 py-2 font-medium whitespace-nowrap">Took</th>
                  <th className="text-left px-4 py-2 font-medium whitespace-nowrap">Configs</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((st, i) => {
                  const o = { boxStatus: st.boxStatus, boxResult: st.boxResult, verdict: st.verdict, stopped: st.stopped };
                  const label = statusLabel(o);
                  const sty = statusStyle(label as StatusLabel);
                  const vd = verdictLabel(o);
                  const open = openRow === st.testcaseId;
                  return (
                    <tr key={`${st.testcaseId}-${i}`}
                      id={`tc-${encodeURIComponent(st.testcaseId)}`}
                      className={cn(
                        'align-top',
                        // The row the History's Preview was clicked on.
                        focus === st.testcaseId && 'bg-primary-50/70 ring-1 ring-inset ring-primary-300',
                      )}>
                      <td className="px-4 py-2.5">
                        <div className="text-slate-900">{st.testcaseId}</div>

                        {/* Validation: the Simnovator's own account of this
                            execution — its status, its verdict, and the checks
                            it measured them from (Avg_DL_BLER<=5%,
                            rrc_measurement_report>=1, …). Fetched from the box
                            on demand, because this is the question this page
                            exists to answer and it is the box's answer that
                            counts.

                            It replaces what used to sit here: SimQA's own list
                            of steps, labelled "Result". That was never a
                            result — it is what SimQA did, which matters when a
                            row goes wrong and is beside the point when asking
                            what the test came to. It is still available, one
                            disclosure further in. */}
                        {st.executionId && st.boxTestcaseId && (
                          <details className="mt-1"
                            onToggle={(e) => {
                              if ((e.currentTarget as HTMLDetailsElement).open) void loadBoxResult(st);
                            }}>
                            <summary className="text-[11px] text-primary-700 cursor-pointer hover:underline">
                              Validation
                            </summary>
                            <BoxValidation state={boxResults[st.testcaseId]} />
                          </details>
                        )}

                        {st.detail && (
                          <details className="mt-1">
                            <summary className="text-[11px] text-slate-500 cursor-pointer hover:underline">
                              What SimQA did
                            </summary>
                            <ul className="mt-1 space-y-0.5">
                              {String(st.detail).split(' · ').map((bit, n) => (
                                <li key={n} className="text-[11px] text-slate-600 font-mono break-all">{bit}</li>
                              ))}
                            </ul>
                          </details>
                        )}
                      </td>
                      {/* The Simnovator's own words. The label maps only
                          change the capitalisation, so the raw pair off the
                          execution record is printed underneath — this page is
                          where someone comes to check a result against the
                          box, and quoting it verbatim is the point. */}
                      <td className={cn('px-4 py-2.5 whitespace-nowrap', sty.cls)}>
                        {sty.dot} {label}
                        {st.boxStatus && st.boxStatus.toUpperCase() !== label.toUpperCase().replace(/ /g, '_')
                          ? <div className="text-[10px] font-mono text-slate-400">{st.boxStatus}</div>
                          : null}
                      </td>
                      <td className={cn('px-4 py-2.5 whitespace-nowrap', verdictClass(vd as VerdictLabel))}>
                        {vd || '–'}
                        {st.boxResult && st.boxResult.toUpperCase() !== vd.toUpperCase().replace(/ /g, '_')
                          ? <div className="text-[10px] font-mono text-slate-400">{st.boxResult}</div>
                          : null}
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap text-xs text-slate-600">
                        {st.durationMs ? `${Math.round(st.durationMs / 1000)}s` : '–'}
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap">
                        <button type="button"
                          onClick={() => { const next = open ? null : st.testcaseId; setOpenRow(next); if (next) void loadFiles(next); }}
                          className="text-xs text-primary-700 hover:underline">
                          {open ? 'Hide' : 'Show'}
                        </button>
                        {open && (
                          <div className="mt-1.5 flex flex-wrap gap-1.5 max-w-sm">
                            {(files[st.testcaseId] ?? []).length === 0
                              ? <span className="text-[11px] text-slate-400">nothing saved for this row</span>
                              : [...(files[st.testcaseId] ?? [])]
                                .sort((a, b) => {
                                  const ai = CONFIG_ORDER.indexOf(a.name); const bi = CONFIG_ORDER.indexOf(b.name);
                                  return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi) || a.name.localeCompare(b.name);
                                })
                                .map(f => (
                                  <button key={f.name} type="button"
                                    onClick={() => void showFile(st.testcaseId, f.name)}
                                    title={`${f.bytes} bytes`}
                                    className="rounded border border-line px-1.5 py-0.5 text-[10px] font-mono text-slate-700 hover:bg-slate-100">
                                    {f.name}
                                  </button>
                                ))}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        {/* The config being read. The files are what /root/automation_configs
            holds for the row — which is what was deployed. */}
        {shown && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4"
            onClick={() => setShown(null)}>
            <div className="bg-surface rounded-xl shadow-xl border border-line max-w-4xl w-full max-h-[80vh] flex flex-col"
              onClick={e => e.stopPropagation()}>
              <div className="flex items-baseline justify-between gap-4 px-5 py-3 border-b border-line">
                <h3 className="text-sm font-semibold text-slate-900 font-mono">{shown.file}</h3>
                <span className="text-xs text-slate-500 truncate">{shown.row}</span>
                <button onClick={() => setShown(null)} className="text-sm text-slate-500 hover:text-slate-800">Close</button>
              </div>
              <pre className="flex-1 overflow-auto px-5 py-3 text-[11px] font-mono text-slate-700 whitespace-pre-wrap break-all">
                {shown.text}
              </pre>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

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

const stamp = (iso?: string) =>
  iso ? new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '–';

export default function RunDetailPage({ params }: { params: Promise<{ runId: string }> }) {
  const [runId, setRunId] = useState('');
  const [run, setRun] = useState<Run | null>(null);
  const [err, setErr] = useState('');
  /** Which row's configs are open, and what the server holds for it. */
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [files, setFiles] = useState<Record<string, Array<{ name: string; bytes: number }>>>({});
  const [shown, setShown] = useState<{ row: string; file: string; text: string } | null>(null);

  useEffect(() => { void params.then(p => setRunId(p.runId)); }, [params]);

  useEffect(() => {
    if (!runId) return;
    void (async () => {
      try {
        const r = await fetch(`/api/automation/runs/${encodeURIComponent(runId)}`, { cache: 'no-store' }).then(x => x.json());
        if (!r?.ok) throw new Error(r?.error ?? 'that run is not on file');
        setRun(r.run);
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
                    <tr key={`${st.testcaseId}-${i}`} className="align-top">
                      <td className="px-4 py-2.5">
                        <div className="text-slate-900">{st.testcaseId}</div>
                        {/* The Result: every step the run took for this row,
                            in its own words. Called logs once, which it never
                            was — these are what SimQA did, not what the box
                            printed. */}
                        {st.detail && (
                          <details className="mt-1">
                            <summary className="text-[11px] text-primary-700 cursor-pointer hover:underline">Result</summary>
                            <ul className="mt-1 space-y-0.5">
                              {String(st.detail).split(' · ').map((bit, n) => (
                                <li key={n} className="text-[11px] text-slate-600 font-mono break-all">{bit}</li>
                              ))}
                            </ul>
                          </details>
                        )}
                      </td>
                      <td className={cn('px-4 py-2.5 whitespace-nowrap', sty.cls)}>{sty.dot} {label}</td>
                      <td className={cn('px-4 py-2.5 whitespace-nowrap', verdictClass(vd as VerdictLabel))}>{vd || '–'}</td>
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

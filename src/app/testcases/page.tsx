'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Header } from '@/components/Header';
import { Card, CardBody, CardHeader, Input, Badge, Button } from '@/components/ui';
import { cn } from '@/lib/cn';
import { ArrowUp, ArrowDown, ArrowUpDown } from 'lucide-react';

interface Tc {
  id: string;
  name: string;
  description?: string;
  metadata?: any;
}

interface SystemSummary { id: string; name: string; host: string }

/** Remembers the chosen box across visits. */
const LS_SYSTEM = 'simqa-testcases-system';

/** Verdicts the box actually reports, plus the two states it has no verdict
 *  for: currently executing, and never executed. */
type ResultKey = 'inprogress' | 'pass' | 'incomplete' | 'fail' | 'error' | 'norun';

const RESULT_FILTERS: Array<{ key: ResultKey; label: string }> = [
  { key: 'inprogress', label: 'In progress' },
  { key: 'pass',       label: 'Pass' },
  { key: 'incomplete', label: 'Incomplete' },
  { key: 'fail',       label: 'Fail' },
  { key: 'error',      label: 'Error' },
  { key: 'norun',      label: 'Not Executed' },
];

export default function TestcasesPage() {
  const [items, setItems] = useState<Tc[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  // Verdicts the box actually reports: PASS / INCOMPLETE / FAIL / ERROR,
  // plus testcases that have never run at all.
  /** Selected verdicts. EMPTY means ALL — no filtering — which is what the
   *  "ALL" checkbox represents; ticking individual results narrows from there,
   *  and several can be combined. */
  const [results, setResults] = useState<Set<ResultKey>>(new Set());
  /** Whether the Last-result checkbox panel is open. */
  const [resultOpen, setResultOpen] = useState(false);
  const resultMenuRef = useRef<HTMLDivElement | null>(null);
  // Id of the testcase the selected box is executing right now, if any.
  const [runningId, setRunningId] = useState<string | null>(null);
  // Column sort. null key = the box's own order.
  const [sortKey, setSortKey] = useState<'name' | 'result' | 'executed' | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [executed, setExecuted] = useState<'any' | '1d' | '7d' | '30d' | 'never'>('any');
  // Render in pages so 842 rows don't all hit the DOM at once; grows as you
  // scroll toward the end of the list.
  const PAGE = 100;
  const [visible, setVisible] = useState(PAGE);
  // Which box to list from. Empty = let the server pick the first UESIM.
  // Seeded from the URL so returning from a testcase keeps the box you were
  // browsing, then from localStorage so a fresh visit does too.
  const router = useRouter();
  const urlSystemId = useSearchParams().get('systemId') ?? '';
  const [systems, setSystems] = useState<SystemSummary[]>([]);
  const [systemId, setSystemId] = useState<string>(urlSystemId);
  const [host, setHost] = useState<string>('');

  // Persist the choice and mirror it into the URL, so Back and a refresh both
  // land on the same box.
  const chooseSystem = useCallback((id: string) => {
    setSystemId(id);
    try { window.localStorage.setItem(LS_SYSTEM, id); } catch { /* private mode */ }
    router.replace(id ? `/testcases?systemId=${encodeURIComponent(id)}` : '/testcases', { scroll: false });
  }, [router]);
  // The listing call is slow (the box takes ~2s for 500 testcases), so it must
  // fire ONCE. Gate it until the picker has resolved: without this the first
  // render fetched with an empty systemId, then setSystemId re-fired the same
  // request — two full box round-trips on every visit.
  const [systemsReady, setSystemsReady] = useState(false);
  // The page <Header> is sticky at 56px (h-14) inside the scrolling content
  // column. The toolbar sticks directly below it, and the table head below the
  // toolbar — whose height changes when the controls wrap, so measure it
  // rather than hard-coding an offset.
  const HEADER_H = 56;
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const [toolbarH, setToolbarH] = useState(0);
  useEffect(() => {
    const el = toolbarRef.current;
    if (!el) return;
    const measure = () => setToolbarH(el.getBoundingClientRect().height);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [systems.length]);

  useEffect(() => {
    fetch('/api/ui-tests/systems')
      .then((r) => r.json())
      .then((d) => {
        // Simnovators only. That endpoint also returns callboxes and UE hosts
        // (valid UI-test targets), but none of them serve the testcase REST
        // API — offering them just hands you a box that can't answer.
        const list: SystemSummary[] = (d?.systems ?? [])
          .filter((s: any) => s.type === 'SIMNOVATOR' || s.type === 'SIMNOVATOR_GUI')
          .map((s: any) => ({ id: s.id, name: s.name, host: s.host }));
        setSystems(list);
        // Precedence: URL (came from Back) > last choice > first box. Only
        // accept a remembered id that still exists in inventory.
        setSystemId((cur) => {
          if (cur && list.some((s) => s.id === cur)) return cur;
          let saved = '';
          try { saved = window.localStorage.getItem(LS_SYSTEM) ?? ''; } catch { /* private mode */ }
          if (saved && list.some((s) => s.id === saved)) return saved;
          return list[0]?.id ?? '';
        });
      })
      .catch(() => { /* picker just stays empty — listing still works */ })
      .finally(() => setSystemsReady(true));
  }, []);

  const load = useCallback((refresh = false) => {
    setLoading(true);
    setErr(null);
    // No limit — the route pages the box and returns the whole catalogue.
    const qs = new URLSearchParams();
    if (systemId) qs.set('systemId', systemId);
    if (refresh) qs.set('refresh', '1');
    fetch(`/api/testcases?${qs}`)
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d?.error ?? `HTTP ${r.status}`);
        return d;
      })
      .then((d) => { setItems(d.items ?? []); setTotal(d.total ?? null); setHost(d.host ?? ''); })
      .catch((e) => { setItems([]); setTotal(null); setErr(e.message ?? String(e)); })
      .finally(() => setLoading(false));
  }, [systemId]);

  // A real browser reload bypasses the route's 30s cache: refreshing the page is
  // how you ask for current state, and serving a cached list then makes it look
  // like nothing changed. In-app navigation still uses the cache, which is what
  // keeps returning to this page instant.
  useEffect(() => {
    if (!systemsReady) return;
    let reloaded = false;
    try {
      const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
      reloaded = nav?.type === 'reload';
    } catch { /* older browsers: treat as a normal visit */ }
    load(reloaded);
  }, [systemsReady, load]);

  // Poll what the selected box is running so the row flips to IN PROGRESS and
  // back to its verdict without a manual reload.
  useEffect(() => {
    if (!systemsReady) return;
    let stop = false;
    const tick = async () => {
      try {
        const qs = systemId ? `?systemId=${encodeURIComponent(systemId)}` : '';
        const d = await (await fetch(`/api/executions${qs}`, { cache: 'no-store' })).json();
        if (!stop) setRunningId(d?.busy ? (d.execution?.testCaseId ?? null) : null);
      } catch { /* keep the last known state */ }
    };
    tick();
    const t = setInterval(tick, 5000);
    return () => { stop = true; clearInterval(t); };
  }, [systemsReady, systemId]);

  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase();
    const now = Date.now();
    const DAY = 86_400_000;
    return items.filter((tc) => {
      // Name only — searching the id too meant a stray hex string matched
      // testcases whose names had nothing to do with the query.
      if (ql && !(tc.name ?? '').toLowerCase().includes(ql)) return false;

      const last = tc.metadata?.lastExecution;
      const verdict = String(last?.result ?? '').toLowerCase();
      const running = tc.id === runningId;

      // Empty selection = ALL, so no filtering at all.
      if (results.size > 0) {
        // A running testcase still reports its PREVIOUS verdict, so it counts as
        // "in progress" and nothing else; likewise a never-executed one is
        // "not executed" rather than any verdict.
        const key: ResultKey | null =
          running ? 'inprogress'
          : !last?.executedOn ? 'norun'
          : (['pass', 'incomplete', 'fail', 'error'] as const).includes(verdict as any) ? (verdict as ResultKey)
          : null;
        if (!key || !results.has(key)) return false;
      }

      if (executed !== 'any') {
        const at = last?.executedOn ? new Date(last.executedOn).getTime() : NaN;
        if (executed === 'never') { if (Number.isFinite(at)) return false; }
        else {
          if (!Number.isFinite(at)) return false;
          const days = executed === '1d' ? 1 : executed === '7d' ? 7 : 30;
          if (now - at > days * DAY) return false;
        }
      }
      return true;
    });
  }, [items, q, results, executed, runningId]);

  // Close the Last-result panel on an outside click, so it behaves like a
  // native <select> rather than staying open until re-clicked.
  useEffect(() => {
    if (!resultOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!resultMenuRef.current?.contains(e.target as Node)) setResultOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [resultOpen]);

  /** What the closed dropdown shows: "ALL", the single chosen label, or a count
   *  once several are ticked (the labels don't fit). */
  const resultSummary = useMemo(() => {
    if (results.size === 0) return 'ALL';
    if (results.size === 1) {
      const only = [...results][0];
      return RESULT_FILTERS.find((f) => f.key === only)?.label ?? 'ALL';
    }
    return `${results.size} selected`;
  }, [results]);

  /** Text shown in the Last Result column — what sorting should follow. */
  const resultText = useCallback((tc: Tc) => (
    tc.id === runningId ? 'IN PROGRESS' : (tc.metadata?.lastExecution?.result ?? '')
  ), [runningId]);

  const sorted = useMemo(() => {
    if (!sortKey) return filtered;
    const dir = sortDir === 'asc' ? 1 : -1;
    const when = (tc: Tc) => {
      const at = tc.metadata?.lastExecution?.executedOn;
      const t = at ? new Date(at).getTime() : NaN;
      // Never-run rows sort together at the bottom of ascending order.
      return Number.isFinite(t) ? t : -Infinity;
    };
    // Copy first — filtered is memoised and must not be mutated in place.
    return [...filtered].sort((a, b) => {
      if (sortKey === 'executed') return (when(a) - when(b)) * dir;
      const av = sortKey === 'name' ? (a.name ?? '') : resultText(a);
      const bv = sortKey === 'name' ? (b.name ?? '') : resultText(b);
      return av.localeCompare(bv, undefined, { numeric: true, sensitivity: 'base' }) * dir;
    });
  }, [filtered, sortKey, sortDir, resultText]);

  /** Click a header: first click sorts ascending, clicking again flips it.
   *  Both setters are called at the top level — nesting setSortDir inside the
   *  setSortKey updater made the flip cancel itself out, because React invokes
   *  updaters twice in development. */
  const toggleSort = useCallback((key: 'name' | 'result' | 'executed') => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  }, [sortKey]);

  // Any change to the result set starts the paging over.
  useEffect(() => { setVisible(PAGE); }, [items, q, results, executed, sortKey, sortDir]);

  const shown = Math.min(visible, sorted.length);
  const rows = useMemo(() => sorted.slice(0, visible), [sorted, visible]);

  // Sentinel just past the last rendered row — when it scrolls into view, add
  // another page. Uses the viewport as root so it works regardless of which
  // ancestor is the scroll container.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || shown >= sorted.length) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setVisible((v) => Math.min(v + PAGE, sorted.length));
      }
    }, { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [shown, sorted.length]);

  return (
    <>
      <Header
        title="Test Case and Validate"
        subtitle={total != null ? `Showing ${shown} of ${sorted.length} items` : 'loading…'}
        uesimHost={host || undefined}
      />
      <main className="p-6">
        <Card>
          <CardHeader
            ref={toolbarRef}
            style={{ top: HEADER_H }}
            className="flex flex-wrap items-center gap-3 justify-start sticky z-20 bg-white rounded-t-lg px-4 py-2.5"
          >
            <div className="flex items-center gap-2 flex-wrap">
              {systems.length > 0 && (
                <label className="flex items-center gap-1.5">
                  <span className="text-[10px] uppercase tracking-wider text-slate-400 font-medium">SIM</span>
                  <select
                    value={systemId}
                    onChange={(e) => chooseSystem(e.target.value)}
                    className="border border-slate-300 rounded-md px-2 py-1 text-sm"
                  >
                    {systems.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.host})</option>)}
                  </select>
                </label>
              )}
              <Input
                placeholder="Search Test case…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                className="w-72 h-8"
              />
              {/* Multi-select as a dropdown: a normal <select> can't hold
                  checkboxes, so this is a button that opens a checkbox panel.
                  Keeps the toolbar to one control while still allowing several
                  verdicts at once. */}
              <div className="relative" ref={resultMenuRef}>
                <label className="flex items-center gap-1.5">
                  <span className="text-[10px] uppercase tracking-wider text-slate-400 font-medium">Last result</span>
                  <button
                    type="button"
                    onClick={() => setResultOpen((o) => !o)}
                    className="border border-slate-300 rounded-md px-2 py-1 text-sm bg-white min-w-[150px] text-left flex items-center justify-between gap-2"
                  >
                    <span className="truncate">{resultSummary}</span>
                    <span className="text-slate-400 text-[10px]">▼</span>
                  </button>
                </label>
                {resultOpen && (
                  <div className="absolute z-20 mt-1 right-0 w-56 rounded-md border border-slate-200 bg-white shadow-lg p-1.5">
                    {/* ALL is "nothing selected" rather than a value of its own,
                        so ticking it simply clears the rest. */}
                    <label className="flex items-center gap-2 text-sm cursor-pointer px-2 py-1 rounded hover:bg-slate-50">
                      <input
                        type="checkbox"
                        checked={results.size === 0}
                        onChange={() => setResults(new Set())}
                      />
                      <span className="font-medium">ALL</span>
                    </label>
                    <div className="my-1 border-t border-slate-100" />
                    {RESULT_FILTERS.map(({ key, label }) => (
                      <label key={key} className="flex items-center gap-2 text-sm cursor-pointer px-2 py-1 rounded hover:bg-slate-50">
                        <input
                          type="checkbox"
                          checked={results.has(key)}
                          onChange={() => {
                            const next = new Set(results);
                            if (next.has(key)) next.delete(key); else next.add(key);
                            setResults(next);
                          }}
                        />
                        <span>{label}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
              <label className="flex items-center gap-1.5">
                <span className="text-[10px] uppercase tracking-wider text-slate-400 font-medium">Last executed</span>
                <select
                  value={executed}
                  onChange={(e) => setExecuted(e.target.value as typeof executed)}
                  className="border border-slate-300 rounded-md px-2 py-1 text-sm"
                >
                  <option value="any">Any time</option>
                  <option value="1d">Last 24 hours</option>
                  <option value="7d">Last 7 days</option>
                  <option value="30d">Last 30 days</option>
                  <option value="never">Never</option>
                </select>
              </label>
            </div>
          </CardHeader>
          <CardBody className="p-0">
            {err ? (
              <div className="p-5 text-sm text-red-700 bg-red-50">Error: {err}</div>
            ) : loading ? (
              <div className="p-5 text-sm text-slate-500">Loading…</div>
            ) : sorted.length === 0 ? (
              <div className="p-5 text-sm text-slate-500">No testcases match.</div>
            ) : (
              <div>
                {/* No overflow-x wrapper here: any non-visible overflow would
                    become the sticky containing block and the header row would
                    stop pinning to the page. */}
                <table className="w-full text-sm">
                  {/* sticky lives on the <th>s — sticky <thead> is unreliable. */}
                  <thead className="text-left text-xs uppercase tracking-wider text-slate-500">
                    <tr>
                      {([
                        { label: 'Test Case',     key: 'name' as const },
                        { label: 'Last Result',   key: 'result' as const },
                        { label: 'Last Executed', key: 'executed' as const },
                        { label: 'Action',        key: null },
                      ]).map(({ label, key }) => (
                        <th
                          key={label}
                          style={{ top: HEADER_H + toolbarH }}
                          className={cn(
                            'px-4 py-2 font-medium sticky z-10 bg-slate-50 border-b border-slate-200',
                            key === null && 'text-right',
                          )}
                        >
                          {key ? (
                            <button
                              onClick={() => toggleSort(key)}
                              title={`Sort by ${label}`}
                              className="inline-flex items-center gap-1 uppercase tracking-wider hover:text-slate-800"
                            >
                              {label}
                              {sortKey === key
                                ? (sortDir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)
                                : <ArrowUpDown className="h-3 w-3 opacity-30" />}
                            </button>
                          ) : label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {rows.map((tc) => {
                      const last = tc.metadata?.lastExecution;
                      return (
                        <tr key={tc.id} className="hover:bg-slate-50 transition-colors">
                          <td className="px-4 py-2">
                            <Link
                              href={`/testcases/${encodeURIComponent(tc.id)}${systemId ? `?systemId=${encodeURIComponent(systemId)}` : ''}`}
                              title={tc.name || tc.id}
                              className="font-medium text-slate-900 hover:text-primary-700"
                            >
                              {tc.name || tc.id}
                            </Link>
                          </td>
                          <td className="px-4 py-2"><ResultBadge value={last?.result} inProgress={tc.id === runningId} /></td>
                          <td className="px-4 py-2 text-xs text-slate-500">
                            {tc.id === runningId ? 'running now' : last?.executedOn ? new Date(last.executedOn).toLocaleString() : '—'}
                          </td>
                          <td className="px-4 py-2 text-right">
                            <Link href={`/testcases/${encodeURIComponent(tc.id)}${systemId ? `?systemId=${encodeURIComponent(systemId)}` : ''}`}>
                              <Button size="sm" variant="ghost">Preview</Button>
                            </Link>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {shown < sorted.length && (
                  <div ref={sentinelRef} className="px-5 py-4 text-xs text-slate-500">
                    Loading more… ({shown} of {sorted.length})
                  </div>
                )}
              </div>
            )}
          </CardBody>
        </Card>
      </main>
    </>
  );
}


function ResultBadge({ value, inProgress }: { value?: string; inProgress?: boolean }) {
  // A live execution outranks whatever the last finished run said — the box
  // keeps reporting the PREVIOUS result until the current one completes.
  if (inProgress)             return <Badge tone="info">IN PROGRESS</Badge>;
  if (value === 'PASS')       return <Badge tone="success">PASS</Badge>;
  if (value === 'FAIL')       return <Badge tone="danger">FAIL</Badge>;
  if (value === 'INCOMPLETE') return <Badge tone="warning">INCOMPLETE</Badge>;
  if (value === 'ERROR')      return <Badge tone="danger">ERROR</Badge>;
  return <Badge>NOT EXECUTED</Badge>;
}


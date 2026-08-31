'use client';

import { useEffect, useMemo, useState } from 'react';
import { Header } from '@/components/Header';
import { BackToRunHistory } from '@/components/BackToRunHistory';
import { Card, CardBody, CardHeader, CardTitle, Button, Badge, Stat, Input } from '@/components/ui';
import { CheckCircle2, XCircle, MinusCircle, Loader2, Beaker, Download, Copy, ChevronRight, ChevronDown, Filter } from 'lucide-react';

/** Shape of a row returned by /api/ui-tests/systems — same endpoint UI Tests uses. */
interface TestSystem { id: string; name: string; host: string; type: string; vendor?: string }

type Category =
  | 'auth' | 'version' | 'users' | 'admin-users' | 'simulators'
  | 'system' | 'tools' | 'testcases' | 'test-creator' | 'executions' | 'statistics'
  | 'logs' | 'jobs' | 'negative' | 'mutating' | 'fuzz';

interface RequestEvidence  { method: string; url: string; headers: Record<string,string>; body?: string }
interface ResponseEvidence { status: number; statusText?: string; headers: Record<string,string>; body?: string; bodyTruncated?: boolean; contentType?: string; durationMs: number }

interface TestResult {
  id: string;
  name: string;
  category: Category;
  method: string;
  endpoint: string;
  severity: 'critical' | 'normal' | 'optional';
  destructive: boolean;
  ok: boolean;
  status?: number;
  detail?: string;
  durationMs?: number;
  skipped?: boolean;
  skippedReason?: string;
  request?: RequestEvidence;
  response?: ResponseEvidence;
  ranAt?: string;
}

interface Response {
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  counts: { total: number; passed: number; failed: number; skipped: number };
  results: TestResult[];
  byCategory: Record<string, { passed: number; failed: number; skipped: number }>;
}

const CATEGORY_LABELS: Record<Category, string> = {
  'auth':         'Authentication',
  'version':      'Version',
  'users':        'Current user',
  'admin-users':  'Admin user mgmt',
  'simulators':   'Simulators',
  'system':       'System',
  'tools':        'Tools (band-info, satellite)',
  'testcases':    'Test cases',
  'test-creator': 'Test creator (/tests/*)',
  'executions':   'Executions',
  'statistics':   'Statistics',
  'logs':         'Logs',
  'jobs':         'Async jobs',
  'negative':     'Negative tests (401/404/400)',
  'mutating':     'Mutating (create/update/delete)',
  'fuzz':         'Schema fuzz (malformed input)',
};

// Defaults: every category EXCEPT the three "advanced" ones at the bottom
// (negative, mutating, fuzz). Those exercise error paths / mutate state /
// throw malformed input — useful but noisy for a normal first-look run.
// Users can opt-in via the Select all button or by ticking individually.
const DEFAULT_CATEGORIES: Category[] = [
  'auth', 'version', 'users', 'admin-users', 'simulators',
  'system', 'tools', 'testcases', 'test-creator', 'executions', 'statistics', 'logs', 'jobs',
];

// All categories, in display order — used by Select all.
const ALL_CATEGORIES: Category[] = [
  'auth', 'version', 'users', 'admin-users', 'simulators',
  'system', 'tools', 'testcases', 'test-creator', 'executions', 'statistics', 'logs', 'jobs',
  'negative', 'mutating', 'fuzz',
];

type StatusFilter = 'all' | 'failed' | 'passed' | 'skipped';
type SortBy = 'failed-first' | 'passed-first';

export default function ApiTestsPage() {
  const [enabled, setEnabled] = useState<Set<Category>>(new Set(DEFAULT_CATEGORIES));
  const [includeDestructive, setIncludeDestructive] = useState(false);
  const [includeLongRunning, setIncludeLongRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [data, setData] = useState<Response | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Filtering / sorting state
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<SortBy>('failed-first');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // System picker. /api/ui-tests/systems also returns UE and callbox entries
  // (the /ui-tests page drives those too), but every test in this catalogue
  // targets the Simnovator REST API — a UE or callbox host has no /v2 surface
  // to test, so they're filtered out here rather than in the shared route.
  const [systems, setSystems] = useState<TestSystem[] | null>(null);
  const [targetSystemId, setTargetSystemId] = useState<string>('');
  useEffect(() => {
    fetch('/api/ui-tests/systems').then((r) => r.json()).then((j) => {
      const list: TestSystem[] = (j.systems ?? []).filter(
        (s: TestSystem) => s.type === 'SIMNOVATOR' || s.type === 'SIMNOVATOR_GUI',
      );
      setSystems(list);
      // Own key, not the 'simqa-target-system' one /ui-tests uses: that page's
      // picker includes UE and callbox systems this one deliberately excludes,
      // so sharing the key means each page silently resets the other's choice.
      const stored = (typeof window !== 'undefined' ? localStorage.getItem('simqa-api-tests-target-system') : null) ?? '';
      const valid = list.find((s) => s.id === stored);
      if (valid) setTargetSystemId(valid.id);
      else if (list.length > 0) setTargetSystemId(list[0].id);
    }).catch(() => setSystems([]));
  }, []);
  useEffect(() => {
    if (typeof window !== 'undefined' && targetSystemId) localStorage.setItem('simqa-api-tests-target-system', targetSystemId);
  }, [targetSystemId]);

  function toggle(c: Category) {
    const next = new Set(enabled);
    next.has(c) ? next.delete(c) : next.add(c);
    setEnabled(next);
  }
  const selectAll = () => setEnabled(new Set(ALL_CATEGORIES));
  const clearAll  = () => setEnabled(new Set());

  async function run() {
    setBusy(true); setErr(null); setData(null); setExpanded(new Set());
    setElapsed(0);
    const startedAt = Date.now();
    const tick = setInterval(() => setElapsed(Math.round((Date.now() - startedAt) / 1000)), 1000);
    try {
      const r = await fetch('/api/api-tests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          categories: Array.from(enabled),
          includeDestructive, includeLongRunning,
          targetSystemId: targetSystemId || undefined,
        }),
        // A sweep with exports enabled legitimately runs for minutes. Without a
        // ceiling a stalled box leaves the page spinning with no explanation.
        signal: AbortSignal.timeout(900_000),
      });
      const j: Response = await r.json();
      setData(j);
      // Auto-expand failures.
      setExpanded(new Set(j.results.filter((x) => !x.ok).map((x) => x.id)));
    } catch (e: any) {
      setErr(e?.name === 'TimeoutError'
        ? 'The run exceeded 15 minutes and was cancelled — the Simnovator or one of the export calls is not responding.'
        : (e?.message ?? String(e)));
    } finally {
      clearInterval(tick);
      setBusy(false);
    }
  }

  // Apply filters + sort, then bucket by category. Groups are emitted in
  // catalogue order (the same order the categories appear in the sidebar and
  // in which the runner executes them) so the layout doesn't reshuffle
  // between runs; the sort control only reorders rows WITHIN a group.
  const groups = useMemo(() => {
    if (!data) return [] as Array<{ category: Category; label: string; rows: TestResult[] }>;
    const ql = search.trim().toLowerCase();
    const kept = data.results.filter((r) => {
      if (statusFilter === 'failed'  && r.ok)         return false;
      if (statusFilter === 'passed'  && (!r.ok || r.skipped)) return false;
      if (statusFilter === 'skipped' && !r.skipped)   return false;
      if (ql) {
        const hay = `${r.id} ${r.name} ${r.method} ${r.endpoint} ${r.category} ${r.detail ?? ''} ${r.skippedReason ?? ''}`.toLowerCase();
        if (!hay.includes(ql)) return false;
      }
      return true;
    });
    // failed(0) → passed(1) → skipped(2), or the reverse for passed-first.
    // Skipped always sorts last either way: it is an absence of a result, not
    // a milder pass, so floating it above real outcomes would bury them.
    const rank = (r: TestResult) => (r.skipped ? 2 : r.ok ? 1 : 0);
    const cmp = (a: TestResult, b: TestResult) => {
      const ra = rank(a), rb = rank(b);
      if (ra !== rb) {
        if (ra === 2 || rb === 2) return ra - rb;
        return sortBy === 'passed-first' ? rb - ra : ra - rb;
      }
      return a.name.localeCompare(b.name);
    };
    const byCat = new Map<Category, TestResult[]>();
    for (const r of kept) {
      const arr = byCat.get(r.category) ?? [];
      arr.push(r);
      byCat.set(r.category, arr);
    }
    return (Object.keys(CATEGORY_LABELS) as Category[])
      .filter((c) => byCat.has(c))
      .map((c) => ({ category: c, label: CATEGORY_LABELS[c], rows: byCat.get(c)!.sort(cmp) }));
  }, [data, statusFilter, search, sortBy]);

  const visibleCount = useMemo(() => groups.reduce((n, g) => n + g.rows.length, 0), [groups]);

  function toggleExpand(id: string) {
    const next = new Set(expanded);
    next.has(id) ? next.delete(id) : next.add(id);
    setExpanded(next);
  }

  function downloadJson(filename: string, obj: unknown) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function downloadOne(r: TestResult) {
    downloadJson(`simqa-${r.id}-${(r.ranAt ?? Date.now()).toString().replace(/[:.]/g, '-')}.json`, r);
  }

  function downloadFailures() {
    if (!data) return;
    const failures = data.results.filter((r) => !r.ok);
    const bundle = {
      box: { reportedAt: data.finishedAt },
      // Counts describe THIS bundle, not the whole run — spreading data.counts
      // here used to leave the full run's passed/skipped totals sitting inside
      // a failures-only file, which read as "67 passed" in a download that
      // contained nothing but failures.
      summary: { kind: 'failures-only', total: failures.length, failed: failures.length, ofRun: data.counts },
      generatedAt: new Date().toISOString(),
      tool: 'simqa api-tests',
      results: failures,
    };
    downloadJson(`simqa-api-failures-${data.finishedAt.replace(/[:.]/g, '-')}.json`, bundle);
  }

  function downloadAll() {
    if (!data) return;
    downloadJson(`simqa-api-results-${data.finishedAt.replace(/[:.]/g, '-')}.json`, data);
  }

  function copyAsCurl(r: TestResult) {
    if (!r.request) return;
    const lines: string[] = [`curl -i -X ${r.request.method}`];
    for (const [k, v] of Object.entries(r.request.headers)) {
      lines.push(`  -H ${shellEscape(`${k}: ${v}`)}`);
    }
    if (r.request.body) lines.push(`  --data ${shellEscape(r.request.body)}`);
    lines.push(`  ${shellEscape(r.request.url)}`);
    const cmd = lines.join(' \\\n');
    navigator.clipboard.writeText(cmd).catch(() => { /* ignored */ });
  }

  return (
    <>
      <Header
        title="API Tests"
        left={<BackToRunHistory />}
        subtitle="Test each Simnovator API endpoint to ensure it works correctly and returns the expected results."
        right={
          <div className="flex items-center gap-2">
            {data ? (
              <>
                <Button size="sm" variant="secondary" onClick={downloadFailures} disabled={data.counts.failed === 0}>
                  <Download className="h-4 w-4" />Failures ({data.counts.failed})
                </Button>
                <Button size="sm" variant="secondary" onClick={downloadAll}>
                  <Download className="h-4 w-4" />All
                </Button>
              </>
            ) : null}
            <Button size="sm" onClick={run} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Beaker className="h-4 w-4" />}
              {busy ? `Running… ${elapsed}s` : 'Run'}
            </Button>
          </div>
        }
      />
      <main className="p-6 grid grid-cols-1 lg:grid-cols-3 gap-4 items-start">
        {/* self-start + sticky keeps the controls in place while the results
            column scrolls. Offsets are measured off the app Header (h-14 =
            3.5rem, sticky top-0) plus this main's p-6: top-20 parks the column
            below it, and the max-height subtracts header + both paddings so a
            category list taller than the viewport stays fully reachable via
            its own scroll rather than being clipped once pinned. */}
        <div className="lg:col-span-1 space-y-4 lg:sticky lg:top-20 lg:max-h-[calc(100vh-6.5rem)] lg:overflow-y-auto lg:pr-1">
          <Card>
            <CardHeader><CardTitle>System</CardTitle></CardHeader>
            <CardBody className="text-sm">
              {!systems ? (
                <div className="text-xs text-slate-500">Loading systems…</div>
              ) : systems.length === 0 ? (
                <div className="text-xs text-red-700">No Simnovator systems in inventory.yaml.</div>
              ) : (
                <select
                  value={targetSystemId}
                  onChange={(e) => setTargetSystemId(e.target.value)}
                  disabled={busy}
                  className="w-full text-xs border border-slate-300 rounded px-2 py-1.5 bg-white"
                >
                  {systems.map((s) => (
                    <option key={s.id} value={s.id}>{s.name} ({s.host})</option>
                  ))}
                </select>
              )}
            </CardBody>
          </Card>
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <CardTitle>Categories</CardTitle>
                <div className="flex gap-1">
                  <button
                    onClick={selectAll}
                    className="text-[11px] px-2 py-1 rounded border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                    title="Enable every category (including the destructive / negative / fuzz ones at the bottom)"
                  >
                    Select all
                  </button>
                  <button
                    onClick={clearAll}
                    className="text-[11px] px-2 py-1 rounded border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                    title="Uncheck every category"
                  >
                    Clear
                  </button>
                </div>
              </div>
            </CardHeader>
            <CardBody className="space-y-2">
              {(Object.entries(CATEGORY_LABELS) as Array<[Category, string]>).map(([c, label]) => (
                <label key={c} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={enabled.has(c)} onChange={() => toggle(c)} />
                  <span className="flex-1">{label}</span>
                  {c === 'mutating' ? <span className="text-[10px] text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded border border-amber-200">destructive</span> : null}
                </label>
              ))}
            </CardBody>
          </Card>
          <Card>
            <CardHeader><CardTitle>Options</CardTitle></CardHeader>
            <CardBody className="space-y-2 text-sm">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={includeDestructive} onChange={(e) => setIncludeDestructive(e.target.checked)} />
                Include destructive tests (auto-rolled-back)
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={includeLongRunning} onChange={(e) => setIncludeLongRunning(e.target.checked)} />
                Include long-running (export/binary)
              </label>
              <div className="text-[11px] text-slate-500 pt-1">
                Destructive tests create + delete throwaway resources. Auth tokens are redacted in downloads.
                Most long-running tests are destructive too, so they need <em>both</em> boxes ticked — each
                skipped test says which options it is waiting on.
              </div>
            </CardBody>
          </Card>
        </div>

        <div className="lg:col-span-2 space-y-4">
          {err ? <Card><CardBody><div className="text-sm text-red-700">{err}</div></CardBody></Card> : null}

          {data ? (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <Stat label="Total"   value={data.counts.total} />
                <Stat label="Passed"  value={data.counts.passed} />
                <Stat label="Failed"  value={data.counts.failed} />
                <Stat label="Skipped" value={data.counts.skipped} />
              </div>

              <Card>
                <CardBody className="flex flex-wrap items-center gap-3">
                  <Filter className="h-4 w-4 text-slate-500" />
                  <div className="flex items-center gap-1">
                    {(['all', 'failed', 'passed', 'skipped'] as const).map((s) => {
                      const count = !data ? 0 : (
                        s === 'all' ? data.counts.total :
                        s === 'failed' ? data.counts.failed :
                        s === 'passed' ? data.counts.passed :
                        data.counts.skipped
                      );
                      return (
                        <button
                          key={s}
                          onClick={() => setStatusFilter(s)}
                          className={
                            'px-3 h-8 text-xs rounded-full border transition-colors ' +
                            (statusFilter === s
                              ? 'bg-primary-700 text-white border-primary-700'
                              : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50')
                          }
                        >
                          {s === 'all' ? 'All' : s[0].toUpperCase() + s.slice(1)}
                          <span className="ml-1.5 opacity-70">{count}</span>
                        </button>
                      );
                    })}
                  </div>
                  <div className="flex-1 min-w-[180px]">
                    <Input
                      placeholder="Search name, endpoint, category, result…"
                      title="Matches the test name, its id, the HTTP method, the endpoint path, the category, the result detail line, and the skip reason. It does not search request or response bodies."
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </div>
                  <select
                    value={sortBy}
                    onChange={(e) => setSortBy(e.target.value as SortBy)}
                    className="h-9 rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900"
                  >
                    <option value="failed-first">Failed first</option>
                    <option value="passed-first">Passed first</option>
                  </select>
                </CardBody>
              </Card>

              <Card>
                <CardHeader className="flex items-center justify-between">
                  <CardTitle>Results <span className="text-xs text-slate-500 font-normal">({visibleCount} shown)</span></CardTitle>
                  {data.ok ? <Badge tone="success">all passed</Badge> : <Badge tone="danger">failures</Badge>}
                </CardHeader>
                <CardBody className="p-0">
                  {groups.length === 0 ? (
                    <div className="p-5 text-sm text-slate-500">No results match the filter.</div>
                  ) : (
                    groups.map((g) => {
                      const failed  = g.rows.filter((r) => !r.ok).length;
                      const skipped = g.rows.filter((r) => r.skipped).length;
                      const passed  = g.rows.length - failed - skipped;
                      return (
                        <section key={g.category}>
                          {/* top-14 parks the heading flush under the app
                              Header; z below the Header's z-10 so it can never
                              paint over it. */}
                          <div className="sticky top-14 z-[5] flex items-center gap-2 px-5 py-2 bg-slate-100/95 backdrop-blur border-y border-slate-200">
                            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-600">{g.label}</h3>
                            <span className="text-[11px] text-slate-500">
                              {passed} passed
                              {failed ? <span className="text-red-700"> · {failed} failed</span> : null}
                              {skipped ? <span> · {skipped} skipped</span> : null}
                            </span>
                          </div>
                          <ul className="divide-y divide-slate-100">
                            {g.rows.map((r) => (
                              <TestRow
                                key={r.id}
                                r={r}
                                expanded={expanded.has(r.id)}
                                onToggle={() => toggleExpand(r.id)}
                                onDownload={() => downloadOne(r)}
                                onCopyCurl={() => copyAsCurl(r)}
                              />
                            ))}
                          </ul>
                        </section>
                      );
                    })
                  )}
                </CardBody>
              </Card>
            </>
          ) : (
            <Card><CardBody><div className="text-sm text-slate-500">
              {busy
                ? `Running… ${elapsed}s elapsed. Long-running exports and destructive tests can take several minutes.`
                : 'Pick Simnovator from the systems and hit Run.'}
            </div></CardBody></Card>
          )}
        </div>
      </main>
    </>
  );
}

function TestRow({ r, expanded, onToggle, onDownload, onCopyCurl }: { r: TestResult; expanded: boolean; onToggle: () => void; onDownload: () => void; onCopyCurl: () => void }) {
  const Icon = r.skipped ? MinusCircle : (r.ok ? CheckCircle2 : XCircle);
  const iconColor = r.skipped ? 'text-slate-400' : (r.ok ? 'text-success-600' : 'text-red-600');
  const Caret = expanded ? ChevronDown : ChevronRight;
  const hasEvidence = !!r.request || !!r.response;

  return (
    <li>
      <button onClick={onToggle} className="w-full text-left px-5 py-3 flex items-start gap-3 hover:bg-slate-50">
        <Caret className="h-4 w-4 mt-0.5 text-slate-400" />
        <Icon className={`h-4 w-4 mt-0.5 ${iconColor}`} />
        <div className="flex-1 min-w-0">
          <div className="text-sm text-slate-900">
            <span className="font-medium">{r.name}</span>
            {r.destructive ? <span className="ml-2 text-[10px] text-amber-700">[destructive]</span> : null}
          </div>
          <div className="text-xs text-slate-500 font-mono mt-0.5 break-all">
            {r.method} {r.endpoint}{typeof r.status === 'number' ? ` -> ${r.status}` : ''}
            <span className="text-slate-400"> · {r.category}</span>
          </div>
          {r.skipped
            ? <div className="text-xs text-slate-500 mt-0.5">skipped: {r.skippedReason}</div>
            : r.detail ? <div className={`text-xs mt-0.5 break-all ${r.ok ? 'text-slate-500' : 'text-red-700'}`}>{r.detail}</div> : null}
        </div>
        {typeof r.durationMs === 'number' ? <span className="text-[11px] text-slate-400 mt-0.5 whitespace-nowrap">{r.durationMs}ms</span> : null}
      </button>

      {expanded && hasEvidence ? (
        <div className="px-5 pb-4 bg-slate-50/50">
          <div className="flex items-center gap-2 mb-3">
            <Button size="sm" variant="secondary" onClick={onDownload}><Download className="h-4 w-4" />Download JSON</Button>
            {r.request ? <Button size="sm" variant="ghost" onClick={onCopyCurl}><Copy className="h-4 w-4" />Copy as curl</Button> : null}
            {r.ranAt ? <span className="text-[11px] text-slate-400 ml-auto">{new Date(r.ranAt).toLocaleString()}</span> : null}
          </div>
          {r.request ? (
            <div className="mb-3">
              <div className="text-[11px] uppercase tracking-wider text-slate-500 mb-1">Request</div>
              <pre className="cfg max-h-60 text-[11px]">{formatRequest(r.request)}</pre>
            </div>
          ) : null}
          {r.response ? (
            <div>
              <div className="text-[11px] uppercase tracking-wider text-slate-500 mb-1">Response</div>
              <pre className="cfg max-h-60 text-[11px]">{formatResponse(r.response)}</pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function formatRequest(req: RequestEvidence): string {
  const lines: string[] = [];
  lines.push(`${req.method} ${req.url}`);
  for (const [k, v] of Object.entries(req.headers)) lines.push(`${k}: ${v}`);
  if (req.body) { lines.push(''); lines.push(req.body); }
  return lines.join('\n');
}
function formatResponse(res: ResponseEvidence): string {
  const lines: string[] = [];
  lines.push(`HTTP ${res.status}${res.statusText ? ' ' + res.statusText : ''}  (${res.durationMs}ms)`);
  for (const [k, v] of Object.entries(res.headers)) lines.push(`${k}: ${v}`);
  if (res.body) { lines.push(''); lines.push(res.body); }
  if (res.bodyTruncated) lines.push('\n[body truncated to 8 KB]');
  return lines.join('\n');
}
function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

'use client';

import { useEffect, useMemo, useState } from 'react';
import { Header } from '@/components/Header';
import { Card, CardBody, CardHeader, CardTitle, Button, Badge, Stat, Input } from '@/components/ui';
import { CheckCircle2, XCircle, MinusCircle, Loader2, Beaker, Download, Copy, ChevronRight, ChevronDown, Filter } from 'lucide-react';

/** Shape of a row returned by /api/ui-tests/systems — same endpoint UI Tests uses. */
interface TestSystem { id: string; name: string; host: string; type: string; vendor?: string }

type Category =
  | 'auth' | 'version' | 'users' | 'admin-users' | 'simulators'
  | 'system' | 'tools' | 'testcases' | 'executions' | 'statistics'
  | 'logs' | 'negative' | 'mutating' | 'fuzz';

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
  'executions':   'Executions',
  'statistics':   'Statistics',
  'logs':         'Logs',
  'negative':     'Negative tests (401/404/400)',
  'mutating':     'Mutating (create/update/delete)',
  'fuzz':         'Schema fuzz (malformed input)',
};

const DEFAULT_CATEGORIES: Category[] = [
  'auth', 'version', 'users', 'admin-users', 'simulators',
  'system', 'tools', 'testcases', 'executions', 'statistics', 'logs',
  'negative', 'fuzz',
];

type StatusFilter = 'all' | 'failed' | 'passed' | 'skipped';
type SortBy = 'failures-first' | 'slowest' | 'name' | 'category';

export default function ApiTestsPage() {
  const [enabled, setEnabled] = useState<Set<Category>>(new Set(DEFAULT_CATEGORIES));
  const [includeDestructive, setIncludeDestructive] = useState(false);
  const [includeLongRunning, setIncludeLongRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [data, setData] = useState<Response | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Filtering / sorting state
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<SortBy>('failures-first');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Target system picker — same flow as /ui-tests: list testable systems
  // from inventory, persist the last choice in localStorage so a refresh
  // doesn't reset the dropdown.
  const [systems, setSystems] = useState<TestSystem[] | null>(null);
  const [targetSystemId, setTargetSystemId] = useState<string>('');
  useEffect(() => {
    fetch('/api/ui-tests/systems').then((r) => r.json()).then((j) => {
      const list: TestSystem[] = j.systems ?? [];
      setSystems(list);
      const stored = (typeof window !== 'undefined' ? localStorage.getItem('simqa-target-system') : null) ?? '';
      const valid = list.find((s) => s.id === stored);
      if (valid) setTargetSystemId(valid.id);
      else if (list.length > 0) setTargetSystemId(list[0].id);
    }).catch(() => setSystems([]));
  }, []);
  useEffect(() => {
    if (typeof window !== 'undefined' && targetSystemId) localStorage.setItem('simqa-target-system', targetSystemId);
  }, [targetSystemId]);

  function toggle(c: Category) {
    const next = new Set(enabled);
    next.has(c) ? next.delete(c) : next.add(c);
    setEnabled(next);
  }

  async function run() {
    setBusy(true); setErr(null); setData(null); setExpanded(new Set());
    try {
      const r = await fetch('/api/api-tests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          categories: Array.from(enabled),
          includeDestructive, includeLongRunning,
          targetSystemId: targetSystemId || undefined,
        }),
      });
      const j: Response = await r.json();
      setData(j);
      // Auto-expand failures.
      setExpanded(new Set(j.results.filter((x) => !x.ok).map((x) => x.id)));
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  // Apply filters + sort.
  const visible = useMemo(() => {
    if (!data) return [] as TestResult[];
    const ql = search.trim().toLowerCase();
    let list = data.results.filter((r) => {
      if (statusFilter === 'failed'  && r.ok)         return false;
      if (statusFilter === 'passed'  && (!r.ok || r.skipped)) return false;
      if (statusFilter === 'skipped' && !r.skipped)   return false;
      if (ql) {
        const hay = `${r.id} ${r.name} ${r.method} ${r.endpoint} ${r.detail ?? ''}`.toLowerCase();
        if (!hay.includes(ql)) return false;
      }
      return true;
    });
    list = [...list];
    list.sort((a, b) => {
      switch (sortBy) {
        case 'slowest':  return (b.durationMs ?? 0) - (a.durationMs ?? 0);
        case 'name':     return a.name.localeCompare(b.name);
        case 'category': return a.category.localeCompare(b.category) || a.name.localeCompare(b.name);
        case 'failures-first':
        default:
          const rank = (r: TestResult) => r.skipped ? 2 : (r.ok ? 1 : 0);
          return rank(a) - rank(b) || a.name.localeCompare(b.name);
      }
    });
    return list;
  }, [data, statusFilter, search, sortBy]);

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
    const failures = data.results.filter((r) => !r.ok && !r.skipped);
    const bundle = {
      box: { reportedAt: data.finishedAt },
      summary: { ...data.counts, total: failures.length, kind: 'failures-only' },
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
        subtitle="Endpoint-by-endpoint coverage of the Simnovator REST surface"
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
              {busy ? 'Running…' : 'Run tests'}
            </Button>
          </div>
        }
      />
      <main className="p-6 grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-1 space-y-4">
          <Card>
            <CardHeader><CardTitle>Test target</CardTitle></CardHeader>
            <CardBody className="space-y-2 text-sm">
              {!systems ? (
                <div className="text-xs text-slate-500">Loading systems…</div>
              ) : systems.length === 0 ? (
                <div className="text-xs text-red-700">No UESIM / Simnovator / Callbox systems in inventory.yaml.</div>
              ) : (
                <select
                  value={targetSystemId}
                  onChange={(e) => setTargetSystemId(e.target.value)}
                  disabled={busy}
                  className="w-full text-xs border border-slate-300 rounded px-2 py-1.5 bg-white"
                >
                  {systems.map((s) => (
                    <option key={s.id} value={s.id}>{s.name} ({s.host}) · {s.type}</option>
                  ))}
                </select>
              )}
              <div className="text-[10px] text-slate-500 pt-1">
                The API runner logs in with the UESIM REST credentials on the selected system.
              </div>
            </CardBody>
          </Card>
          <Card>
            <CardHeader><CardTitle>Categories</CardTitle></CardHeader>
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
                    <Input placeholder="Search id / endpoint / detail…" value={search} onChange={(e) => setSearch(e.target.value)} />
                  </div>
                  <select
                    value={sortBy}
                    onChange={(e) => setSortBy(e.target.value as SortBy)}
                    className="h-9 rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900"
                  >
                    <option value="failures-first">Failures first</option>
                    <option value="slowest">Slowest first</option>
                    <option value="name">Name</option>
                    <option value="category">Category</option>
                  </select>
                </CardBody>
              </Card>

              <Card>
                <CardHeader className="flex items-center justify-between">
                  <CardTitle>Results <span className="text-xs text-slate-500 font-normal">({visible.length} shown)</span></CardTitle>
                  {data.ok ? <Badge tone="success">all passed</Badge> : <Badge tone="danger">failures</Badge>}
                </CardHeader>
                <CardBody className="p-0">
                  {visible.length === 0 ? (
                    <div className="p-5 text-sm text-slate-500">No results match the filter.</div>
                  ) : (
                    <ul className="divide-y divide-slate-100">
                      {visible.map((r) => (
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
                  )}
                </CardBody>
              </Card>
            </>
          ) : (
            <Card><CardBody><div className="text-sm text-slate-500">{busy ? 'Running…' : 'Pick categories on the left and hit Run tests.'}</div></CardBody></Card>
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

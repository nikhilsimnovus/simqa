'use client';

// UI Tests, discovered rather than written down.
//
// The page has no list of test cases in it. Pick a setup, press Discover, and
// what comes back is the UI that setup is actually running: its menus, its
// pages, its tabs, the controls on each one — and, when a build has changed
// something, what is new since the last time it was read. Run UI Tests then
// executes the checks generated from that map.
//
// The result table is deliberately the columns a QA engineer has to fill in by
// hand otherwise: section, page, element, what was done, what was expected,
// what happened, status, error, screenshot, time, setup and build.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card, CardBody, CardHeader, CardTitle, Button, Badge, Input } from '@/components/ui';
import {
  Loader2, Play, Square, Search, ChevronRight, ChevronDown, Download,
  CheckCircle2, XCircle, AlertTriangle, MinusCircle, Ban, Radar, GitCompare,
} from 'lucide-react';

interface TestSystem { id: string; name: string; host: string; type: string }
type Status = 'pass' | 'fail' | 'skip' | 'not-available' | 'error';

interface GeneratedCheck {
  id: string; kind: string; severity: string;
  section: string; page: string; nodeId: string;
  element?: string; elementKind?: string;
  test: string; expected: string; notApplicable?: string;
}
interface Outcome {
  check: GeneratedCheck;
  status: Status;
  actual: string;
  error?: string;
  reason?: string;
  durationMs: number;
  ranAt: string;
  finalUrl?: string;
  screenshotFile?: string;
}
interface UiElementLite {
  key: string; kind: string; label: string; risk: string;
  disabled?: boolean; required?: boolean; options?: string[]; columns?: string[]; rowCount?: number; note?: string;
}
interface UiNodeLite {
  id: string; kind: string; path: string[]; label: string; url?: string;
  elements: UiElementLite[]; unreachable?: string; screenshotFile?: string;
}
interface UiMapLite {
  host: string; username?: string; build?: string; discoveredAt: string;
  durationMs?: number; nodes: UiNodeLite[]; notes?: string[]; dir?: string;
}
interface MapDiff {
  previousBuild?: string; previousDiscoveredAt?: string; currentBuild?: string;
  addedPages: Array<{ id: string; page: string }>;
  removedPages: Array<{ id: string; page: string }>;
  renamedPages: Array<{ id: string; from: string; to: string }>;
  addedElements: Array<{ id: string; page: string; element: string; kind: string }>;
  removedElements: Array<{ id: string; page: string; element: string; kind: string }>;
  changedElements: Array<{ id: string; page: string; element: string; what: string }>;
}
interface RunResult {
  ok: boolean; error?: string;
  startedAt: string; finishedAt: string; runDir: string;
  host: string; username?: string; build?: string; systemId?: string;
  map?: UiMapLite; diff?: MapDiff; diffSummary?: string;
  plan?: { total: number; willRun: number; notApplicable: number; bySection: Array<{ section: string; total: number }>; byKind: Array<{ kind: string; total: number }> };
  counts: { total: number; passed: number; failed: number; skipped: number; notAvailable: number; errors: number };
  outcomes: Outcome[];
  notes: string[];
}
interface Progress {
  host: string; username?: string; startedAt: string;
  phase: string; current?: string; pagesFound: number;
  completed: number; total: number;
  counts: RunResult['counts'];
  stopping?: boolean;
}

const STATUS_META: Record<Status, { label: string; tone: string; Icon: typeof CheckCircle2 }> = {
  pass: { label: 'Passed', tone: 'text-emerald-700 bg-emerald-50 border-emerald-200', Icon: CheckCircle2 },
  fail: { label: 'Failed', tone: 'text-red-700 bg-red-50 border-red-200', Icon: XCircle },
  skip: { label: 'Skipped', tone: 'text-amber-700 bg-amber-50 border-amber-200', Icon: MinusCircle },
  'not-available': { label: 'Not Available', tone: 'text-slate-600 bg-slate-50 border-slate-200', Icon: Ban },
  error: { label: 'Error', tone: 'text-fuchsia-700 bg-fuchsia-50 border-fuchsia-200', Icon: AlertTriangle },
};

export function DynamicUiTests() {
  const [systems, setSystems] = useState<TestSystem[] | null>(null);
  const [systemId, setSystemId] = useState('');
  const [boxUsers, setBoxUsers] = useState<Array<{ id: string; username: string }>>([]);
  const [boxUserId, setBoxUserId] = useState('');

  const [map, setMap] = useState<UiMapLite | null>(null);
  const [checks, setChecks] = useState<GeneratedCheck[]>([]);
  const [diff, setDiff] = useState<MapDiff | null>(null);
  const [diffSummary, setDiffSummary] = useState<string | null>(null);
  const [mapMessage, setMapMessage] = useState<string | null>(null);

  const [result, setResult] = useState<RunResult | null>(null);
  const [busy, setBusy] = useState<'discover' | 'run' | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [maxPages, setMaxPages] = useState(45);
  const [budgetMin, setBudgetMin] = useState(12);
  const [openForms, setOpenForms] = useState(true);
  const [probeRequired, setProbeRequired] = useState(false);
  const [sectionFilter, setSectionFilter] = useState<Set<string>>(new Set());
  const [statusFilter, setStatusFilter] = useState<Status | 'all'>('all');
  const [search, setSearch] = useState('');
  const [openNodes, setOpenNodes] = useState<Set<string>>(new Set());
  const [openSections, setOpenSections] = useState<Set<string>>(new Set());

  const host = useMemo(() => systems?.find(s => s.id === systemId)?.host ?? '', [systems, systemId]);

  useEffect(() => {
    fetch('/api/ui-tests/systems').then(r => r.json()).then(j => {
      const list: TestSystem[] = j.systems ?? [];
      setSystems(list);
      // Default to a Simnovator with a GUI — the only kind that has a UI to map.
      const gui = list.find(s => s.type === 'SIMNOVATOR_GUI') ?? list[0];
      if (gui) setSystemId(gui.id);
    }).catch(() => setSystems([]));
  }, []);

  useEffect(() => {
    if (!systemId) return;
    fetch(`/api/box-users?systemId=${encodeURIComponent(systemId)}`)
      .then(r => r.json())
      .then(j => {
        const us = j.users ?? [];
        setBoxUsers(us);
        setBoxUserId(us[0]?.id ?? '');
      })
      .catch(() => { setBoxUsers([]); setBoxUserId(''); });
  }, [systemId]);

  /** Whatever has already been discovered for this setup, with the plan that
   *  comes out of it. Read-only, so switching setups is instant. */
  const loadMap = useCallback(async () => {
    if (!systemId) return;
    setErr(null);
    const qs = new URLSearchParams({ systemId });
    if (boxUserId) qs.set('boxUserId', boxUserId);
    if (probeRequired) qs.set('probeRequiredFields', '1');
    try {
      const j = await fetch(`/api/ui-discovery/map?${qs}`).then(r => r.json());
      setMap(j.map ?? null);
      setChecks(j.checks ?? []);
      setDiff(j.diff ?? null);
      setDiffSummary(j.diffSummary ?? null);
      setMapMessage(j.message ?? null);
      setResult(null);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    }
  }, [systemId, boxUserId, probeRequired]);

  useEffect(() => { void loadMap(); }, [loadMap]);

  // While a crawl or a run is in flight, follow it.
  const pollRef = useRef<number | null>(null);
  useEffect(() => {
    if (!busy || !host) return;
    const tick = async () => {
      try {
        const j = await fetch(`/api/ui-discovery/status?host=${encodeURIComponent(host)}`).then(r => r.json());
        setProgress(j.current ?? null);
      } catch { /* a poll that misses is not an error */ }
    };
    void tick();
    pollRef.current = window.setInterval(tick, 2000);
    return () => { if (pollRef.current) window.clearInterval(pollRef.current); };
  }, [busy, host]);

  const start = async (mode: 'discover' | 'discover+run' | 'run') => {
    setErr(null);
    setBusy(mode === 'discover' ? 'discover' : 'run');
    setResult(null);
    try {
      const body = {
        targetSystemId: systemId,
        boxUserId: boxUserId || undefined,
        mode,
        maxPages,
        budgetMs: Math.max(1, budgetMin) * 60_000,
        openDialogs: openForms,
        plan: { probeRequiredFields: probeRequired },
        onlySections: sectionFilter.size ? [...sectionFilter] : undefined,
      };
      const j: RunResult = await fetch('/api/ui-discovery', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then(r => r.json());
      if (j.error) setErr(j.error);
      setResult(j);
      if (j.map) {
        setMap(j.map);
        setDiff(j.diff ?? null);
        setDiffSummary(j.diffSummary ?? null);
        setMapMessage(null);
      }
      if (mode !== 'run') void loadMap();
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  const stop = async () => {
    await fetch('/api/ui-discovery/stop', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host }),
    }).catch(() => null);
  };

  // ------------------------------------------------------------- derived --

  const sections = useMemo(() => {
    const bySection = new Map<string, UiNodeLite[]>();
    for (const n of map?.nodes ?? []) {
      const key = n.path[0] ?? n.label;
      const arr = bySection.get(key);
      if (arr) arr.push(n); else bySection.set(key, [n]);
    }
    return [...bySection].map(([section, nodes]) => ({ section, nodes }));
  }, [map]);

  const checksByNode = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of checks) m.set(c.nodeId, (m.get(c.nodeId) ?? 0) + 1);
    return m;
  }, [checks]);

  const newPageIds = useMemo(() => new Set((diff?.addedPages ?? []).map(p => p.id)), [diff]);

  const rows = useMemo(() => {
    let out = result?.outcomes ?? [];
    if (statusFilter !== 'all') out = out.filter(o => o.status === statusFilter);
    const q = search.trim().toLowerCase();
    if (q) {
      out = out.filter(o =>
        o.check.page.toLowerCase().includes(q)
        || (o.check.element ?? '').toLowerCase().includes(q)
        || o.check.test.toLowerCase().includes(q)
        || o.actual.toLowerCase().includes(q)
        || o.check.kind.includes(q));
    }
    return out;
  }, [result, statusFilter, search]);

  const counts = result?.counts;
  const shotUrl = (file?: string) => {
    if (!file || !result?.runDir) return undefined;
    const run = result.runDir.replace(/\\/g, '/').split('/').pop();
    return `/api/ui-discovery/evidence/${run}/${file.replace(/^shots\//, 'shots/')}`;
  };

  /** A discovery screenshot, which lives in the folder the map was read into
   *  — not in the folder of the run that is on screen now. */
  const mapShotUrl = (file?: string) => {
    const dir = map?.dir?.split(/[\\/]/).filter(Boolean).pop();
    return file && dir ? `/api/ui-discovery/evidence/${dir}/${file}` : undefined;
  };

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(result ?? { map, checks, diff }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ui-discovery-${host || 'setup'}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // ---------------------------------------------------------------- view --

  return (
    <div className="px-6 pb-10 space-y-4">
      {/* Setup picker and what to do with it. */}
      <Card>
        <CardBody className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col text-[11px] text-slate-500">
              Simnovator
              <select
                value={systemId}
                onChange={e => setSystemId(e.target.value)}
                className="mt-0.5 border border-slate-300 rounded-md px-2 py-1.5 text-sm text-slate-900 min-w-[220px]"
              >
                {(systems ?? []).map(s => (
                  <option key={s.id} value={s.id}>{s.host}{s.name ? ` — ${s.name}` : ''}</option>
                ))}
              </select>
            </label>

            <label className="flex flex-col text-[11px] text-slate-500">
              Signed in as
              <select
                value={boxUserId}
                onChange={e => setBoxUserId(e.target.value)}
                className="mt-0.5 border border-slate-300 rounded-md px-2 py-1.5 text-sm text-slate-900 min-w-[150px]"
                disabled={boxUsers.length === 0}
              >
                {boxUsers.length === 0 ? <option value="">the setup&apos;s login</option> : null}
                {boxUsers.map(u => <option key={u.id} value={u.id}>{u.username}</option>)}
              </select>
            </label>

            <label className="flex flex-col text-[11px] text-slate-500">
              Page budget
              <Input type="number" min={1} max={200} value={maxPages}
                onChange={e => setMaxPages(Number(e.target.value) || 1)}
                className="mt-0.5 w-20 text-sm" />
            </label>
            <label className="flex flex-col text-[11px] text-slate-500">
              Time budget (min)
              <Input type="number" min={1} max={60} value={budgetMin}
                onChange={e => setBudgetMin(Number(e.target.value) || 1)}
                className="mt-0.5 w-20 text-sm" />
            </label>

            <div className="flex-1" />

            {busy ? (
              <Button size="sm" variant="secondary" onClick={stop}
                className="!bg-red-600 !text-white !border-red-600 hover:!bg-red-700">
                <Square className="h-4 w-4 fill-current" />Stop
              </Button>
            ) : (
              <>
                <Button size="sm" variant="secondary" onClick={() => start('discover')} disabled={!systemId}>
                  <Radar className="h-4 w-4" />Discover UI
                </Button>
                <Button size="sm" onClick={() => start(map ? 'run' : 'discover+run')} disabled={!systemId}>
                  <Play className="h-4 w-4" />
                  {map ? `Run UI Tests (${checks.length})` : 'Discover + Run'}
                </Button>
                {map ? (
                  <Button size="sm" variant="secondary" onClick={() => start('discover+run')} disabled={!systemId}>
                    Re-discover + Run
                  </Button>
                ) : null}
              </>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-4 text-xs text-slate-600">
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={openForms} onChange={e => setOpenForms(e.target.checked)} />
              Open Add/Edit forms to read their fields
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={probeRequired} onChange={e => setProbeRequired(e.target.checked)} />
              Submit forms with mandatory fields empty
            </label>
            {probeRequired ? (
              <span className="text-amber-700">
                If the validation under test is broken, submitting is what proves it — and what leaves the record behind.
              </span>
            ) : null}
          </div>

          <p className="text-[11px] text-slate-500">
            Nothing that changes the box is ever pressed: Delete, Save, Start, Stop, Install, Reboot and Logout are
            reported as offered and left alone. Add and Edit are opened and cancelled.
          </p>
        </CardBody>
      </Card>

      {err ? (
        <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">{err}</div>
      ) : null}

      {/* Live progress. */}
      {busy ? (
        <div className="rounded-md border border-primary-200 bg-primary-50 px-4 py-2 text-xs text-primary-900">
          <div className="flex items-center gap-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            <span className="font-medium capitalize">{progress?.phase ?? busy}</span>
            {progress?.current ? <span className="text-primary-700">— {progress.current}</span> : null}
            {progress?.pagesFound ? <span className="text-primary-700">· {progress.pagesFound} page(s) found</span> : null}
            {progress?.total ? <span className="text-primary-700">· {progress.completed}/{progress.total} checks</span> : null}
            {progress?.stopping ? <span className="text-red-700">· stopping</span> : null}
          </div>
        </div>
      ) : null}

      {/* What this build changed. */}
      {diff && diffSummary && diffSummary !== 'No UI changes since the last discovery.' ? (
        <Card>
          <CardHeader className="flex items-center gap-2">
            <GitCompare className="h-4 w-4 text-amber-600" />
            <CardTitle>UI changes since {diff.previousBuild ? `build ${diff.previousBuild}` : 'the last discovery'}</CardTitle>
            <Badge tone="warning">{diffSummary}</Badge>
          </CardHeader>
          <CardBody className="text-xs space-y-1.5">
            {diff.addedPages.map(p => (
              <div key={p.id} className="text-emerald-800">
                <span className="font-semibold">New page</span> — {p.page}
                <span className="text-slate-500"> (now in the test scope)</span>
              </div>
            ))}
            {diff.removedPages.map(p => (
              <div key={p.id} className="text-red-800"><span className="font-semibold">Page gone</span> — {p.page}</div>
            ))}
            {diff.renamedPages.map(p => (
              <div key={p.id} className="text-sky-800"><span className="font-semibold">Renamed</span> — {p.from} → {p.to}</div>
            ))}
            {diff.addedElements.slice(0, 40).map(e => (
              <div key={e.id} className="text-emerald-800">New {e.kind} <span className="font-medium">{e.element}</span> on {e.page}</div>
            ))}
            {diff.removedElements.slice(0, 40).map(e => (
              <div key={e.id} className="text-red-800">{e.kind} <span className="font-medium">{e.element}</span> is gone from {e.page}</div>
            ))}
            {diff.changedElements.slice(0, 40).map(e => (
              <div key={e.id} className="text-amber-800"><span className="font-medium">{e.element}</span> on {e.page}: {e.what}</div>
            ))}
          </CardBody>
        </Card>
      ) : null}

      {/* The discovered hierarchy. */}
      <Card>
        <CardHeader className="flex flex-wrap items-center gap-2">
          <CardTitle>UI on this setup</CardTitle>
          {map ? (
            <>
              <Badge>{map.host}</Badge>
              {map.username ? <Badge tone="default">as {map.username}</Badge> : null}
              {map.build ? <Badge tone="info">build {map.build}</Badge> : null}
              <Badge tone="default">{map.nodes.length} page(s)</Badge>
              <Badge tone="default">{checks.length} check(s)</Badge>
              <span className="text-[11px] text-slate-500">
                read {new Date(map.discoveredAt).toLocaleString()}
                {map.durationMs ? ` in ${Math.round(map.durationMs / 1000)}s` : ''}
              </span>
            </>
          ) : null}
          <div className="flex-1" />
          {map || result ? (
            <Button size="sm" variant="secondary" onClick={exportJson}>
              <Download className="h-4 w-4" />Export JSON
            </Button>
          ) : null}
        </CardHeader>
        <CardBody>
          {!map ? (
            <p className="text-sm text-slate-600">
              {mapMessage ?? 'Nothing discovered yet.'} Press <span className="font-medium">Discover UI</span> and
              SimQA will sign in to this setup, walk its menus, submenus, tabs and forms, and build the test
              hierarchy from what it finds.
            </p>
          ) : (
            <div className="space-y-1">
              {sections.map(({ section, nodes }) => {
                const openS = openSections.has(section);
                const sectionChecks = nodes.reduce((n, x) => n + (checksByNode.get(x.id) ?? 0), 0);
                const picked = sectionFilter.size === 0 || sectionFilter.has(section);
                return (
                  <div key={section} className="border border-line rounded-md">
                    <div className="flex items-center gap-2 px-2 py-1.5 bg-slate-50">
                      <button
                        onClick={() => setOpenSections(p => {
                          const n = new Set(p); n.has(section) ? n.delete(section) : n.add(section); return n;
                        })}
                        className="flex items-center gap-1 text-sm font-medium text-slate-800"
                      >
                        {openS ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        {section}
                      </button>
                      <Badge tone="default">{nodes.length} page(s)</Badge>
                      <Badge tone="default">{sectionChecks} check(s)</Badge>
                      <div className="flex-1" />
                      <label className="flex items-center gap-1 text-[11px] text-slate-500">
                        <input
                          type="checkbox"
                          checked={picked}
                          onChange={() => setSectionFilter(p => {
                            const n = new Set(p.size === 0 ? sections.map(s => s.section) : p);
                            n.has(section) ? n.delete(section) : n.add(section);
                            return n.size === sections.length ? new Set() : n;
                          })}
                        />
                        in scope
                      </label>
                    </div>
                    {openS ? (
                      <div className="divide-y divide-line">
                        {nodes.map(n => {
                          const openN = openNodes.has(n.id);
                          return (
                            <div key={n.id} className="px-3 py-1.5">
                              <div className="flex items-center gap-2">
                                <button
                                  onClick={() => setOpenNodes(p => {
                                    const s = new Set(p); s.has(n.id) ? s.delete(n.id) : s.add(n.id); return s;
                                  })}
                                  className="flex items-center gap-1 text-left text-sm text-slate-800"
                                >
                                  {openN ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                                  <span className="font-mono text-[11px] text-slate-400">{n.kind}</span>
                                  {n.path.join(' → ')}
                                </button>
                                {newPageIds.has(n.id) ? <Badge tone="success">new in this build</Badge> : null}
                                {n.unreachable ? <Badge tone="danger">could not open</Badge> : null}
                                <span className="text-[11px] text-slate-500">
                                  {n.elements.length} control(s) · {checksByNode.get(n.id) ?? 0} check(s)
                                </span>
                              </div>
                              {openN ? (
                                <div className="mt-1.5 ml-5 space-y-0.5">
                                  {n.unreachable ? (
                                    <div className="text-[11px] text-red-700">{n.unreachable}</div>
                                  ) : null}
                                  {n.url ? <div className="text-[11px] text-slate-500 font-mono break-all">{n.url}</div> : null}
                                  {mapShotUrl(n.screenshotFile) ? (
                                    <a href={mapShotUrl(n.screenshotFile)} target="_blank" rel="noreferrer"
                                      className="text-[11px] text-primary-700 underline">
                                      screenshot of this page as discovered
                                    </a>
                                  ) : null}
                                  {n.elements.map(e => (
                                    <div key={e.key} className="flex flex-wrap items-center gap-1.5 text-[11px]">
                                      <span className="font-mono text-slate-400 w-16">{e.kind}</span>
                                      <span className="text-slate-800">{e.label || e.key}</span>
                                      {e.required ? <Badge tone="warning">mandatory</Badge> : null}
                                      {e.disabled ? <Badge tone="default">disabled</Badge> : null}
                                      {e.risk === 'mutate' ? <Badge tone="danger">not operated</Badge> : null}
                                      {e.risk === 'open' ? <Badge tone="info">opened + cancelled</Badge> : null}
                                      {e.columns?.length ? <span className="text-slate-500">columns: {e.columns.join(', ')}</span> : null}
                                      {typeof e.rowCount === 'number' ? <span className="text-slate-500">{e.rowCount} row(s)</span> : null}
                                      {e.options?.length ? <span className="text-slate-500">{e.options.length} option(s)</span> : null}
                                      {e.note ? <span className="text-slate-500 italic">{e.note}</span> : null}
                                    </div>
                                  ))}
                                </div>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                );
              })}
              {(map.notes ?? []).length ? (
                <div className="mt-2 text-[11px] text-amber-800">
                  {map.notes!.map((nt, i) => <div key={i}>· {nt}</div>)}
                </div>
              ) : null}
            </div>
          )}
        </CardBody>
      </Card>

      {/* Results. */}
      {result && result.outcomes.length > 0 ? (
        <Card>
          <CardHeader className="flex flex-wrap items-center gap-2">
            <CardTitle>Results</CardTitle>
            <Badge>{result.host}</Badge>
            {result.username ? <Badge tone="default">as {result.username}</Badge> : null}
            {result.build ? <Badge tone="info">build {result.build}</Badge> : null}
            <span className="text-[11px] text-slate-500">
              {new Date(result.startedAt).toLocaleString()} ·{' '}
              {Math.round((new Date(result.finishedAt).getTime() - new Date(result.startedAt).getTime()) / 1000)}s
            </span>
            <div className="flex-1" />
            {(['all', 'pass', 'fail', 'skip', 'not-available', 'error'] as const).map(s => {
              const n = s === 'all' ? counts?.total
                : s === 'pass' ? counts?.passed
                : s === 'fail' ? counts?.failed
                : s === 'skip' ? counts?.skipped
                : s === 'not-available' ? counts?.notAvailable
                : counts?.errors;
              return (
                <button
                  key={s}
                  onClick={() => setStatusFilter(s as Status | 'all')}
                  className={`text-xs px-2 py-1 rounded-md border ${statusFilter === s ? 'bg-slate-900 text-white border-slate-900' : 'bg-white border-slate-300 text-slate-700'}`}
                >
                  {s === 'all' ? 'All' : STATUS_META[s as Status].label} {n ?? 0}
                </button>
              );
            })}
            <div className="relative">
              <Search className="h-3.5 w-3.5 absolute left-2 top-2 text-slate-400" />
              <Input value={search} onChange={e => setSearch(e.target.value)}
                placeholder="filter rows" className="pl-7 text-sm w-44" />
            </div>
          </CardHeader>
          <CardBody className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-left text-slate-500 border-b border-line">
                  <th className="py-1 pr-2">Status</th>
                  <th className="py-1 pr-2">Section</th>
                  <th className="py-1 pr-2">Page</th>
                  <th className="py-1 pr-2">Element</th>
                  <th className="py-1 pr-2">Test performed</th>
                  <th className="py-1 pr-2">Expected</th>
                  <th className="py-1 pr-2">Actual</th>
                  <th className="py-1 pr-2">Time</th>
                  <th className="py-1 pr-2">Shot</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(o => {
                  const meta = STATUS_META[o.status];
                  const url = shotUrl(o.screenshotFile);
                  return (
                    <tr key={o.check.id} className="border-b border-line/60 align-top">
                      <td className="py-1 pr-2 whitespace-nowrap">
                        <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border ${meta.tone}`}>
                          <meta.Icon className="h-3 w-3" />{meta.label}
                        </span>
                      </td>
                      <td className="py-1 pr-2 whitespace-nowrap text-slate-700">{o.check.section}</td>
                      <td className="py-1 pr-2 text-slate-700">{o.check.page}</td>
                      <td className="py-1 pr-2 text-slate-800">
                        {o.check.element ?? '—'}
                        {o.check.elementKind ? <span className="text-slate-400 font-mono"> {o.check.elementKind}</span> : null}
                      </td>
                      <td className="py-1 pr-2 text-slate-700">{o.check.test}</td>
                      <td className="py-1 pr-2 text-slate-600">{o.check.expected}</td>
                      <td className="py-1 pr-2 text-slate-900">
                        {o.actual}
                        {o.reason ? <div className="text-slate-500">({o.reason})</div> : null}
                        {o.error ? <div className="text-red-700 font-mono break-all">{o.error.slice(0, 300)}</div> : null}
                      </td>
                      <td className="py-1 pr-2 whitespace-nowrap text-slate-500">
                        {new Date(o.ranAt).toLocaleTimeString()}
                        <div className="text-slate-400">{o.durationMs}ms</div>
                      </td>
                      <td className="py-1 pr-2">
                        {url ? <a href={url} target="_blank" rel="noreferrer" className="text-primary-700 underline">view</a> : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {rows.length === 0 ? <p className="text-sm text-slate-500 py-3">Nothing matches that filter.</p> : null}
            {result.notes.length ? (
              <div className="mt-3 text-[11px] text-amber-800">
                {result.notes.map((n, i) => <div key={i}>· {n}</div>)}
              </div>
            ) : null}
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}

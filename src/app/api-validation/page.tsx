'use client';

// API Validation — the API Automation and Validation tool, inside SimQA.
//
// Same capabilities as the standalone GUI it came from: pick a server and a
// login, choose APIs section by section, edit any API's parameters and body
// with the document enforced live, run them in dependency order with negative
// tests and the safety check, watch the results stream in, and download the
// report. Plus the document panel: upload a new openapi.yaml, see what it
// would change, apply it or roll back.
//
// The looks are SimQA's — Card, Button, Badge, the same tokens — so it reads
// as part of this application rather than a port of another one.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Header } from '@/components/Header';
import { Card, CardBody, CardHeader, CardTitle, Button, Badge, Input } from '@/components/ui';
import {
  Play, Square, Loader2, ChevronRight, ChevronDown, Download, FileJson, FileText,
  ShieldAlert, ShieldCheck, Search, RefreshCw, Upload, History, AlertTriangle, CheckCircle2,
  XCircle, MinusCircle, Rocket, KeyRound,
} from 'lucide-react';

type Json = any;

interface ParamView {
  name: string; in: string; required: boolean; description: string;
  type: string; format?: string; enum?: Json[]; minimum?: number; maximum?: number;
  doc_default?: Json; default: string;
}
interface OpView {
  id: string; method: string; path: string; summary: string; description: string;
  admin_only: boolean; secured: boolean;
  params: ParamView[];
  body: null | { content_type: string; required: boolean; examples: Record<string, Json>; changed: Array<{ key: string; document: Json; tool: Json }> };
  responses: Record<string, string>;
  needs: string[]; normal_delete: boolean; produces: string[];
  follows_cells: boolean; spec_issue: boolean; destructive: boolean;
}
interface SectionView { name: string; ops: OpView[] }
interface SpecView {
  tool: string; title: string; version: string; base_path: string; fingerprint: string;
  suite: Array<[string, string]>; suite_logins: Record<string, string>;
  sections: SectionView[];
  shared_vars: Array<{ name: string; producer: string | null }>;
}
interface ResultRow {
  n: number; section: string; method: string; path: string; case: string; kind: string;
  expect: string[]; status: number | null; verdict: string; reason: string; note: string;
  ms: number | null; as: string; issues: number; warnings: number;
}
interface Override { params?: Record<string, string>; body?: string; example?: string }

const VERDICT: Record<string, { tone: string; Icon: typeof CheckCircle2 }> = {
  PASS: { tone: 'text-emerald-700 bg-emerald-50 border-emerald-200', Icon: CheckCircle2 },
  FAIL: { tone: 'text-red-700 bg-red-50 border-red-200', Icon: XCircle },
  SKIP: { tone: 'text-amber-700 bg-amber-50 border-amber-200', Icon: MinusCircle },
  ERROR: { tone: 'text-fuchsia-700 bg-fuchsia-50 border-fuchsia-200', Icon: AlertTriangle },
};

export default function ApiValidationPage() {
  const [spec, setSpec] = useState<SpecView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Connection
  const [runAs, setRunAs] = useState('');
  const [host, setHost] = useState('');
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [insecure, setInsecure] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [roles, setRoles] = useState<string[]>([]);
  const [loginMsg, setLoginMsg] = useState<string | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);

  // Options
  const [negative, setNegative] = useState(true);
  const [safety, setSafety] = useState(true);
  const [strict, setStrict] = useState(false);
  const [timeout, setTimeoutS] = useState(30);
  const [shared, setShared] = useState<Record<string, string>>({});

  // Selection + per-API inputs
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openSections, setOpenSections] = useState<Set<string>>(new Set());
  const [openInputs, setOpenInputs] = useState<Set<string>>(new Set());
  const [overrides, setOverrides] = useState<Record<string, Override>>({});
  const [inputErrors, setInputErrors] = useState<Record<string, { errors: string[]; warnings: string[] }>>({});
  const [filter, setFilter] = useState('');

  // Run state
  const [runId, setRunId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState<ResultRow[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number; current: string; status: string; error?: string | null } | null>(null);
  const [runError, setRunError] = useState<string[] | null>(null);
  const [verdictFilter, setVerdictFilter] = useState<'all' | 'PASS' | 'FAIL' | 'SKIP' | 'ERROR'>('all');

  // Suite
  const [suiteUeIp, setSuiteUeIp] = useState('');
  const [suiteAdmin, setSuiteAdmin] = useState({ username: 'admin', password: 'admin' });
  const [suiteUser, setSuiteUser] = useState({ username: 'simuser', password: 'simuser' });
  const [suiteOpen, setSuiteOpen] = useState(false);

  // Document panel + recent runs
  const [doc, setDoc] = useState<Json>(null);
  const [docPreview, setDocPreview] = useState<Json>(null);
  const [docBusy, setDocBusy] = useState(false);
  const [docMsg, setDocMsg] = useState<string | null>(null);
  const [recent, setRecent] = useState<Json[]>([]);
  const [docOpen, setDocOpen] = useState(false);

  const pollRef = useRef<number | null>(null);

  // ---- loading ---------------------------------------------------------

  useEffect(() => {
    fetch('/api/api-validation/spec')
      .then(r => r.json())
      .then(j => {
        if (j.error) { setLoadError(j.error); return; }
        setSpec(j);
        setOpenSections(new Set([j.sections[0]?.name].filter(Boolean)));
      })
      .catch(e => setLoadError(String(e?.message ?? e)));
    void refreshDoc();
    void refreshRecent();
  }, []);

  const refreshDoc = useCallback(async () => {
    try { setDoc(await fetch('/api/api-validation/document').then(r => r.json())); } catch { /* panel stays as it was */ }
  }, []);
  const refreshRecent = useCallback(async () => {
    try {
      const j = await fetch('/api/api-validation/reports?limit=12').then(r => r.json());
      setRecent(j.runs ?? []);
    } catch { /* the list is a convenience */ }
  }, []);

  // ---- selection -------------------------------------------------------

  const allOps = useMemo(() => (spec?.sections ?? []).flatMap(s => s.ops), [spec]);
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return null;
    return new Set(allOps.filter(o =>
      `${o.method} ${o.path} ${o.summary} ${o.id}`.toLowerCase().includes(q)).map(o => o.id));
  }, [filter, allOps]);

  const toggleOp = (id: string) => setSelected(p => {
    const n = new Set(p);
    n.has(id) ? n.delete(id) : n.add(id);
    return n;
  });
  const toggleSection = (s: SectionView) => setSelected(p => {
    const n = new Set(p);
    const ids = s.ops.map(o => o.id);
    const allOn = ids.every(i => n.has(i));
    for (const i of ids) allOn ? n.delete(i) : n.add(i);
    return n;
  });

  // ---- live input validation -------------------------------------------

  const validateOp = useCallback(async (op: OpView, next: Override) => {
    try {
      const r = await fetch('/api/api-validation/validate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op_id: op.id, params: next.params, body: next.body }),
      }).then(x => x.json());
      setInputErrors(p => ({ ...p, [op.id]: { errors: r.errors ?? [], warnings: r.warnings ?? [] } }));
    } catch { /* a failed check must not block typing */ }
  }, []);

  const setOverride = (op: OpView, patch: Partial<Override>) => {
    setOverrides(p => {
      const next = { ...(p[op.id] ?? {}), ...patch };
      void validateOp(op, next);
      return { ...p, [op.id]: next };
    });
  };

  // ---- running ---------------------------------------------------------

  const stopPolling = () => {
    if (pollRef.current) { window.clearInterval(pollRef.current); pollRef.current = null; }
  };

  const poll = useCallback((id: string) => {
    let since = 0;
    stopPolling();
    const tick = async () => {
      try {
        const j = await fetch(`/api/api-validation/runs/${id}?since=${since}`).then(r => r.json());
        if (j.error) return;
        if (j.results?.length) {
          since += j.results.length;
          setRows(prev => [...prev, ...j.results]);
        }
        setProgress({ done: j.done, total: j.total, current: j.current, status: j.status, error: j.error });
        if (j.status !== 'running') {
          stopPolling();
          setBusy(false);
          void refreshRecent();
        }
      } catch { /* a missed poll is retried on the next tick */ }
    };
    void tick();
    pollRef.current = window.setInterval(tick, 1200);
  }, [refreshRecent]);

  useEffect(() => stopPolling, []);

  const start = async (suite: boolean) => {
    setRunError(null);
    setRows([]);
    setProgress(null);
    setBusy(true);
    const body: Json = {
      run_as: runAs, host, username, password, token, roles,
      insecure, negative, safety, strict_status: strict, timeout,
      selected: [...selected],
      variables: Object.fromEntries(Object.entries(shared).filter(([, v]) => String(v ?? '').trim())),
      overrides: Object.fromEntries(Object.entries(overrides).map(([k, v]) => [k, {
        params: v.params, body: v.body, example: v.example,
      }])),
    };
    if (suite) {
      body.suite = true;
      body.suite_ue_ip = suiteUeIp;
      body.suite_admin = suiteAdmin;
      body.suite_user = suiteUser;
    }
    try {
      const r = await fetch('/api/api-validation/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) {
        setRunError(j.errors ?? [j.error ?? 'the run could not be started']);
        setBusy(false);
        return;
      }
      setRunId(j.id);
      setProgress({ done: 0, total: j.total, current: '', status: 'running' });
      poll(j.id);
    } catch (e: Json) {
      setRunError([String(e?.message ?? e)]);
      setBusy(false);
    }
  };

  const login = async () => {
    setLoggingIn(true);
    setLoginMsg(null);
    try {
      const j = await fetch('/api/api-validation/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host, username, password, insecure }),
      }).then(r => r.json());
      if (j.ok) {
        setToken(j.token);
        setRoles(j.roles ?? []);
        setLoginMsg(`signed in${j.roles?.length ? ` as ${j.roles.join(', ')}` : ''}`);
      } else {
        setToken(null);
        setLoginMsg(j.message ?? 'login failed');
      }
    } catch (e: Json) {
      setLoginMsg(String(e?.message ?? e));
    } finally {
      setLoggingIn(false);
    }
  };

  // ---- document panel --------------------------------------------------

  const uploadDoc = async (file: File) => {
    setDocBusy(true);
    setDocMsg(null);
    setDocPreview(null);
    try {
      const text = await file.text();
      const j = await fetch('/api/api-validation/document/preview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
      }).then(r => r.json());
      if (j.error) setDocMsg(j.error);
      else setDocPreview(j);
    } catch (e: Json) {
      setDocMsg(String(e?.message ?? e));
    } finally {
      setDocBusy(false);
    }
  };

  const applyDoc = async () => {
    if (!docPreview) return;
    setDocBusy(true);
    try {
      const j = await fetch('/api/api-validation/document/apply', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: docPreview.token }),
      }).then(r => r.json());
      if (j.error) { setDocMsg(j.error); return; }
      setDocPreview(null);
      setDocMsg('the new document is active');
      await refreshDoc();
      const s = await fetch('/api/api-validation/spec').then(r => r.json());
      setSpec(s);
      setSelected(new Set());
    } finally {
      setDocBusy(false);
    }
  };

  const rollbackDoc = async (file: string) => {
    setDocBusy(true);
    try {
      const j = await fetch('/api/api-validation/document/rollback', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file }),
      }).then(r => r.json());
      if (j.error) { setDocMsg(j.error); return; }
      setDocMsg(`rolled back to ${file}`);
      await refreshDoc();
      const s = await fetch('/api/api-validation/spec').then(r => r.json());
      setSpec(s);
      setSelected(new Set());
    } finally {
      setDocBusy(false);
    }
  };

  // ---- derived ---------------------------------------------------------

  const counts = useMemo(() => {
    const c = { PASS: 0, FAIL: 0, SKIP: 0, ERROR: 0 } as Record<string, number>;
    for (const r of rows) if (r.verdict in c) c[r.verdict] += 1;
    return c;
  }, [rows]);

  const shownRows = useMemo(
    () => (verdictFilter === 'all' ? rows : rows.filter(r => r.verdict === verdictFilter)),
    [rows, verdictFilter],
  );

  const selectedCount = selected.size;
  const hasBlockingErrors = Object.values(inputErrors).some(e => e.errors.length);

  // ---- view ------------------------------------------------------------

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <Header
        title="API Validation"
        subtitle="Calls the APIs you select on a Simnovator and checks every request and response against the API document"
        right={
          <div className="flex items-center gap-2">
            {doc ? <Badge tone="info">{doc.title} {doc.version} · {doc.apis} APIs · {doc.fingerprint}</Badge> : null}
            {busy ? (
              <Button size="sm" variant="secondary" disabled><Loader2 className="h-4 w-4 animate-spin" />Running…</Button>
            ) : (
              <>
                <Button size="sm" variant="secondary" onClick={() => setSuiteOpen(v => !v)}>
                  <Rocket className="h-4 w-4" />Full API suite
                </Button>
                <Button size="sm" onClick={() => start(false)} disabled={!spec || selectedCount === 0 || hasBlockingErrors}>
                  <Play className="h-4 w-4" />Run {selectedCount ? `(${selectedCount})` : ''}
                </Button>
              </>
            )}
          </div>
        }
      />

      <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-10 space-y-4">
        {loadError ? (
          <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">{loadError}</div>
        ) : null}

        {/* 1 — server and login */}
        <Card>
          <CardHeader><CardTitle>1 · Server and login</CardTitle></CardHeader>
          <CardBody className="space-y-3">
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col text-[11px] text-slate-500">
                Run As
                <Input value={runAs} onChange={e => setRunAs(e.target.value)} placeholder="your name"
                  className="mt-0.5 w-40 text-sm" />
              </label>
              <label className="flex flex-col text-[11px] text-slate-500">
                Simnovator
                <Input value={host} onChange={e => setHost(e.target.value)} placeholder="192.168.1.102"
                  className="mt-0.5 w-48 text-sm" />
              </label>
              <label className="flex flex-col text-[11px] text-slate-500">
                Username
                <Input value={username} onChange={e => setUsername(e.target.value)} className="mt-0.5 w-32 text-sm" />
              </label>
              <label className="flex flex-col text-[11px] text-slate-500">
                Password
                <Input type="password" value={password} onChange={e => setPassword(e.target.value)} className="mt-0.5 w-32 text-sm" />
              </label>
              <label className="flex items-center gap-1.5 text-xs text-slate-600 pb-1.5">
                <input type="checkbox" checked={insecure} onChange={e => setInsecure(e.target.checked)} />
                Skip TLS check
              </label>
              <Button size="sm" variant="secondary" onClick={login} disabled={loggingIn || !host}>
                <KeyRound className="h-4 w-4" />{loggingIn ? 'Signing in…' : 'Login'}
              </Button>
              {loginMsg ? (
                <span className={`text-xs ${token ? 'text-emerald-700' : 'text-red-700'}`}>{loginMsg}</span>
              ) : null}
            </div>
            <p className="text-[11px] text-slate-500">
              The token is sent as <code>Authorization: Bearer …</code> on every API. Skip Login and the run signs in itself.
              The address may be <code>192.168.1.10</code>, <code>192.168.1.10:8080</code>, or prefixed with <code>https://</code>.
            </p>
          </CardBody>
        </Card>

        {/* 2 — options */}
        <Card>
          <CardHeader><CardTitle>2 · Options</CardTitle></CardHeader>
          <CardBody className="space-y-2">
            <div className="flex flex-wrap items-center gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={negative} onChange={e => setNegative(e.target.checked)} />
                Include negative tests
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={safety} onChange={e => setSafety(e.target.checked)} />
                Safety check
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={strict} onChange={e => setStrict(e.target.checked)} />
                Strict status codes
              </label>
              <label className="flex items-center gap-2 text-[11px] text-slate-500">
                Timeout (s)
                <Input type="number" min={1} max={600} value={timeout}
                  onChange={e => setTimeoutS(Number(e.target.value) || 30)} className="w-20 text-sm" />
              </label>
            </div>
            {!safety ? (
              <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800 flex items-start gap-2">
                <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0" />
                <span>
                  The safety check is <b>off</b>: every selected PUT, PATCH and DELETE runs on whatever ID it is given —
                  including resources this run did not create. The report records that it was off.
                </span>
              </div>
            ) : (
              <p className="text-[11px] text-slate-500 flex items-center gap-1.5">
                <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
                Updates and deletes only touch what this run created. A DELETE in a section with no create API
                (test-cases) is a normal delete and uses the ID you give it.
              </p>
            )}
          </CardBody>
        </Card>

        {/* Full API suite */}
        {suiteOpen ? (
          <Card>
            <CardHeader><CardTitle>Full API suite</CardTitle></CardHeader>
            <CardBody className="space-y-3">
              <p className="text-xs text-slate-600">
                Runs every API in a fixed order, each section as admin or as the user, with predefined inputs
                only — Inputs edits and Shared values are not used. The simulator it creates lives on the UE IP below.
              </p>
              <div className="flex flex-wrap items-end gap-3">
                <label className="flex flex-col text-[11px] text-slate-500">
                  UE IP address
                  <Input value={suiteUeIp} onChange={e => setSuiteUeIp(e.target.value)} placeholder="192.168.1.101"
                    className="mt-0.5 w-40 text-sm" />
                </label>
                <label className="flex flex-col text-[11px] text-slate-500">
                  Admin login
                  <div className="flex gap-1 mt-0.5">
                    <Input value={suiteAdmin.username} onChange={e => setSuiteAdmin(s => ({ ...s, username: e.target.value }))} className="w-28 text-sm" />
                    <Input type="password" value={suiteAdmin.password} onChange={e => setSuiteAdmin(s => ({ ...s, password: e.target.value }))} className="w-28 text-sm" />
                  </div>
                </label>
                <label className="flex flex-col text-[11px] text-slate-500">
                  User login
                  <div className="flex gap-1 mt-0.5">
                    <Input value={suiteUser.username} onChange={e => setSuiteUser(s => ({ ...s, username: e.target.value }))} className="w-28 text-sm" />
                    <Input type="password" value={suiteUser.password} onChange={e => setSuiteUser(s => ({ ...s, password: e.target.value }))} className="w-28 text-sm" />
                  </div>
                </label>
                <Button size="sm" onClick={() => start(true)} disabled={busy || !host || !suiteUeIp}>
                  <Rocket className="h-4 w-4" />Run full API suite
                </Button>
              </div>
              {spec ? (
                <p className="text-[11px] text-slate-500">
                  Order: {spec.suite.map(([s, role]) => `${s} (${role})`).join(' → ')} → clean-up → logout
                </p>
              ) : null}
            </CardBody>
          </Card>
        ) : null}

        {/* 3 — shared values */}
        {spec ? (
          <Card>
            <CardHeader><CardTitle>3 · Shared values</CardTitle></CardHeader>
            <CardBody>
              <p className="text-[11px] text-slate-500 mb-2">
                Set an ID here to test read-only APIs against something that already exists. Left empty, each value
                comes from the API that creates it during the run.
              </p>
              <div className="flex flex-wrap gap-3">
                {spec.shared_vars.map(v => (
                  <label key={v.name} className="flex flex-col text-[11px] text-slate-500">
                    {v.name}
                    <Input value={shared[v.name] ?? ''} onChange={e => setShared(p => ({ ...p, [v.name]: e.target.value }))}
                      placeholder={v.producer ?? 'not produced by any API'} className="mt-0.5 w-52 text-sm" />
                  </label>
                ))}
              </div>
            </CardBody>
          </Card>
        ) : null}

        {/* 4 — APIs */}
        <Card>
          <CardHeader className="flex flex-wrap items-center gap-2">
            <CardTitle>4 · Select APIs</CardTitle>
            {spec ? <Badge tone="default">{selectedCount} of {allOps.length} selected</Badge> : null}
            <div className="flex-1" />
            <div className="relative">
              <Search className="h-3.5 w-3.5 absolute left-2 top-2 text-slate-400" />
              <Input value={filter} onChange={e => setFilter(e.target.value)} placeholder="filter APIs"
                className="pl-7 text-sm w-48" />
            </div>
            <Button size="sm" variant="secondary" onClick={() => setSelected(new Set(allOps.map(o => o.id)))}>All</Button>
            <Button size="sm" variant="secondary" onClick={() => setSelected(new Set())}>None</Button>
          </CardHeader>
          <CardBody className="space-y-1">
            {!spec ? (
              <p className="text-sm text-slate-500">Loading the API document…</p>
            ) : spec.sections.map(s => {
              const ops = visible ? s.ops.filter(o => visible.has(o.id)) : s.ops;
              if (!ops.length) return null;
              const open = openSections.has(s.name) || !!visible;
              const on = ops.filter(o => selected.has(o.id)).length;
              return (
                <div key={s.name} className="border border-line rounded-md">
                  <div className="flex items-center gap-2 px-2 py-1.5 bg-slate-50">
                    <button onClick={() => setOpenSections(p => {
                      const n = new Set(p); n.has(s.name) ? n.delete(s.name) : n.add(s.name); return n;
                    })} className="flex items-center gap-1 text-sm font-medium text-slate-800">
                      {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                      {s.name}
                    </button>
                    <Badge tone="default">{on}/{ops.length}</Badge>
                    <div className="flex-1" />
                    <button onClick={() => toggleSection(s)} className="text-[11px] text-primary-700 hover:underline">
                      {on === ops.length ? 'clear section' : 'select section'}
                    </button>
                  </div>
                  {open ? (
                    <div className="divide-y divide-line">
                      {ops.map(op => {
                        const errs = inputErrors[op.id];
                        const inputsOpen = openInputs.has(op.id);
                        return (
                          <div key={op.id} className="px-3 py-1.5">
                            <div className="flex flex-wrap items-center gap-2">
                              <input type="checkbox" checked={selected.has(op.id)} onChange={() => toggleOp(op.id)} />
                              <span className={`text-[11px] font-bold w-14 ${op.method === 'DELETE' ? 'text-red-700' : op.method === 'GET' ? 'text-slate-600' : 'text-primary-700'}`}>{op.method}</span>
                              <span className="font-mono text-xs text-slate-800">{op.path}</span>
                              {op.admin_only ? <Badge tone="warning">admin only</Badge> : null}
                              {op.destructive ? <Badge tone="danger">delete</Badge> : null}
                              {op.normal_delete ? <Badge tone="default">deletes given ID</Badge> : null}
                              {op.spec_issue ? <Badge tone="warning">document example is invalid</Badge> : null}
                              {op.needs.length ? <span className="text-[11px] text-slate-500">needs {op.needs.join(', ')}</span> : null}
                              {op.produces.length ? <span className="text-[11px] text-emerald-700">produces {op.produces.join(', ')}</span> : null}
                              <div className="flex-1" />
                              {op.params.length || op.body ? (
                                <button onClick={() => setOpenInputs(p => {
                                  const n = new Set(p); n.has(op.id) ? n.delete(op.id) : n.add(op.id); return n;
                                })} className="text-[11px] text-primary-700 hover:underline">Inputs</button>
                              ) : null}
                            </div>
                            {op.summary ? <div className="ml-6 text-[11px] text-slate-500">{op.summary}</div> : null}
                            {errs?.errors.length ? (
                              <div className="ml-6 mt-1 text-[11px] text-red-700">{errs.errors.map((e, i) => <div key={i}>{e}</div>)}</div>
                            ) : null}
                            {errs?.warnings.length ? (
                              <div className="ml-6 mt-1 text-[11px] text-amber-700">{errs.warnings.map((e, i) => <div key={i}>{e}</div>)}</div>
                            ) : null}
                            {inputsOpen ? <OpInputs op={op} ov={overrides[op.id] ?? {}} onChange={patch => setOverride(op, patch)} /> : null}
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </CardBody>
        </Card>

        {/* errors from the start attempt */}
        {runError ? (
          <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
            <div className="font-medium mb-1">The run did not start</div>
            {runError.map((e, i) => <div key={i} className="text-xs">{e}</div>)}
          </div>
        ) : null}

        {/* 5 — results */}
        {progress || rows.length ? (
          <Card>
            <CardHeader className="flex flex-wrap items-center gap-2">
              <CardTitle>Results</CardTitle>
              {runId ? <Badge tone="default">{runId}</Badge> : null}
              {progress ? (
                <span className="text-[11px] text-slate-600">
                  {progress.status === 'running'
                    ? <>running · {progress.done}/{progress.total} APIs{progress.current ? ` · ${progress.current}` : ''}</>
                    : progress.status === 'error' ? <span className="text-red-700">{progress.error}</span> : 'finished'}
                </span>
              ) : null}
              <div className="flex-1" />
              {(['all', 'PASS', 'FAIL', 'SKIP', 'ERROR'] as const).map(v => (
                <button key={v} onClick={() => setVerdictFilter(v)}
                  className={`text-xs px-2 py-1 rounded-md border ${verdictFilter === v ? 'bg-slate-900 text-white border-slate-900' : 'bg-white border-slate-300 text-slate-700'}`}>
                  {v === 'all' ? `All ${rows.length}` : `${v} ${counts[v] ?? 0}`}
                </button>
              ))}
              {runId && !busy ? (
                <>
                  <a href={`/api/api-validation/runs/${runId}/download/html`} target="_blank" rel="noreferrer"
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-slate-300 text-sm hover:bg-slate-50">
                    <FileText className="h-4 w-4" />Open report
                  </a>
                  <a href={`/api/api-validation/runs/${runId}/download/json`} target="_blank" rel="noreferrer"
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-slate-300 text-sm hover:bg-slate-50">
                    <FileJson className="h-4 w-4" />Results JSON
                  </a>
                </>
              ) : null}
            </CardHeader>
            <CardBody className="overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="text-left text-slate-500 border-b border-line">
                    <th className="py-1 pr-2">#</th>
                    <th className="py-1 pr-2">Verdict</th>
                    <th className="py-1 pr-2">Section</th>
                    <th className="py-1 pr-2">API</th>
                    <th className="py-1 pr-2">Case</th>
                    <th className="py-1 pr-2">Expected</th>
                    <th className="py-1 pr-2">Status</th>
                    <th className="py-1 pr-2">Detail</th>
                    <th className="py-1 pr-2">ms</th>
                  </tr>
                </thead>
                <tbody>
                  {shownRows.map(r => {
                    const v = VERDICT[r.verdict] ?? VERDICT.SKIP;
                    return (
                      <tr key={r.n} className="border-b border-line/60 align-top">
                        <td className="py-1 pr-2 text-slate-400">{r.n}</td>
                        <td className="py-1 pr-2 whitespace-nowrap">
                          <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border ${v.tone}`}>
                            <v.Icon className="h-3 w-3" />{r.verdict}
                          </span>
                        </td>
                        <td className="py-1 pr-2 text-slate-600">{r.section}</td>
                        <td className="py-1 pr-2 font-mono text-slate-800 whitespace-nowrap">{r.method} {r.path}</td>
                        <td className="py-1 pr-2 text-slate-700">
                          {r.case}
                          {r.as ? <span className="ml-1 text-primary-700">as {r.as}</span> : null}
                          {r.kind === 'negative' ? <Badge tone="default">negative</Badge> : null}
                        </td>
                        <td className="py-1 pr-2 text-slate-500">{(r.expect ?? []).join(' / ')}</td>
                        <td className="py-1 pr-2 text-slate-800">{r.status ?? '—'}</td>
                        <td className="py-1 pr-2 text-slate-700">
                          {r.reason || r.note || (r.issues ? `${r.issues} issue(s)` : '')}
                          {r.warnings ? <span className="ml-1 text-amber-700">{r.warnings} warning(s)</span> : null}
                        </td>
                        <td className="py-1 pr-2 text-slate-500">{r.ms ?? ''}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {!shownRows.length ? <p className="text-sm text-slate-500 py-3">Nothing to show yet.</p> : null}
            </CardBody>
          </Card>
        ) : null}

        {/* API document + recent runs */}
        <Card>
          <CardHeader className="flex items-center gap-2">
            <CardTitle>API document</CardTitle>
            {doc ? <Badge tone="default">{doc.fingerprint}</Badge> : null}
            <div className="flex-1" />
            <button onClick={() => setDocOpen(v => !v)} className="text-[11px] text-primary-700 hover:underline">
              {docOpen ? 'hide' : 'upload, preview or roll back'}
            </button>
          </CardHeader>
          {docOpen ? (
            <CardBody className="space-y-3">
              <div className="flex flex-wrap items-center gap-3">
                <label className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-slate-300 text-sm cursor-pointer hover:bg-slate-50">
                  <Upload className="h-4 w-4" />Upload new document (.yaml)
                  <input type="file" accept=".yaml,.yml" className="hidden"
                    onChange={e => { const f = e.target.files?.[0]; if (f) void uploadDoc(f); }} />
                </label>
                {docBusy ? <Loader2 className="h-4 w-4 animate-spin text-slate-500" /> : null}
                {docMsg ? <span className="text-xs text-slate-700">{docMsg}</span> : null}
              </div>

              {docPreview ? (
                <div className="rounded-md border border-line p-3 space-y-2 text-xs">
                  <div className="font-medium text-slate-800">
                    {docPreview.current.title} {docPreview.current.version} ({docPreview.current.apis} APIs)
                    {' → '}
                    {docPreview.new.title} {docPreview.new.version} ({docPreview.new.apis} APIs)
                  </div>
                  <DiffList title="New sections" items={docPreview.diff.sections_added} tone="text-emerald-700" />
                  <DiffList title="Removed sections" items={docPreview.diff.sections_removed} tone="text-red-700" />
                  <DiffList title="New APIs" items={docPreview.diff.added.map((a: Json) => `${a.api} (${a.section})`)} tone="text-emerald-700" />
                  <DiffList title="Removed APIs" items={docPreview.diff.removed.map((a: Json) => `${a.api} (${a.section})`)} tone="text-red-700" />
                  <DiffList title="Changed APIs" items={docPreview.diff.changed.map((a: Json) =>
                    `${a.api} — ${a.parts.join(', ')}${a.codes_added.length ? ` · +${a.codes_added.join(',')}` : ''}${a.codes_removed.length ? ` · -${a.codes_removed.join(',')}` : ''}`)} tone="text-amber-700" />
                  <DiffList title="Changed schemas" items={docPreview.diff.components.map((c: Json) => `${c.kind}/${c.name} ${c.state}${c.used_by.length ? ` (used by ${c.used_by.length} API(s))` : ''}`)} tone="text-slate-700" />
                  <DiffList title="Wiring: APIs this tool names that are not in the new document" items={docPreview.wiring.unknown} tone="text-red-700" />
                  <DiffList title="Wiring: APIs that would be skipped (nothing creates their ID)" items={docPreview.wiring.unlinked.map((u: Json) => `${u.api} — needs ${u.needs.join(', ')}`)} tone="text-amber-700" />
                  <DiffList title="Wiring suggestions" items={docPreview.wiring.suggestions} tone="text-slate-600" />
                  <Button size="sm" onClick={applyDoc} disabled={docBusy}>Apply this document</Button>
                </div>
              ) : null}

              {doc?.history?.length ? (
                <div className="text-xs">
                  <div className="font-medium text-slate-700 mb-1 flex items-center gap-1.5"><History className="h-3.5 w-3.5" />Previous documents</div>
                  {doc.history.map((h: Json) => (
                    <div key={h.file} className="flex items-center gap-2 py-0.5">
                      <span className="font-mono text-slate-700">{h.file}</span>
                      <span className="text-slate-500">{h.title} {h.version} · {h.apis} APIs · replaced {h.replaced_at}</span>
                      <button onClick={() => rollbackDoc(h.file)} className="text-primary-700 hover:underline">Roll back</button>
                    </div>
                  ))}
                </div>
              ) : null}
            </CardBody>
          ) : null}
        </Card>

        <Card>
          <CardHeader className="flex items-center gap-2">
            <CardTitle>Recent runs</CardTitle>
            <div className="flex-1" />
            <button onClick={refreshRecent} className="text-[11px] text-primary-700 hover:underline inline-flex items-center gap-1">
              <RefreshCw className="h-3 w-3" />refresh
            </button>
          </CardHeader>
          <CardBody>
            {!recent.length ? <p className="text-sm text-slate-500">No runs yet.</p> : (
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="text-left text-slate-500 border-b border-line">
                    <th className="py-1 pr-2">Run</th><th className="py-1 pr-2">When</th><th className="py-1 pr-2">Run as</th>
                    <th className="py-1 pr-2">Server</th><th className="py-1 pr-2">Tests</th><th className="py-1 pr-2">Pass rate</th><th className="py-1 pr-2">Report</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map(r => (
                    <tr key={r.id} className="border-b border-line/60">
                      <td className="py-1 pr-2 font-mono">{r.id}{r.suite ? <Badge tone="info">suite</Badge> : null}</td>
                      <td className="py-1 pr-2 text-slate-600">{r.finished ?? r.started}</td>
                      <td className="py-1 pr-2">{r.runAs ?? '—'}</td>
                      <td className="py-1 pr-2">{r.host}</td>
                      <td className="py-1 pr-2">
                        {r.total ?? 0}
                        <span className="text-emerald-700"> {r.counts?.PASS ?? 0}P</span>
                        <span className="text-red-700"> {r.counts?.FAIL ?? 0}F</span>
                        <span className="text-amber-700"> {r.counts?.SKIP ?? 0}S</span>
                      </td>
                      <td className="py-1 pr-2">{r.passRate ?? 0}%</td>
                      <td className="py-1 pr-2">
                        <a href={`/api/api-validation/runs/${r.id}/download/html`} target="_blank" rel="noreferrer"
                          className="text-primary-700 hover:underline">open</a>
                        {' · '}
                        <a href={`/api/api-validation/runs/${r.id}/download/json`} target="_blank" rel="noreferrer"
                          className="text-primary-700 hover:underline">json</a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

function DiffList({ title, items, tone }: { title: string; items: string[]; tone: string }) {
  if (!items?.length) return null;
  return (
    <div>
      <div className="font-medium text-slate-700">{title} <span className="text-slate-400">{items.length}</span></div>
      <ul className={`pl-4 list-disc ${tone}`}>
        {items.slice(0, 40).map((i, n) => <li key={n}>{i}</li>)}
        {items.length > 40 ? <li className="text-slate-500">… {items.length - 40} more</li> : null}
      </ul>
    </div>
  );
}

/** Parameters and body of one API, pre-filled from the document. An empty
 *  field uses the documented default, exactly as the original tool. */
function OpInputs({ op, ov, onChange }: { op: OpView; ov: Override; onChange: (patch: Partial<Override>) => void }) {
  const exampleNames = Object.keys(op.body?.examples ?? {});
  const current = ov.example ?? exampleNames[0];
  const [schema, setSchema] = useState<Json>(null);

  const bodyText = ov.body ?? (op.body ? JSON.stringify(op.body.examples[current] ?? {}, null, 2) : '');

  return (
    <div className="ml-6 mt-2 mb-1 rounded-md border border-line bg-slate-50/60 p-2 space-y-2">
      {op.params.length ? (
        <div className="space-y-1">
          {op.params.map(p => (
            <label key={p.name} className="flex flex-wrap items-center gap-2 text-[11px]">
              <span className="w-40 text-slate-600">
                {p.name}
                <span className="text-slate-400"> {p.in}{p.required ? ' · required' : ''}</span>
              </span>
              <Input
                value={ov.params?.[p.name] ?? p.default}
                onChange={e => onChange({ params: { ...(ov.params ?? {}), [p.name]: e.target.value } })}
                className="w-64 text-xs"
                placeholder={String(p.doc_default ?? '')}
              />
              <span className="text-slate-500">
                {p.type}{p.enum ? ` · one of ${p.enum.join(', ')}` : ''}{p.description ? ` · ${p.description}` : ''}
              </span>
            </label>
          ))}
        </div>
      ) : null}

      {op.body ? (
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            {exampleNames.length > 1 ? (
              <label className="flex items-center gap-1 text-slate-600">
                Example
                <select value={current}
                  onChange={e => onChange({ example: e.target.value, body: JSON.stringify(op.body!.examples[e.target.value] ?? {}, null, 2) })}
                  className="border border-slate-300 rounded px-1 py-0.5 text-xs">
                  {exampleNames.map(n => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
            ) : null}
            <button
              onClick={async () => {
                if (schema) { setSchema(null); return; }
                try {
                  setSchema(await fetch(`/api/api-validation/schema/${op.id}`).then(r => r.json()));
                } catch { /* the editor still works without it */ }
              }}
              className="text-primary-700 hover:underline">
              {schema ? 'hide schema' : 'view schema'}
            </button>
            {op.body.changed.length ? (
              <span className="text-slate-500">
                tool sets: {op.body.changed.map(c => `${c.key}=${JSON.stringify(c.tool)}`).join(', ')}
              </span>
            ) : null}
            {op.follows_cells ? <span className="text-slate-500">follows the RAT chosen for POST /tests/cells</span> : null}
          </div>
          <textarea
            value={bodyText}
            onChange={e => onChange({ body: e.target.value })}
            spellCheck={false}
            className="w-full h-48 font-mono text-[11px] border border-slate-300 rounded p-2 bg-white"
          />
          {schema ? (
            <pre className="max-h-64 overflow-auto text-[10px] bg-white border border-slate-200 rounded p-2">
              {JSON.stringify(schema, null, 2)}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

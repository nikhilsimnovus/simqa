'use client';

import { useEffect, useRef, useState } from 'react';
import { Header } from '@/components/Header';
import { BackToRunHistory } from '@/components/BackToRunHistory';
import { Card, CardBody, CardHeader, CardTitle, Button, Badge, Input, Field, Stat } from '@/components/ui';
import { FileCheck2, Play, Square, ChevronRight, ChevronDown, AlertTriangle } from 'lucide-react';

type Rat = 'lte' | 'nr-sa';
interface SystemRow { id: string; name: string; host: string; type: string; hasSsh: boolean }
interface ParamResult { inputPath: string; ueCfgPath?: string; label: string; feature: string; criticality: string; status: string; expected?: unknown; actual?: unknown; detail?: string }
interface CaseOutcome { caseId: string; rat: string; description: string; phase: string; pass: boolean; configErrors: { source: string; message: string }[]; validation?: { ok: boolean; params: ParamResult[]; counts: { honoured: number; missing: number; mismatch: number; noRule: number } }; durationMs?: number; error?: string; tags?: string[] }
interface Report { runId: string; status: string; startedAt: string; finishedAt?: string; targetHost: string; ueSimSystemId: string; mode: string; counts: { total: number; passed: number; failed: number; error: number; skipped: number; done: number }; coverage: { byFeature: Record<string, { pass: number; fail: number }>; byCriticality: Record<string, { pass: number; fail: number }>; tagsCovered: string[]; paramsWithNoRule: string[] }; cases: CaseOutcome[]; baseline?: { baselineRunId: string; regressions: string[]; fixes: string[]; unchanged: number } }

export default function ConfigFidelityPage() {
  const [systems, setSystems] = useState<SystemRow[]>([]);
  const [target, setTarget] = useState('');
  const [ueSim, setUeSim] = useState('');
  const [rats, setRats] = useState<Record<Rat, boolean>>({ lte: true, 'nr-sa': false });
  const [mode, setMode] = useState<'pairwise' | 'full'>('pairwise');
  const [slicing, setSlicing] = useState(false);
  const [bandSweep, setBandSweep] = useState(false);
  const [bandRats, setBandRats] = useState<Record<string, boolean>>({ NR: true, LTE: true, CATM: true, NBIOT: true });
  const [variationOf, setVariationOf] = useState('');
  const [cap, setCap] = useState('5');
  const [preview, setPreview] = useState<{ count: number } | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    fetch('/api/config-fidelity/runs').then((r) => r.json()).then((j) => {
      setSystems(j.systems ?? []);
      if (j.systems?.[0]) { setTarget(j.systems[0].id); setUeSim(j.systems.find((s: SystemRow) => s.hasSsh)?.id ?? j.systems[0].id); }
    }).catch(() => {});
    return () => { if (poll.current) clearInterval(poll.current); };
  }, []);

  function reqBody() {
    const base = { cap: cap ? Number(cap) : undefined, targetSystemId: target || undefined, ueSimSystemId: ueSim || undefined };
    if (variationOf.trim()) {
      return { ...base, variationOf: variationOf.trim(), mode };
    }
    if (bandSweep) {
      return { ...base, bandSweep: true, bandRats: Object.keys(bandRats).filter((r) => bandRats[r]), bandDataType: 'no_data' };
    }
    return {
      ...base,
      rats: (Object.keys(rats) as Rat[]).filter((r) => rats[r]),
      mode,
      featureFlags: slicing ? ['networkSlicing'] : [],
    };
  }

  async function doPreview() {
    setErr(null);
    try { const r = await fetch('/api/config-fidelity/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reqBody()) }); setPreview(await r.json()); }
    catch (e: any) { setErr(e?.message ?? String(e)); }
  }

  async function start() {
    setErr(null); setBusy(true); setReport(null);
    try {
      const r = await fetch('/api/config-fidelity/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reqBody()) });
      const j = await r.json();
      if (!r.ok || j.error) { setErr(j.error ?? `HTTP ${r.status}`); setBusy(false); return; }
      setRunId(j.runId);
      if (poll.current) clearInterval(poll.current);
      poll.current = setInterval(() => pollStatus(j.runId), 2500);
      pollStatus(j.runId);
    } catch (e: any) { setErr(e?.message ?? String(e)); setBusy(false); }
  }

  async function pollStatus(id: string) {
    try {
      const r = await fetch(`/api/config-fidelity/status/${id}`);
      if (!r.ok) return;
      const j: Report = await r.json();
      setReport(j);
      if (j.status !== 'running') { if (poll.current) clearInterval(poll.current); setBusy(false); }
    } catch { /* keep polling */ }
  }

  async function abort() {
    if (!runId) return;
    await fetch('/api/config-fidelity/abort', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId }) }).catch(() => {});
  }

  const toggle = (id: string) => setExpanded((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const c = report?.counts;

  return (
    <>
      <Header title="Config Fidelity" subtitle="Create → execute → retrieve ue.cfg → prove every JSON parameter is honoured" uesimHost={report?.targetHost}
        left={<BackToRunHistory />}
        right={<div className="flex items-center gap-2">
          <a href="/runs?surface=config-fidelity" className="text-sm rounded-md border border-slate-300 px-3 py-1.5 text-slate-700 hover:bg-slate-50 whitespace-nowrap">Past runs →</a>
          {busy ? <Button variant="danger" size="sm" onClick={abort}><Square className="h-4 w-4" /> Abort</Button>
            : <Button size="sm" onClick={start} disabled={!target}><Play className="h-4 w-4" /> Run matrix</Button>}
        </div>} />
      <main className="p-6 grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Controls */}
        <div className="lg:col-span-1 space-y-4">
          <Card>
            <CardHeader><CardTitle>Coverage</CardTitle></CardHeader>
            <CardBody className="space-y-3">
              <Field label="Target system (API)"><select className="w-full border rounded-md px-2 py-1.5 text-sm" value={target} onChange={(e) => setTarget(e.target.value)}>{systems.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.host})</option>)}</select></Field>
              <Field label="UE-sim host (SSH → ue.cfg)" hint="where /root/ue/config/ue.cfg is written"><select className="w-full border rounded-md px-2 py-1.5 text-sm" value={ueSim} onChange={(e) => setUeSim(e.target.value)}>{systems.map((s) => <option key={s.id} value={s.id} disabled={!s.hasSsh}>{s.name} ({s.host}){s.hasSsh ? '' : ' — no SSH'}</option>)}</select></Field>
              <div>
                <div className="text-xs font-medium text-slate-600 mb-1">RATs</div>
                {(['lte', 'nr-sa'] as Rat[]).map((r) => <label key={r} className="flex items-center gap-2 text-sm py-0.5"><input type="checkbox" checked={rats[r]} onChange={(e) => setRats((s) => ({ ...s, [r]: e.target.checked }))} />{r.toUpperCase()}</label>)}
              </div>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={slicing} onChange={(e) => setSlicing(e.target.checked)} /> Network Slicing (NR feature flag)</label>
              <div className="pt-2 border-t">
                <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={bandSweep} onChange={(e) => setBandSweep(e.target.checked)} /> Band sweep (every band)</label>
                {bandSweep ? <div className="mt-1.5 pl-1">{['NR', 'LTE', 'CATM', 'NBIOT'].map((r) => <label key={r} className="inline-flex items-center gap-1 text-xs mr-3"><input type="checkbox" checked={bandRats[r]} onChange={(e) => setBandRats((s) => ({ ...s, [r]: e.target.checked }))} />{r}</label>)}<div className="text-xs text-slate-500 mt-1">one case per band from the vetted master table (real ARFCNs). Overrides RAT/mode above.</div></div> : null}
              </div>
              <div className="pt-2 border-t">
                <Field label="Variation sweep — base test case ID" hint="keep this case's cells + subscribers fixed; vary traffic / mobility / channel-model / loop. Overrides the options above."><Input value={variationOf} onChange={(e) => setVariationOf(e.target.value)} placeholder="(paste a test case id to vary)" /></Field>
              </div>
              <Field label="Mode"><select className="w-full border rounded-md px-2 py-1.5 text-sm" value={mode} onChange={(e) => setMode(e.target.value as any)}><option value="pairwise">Pairwise (all-pairs)</option><option value="full">Full Cartesian</option></select></Field>
              <Field label="Cap (max cases)" hint="executions are sequential — keep small first"><Input value={cap} onChange={(e) => setCap(e.target.value)} /></Field>
              <div className="flex gap-2"><Button variant="secondary" size="sm" onClick={doPreview}>Preview count</Button>{preview ? <span className="text-sm text-slate-600 self-center">{preview.count} case(s)</span> : null}</div>
            </CardBody>
          </Card>
          {report?.coverage ? (
            <Card>
              <CardHeader><CardTitle>Coverage by criticality</CardTitle></CardHeader>
              <CardBody className="space-y-2">
                {Object.entries(report.coverage.byCriticality).map(([k, v]) => <div key={k} className="flex justify-between text-sm"><span className="capitalize">{k}</span><span><span className="text-success-700">{v.pass}✓</span> / <span className="text-danger-700">{v.fail}✗</span></span></div>)}
                {report.coverage.paramsWithNoRule.length ? <div className="text-xs text-amber-700 pt-2 border-t"><AlertTriangle className="inline h-3 w-3" /> {report.coverage.paramsWithNoRule.length} param(s) with no mapping rule yet</div> : null}
              </CardBody>
            </Card>
          ) : null}
        </div>

        {/* Results */}
        <div className="lg:col-span-2 space-y-4">
          {err ? <Card><CardBody><div className="text-danger-700 text-sm">{err}</div></CardBody></Card> : null}
          {report ? (
            <>
              <Card><CardBody><div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
                <Stat label="Total" value={c?.total ?? 0} />
                <Stat label="Done" value={c?.done ?? 0} />
                <Stat label="Passed" value={c?.passed ?? 0} />
                <Stat label="Failed" value={c?.failed ?? 0} />
                <Stat label="Error" value={c?.error ?? 0} />
                <Stat label="Status" value={report.status} />
              </div>
              {report.baseline ? <div className="mt-3 text-xs text-slate-600">vs baseline {report.baseline.baselineRunId}: <span className="text-danger-700">{report.baseline.regressions.length} regressions</span>, <span className="text-success-700">{report.baseline.fixes.length} fixes</span>, {report.baseline.unchanged} unchanged</div> : null}
              </CardBody></Card>

              <Card>
                <CardHeader><CardTitle>Cases</CardTitle></CardHeader>
                <CardBody className="space-y-1">
                  {report.cases.map((cs) => (
                    <div key={cs.caseId} className="border rounded-md">
                      <button className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm" onClick={() => toggle(cs.caseId)}>
                        {expanded.has(cs.caseId) ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        <Badge tone={cs.pass ? 'success' : cs.phase === 'error' ? 'warning' : 'danger'}>{cs.pass ? 'PASS' : cs.phase.toUpperCase()}</Badge>
                        <span className="font-mono text-xs">{cs.caseId}</span>
                        <span className="ml-auto text-xs text-slate-500">{cs.validation ? `${cs.validation.counts.honoured}✓ ${cs.validation.counts.mismatch}✗ ${cs.validation.counts.missing}gap` : ''}{cs.configErrors.length ? ` · ${cs.configErrors.length} cfg-err` : ''}</span>
                      </button>
                      {expanded.has(cs.caseId) ? (
                        <div className="px-3 pb-3 text-xs space-y-2">
                          {cs.error ? <div className="text-danger-700">{cs.error}</div> : null}
                          {cs.configErrors.length ? <div className="text-danger-700"><div className="font-medium">Config errors</div>{cs.configErrors.map((e, i) => <div key={i}>· [{e.source}] {e.message}</div>)}</div> : null}
                          {cs.validation ? (
                            <table className="w-full">
                              <thead><tr className="text-slate-400 text-left"><th className="font-normal">param</th><th className="font-normal">expected</th><th className="font-normal">actual</th><th className="font-normal">where</th></tr></thead>
                              <tbody>{cs.validation.params.map((p, i) => (
                                <tr key={i} className={p.status === 'honoured' ? 'text-slate-600' : p.status === 'mismatch' ? 'text-danger-700' : 'text-amber-700'}>
                                  <td>{p.label}</td><td className="font-mono">{JSON.stringify(p.expected)}</td><td className="font-mono">{JSON.stringify(p.actual)}</td><td className="font-mono text-slate-400">{p.ueCfgPath}</td>
                                </tr>
                              ))}</tbody>
                            </table>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ))}
                  {!report.cases.length ? <div className="text-sm text-slate-500 py-6 text-center">waiting for first case…</div> : null}
                </CardBody>
              </Card>
            </>
          ) : <Card><CardBody><div className="text-sm text-slate-500 py-10 text-center"><FileCheck2 className="h-8 w-8 mx-auto mb-2 text-slate-300" />Pick RATs and Run matrix to validate config fidelity.</div></CardBody></Card>}
        </div>
      </main>
    </>
  );
}

'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { Header } from '@/components/Header';
import { Card, CardBody, CardHeader, CardTitle, Badge, Button } from '@/components/ui';
import { ChevronLeft, CheckCircle2, XCircle, Loader2, AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';

interface VerificationCheck { name: string; ok: boolean; value?: any; expected?: string; detail?: string }
interface VerificationDimension { name: string; ok: boolean; warnings: string[]; checks: VerificationCheck[]; hasWarnings: boolean }
interface VerificationReport {
  generatedAt: string;
  overall: 'pass' | 'warn' | 'fail';
  dimensions: {
    lifecycle: VerificationDimension;
    criteria: VerificationDimension;
    statsSanity: VerificationDimension;
    cleanup: VerificationDimension;
  };
}

interface RunDetail {
  id: string;
  testcaseId: string;
  topology?: string;
  startedAt: string;
  finishedAt?: string;
  status: string;
  dryRun?: boolean;
  steps: Array<{ name: string; ok: boolean; detail?: string; ms?: number }>;
  generatorSummary?: any;
  evidenceFiles?: string[];
  boxVersion?: { version?: string; build?: string };
  verification?: VerificationReport;
}

export default function RunDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [run, setRun] = useState<RunDetail | null>(null);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [openDims, setOpenDims] = useState<Set<string>>(new Set(['lifecycle', 'criteria']));

  const toggleDim = (k: string) => {
    const next = new Set(openDims);
    next.has(k) ? next.delete(k) : next.add(k);
    setOpenDims(next);
  };

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch(`/api/runs/${encodeURIComponent(id)}`);
        if (!r.ok) return;
        const d = await r.json();
        if (alive) setRun(d);
        if (d.status === 'running' || d.status === 'queued') setTimeout(tick, 1000);
      } catch { /* retry */ }
    };
    tick();
    return () => { alive = false; };
  }, [id]);

  useEffect(() => {
    if (!activeFile) return;
    fetch(`/api/runs/${encodeURIComponent(id)}/files/${encodeURIComponent(activeFile)}`)
      .then((r) => r.text())
      .then(setFileContent)
      .catch(() => setFileContent(null));
  }, [id, activeFile]);

  if (!run) {
    return (
      <>
        <Header title="Run" subtitle="loading…" />
        <main className="p-6"><Card><CardBody><div className="text-sm text-slate-500">Loading run…</div></CardBody></Card></main>
      </>
    );
  }

  return (
    <>
      <Header
        title={run.testcaseId}
        subtitle={`Run ${run.id} · ${new Date(run.startedAt).toLocaleString()}`}
        right={
          <div className="flex items-center gap-2">
            <Link href="/runs"><Button size="sm" variant="ghost"><ChevronLeft className="h-4 w-4" />All runs</Button></Link>
            <StatusBadge status={run.status} />
          </div>
        }
      />
      <main className="p-6 space-y-4">
        {run.generatorSummary || run.boxVersion ? (
          <Card>
            <CardHeader><CardTitle>Run context</CardTitle></CardHeader>
            <CardBody className="space-y-2">
              {run.generatorSummary ? (
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <Badge tone="info">{(run.generatorSummary.ratType ?? '').toUpperCase()}</Badge>
                  <Badge>{run.generatorSummary.cells} cell{run.generatorSummary.cells === 1 ? '' : 's'}</Badge>
                  <Badge>{run.generatorSummary.ueCount} UE{run.generatorSummary.ueCount === 1 ? '' : 's'}</Badge>
                  <Badge>PLMN {run.generatorSummary.plmn}</Badge>
                  {run.generatorSummary.ims ? <Badge tone="success">IMS</Badge> : null}
                  {run.dryRun ? <Badge tone="warning">dry-run</Badge> : null}
                </div>
              ) : null}
              {run.boxVersion?.version || run.boxVersion?.build ? (
                <div className="text-xs text-slate-600">
                  <span className="text-slate-400">box:</span>{' '}
                  <span className="font-mono">{run.boxVersion.version ?? '?'} {run.boxVersion.build ? `(${run.boxVersion.build})` : ''}</span>
                </div>
              ) : null}
            </CardBody>
          </Card>
        ) : null}

        {run.verification ? (
          <Card>
            <CardHeader className="flex items-center justify-between">
              <CardTitle>Verification report</CardTitle>
              <VerificationOverallBadge overall={run.verification.overall} />
            </CardHeader>
            <CardBody className="space-y-2">
              <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
                {(['lifecycle', 'criteria', 'statsSanity', 'cleanup'] as const).map((k) => {
                  const d = run.verification!.dimensions[k];
                  return (
                    <DimensionTile key={k} dim={d} open={openDims.has(k)} onToggle={() => toggleDim(k)} />
                  );
                })}
              </div>
              <div className="space-y-2">
                {(['lifecycle', 'criteria', 'statsSanity', 'cleanup'] as const).filter((k) => openDims.has(k)).map((k) => {
                  const d = run.verification!.dimensions[k];
                  return <DimensionDetails key={k} dim={d} />;
                })}
              </div>
              <div className="text-[11px] text-slate-400 pt-1">
                Generated {new Date(run.verification.generatedAt).toLocaleString()}.
                Pass = every check ok with no warnings. Warn = checks ok but a metric looks suspicious (e.g., PASS with achieved=0). Fail = at least one check failed.
              </div>
            </CardBody>
          </Card>
        ) : null}

        <Card>
          <CardHeader><CardTitle>Pipeline</CardTitle></CardHeader>
          <CardBody className="p-0">
            <ol className="divide-y divide-slate-100">
              {run.steps.map((s, i) => (
                <li key={i} className="px-5 py-3 flex items-start gap-3">
                  {s.ok
                    ? <CheckCircle2 className="h-4 w-4 text-success-600 mt-0.5" />
                    : <XCircle    className="h-4 w-4 text-red-600 mt-0.5" />}
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-slate-900">{s.name}</div>
                    {s.detail ? <div className="text-xs text-slate-500 mt-0.5 break-all">{s.detail}</div> : null}
                  </div>
                  {typeof s.ms === 'number' ? <span className="text-[11px] text-slate-400 mt-0.5">{s.ms}ms</span> : null}
                </li>
              ))}
              {run.status === 'running' ? (
                <li className="px-5 py-3 flex items-center gap-2 text-sm text-slate-500">
                  <Loader2 className="h-4 w-4 animate-spin" /> running…
                </li>
              ) : null}
            </ol>
          </CardBody>
        </Card>

        {(run.evidenceFiles ?? []).length > 0 ? (
          <Card>
            <CardHeader className="flex items-center justify-between">
              <CardTitle>Evidence</CardTitle>
              <div className="flex flex-wrap items-center gap-1.5">
                {run.evidenceFiles!.map((name) => (
                  <button
                    key={name}
                    onClick={() => setActiveFile(name)}
                    className={
                      'px-3 h-8 text-xs rounded-md border ' +
                      (activeFile === name
                        ? 'bg-slate-900 text-white border-slate-900'
                        : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50')
                    }
                  >
                    {name}
                  </button>
                ))}
              </div>
            </CardHeader>
            <CardBody>
              {activeFile ? (
                <pre className="cfg">{fileContent ?? 'loading…'}</pre>
              ) : (
                <div className="text-sm text-slate-500">Pick a file to view.</div>
              )}
            </CardBody>
          </Card>
        ) : null}
      </main>
    </>
  );
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'passed')   return <Badge tone="success">passed</Badge>;
  if (status === 'failed')   return <Badge tone="danger">failed</Badge>;
  if (status === 'running')  return <Badge tone="info">running</Badge>;
  if (status === 'queued')   return <Badge tone="warning">queued</Badge>;
  return <Badge>{status}</Badge>;
}

function VerificationOverallBadge({ overall }: { overall: 'pass' | 'warn' | 'fail' }) {
  if (overall === 'pass') return <Badge tone="success">all dimensions pass</Badge>;
  if (overall === 'warn') return <Badge tone="warning">pass with warnings</Badge>;
  return <Badge tone="danger">fail</Badge>;
}

const DIMENSION_LABELS: Record<string, string> = {
  lifecycle:   'Lifecycle',
  criteria:    'Success criteria',
  statsSanity: 'Stats sanity',
  cleanup:     'Cleanup',
};

function DimensionTile({ dim, open, onToggle }: { dim: VerificationDimension; open: boolean; onToggle: () => void }) {
  const tone = !dim.ok ? 'border-red-300 bg-red-50' : (dim.hasWarnings ? 'border-amber-300 bg-amber-50' : 'border-emerald-300 bg-emerald-50');
  const passed = dim.checks.filter((c) => c.ok).length;
  const total = dim.checks.length;
  return (
    <button
      onClick={onToggle}
      className={`text-left rounded-md border p-3 transition-colors hover:brightness-95 ${tone}`}
    >
      <div className="flex items-start gap-2">
        {!dim.ok
          ? <XCircle className="h-4 w-4 text-red-600 mt-0.5" />
          : dim.hasWarnings
            ? <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5" />
            : <CheckCircle2 className="h-4 w-4 text-emerald-600 mt-0.5" />}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1 text-sm font-medium text-slate-900">
            {DIMENSION_LABELS[dim.name] ?? dim.name}
            {open ? <ChevronDown className="h-3 w-3 text-slate-400" /> : <ChevronRight className="h-3 w-3 text-slate-400" />}
          </div>
          <div className="text-[11px] text-slate-600 mt-0.5">
            {passed}/{total} checks pass{dim.warnings.length ? ` · ${dim.warnings.length} warning(s)` : ''}
          </div>
        </div>
      </div>
    </button>
  );
}

function DimensionDetails({ dim }: { dim: VerificationDimension }) {
  return (
    <div className="rounded-md border border-slate-200 bg-white">
      <div className="px-4 py-2 border-b border-slate-100 text-sm font-medium text-slate-800">
        {DIMENSION_LABELS[dim.name] ?? dim.name}
      </div>
      {dim.warnings.length > 0 ? (
        <div className="px-4 py-2 border-b border-amber-100 bg-amber-50">
          <div className="text-[11px] uppercase tracking-wide text-amber-700 mb-1">Warnings</div>
          <ul className="text-xs text-amber-800 space-y-0.5">
            {dim.warnings.map((w, i) => <li key={i}>• {w}</li>)}
          </ul>
        </div>
      ) : null}
      <ul className="divide-y divide-slate-100">
        {dim.checks.map((c, i) => (
          <li key={i} className="px-4 py-2 flex items-start gap-2 text-xs">
            {c.ok
              ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 mt-0.5" />
              : <XCircle      className="h-3.5 w-3.5 text-red-600 mt-0.5" />}
            <div className="flex-1 min-w-0">
              <div className="font-medium text-slate-800 break-all">{c.name}</div>
              {c.value !== undefined ? (
                <div className="text-slate-600 break-all">value: <span className="font-mono">{String(c.value)}</span></div>
              ) : null}
              {!c.ok && c.expected ? (
                <div className="text-slate-500 break-all">expected: {c.expected}</div>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

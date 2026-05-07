'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { Header } from '@/components/Header';
import { Card, CardBody, CardHeader, CardTitle, Stat, Badge, Button } from '@/components/ui';
import { ChevronLeft, CheckCircle2, XCircle, Loader2 } from 'lucide-react';

interface BatchData {
  batchId: string;
  status: string;
  counts: { total: number; passed: number; failed: number; running: number; queued: number };
  runs: Array<{
    id: string;
    testcaseId: string;
    status: string;
    startedAt: string;
    finishedAt?: string;
    failedStep?: string;
    summary?: any;
  }>;
}

export default function BatchDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [data, setData] = useState<BatchData | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch(`/api/runs/batch/${encodeURIComponent(id)}`);
        const d: BatchData = await r.json();
        if (!alive) return;
        setData(d);
        if (d.status === 'running') setTimeout(tick, 2000);
      } catch { setTimeout(tick, 2000); }
    };
    tick();
    return () => { alive = false; };
  }, [id]);

  if (!data) {
    return (
      <>
        <Header title="Batch" subtitle="loading…" />
        <main className="p-6"><Card><CardBody><div className="text-sm text-slate-500">Loading…</div></CardBody></Card></main>
      </>
    );
  }

  return (
    <>
      <Header
        title="Automation batch"
        subtitle={`${data.batchId}`}
        right={
          <div className="flex items-center gap-2">
            <Link href="/runs"><Button size="sm" variant="ghost"><ChevronLeft className="h-4 w-4" />All runs</Button></Link>
            <BatchStatusBadge status={data.status} />
          </div>
        }
      />
      <main className="p-6 space-y-4">
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          <Stat label="Total"   value={data.counts.total} />
          <Stat label="Passed"  value={data.counts.passed} />
          <Stat label="Failed"  value={data.counts.failed} />
          <Stat label="Running" value={data.counts.running} />
          <Stat label="Queued"  value={data.counts.queued} />
        </div>

        <Card>
          <CardHeader><CardTitle>Runs in this batch</CardTitle></CardHeader>
          <CardBody className="p-0">
            {data.runs.length === 0 ? (
              <div className="p-5 text-sm text-slate-500">No runs yet — they'll appear here as the batch progresses.</div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="px-5 py-3 font-medium w-8"></th>
                    <th className="px-5 py-3 font-medium">Test Case</th>
                    <th className="px-5 py-3 font-medium">Status</th>
                    <th className="px-5 py-3 font-medium">Detail</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.runs.map((r) => (
                    <tr key={r.id} className="hover:bg-slate-50">
                      <td className="pl-5 py-3 w-8"><RunIcon status={r.status} /></td>
                      <td className="px-5 py-3">
                        <Link href={`/runs/${r.id}`} className="font-medium text-slate-900 hover:text-primary-700">{r.testcaseId}</Link>
                      </td>
                      <td className="px-5 py-3"><RunStatus status={r.status} /></td>
                      <td className="px-5 py-3 text-xs text-slate-500">
                        {r.failedStep ? `failed at ${r.failedStep}` : (r.summary as any)?.cells ? `${(r.summary as any).cells}-cell ${(r.summary as any).ratType}` : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardBody>
        </Card>
      </main>
    </>
  );
}

function RunIcon({ status }: { status: string }) {
  if (status === 'passed')  return <CheckCircle2 className="h-4 w-4 text-success-600" />;
  if (status === 'failed')  return <XCircle className="h-4 w-4 text-red-600" />;
  if (status === 'running') return <Loader2 className="h-4 w-4 animate-spin text-primary-700" />;
  return <div className="h-4 w-4 rounded-full bg-slate-200" />;
}
function RunStatus({ status }: { status: string }) {
  if (status === 'passed')  return <Badge tone="success">passed</Badge>;
  if (status === 'failed')  return <Badge tone="danger">failed</Badge>;
  if (status === 'running') return <Badge tone="info">running</Badge>;
  if (status === 'queued')  return <Badge tone="warning">queued</Badge>;
  return <Badge>{status}</Badge>;
}
function BatchStatusBadge({ status }: { status: string }) {
  if (status === 'passed')  return <Badge tone="success">passed</Badge>;
  if (status === 'failed')  return <Badge tone="danger">failed</Badge>;
  if (status === 'running') return <Badge tone="info">running</Badge>;
  return <Badge>{status}</Badge>;
}

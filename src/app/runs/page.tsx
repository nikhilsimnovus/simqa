'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Header } from '@/components/Header';
import { Card, CardBody, CardHeader, CardTitle, Badge } from '@/components/ui';

interface RunSummary {
  id: string;
  testcaseId: string;
  topology?: string;
  startedAt: string;
  finishedAt?: string;
  status: string;
  dryRun?: boolean;
  stepCount?: number;
  failedStep?: string;
  summary?: any;
}

export default function RunsPage() {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);

  useEffect(() => {
    fetch('/api/runs').then((r) => r.json()).then((d) => setRuns(d.runs ?? []));
  }, []);

  return (
    <>
      <Header title="Runs" subtitle="Recent test runs" />
      <main className="p-6 space-y-4">
        <Card>
          <CardHeader><CardTitle>History</CardTitle></CardHeader>
          <CardBody className="p-0">
            {runs == null ? (
              <div className="p-5 text-sm text-slate-500">Loading…</div>
            ) : runs.length === 0 ? (
              <div className="p-5 text-sm text-slate-500">No runs yet. Pick a testcase and hit "Run Test".</div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="px-5 py-3 font-medium">Test Case</th>
                    <th className="px-5 py-3 font-medium">Status</th>
                    <th className="px-5 py-3 font-medium">Started</th>
                    <th className="px-5 py-3 font-medium">Steps</th>
                    <th className="px-5 py-3 font-medium">Run ID</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {runs.map((r) => (
                    <tr key={r.id} className="hover:bg-slate-50">
                      <td className="px-5 py-3">
                        <Link href={`/runs/${r.id}`} className="font-medium text-slate-900 hover:text-primary-700">
                          {r.testcaseId}
                        </Link>
                        <div className="text-xs text-slate-500">{r.dryRun ? 'dry-run' : ''}</div>
                      </td>
                      <td className="px-5 py-3"><StatusBadge status={r.status} /></td>
                      <td className="px-5 py-3 text-xs text-slate-500">{new Date(r.startedAt).toLocaleString()}</td>
                      <td className="px-5 py-3 text-xs text-slate-500">{r.stepCount ?? 0}{r.failedStep ? ` (failed at ${r.failedStep})` : ''}</td>
                      <td className="px-5 py-3 text-xs font-mono text-slate-500">{r.id}</td>
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

function StatusBadge({ status }: { status: string }) {
  if (status === 'passed')   return <Badge tone="success">passed</Badge>;
  if (status === 'failed')   return <Badge tone="danger">failed</Badge>;
  if (status === 'running')  return <Badge tone="info">running</Badge>;
  if (status === 'queued')   return <Badge tone="warning">queued</Badge>;
  return <Badge>{status}</Badge>;
}

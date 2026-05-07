'use client';

import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Header } from '@/components/Header';
import { Card, CardBody, CardHeader, CardTitle, Button, Badge } from '@/components/ui';
import { ChevronLeft, FileText, Download } from 'lucide-react';

interface PreviewBundle {
  files: Record<string, string>;
  summary: {
    testcaseId: string;
    ratType: string;
    cells: number;
    cellTypes: string[];
    dataTypes: string[];
    ueCount: number;
    plmn: string;
    apns: string[];
    ims: boolean;
    realm: string;
    pcscf: string;
    notes: string[];
  };
}

export default function TestcaseDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const decoded = decodeURIComponent(id);
  const router = useRouter();
  const [tc, setTc] = useState<any>(null);
  const [bundle, setBundle] = useState<PreviewBundle | null>(null);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    Promise.all([
      fetch(`/api/testcases/${encodeURIComponent(decoded)}`).then((r) => r.json()),
      fetch(`/api/testcases/${encodeURIComponent(decoded)}/preview`).then((r) => r.json()),
    ])
      .then(([t, b]) => {
        setTc(t);
        setBundle(b);
        if (b?.files) setActiveFile(Object.keys(b.files)[0] ?? null);
      })
      .catch((e) => setErr(e?.message ?? String(e)));
  }, [decoded]);

  async function triggerRun(opts: { dryRun: boolean }) {
    setRunning(true);
    try {
      const r = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ testcaseId: decoded, dryRun: opts.dryRun, noTrigger: opts.dryRun }),
      });
      const j = await r.json();
      if (j.runId) router.push(`/runs/${j.runId}`);
      else throw new Error(j.error ?? 'no runId in response');
    } catch (e: any) {
      alert(`Run failed: ${e?.message ?? e}`);
    } finally {
      setRunning(false);
    }
  }

  return (
    <>
      <Header
        title={tc?.name ?? decoded}
        subtitle={decoded}
        right={
          <div className="flex items-center gap-2">
            <Link href="/testcases">
              <Button size="sm" variant="ghost"><ChevronLeft className="h-4 w-4" />Back</Button>
            </Link>
            <Button size="sm" variant="secondary" onClick={() => triggerRun({ dryRun: true })} disabled={running}>
              Generate (dry-run)
            </Button>
            <Button size="sm" onClick={() => triggerRun({ dryRun: false })} disabled={running}>
              Run Test
            </Button>
          </div>
        }
      />
      <main className="p-6 space-y-4">
        {err ? <div className="rounded bg-red-50 text-red-700 p-3 text-sm">{err}</div> : null}

        {bundle ? (
          <Card>
            <CardHeader>
              <CardTitle>Generator preview</CardTitle>
            </CardHeader>
            <CardBody className="space-y-3">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Badge tone="info">{bundle.summary.ratType.toUpperCase()}</Badge>
                <Badge>{bundle.summary.cells} cell{bundle.summary.cells === 1 ? '' : 's'}</Badge>
                <Badge>{bundle.summary.ueCount} UE{bundle.summary.ueCount === 1 ? '' : 's'}</Badge>
                <Badge>PLMN {bundle.summary.plmn}</Badge>
                {bundle.summary.ims ? <Badge tone="success">IMS</Badge> : null}
                {bundle.summary.dataTypes.map((d) => <Badge key={d}>{d}</Badge>)}
              </div>
              {bundle.summary.notes.length > 0 ? (
                <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
                  {bundle.summary.notes.map((n, i) => <div key={i}>· {n}</div>)}
                </div>
              ) : null}
            </CardBody>
          </Card>
        ) : null}

        {bundle ? (
          <Card>
            <CardHeader className="flex items-center justify-between">
              <CardTitle>Generated configs</CardTitle>
              <div className="flex items-center gap-1.5">
                {Object.keys(bundle.files).map((name) => (
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
                    <span className="inline-flex items-center gap-1.5">
                      <FileText className="h-3.5 w-3.5" />
                      {name}
                    </span>
                  </button>
                ))}
              </div>
            </CardHeader>
            <CardBody>
              {activeFile ? (
                <pre className="cfg">{bundle.files[activeFile]}</pre>
              ) : (
                <div className="text-sm text-slate-500">No file selected.</div>
              )}
            </CardBody>
          </Card>
        ) : !err ? (
          <Card><CardBody><div className="text-sm text-slate-500">Generating preview…</div></CardBody></Card>
        ) : null}
      </main>
    </>
  );
}

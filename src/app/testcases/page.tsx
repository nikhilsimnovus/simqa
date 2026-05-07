'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Header } from '@/components/Header';
import { Card, CardBody, CardHeader, CardTitle, Input, Badge, Button } from '@/components/ui';

interface Tc {
  id: string;
  name: string;
  description?: string;
  metadata?: any;
}

export default function TestcasesPage() {
  const [items, setItems] = useState<Tc[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | 'sa' | 'lte' | 'volte' | 'ho'>('all');

  useEffect(() => {
    setLoading(true);
    fetch('/api/testcases?limit=500')
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => { setItems(d.items ?? []); setTotal(d.total ?? null); })
      .catch((e) => setErr(e.message ?? String(e)))
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return items.filter((tc) => {
      if (ql && !(tc.id.toLowerCase().includes(ql) || (tc.name ?? '').toLowerCase().includes(ql))) return false;
      const idl = tc.id.toLowerCase();
      switch (filter) {
        case 'sa':    return idl.includes('sa') && !idl.includes('nsa');
        case 'lte':   return idl.includes('lte') || idl.includes('volte');
        case 'volte': return idl.includes('volte') || idl.includes('vonr') || idl.includes('vinr');
        case 'ho':    return idl.includes('ho');
        default:      return true;
      }
    });
  }, [items, q, filter]);

  return (
    <>
      <Header
        title="Test Cases"
        subtitle={total != null ? `${filtered.length} shown · ${total} total on the box` : 'loading…'}
      />
      <main className="p-6 space-y-4">
        <Card>
          <CardHeader className="flex flex-wrap items-center gap-3 justify-between">
            <CardTitle>Catalog</CardTitle>
            <div className="flex items-center gap-2 flex-wrap">
              <Input
                placeholder="Search by id or name…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                className="w-72"
              />
              <FilterChips filter={filter} setFilter={setFilter} />
            </div>
          </CardHeader>
          <CardBody className="p-0">
            {err ? (
              <div className="p-5 text-sm text-red-700 bg-red-50">Error: {err}</div>
            ) : loading ? (
              <div className="p-5 text-sm text-slate-500">Loading…</div>
            ) : filtered.length === 0 ? (
              <div className="p-5 text-sm text-slate-500">No testcases match.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-500">
                    <tr>
                      <th className="px-5 py-3 font-medium">Test Case</th>
                      <th className="px-5 py-3 font-medium">Last Result</th>
                      <th className="px-5 py-3 font-medium">Last Executed</th>
                      <th className="px-5 py-3 font-medium text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {filtered.map((tc) => {
                      const last = tc.metadata?.lastExecution;
                      return (
                        <tr key={tc.id} className="hover:bg-slate-50">
                          <td className="px-5 py-3">
                            <Link href={`/testcases/${encodeURIComponent(tc.id)}`} className="font-medium text-slate-900 hover:text-primary-700">
                              {tc.name || tc.id}
                            </Link>
                            <div className="text-xs text-slate-500 truncate max-w-[480px]">{tc.id}</div>
                          </td>
                          <td className="px-5 py-3"><ResultBadge value={last?.result} /></td>
                          <td className="px-5 py-3 text-xs text-slate-500">{last?.executedOn ? new Date(last.executedOn).toLocaleString() : '—'}</td>
                          <td className="px-5 py-3 text-right">
                            <Link href={`/testcases/${encodeURIComponent(tc.id)}`}>
                              <Button size="sm" variant="secondary">Open</Button>
                            </Link>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardBody>
        </Card>
      </main>
    </>
  );
}

function FilterChips({ filter, setFilter }: { filter: string; setFilter: (s: any) => void }) {
  const chips: Array<{ k: string; label: string }> = [
    { k: 'all',   label: 'All' },
    { k: 'sa',    label: '5G SA' },
    { k: 'lte',   label: 'LTE' },
    { k: 'volte', label: 'VoLTE/VoNR' },
    { k: 'ho',    label: 'Handover' },
  ];
  return (
    <div className="flex items-center gap-1.5">
      {chips.map((c) => (
        <button
          key={c.k}
          onClick={() => setFilter(c.k)}
          className={
            'px-3 h-8 text-xs rounded-full border transition-colors ' +
            (filter === c.k
              ? 'bg-primary-700 text-white border-primary-700'
              : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50')
          }
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}

function ResultBadge({ value }: { value?: string }) {
  if (value === 'PASS')       return <Badge tone="success">PASS</Badge>;
  if (value === 'FAIL')       return <Badge tone="danger">FAIL</Badge>;
  if (value === 'INCOMPLETE') return <Badge tone="warning">INCOMPLETE</Badge>;
  return <Badge>—</Badge>;
}

'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Header } from '@/components/Header';
import { Card, CardBody, CardHeader, CardTitle, Input, Button, Badge, Field } from '@/components/ui';
import { Save, Play } from 'lucide-react';

interface Tc { id: string; name: string }
interface Suite { id: string; name: string; testcaseIds: string[]; topologyId?: string; defaultDryRun?: boolean; stopOnFail?: boolean; notes?: string }
interface Profile { id: string; name: string }

export default function AutomationPage() {
  const router = useRouter();
  const [tcs, setTcs] = useState<Tc[]>([]);
  const [suites, setSuites] = useState<Suite[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activeSuite, setActiveSuite] = useState<string | null>(null);
  const [topologyId, setTopologyId] = useState<string>('');
  const [dryRun, setDryRun] = useState(true);
  const [noTrigger, setNoTrigger] = useState(true);
  const [stopOnFail, setStopOnFail] = useState(false);
  const [q, setQ] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      fetch('/api/testcases?limit=500').then((r) => r.json()),
      fetch('/api/inventory').then((r) => r.json()),
    ]).then(([t, inv]) => {
      setTcs(t.items ?? []);
      setSuites(inv.suites ?? []);
      setProfiles(inv.profiles ?? []);
    });
  }, []);

  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return tcs.filter((tc) => !ql || tc.id.toLowerCase().includes(ql) || (tc.name ?? '').toLowerCase().includes(ql));
  }, [tcs, q]);

  function toggle(id: string) {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
  }

  function loadSuite(s: Suite) {
    setActiveSuite(s.id);
    setSelected(new Set(s.testcaseIds));
    setTopologyId(s.topologyId ?? '');
    setDryRun(!!s.defaultDryRun);
    setStopOnFail(!!s.stopOnFail);
    setName(s.name);
  }

  async function saveSuite() {
    if (!name.trim()) { setMsg('name required'); return; }
    if (selected.size === 0) { setMsg('select at least one testcase'); return; }
    setBusy(true); setMsg(null);
    try {
      const inv = await (await fetch('/api/inventory')).json();
      const id = activeSuite ?? `suite-${Date.now().toString(36)}`;
      const suite: Suite = {
        id,
        name: name.trim(),
        testcaseIds: Array.from(selected),
        topologyId: topologyId || undefined,
        defaultDryRun: dryRun,
        stopOnFail,
      };
      const next = { ...inv, suites: [
        ...((inv.suites ?? []).filter((s: Suite) => s.id !== id) as Suite[]),
        suite,
      ] };
      const r = await fetch('/api/inventory', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setSuites(next.suites);
      setActiveSuite(id);
      setMsg('Saved');
      setTimeout(() => setMsg(null), 1500);
    } catch (e: any) {
      setMsg(`Error: ${e?.message ?? e}`);
    } finally {
      setBusy(false);
    }
  }

  async function runBatch() {
    if (selected.size === 0) { setMsg('select at least one testcase'); return; }
    setBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/runs/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          testcaseIds: Array.from(selected),
          topologyId: topologyId || undefined,
          dryRun, noTrigger, stopOnFail,
          suiteId: activeSuite ?? undefined,
        }),
      });
      const j = await r.json();
      if (j.batchId) router.push(`/runs/batch/${j.batchId}`);
      else throw new Error(j.error ?? 'no batchId');
    } catch (e: any) {
      setMsg(`Error: ${e?.message ?? e}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Header
        title="Automation"
        subtitle="Build a test suite, save it, and run it as a batch"
        right={
          <div className="flex items-center gap-2">
            {msg ? <span className="text-xs text-slate-500">{msg}</span> : null}
            <Button size="sm" variant="secondary" onClick={saveSuite} disabled={busy}>
              <Save className="h-4 w-4" />Save suite
            </Button>
            <Button size="sm" onClick={runBatch} disabled={busy || selected.size === 0}>
              <Play className="h-4 w-4" />Run {selected.size > 0 ? `(${selected.size})` : ''}
            </Button>
          </div>
        }
      />
      <main className="p-6 grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-1 space-y-4">
          <Card>
            <CardHeader><CardTitle>Suite</CardTitle></CardHeader>
            <CardBody className="space-y-3">
              <Field label="Name">
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Smoke - 5G SA" />
              </Field>
              <Field label="Topology" hint="optional - leaves deploy step skipped if blank">
                <select
                  value={topologyId}
                  onChange={(e) => setTopologyId(e.target.value)}
                  className="h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900"
                >
                  <option value="">— none —</option>
                  {profiles.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.id})</option>)}
                </select>
              </Field>
              <div className="flex flex-col gap-2 text-sm">
                <label className="flex items-center gap-2"><input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />Dry-run (no SSH push, no execution)</label>
                <label className="flex items-center gap-2"><input type="checkbox" checked={noTrigger} onChange={(e) => setNoTrigger(e.target.checked)} />Skip trigger (generate + deploy only)</label>
                <label className="flex items-center gap-2"><input type="checkbox" checked={stopOnFail} onChange={(e) => setStopOnFail(e.target.checked)} />Stop on first failure</label>
              </div>
              <div className="text-xs text-slate-500">Selected: <span className="font-medium text-slate-900">{selected.size}</span> testcase(s)</div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader className="flex items-center justify-between">
              <CardTitle>Saved suites</CardTitle>
              <span className="text-[11px] text-slate-500">{suites.length}</span>
            </CardHeader>
            <CardBody className="p-0">
              {suites.length === 0 ? (
                <div className="p-4 text-sm text-slate-500">No saved suites. Build one, hit Save.</div>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {suites.map((s) => (
                    <li key={s.id}>
                      <button onClick={() => loadSuite(s)} className={
                        'w-full text-left px-4 py-3 hover:bg-slate-50 ' +
                        (activeSuite === s.id ? 'bg-primary-50' : '')
                      }>
                        <div className="text-sm font-medium text-slate-900">{s.name}</div>
                        <div className="text-xs text-slate-500">{s.testcaseIds.length} cases · {s.topologyId ?? 'no topology'}</div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        </div>

        <div className="lg:col-span-2 space-y-4">
          <Card>
            <CardHeader className="flex items-center justify-between">
              <CardTitle>Testcases</CardTitle>
              <Input placeholder="Search…" className="w-72" value={q} onChange={(e) => setQ(e.target.value)} />
            </CardHeader>
            <CardBody className="p-0 max-h-[70vh] overflow-auto">
              {filtered.length === 0 ? (
                <div className="p-5 text-sm text-slate-500">No testcases match.</div>
              ) : (
                <table className="w-full text-sm">
                  <tbody className="divide-y divide-slate-100">
                    {filtered.map((tc) => {
                      const checked = selected.has(tc.id);
                      return (
                        <tr key={tc.id} onClick={() => toggle(tc.id)} className={
                          'cursor-pointer hover:bg-slate-50 ' + (checked ? 'bg-primary-50' : '')
                        }>
                          <td className="pl-5 py-3 w-8">
                            <input type="checkbox" checked={checked} readOnly />
                          </td>
                          <td className="px-3 py-3">
                            <div className="font-medium text-slate-900">{tc.name || tc.id}</div>
                            <div className="text-xs text-slate-500">{tc.id}</div>
                          </td>
                          <td className="px-5 py-3 text-right">
                            {checked ? <Badge tone="info">selected</Badge> : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </CardBody>
          </Card>
        </div>
      </main>
    </>
  );
}

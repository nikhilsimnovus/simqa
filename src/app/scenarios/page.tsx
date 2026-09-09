'use client';

// Scenarios — saved one-click runs.
//
// The card is the whole point: a name you recognise, the box it will use, and
// a Run button. Choosing a system is a dropdown next to Run rather than a
// separate dialog, because the common case is "same box as last time" and
// that should cost zero clicks.

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Header } from '@/components/Header';
import { Card, CardBody, CardHeader, CardTitle, Button, Input, Field, Badge } from '@/components/ui';
import { Play, Plus, Trash2, ExternalLink, Loader2 } from 'lucide-react';
import { cn } from '@/lib/cn';

interface Scenario {
  id: string; name: string;
  testcaseId: string; testcaseName?: string;
  systemId?: string; lastSystemId?: string;
  lastRunAt?: string; lastRunId?: string;
  notes?: string; createdBy?: string;
}
interface SystemRow { id: string; name: string; host: string; type: string }
interface TestcaseRow { id: string; name: string }

const SELECT_CLS =
  'h-9 rounded-lg border border-line-strong bg-surface px-2 text-sm text-slate-900 ' +
  'focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/25';

export default function ScenariosPage() {
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [systems, setSystems] = useState<SystemRow[]>([]);
  const [testcases, setTestcases] = useState<TestcaseRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [creating, setCreating] = useState(false);

  const flash = useCallback((kind: 'ok' | 'err', text: string) => {
    setMsg({ kind, text });
    window.setTimeout(() => setMsg(null), 6000);
  }, []);

  const reload = useCallback(async () => {
    const r = await fetch('/api/scenarios', { cache: 'no-store' }).then((x) => x.json()).catch(() => null);
    setScenarios(r?.scenarios ?? []);
  }, []);

  useEffect(() => {
    (async () => {
      await reload();
      // Systems that can actually run a testcase — the same UESIM-capable
      // filter the rest of the app uses.
      const inv = await fetch('/api/inventory', { cache: 'no-store' }).then((x) => x.json()).catch(() => null);
      setSystems((inv?.systems ?? []).filter((s: SystemRow) => s.type === 'SIMNOVATOR' || s.type === 'SIMNOVATOR_GUI' || s.type === 'UESIM'));
      const tc = await fetch('/api/testcases?limit=500', { cache: 'no-store' }).then((x) => x.json()).catch(() => null);
      setTestcases((tc?.items ?? []).map((t: any) => ({ id: t.id, name: t.name })));
      setLoading(false);
    })();
  }, [reload]);

  const systemLabel = useCallback((id?: string) => {
    if (!id) return null;
    const s = systems.find((x) => x.id === id);
    return s ? `${s.name} · ${s.host}` : id;
  }, [systems]);

  async function run(s: Scenario, systemId?: string) {
    setBusyId(s.id);
    try {
      const r = await fetch(`/api/scenarios/${encodeURIComponent(s.id)}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(systemId ? { systemId } : {}),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      flash('ok', `${s.name} started on ${systemLabel(j.systemId)} — run ${j.runId}`);
      await reload();
    } catch (e: any) {
      flash('err', `${s.name}: ${e?.message ?? e}`);
    } finally {
      setBusyId(null);
    }
  }

  async function remove(s: Scenario) {
    if (!window.confirm(`Delete scenario "${s.name}"? The testcase itself is not affected.`)) return;
    await fetch(`/api/scenarios/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
    await reload();
  }

  return (
    <>
      <Header
        title="Scenarios"
        subtitle="Saved one-click runs — a name, a testcase, and the box it last ran on"
        right={
          <div className="flex items-center gap-2">
            {msg ? (
              <span className={cn('text-xs font-medium', msg.kind === 'err' ? 'text-red-600' : 'text-emerald-600')}>{msg.text}</span>
            ) : null}
            <Button size="sm" variant="secondary" onClick={() => setCreating((v) => !v)}>
              <Plus className="h-4 w-4" />New scenario
            </Button>
          </div>
        }
      />
      <main className="p-5 space-y-4">
        {creating ? (
          <NewScenarioForm
            systems={systems}
            testcases={testcases}
            onCancel={() => setCreating(false)}
            onCreated={async () => { setCreating(false); await reload(); flash('ok', 'Scenario saved'); }}
            onError={(t) => flash('err', t)}
          />
        ) : null}

        {loading ? (
          <div className="rounded-xl border border-line bg-surface p-5 text-sm text-slate-500">Loading…</div>
        ) : scenarios.length === 0 ? (
          <div className="rounded-xl border border-dashed border-line-strong bg-surface/60 p-8 text-center">
            <div className="text-sm font-medium text-slate-700">No scenarios yet</div>
            <p className="mx-auto mt-1 max-w-lg text-xs font-light text-slate-500">
              A scenario pins one testcase to a box so you can re-run it with a single click — the
              demo you give every week, rather than a whole campaign. For an ordered list of
              testcases with cfg pushes, use <Link href="/automation-suite" className="text-primary-700 hover:underline">Automation Suite</Link> instead.
            </p>
            <div className="mt-4"><Button size="sm" onClick={() => setCreating(true)}><Plus className="h-4 w-4" />New scenario</Button></div>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {scenarios.map((s) => (
              <ScenarioCard
                key={s.id}
                s={s}
                systems={systems}
                systemLabel={systemLabel}
                busy={busyId === s.id}
                onRun={(sysId) => run(s, sysId)}
                onDelete={() => remove(s)}
              />
            ))}
          </div>
        )}
      </main>
    </>
  );
}

function ScenarioCard({
  s, systems, systemLabel, busy, onRun, onDelete,
}: {
  s: Scenario; systems: SystemRow[]; systemLabel: (id?: string) => string | null;
  busy: boolean; onRun: (systemId?: string) => void; onDelete: () => void;
}) {
  // The box this click would use, resolved the same way the API resolves it.
  const remembered = s.systemId || s.lastSystemId;
  const [choice, setChoice] = useState<string>('');
  const target = choice || remembered;
  const needsChoice = !target;

  return (
    <Card>
      <CardHeader className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <CardTitle className="truncate">{s.name}</CardTitle>
          <div className="mt-0.5 truncate text-[11px] font-light text-slate-500" title={s.testcaseId}>
            {s.testcaseName ?? s.testcaseId}
          </div>
        </div>
        <button
          type="button" onClick={onDelete}
          className="rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"
          aria-label={`Delete ${s.name}`}
        ><Trash2 className="h-3.5 w-3.5" /></button>
      </CardHeader>
      <CardBody className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
          {s.lastRunAt ? (
            <>
              <Badge tone="default">last run {new Date(s.lastRunAt).toLocaleString()}</Badge>
              {s.lastRunId ? (
                <Link href={`/runs`} className="inline-flex items-center gap-1 text-primary-700 hover:underline">
                  report <ExternalLink className="h-3 w-3" />
                </Link>
              ) : null}
            </>
          ) : <Badge tone="warning">never run</Badge>}
        </div>

        {s.notes ? <p className="text-[12px] font-light text-slate-600">{s.notes}</p> : null}

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={choice}
            onChange={(e) => setChoice(e.target.value)}
            className={cn(SELECT_CLS, 'min-w-[15rem] flex-1')}
            aria-label="System to run on"
          >
            <option value="">
              {remembered ? `Use last: ${systemLabel(remembered)}` : '— choose a system —'}
            </option>
            {systems.map((x) => <option key={x.id} value={x.id}>{x.name} · {x.host}</option>)}
          </select>
          <Button size="sm" onClick={() => onRun(choice || undefined)} disabled={busy || needsChoice}
            title={needsChoice ? 'Pick a system first — this scenario has never run' : undefined}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {busy ? 'Starting…' : 'Run'}
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

function NewScenarioForm({
  systems, testcases, onCancel, onCreated, onError,
}: {
  systems: SystemRow[]; testcases: TestcaseRow[];
  onCancel: () => void; onCreated: () => void; onError: (t: string) => void;
}) {
  const [name, setName] = useState('');
  const [testcaseId, setTestcaseId] = useState('');
  const [systemId, setSystemId] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [q, setQ] = useState('');

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = needle ? testcases.filter((t) => t.name?.toLowerCase().includes(needle) || t.id.includes(needle)) : testcases;
    return list.slice(0, 300);
  }, [q, testcases]);

  async function save() {
    if (!name.trim() || !testcaseId) return;
    setSaving(true);
    try {
      const r = await fetch('/api/scenarios', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(), testcaseId,
          testcaseName: testcases.find((t) => t.id === testcaseId)?.name,
          systemId: systemId || undefined,
          notes: notes.trim() || undefined,
        }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      onCreated();
    } catch (e: any) {
      onError(`${e?.message ?? e}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card accent>
      <CardHeader><CardTitle>New scenario</CardTitle></CardHeader>
      <CardBody className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Name" hint="what the card shows, e.g. DishDemo">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="DishDemo" />
          </Field>
          <Field label="System" hint="optional — leave empty to use whichever box it last ran on">
            <select value={systemId} onChange={(e) => setSystemId(e.target.value)} className={cn(SELECT_CLS, 'w-full')}>
              <option value="">— remember the last-used box —</option>
              {systems.map((x) => <option key={x.id} value={x.id}>{x.name} · {x.host}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Test case" hint={`${testcases.length} on the box — type to filter`}>
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or id…" />
        </Field>
        <select
          value={testcaseId} onChange={(e) => setTestcaseId(e.target.value)}
          className={cn(SELECT_CLS, 'w-full')} size={6} aria-label="Test case"
        >
          {filtered.map((t) => <option key={t.id} value={t.id}>{t.name || t.id}</option>)}
        </select>
        <Field label="Notes" hint="optional">
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. two-core roaming demo, needs the DISH build on .122" />
        </Field>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={save} disabled={saving || !name.trim() || !testcaseId}>
            {saving ? 'Saving…' : 'Save scenario'}
          </Button>
          <Button size="sm" variant="secondary" onClick={onCancel}>Cancel</Button>
        </div>
      </CardBody>
    </Card>
  );
}

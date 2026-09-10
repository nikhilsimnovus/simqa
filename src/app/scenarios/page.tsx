'use client';

// Scenarios — saved one-click runs.
//
// Listed as ROWS, matching how the Simnovator GUI and the Test Cases page
// list things: one line per scenario, columns you can scan down, action on
// the right. Cards wasted vertical space and made two scenarios look like a
// dashboard rather than a list.
//
// The system dropdown sits in its own column next to Run, because the common
// case is "same box as last time" and that should cost zero clicks.

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Header } from '@/components/Header';
import { Card, CardBody, CardHeader, CardTitle, Button, Input, Field, Badge } from '@/components/ui';
import { Play, Plus, Trash2, Loader2, Pencil } from 'lucide-react';
import { cn } from '@/lib/cn';

interface Scenario {
  id: string; name: string;
  testcaseId: string; testcaseName?: string;
  topologyId?: string; lastTopologyId?: string;
  systemId?: string; lastSystemId?: string;
  lastRunAt?: string; lastRunId?: string;
  notes?: string; createdBy?: string;
  cfgSelection?: CfgSel;
}
type CfgSel = { enb?: string; gnb?: string; mme?: string; mme2?: string; ims?: string };
interface CfgOptions {
  callbox: { id: string; name: string; host: string } | null;
  enb: string[]; mme: string[];
  current: CfgSel;
  ueDb: Record<string, string[]>;
}
/** The five symlink slots, and which directory listing feeds each. The UE
 *  database is absent on purpose: it is an `include` inside the MME config,
 *  not a symlink, so it travels with the MME choice. */
const CFG_SLOTS: { key: keyof CfgSel; label: string; from: 'enb' | 'mme'; hint: string }[] = [
  { key: 'enb',  label: 'eNB / gNB config', from: 'enb', hint: 'becomes enb.cfg' },
  { key: 'gnb',  label: 'gNB config',       from: 'enb', hint: 'becomes gnb.cfg — only if the box keeps a separate NR link' },
  { key: 'mme',  label: 'MME config',       from: 'mme', hint: 'becomes mme.cfg — the subscriber DB comes with it' },
  { key: 'mme2', label: 'MME2 config',      from: 'mme', hint: 'becomes mme2.cfg — second core, two-core setups only' },
  { key: 'ims',  label: 'IMS config',       from: 'mme', hint: 'becomes ims.cfg' },
];
interface SystemRow { id: string; name: string; host: string; type: string }
interface TopologyRow { id: string; name: string; simnovator?: string; enb?: string; gnb?: string }
interface TestcaseRow { id: string; name: string }

const SELECT_CLS =
  'h-9 rounded-lg border border-line-strong bg-surface px-2 text-sm text-slate-900 ' +
  'focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/25';

export default function ScenariosPage() {
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [systems, setSystems] = useState<SystemRow[]>([]);
  const [topologies, setTopologies] = useState<TopologyRow[]>([]);
  const [testcases, setTestcases] = useState<TestcaseRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

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
      // Topology is the unit a scenario runs against: it names the Simnovator
      // that owns the testcase AND the callbox whose configs get linked.
      setTopologies(inv?.profiles ?? []);
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

  const topologyLabel = useCallback((id?: string) => {
    if (!id) return null;
    const t = topologies.find((x) => x.id === id);
    if (!t) return id;
    const sim = systems.find((x) => x.id === t.simnovator);
    return sim ? `${t.name} · ${sim.host}` : t.name;
  }, [topologies, systems]);

  async function run(s: Scenario, topologyId?: string) {
    setBusyId(s.id);
    try {
      const r = await fetch(`/api/scenarios/${encodeURIComponent(s.id)}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(topologyId ? { topologyId } : {}),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      flash('ok', `${s.name} started on ${topologyLabel(j.topologyId) ?? systemLabel(j.systemId)} — run ${j.runId}`);
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
            <Button size="sm" variant="secondary" onClick={() => { setEditingId(null); setCreating((v) => !v); }}>
              <Plus className="h-4 w-4" />New scenario
            </Button>
          </div>
        }
      />
      <main className="p-5 space-y-4">
        {creating || editingId ? (
          <ScenarioForm
            // Remount when the target changes so the form re-seeds its fields
            // instead of keeping the previous scenario's values.
            key={editingId ?? 'new'}
            existing={editingId ? scenarios.find((x) => x.id === editingId) : undefined}
            topologies={topologies}
            systems={systems}
            testcases={testcases}
            onCancel={() => { setCreating(false); setEditingId(null); }}
            onSaved={async () => {
              const wasEdit = !!editingId;
              setCreating(false); setEditingId(null);
              await reload();
              flash('ok', wasEdit ? 'Changes saved' : 'Scenario saved');
            }}
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
          <div className="overflow-hidden rounded-xl border border-line bg-surface">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wider text-slate-500">
                <tr>
                  {['Scenario', 'Test case', 'Callbox configs', 'Last run', 'Topology', 'Action'].map((label, i) => (
                    <th
                      key={label}
                      className={cn(
                        'border-b border-line bg-slate-50 px-4 py-2 font-medium',
                        i >= 4 && 'text-right',
                      )}
                    >{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {scenarios.map((s) => (
                  <ScenarioRow
                    key={s.id}
                    s={s}
                    topologies={topologies}
                    topologyLabel={topologyLabel}
                    systemLabel={systemLabel}
                    busy={busyId === s.id}
                    onRun={(topoId) => run(s, topoId)}
                    onEdit={() => { setCreating(false); setEditingId(s.id); }}
                    onDelete={() => remove(s)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </>
  );
}

function ScenarioRow({
  s, topologies, topologyLabel, systemLabel, busy, onRun, onEdit, onDelete,
}: {
  s: Scenario; topologies: TopologyRow[];
  topologyLabel: (id?: string) => string | null;
  systemLabel: (id?: string) => string | null;
  busy: boolean; onRun: (topologyId?: string) => void;
  onEdit: () => void; onDelete: () => void;
}) {
  // What this click would target, resolved the same way the API resolves it:
  // pinned topology, else the one it last ran on. Legacy scenarios that only
  // ever had a bare system fall back to showing that.
  const remembered = s.topologyId || s.lastTopologyId;
  const legacySystem = !remembered ? (s.systemId || s.lastSystemId) : undefined;
  const [choice, setChoice] = useState<string>('');
  const needsChoice = !(choice || remembered || legacySystem);
  const cfgs = CFG_SLOTS.filter((sl) => s.cfgSelection?.[sl.key]);

  return (
    <tr className="transition-colors hover:bg-slate-50">
      <td className="px-4 py-2">
        <div className="font-medium text-slate-900">{s.name}</div>
        {s.notes ? <div className="mt-0.5 text-[11px] font-light text-slate-500">{s.notes}</div> : null}
      </td>

      <td className="px-4 py-2">
        <span className="text-slate-700" title={s.testcaseId}>{s.testcaseName ?? s.testcaseId}</span>
      </td>

      <td className="px-4 py-2">
        {cfgs.length === 0 ? (
          <span className="text-xs text-slate-400">— box as-is —</span>
        ) : (
          <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-[11px]">
            {cfgs.map((sl) => (
              <span key={sl.key} title={sl.hint}>
                <span className="text-slate-400">{sl.key}</span>{' '}
                <span className="font-mono text-slate-600">{s.cfgSelection![sl.key]}</span>
              </span>
            ))}
          </div>
        )}
      </td>

      <td className="px-4 py-2 text-xs text-slate-500">
        {s.lastRunAt ? new Date(s.lastRunAt).toLocaleString() : <Badge tone="warning">never run</Badge>}
      </td>

      <td className="px-4 py-2 text-right">
        <select
          value={choice}
          onChange={(e) => setChoice(e.target.value)}
          className={cn(SELECT_CLS, 'w-full max-w-[15rem]')}
          aria-label={`Topology for ${s.name}`}
        >
          <option value="">
            {remembered ? `Last: ${topologyLabel(remembered)}`
              : legacySystem ? `Legacy: ${systemLabel(legacySystem)}`
              : '— choose —'}
          </option>
          {topologies.map((t) => <option key={t.id} value={t.id}>{topologyLabel(t.id)}</option>)}
        </select>
      </td>

      <td className="px-4 py-2">
        <div className="flex items-center justify-end gap-1">
          <Button
            size="sm" onClick={() => onRun(choice || undefined)} disabled={busy || needsChoice}
            title={needsChoice ? 'Pick a system first — this scenario has never run' : undefined}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {busy ? 'Starting…' : 'Run'}
          </Button>
          <button
            type="button" onClick={onEdit}
            className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-900"
            aria-label={`Edit ${s.name}`} title="Edit"
          ><Pencil className="h-3.5 w-3.5" /></button>
          <button
            type="button" onClick={onDelete}
            className="rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"
            aria-label={`Delete ${s.name}`} title="Delete"
          ><Trash2 className="h-3.5 w-3.5" /></button>
        </div>
      </td>
    </tr>
  );
}

/** One form for create AND edit. `existing` switches it to edit mode: fields
 *  pre-fill from the scenario and Save does a PUT rather than a POST. Keeping
 *  one component means the two paths can't drift in what they offer. */
function ScenarioForm({
  existing, topologies, systems, testcases, onCancel, onSaved, onError,
}: {
  existing?: Scenario;
  topologies: TopologyRow[]; systems: SystemRow[]; testcases: TestcaseRow[];
  onCancel: () => void; onSaved: () => void; onError: (t: string) => void;
}) {
  const editing = !!existing;
  const [name, setName] = useState(existing?.name ?? '');
  const [testcaseId, setTestcaseId] = useState(existing?.testcaseId ?? '');
  const [topologyId, setTopologyId] = useState(existing?.topologyId ?? existing?.lastTopologyId ?? '');
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [q, setQ] = useState('');
  const [cfg, setCfg] = useState<CfgSel>(existing?.cfgSelection ?? {});
  const [opts, setOpts] = useState<CfgOptions | null>(null);
  const [optsLoading, setOptsLoading] = useState(false);

  // Cfg files live on the callbox bound to the chosen Simnovator, so the
  // pickers can only be populated once a system is picked.
  useEffect(() => {
    if (!topologyId) { setOpts(null); return; }
    let cancelled = false;
    setOptsLoading(true);
    fetch(`/api/scenarios/cfg-options?topologyId=${encodeURIComponent(topologyId)}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => {
        if (cancelled || !j?.ok) return;
        setOpts(j);
        // Pre-fill from the box's CURRENT links only when creating. When
        // editing, the scenario's saved selection is the answer — overwriting
        // it with whatever the callbox happens to be wearing would silently
        // rewrite the thing being edited.
        if (!editing) setCfg(j.current ?? {});
      })
      .catch(() => { if (!cancelled) setOpts(null); })
      .finally(() => { if (!cancelled) setOptsLoading(false); });
    return () => { cancelled = true; };
  }, [topologyId]);

  // The subscriber DB the chosen MME config pulls in — shown, not chosen.
  const ueDb = cfg.mme ? (opts?.ueDb?.[cfg.mme] ?? []) : [];

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = needle ? testcases.filter((t) => t.name?.toLowerCase().includes(needle) || t.id.includes(needle)) : testcases;
    return list.slice(0, 300);
  }, [q, testcases]);

  async function save() {
    if (!name.trim() || !testcaseId) return;
    setSaving(true);
    try {
      const r = await fetch(
        editing ? `/api/scenarios/${encodeURIComponent(existing!.id)}` : '/api/scenarios',
        {
        method: editing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(), testcaseId,
          testcaseName: testcases.find((t) => t.id === testcaseId)?.name,
          topologyId: topologyId || undefined,
          // undefined is dropped by JSON.stringify, which on an EDIT would
          // read as "leave it alone" — so a cleared selection is sent as an
          // explicit null the PUT can act on.
          cfgSelection: Object.values(cfg).some(Boolean) ? cfg : (editing ? null : undefined),
          notes: notes.trim() || undefined,
        }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      onSaved();
    } catch (e: any) {
      onError(`${e?.message ?? e}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card accent>
      <CardHeader><CardTitle>{editing ? `Edit ${existing!.name}` : 'New scenario'}</CardTitle></CardHeader>
      <CardBody className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Name" hint="what the card shows, e.g. DishDemo">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="DishDemo" />
          </Field>
          <Field label="Topology" hint="names both the Simnovator that runs the testcase and the callbox whose configs get linked">
            <select value={topologyId} onChange={(e) => setTopologyId(e.target.value)} className={cn(SELECT_CLS, 'w-full')}>
              <option value="">— remember the last-used topology —</option>
              {topologies.map((t) => {
                const sim = systems.find((x) => x.id === t.simnovator);
                return <option key={t.id} value={t.id}>{sim ? `${t.name} · ${sim.host}` : t.name}</option>;
              })}
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
        {/* Callbox config set — only meaningful once a system (hence a bound
            callbox) is chosen. */}
        {topologyId ? (
          <div className="rounded-lg border border-line bg-panel p-3">
            <div className="mb-2 flex items-baseline gap-2">
              <span className="font-mono text-[10px] font-semibold uppercase tracking-label text-slate-500">
                Callbox configs
              </span>
              <span className="text-[11px] font-light text-slate-500">
                {optsLoading ? 'reading the callbox…'
                  : opts?.callbox ? `${opts.callbox.name} · ${opts.callbox.host} — linked before each run, then one lte restart`
                  : 'this topology binds no callbox — REST-only run'}
              </span>
            </div>
            {opts?.callbox ? (
              <>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {CFG_SLOTS.map((sl) => {
                    const list = sl.from === 'enb' ? opts.enb : opts.mme;
                    return (
                      <label key={sl.key} className="block">
                        <span className="mb-1 block text-xs font-medium text-slate-700">{sl.label}</span>
                        <select
                          value={cfg[sl.key] ?? ''}
                          onChange={(e) => setCfg((c) => ({ ...c, [sl.key]: e.target.value || undefined }))}
                          className={cn(SELECT_CLS, 'w-full')}
                          title={sl.hint}
                        >
                          <option value="">— leave as-is —</option>
                          {list.map((f) => <option key={f} value={f}>{f}</option>)}
                        </select>
                      </label>
                    );
                  })}
                </div>
                <p className="mt-2 text-[11px] font-light text-slate-500">
                  <span className="font-medium text-slate-600">UE database:</span>{' '}
                  {cfg.mme
                    ? (ueDb.length
                      ? <span className="font-mono">{ueDb.join(', ')}</span>
                      : <span>none found in {cfg.mme}</span>)
                    : 'pick an MME config — the database is an include inside it, not a separate link'}
                </p>
              </>
            ) : null}
          </div>
        ) : null}

        <Field label="Notes" hint="optional">
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. two-core roaming demo, needs the DISH build on .122" />
        </Field>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={save} disabled={saving || !name.trim() || !testcaseId}>
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Save scenario'}
          </Button>
          <Button size="sm" variant="secondary" onClick={onCancel}>Cancel</Button>
        </div>
      </CardBody>
    </Card>
  );
}

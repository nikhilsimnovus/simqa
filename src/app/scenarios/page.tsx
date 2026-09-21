'use client';

// Scenarios — saved one-click runs.
//
// Listed as ROWS, matching how the Simnovator GUI and the Test Cases page
// list things: one line per scenario, columns you can scan down, action on
// the right. Cards wasted vertical space and made two scenarios look like a
// dashboard rather than a list.
//
// A scenario runs on EITHER a topology (end to end: its boxes' testcases, plus
// the callbox configs linked before the run) OR a single system (that box's
// own testcases, run against it as it is). One "Run on" dropdown offers both,
// and the testcase list follows it. The same dropdown sits next to Run,
// because the common case is "same as last time" and that should cost zero
// clicks.

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Header } from '@/components/Header';
import { Card, CardBody, CardHeader, CardTitle, Button, Input, Field, Badge } from '@/components/ui';
import { SearchableSelect } from '@/components/SearchableSelect';
import { Play, Plus, Trash2, Loader2, Pencil } from 'lucide-react';
import { cn } from '@/lib/cn';

type CfgSel = { enb?: string; mme?: string; mme2?: string; ims?: string };
interface Scenario {
  id: string; name: string;
  testcaseId: string; testcaseName?: string; testcaseSystemId?: string;
  topologyId?: string; lastTopologyId?: string;
  systemId?: string; lastSystemId?: string;
  lastRunAt?: string; lastRunId?: string;
  notes?: string; createdBy?: string;
  /** May still carry `gnb` from an older build — read through foldCfg. */
  cfgSelection?: CfgSel & { gnb?: string };
}
interface CfgOptions {
  callbox: { id: string; name: string; host: string } | null;
  enb: string[]; mme: string[];
  current: CfgSel;
  ueDb: Record<string, string[]>;
  /** A list above may be empty because reading it FAILED — see cfg-options. */
  readErrors?: string[];
}
/** The symlink slots, and which directory listing feeds each. ONE radio slot:
 *  OTS loads a single ENB_CONFIG_FILE (config/enb.cfg) for LTE and NR alike,
 *  so a separate gNB picker linked a gnb.cfg nothing reads. The UE database is
 *  absent on purpose: it is an `include` inside the MME config, not a symlink,
 *  so it travels with the MME choice. */
const CFG_SLOTS: { key: keyof CfgSel; label: string; from: 'enb' | 'mme'; hint: string }[] = [
  { key: 'enb',  label: 'eNB / gNB config', from: 'enb', hint: 'becomes enb.cfg — the one radio config OTS loads, LTE or NR' },
  { key: 'mme',  label: 'MME config',       from: 'mme', hint: 'becomes mme.cfg — the subscriber DB comes with it' },
  { key: 'mme2', label: 'MME2 config',      from: 'mme', hint: 'becomes mme2.cfg — second core, two-core setups only' },
  { key: 'ims',  label: 'IMS config',       from: 'mme', hint: 'becomes ims.cfg' },
];

/** A legacy `gnb` value becomes `enb` (when enb is empty) — same rule as
 *  normalizeCfgSelection on the server, so the editor shows what a run links. */
function foldCfg(raw?: Record<string, string | undefined> | null): CfgSel {
  if (!raw) return {};
  const out: CfgSel = {};
  const enb = raw.enb || raw.gnb;
  if (enb) out.enb = enb;
  for (const k of ['mme', 'mme2', 'ims'] as const) if (raw[k]) out[k] = raw[k];
  return out;
}

interface SystemRow { id: string; name: string; host: string; type: string }
interface TopologyRow { id: string; name: string; simnovator?: string; uesim?: string }
interface TestcaseRow { id: string; name: string; systemId: string }

/** Where a scenario runs. Encoded into one <select> value ("topo:<id>" /
 *  "sys:<id>") so both kinds share a dropdown. */
type Target = { kind: 'topology' | 'system'; id: string };
const encodeTarget = (t: Target | null) => (t ? `${t.kind === 'topology' ? 'topo' : 'sys'}:${t.id}` : '');
function decodeTarget(v: string): Target | null {
  const i = v.indexOf(':');
  const id = i < 0 ? '' : v.slice(i + 1);
  if (!id) return null;
  const kind = v.slice(0, i);
  return kind === 'topo' ? { kind: 'topology', id } : kind === 'sys' ? { kind: 'system', id } : null;
}
/** Same precedence as resolveTarget() in src/lib/scenarios.ts — keep in step,
 *  or "Last: …" names a different box than Run actually uses. */
function rememberedTarget(s: Scenario): Target | null {
  if (s.topologyId) return { kind: 'topology', id: s.topologyId };
  if (s.systemId) return { kind: 'system', id: s.systemId };
  if (s.lastTopologyId) return { kind: 'topology', id: s.lastTopologyId };
  if (s.lastSystemId) return { kind: 'system', id: s.lastSystemId };
  return null;
}

/** Boxes that serve the testcase REST API. A UESIM-typed entry is the bare UE
 *  host (.34 answers /v2/login with Apache's 404), so it is never a source. */
const servesTestcases = (s: SystemRow) => s.type === 'SIMNOVATOR' || s.type === 'SIMNOVATOR_GUI';

/** Where a target's testcases come from: a single system is just itself; a
 *  topology is every box in it that serves testcases. */
function testcaseSources(t: Target | null, topologies: TopologyRow[], systems: SystemRow[]): SystemRow[] {
  if (!t) return [];
  let ids: (string | undefined)[] = [t.id];
  if (t.kind === 'topology') {
    const p = topologies.find((x) => x.id === t.id);
    ids = p ? [p.simnovator, p.uesim] : [];
  }
  const out: SystemRow[] = [];
  for (const id of ids) {
    const sys = systems.find((s) => s.id === id);
    if (sys && servesTestcases(sys) && !out.some((o) => o.id === sys.id)) out.push(sys);
  }
  return out;
}

const SELECT_CLS =
  'h-9 rounded-lg border border-line-strong bg-surface px-2 text-sm text-slate-900 ' +
  'focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/25';

export default function ScenariosPage() {
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [systems, setSystems] = useState<SystemRow[]>([]);
  const [topologies, setTopologies] = useState<TopologyRow[]>([]);
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
      const inv = await fetch('/api/inventory', { cache: 'no-store' }).then((x) => x.json()).catch(() => null);
      // Every system is kept for labels (a topology names its boxes by id);
      // the dropdown offers only those that can run a testcase on their own.
      setSystems(inv?.systems ?? []);
      setTopologies(inv?.profiles ?? []);
      setLoading(false);
    })();
  }, [reload]);

  const runnableSystems = useMemo(() => systems.filter(servesTestcases), [systems]);

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

  const targetLabel = useCallback((t: Target | null) => {
    if (!t) return null;
    return t.kind === 'topology' ? `${topologyLabel(t.id)} (end to end)` : systemLabel(t.id);
  }, [topologyLabel, systemLabel]);

  async function run(s: Scenario, target: Target | null) {
    setBusyId(s.id);
    try {
      const r = await fetch(`/api/scenarios/${encodeURIComponent(s.id)}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(!target ? {} : target.kind === 'topology' ? { topologyId: target.id } : { systemId: target.id }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      flash('ok', `${s.name} started on ${j.topologyId ? topologyLabel(j.topologyId) : systemLabel(j.systemId)} — run ${j.runId}`);
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

  const targetOptions = (
    <>
      {topologies.length ? (
        <optgroup label="Topology — end to end">
          {topologies.map((t) => <option key={t.id} value={encodeTarget({ kind: 'topology', id: t.id })}>{topologyLabel(t.id)}</option>)}
        </optgroup>
      ) : null}
      {runnableSystems.length ? (
        <optgroup label="Single system">
          {runnableSystems.map((s) => <option key={s.id} value={encodeTarget({ kind: 'system', id: s.id })}>{systemLabel(s.id)}</option>)}
        </optgroup>
      ) : null}
    </>
  );

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
            targetOptions={targetOptions}
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
                  {['Scenario', 'Test case', 'Callbox configs', 'Last run', 'Run on', 'Action'].map((label, i) => (
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
                    targetLabel={targetLabel}
                    targetOptions={targetOptions}
                    busy={busyId === s.id}
                    onRun={(t) => run(s, t)}
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
  s, targetLabel, targetOptions, busy, onRun, onEdit, onDelete,
}: {
  s: Scenario;
  targetLabel: (t: Target | null) => string | null;
  targetOptions: React.ReactNode;
  busy: boolean; onRun: (t: Target | null) => void;
  onEdit: () => void; onDelete: () => void;
}) {
  // What this click would target, resolved the same way the API resolves it.
  const remembered = rememberedTarget(s);
  const [choice, setChoice] = useState<string>('');
  const effective = decodeTarget(choice) ?? remembered;
  const needsChoice = !effective;
  // Configs only get linked on a topology run — a single system has no
  // callbox, so showing them there would promise something the run won't do.
  const cfg = foldCfg(s.cfgSelection);
  const cfgs = effective?.kind === 'topology' ? CFG_SLOTS.filter((sl) => cfg[sl.key]) : [];

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
                <span className="font-mono text-slate-600">{cfg[sl.key]}</span>
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
          className={cn(SELECT_CLS, 'w-full max-w-[16rem]')}
          aria-label={`Run ${s.name} on`}
        >
          <option value="">{remembered ? `Last: ${targetLabel(remembered)}` : '— choose —'}</option>
          {targetOptions}
        </select>
      </td>

      <td className="px-4 py-2">
        <div className="flex items-center justify-end gap-1">
          <Button
            size="sm" onClick={() => onRun(decodeTarget(choice))} disabled={busy || needsChoice}
            title={needsChoice ? 'Pick a topology or system first — this scenario has never run' : undefined}
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
  existing, topologies, systems, targetOptions, onCancel, onSaved, onError,
}: {
  existing?: Scenario;
  topologies: TopologyRow[]; systems: SystemRow[];
  targetOptions: React.ReactNode;
  onCancel: () => void; onSaved: () => void; onError: (t: string) => void;
}) {
  const editing = !!existing;
  const [name, setName] = useState(existing?.name ?? '');
  const [targetValue, setTargetValue] = useState(encodeTarget(existing ? rememberedTarget(existing) : null));
  const target = useMemo(() => decodeTarget(targetValue), [targetValue]);
  const topologyId = target?.kind === 'topology' ? target.id : '';
  const [testcaseId, setTestcaseId] = useState(existing?.testcaseId ?? '');
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [cfg, setCfg] = useState<CfgSel>(foldCfg(existing?.cfgSelection));
  const [opts, setOpts] = useState<CfgOptions | null>(null);
  const [optsLoading, setOptsLoading] = useState(false);
  // Bumped by Retry to re-run the fetch below without changing the topology.
  const [optsNonce, setOptsNonce] = useState(0);

  // ── Testcases: whatever the chosen target's boxes serve ──
  const sources = useMemo(() => testcaseSources(target, topologies, systems), [target, topologies, systems]);
  const sourceKey = sources.map((s) => s.id).join(',');
  /** null while loading (or with no target). */
  const [tcs, setTcs] = useState<TestcaseRow[] | null>(null);
  const [tcInfo, setTcInfo] = useState<{ sys: SystemRow; count: number; total: number; error?: string }[]>([]);
  const [tcNonce, setTcNonce] = useState(0);
  /** Name of a picked testcase the new target does not hold, to say why it was cleared. */
  const [tcGone, setTcGone] = useState<string | null>(null);

  useEffect(() => {
    setTcs(null); setTcInfo([]);
    if (!sources.length) return;
    let cancelled = false;
    Promise.all(sources.map(async (sys) => {
      try {
        // limit=5000: the route pages the box, so a 925-testcase catalogue
        // comes back whole. This used to ask for 500 and call it "on the box".
        const r = await fetch(
          `/api/testcases?systemId=${encodeURIComponent(sys.id)}&limit=5000${tcNonce ? '&refresh=1' : ''}`,
          { cache: 'no-store' },
        );
        const j = await r.json();
        if (!r.ok || j?.error) throw new Error(j?.error ?? `HTTP ${r.status}`);
        const items: TestcaseRow[] = (j.items ?? []).map((t: any) => ({ id: String(t.id), name: String(t.name || t.id), systemId: sys.id }));
        return { sys, items, total: Number(j.total ?? items.length) };
      } catch (e: any) {
        return { sys, items: [] as TestcaseRow[], total: 0, error: String(e?.message ?? e) };
      }
    })).then((results) => {
      if (cancelled) return;
      const merged: TestcaseRow[] = [];
      for (const r of results) for (const t of r.items) if (!merged.some((m) => m.id === t.id)) merged.push(t);
      setTcs(merged);
      setTcInfo(results.map((r) => ({ sys: r.sys, count: r.items.length, total: r.total, error: r.error })));
    });
    return () => { cancelled = true; };
  }, [sourceKey, tcNonce]);

  // A testcase id only exists on the box that serves it. If the new target's
  // boxes don't hold the one picked, clear it rather than save a scenario that
  // 404s at trigger — but only on a clean load: a box that failed to answer
  // proves nothing about what it holds.
  useEffect(() => {
    if (!tcs || !testcaseId || tcInfo.some((i) => i.error)) return;
    if (!tcs.some((t) => t.id === testcaseId)) {
      setTcGone(existing?.testcaseId === testcaseId ? (existing.testcaseName ?? testcaseId) : testcaseId);
      setTestcaseId('');
    }
  }, [tcs]);

  const tcOptions = useMemo(
    () => (tcs ?? []).map((t) => ({
      value: t.id,
      label: t.name,
      // Which box, only when there is more than one to come from.
      hint: sources.length > 1 ? systems.find((s) => s.id === t.systemId)?.host : undefined,
    })),
    [tcs, sources.length, systems],
  );

  const tcHint = !target ? 'choose where it runs first — the list comes from those boxes'
    : !sources.length ? 'this topology binds no Simnovator that serves testcases'
    : !tcs ? `loading from ${sources.map((s) => s.host).join(' + ')}…`
    : tcInfo.filter((i) => !i.error).map((i) =>
        `${i.count} on ${i.sys.name} · ${i.sys.host}${i.total > i.count ? ` (box reports ${i.total})` : ''}`,
      ).join(' + ') || 'none loaded';
  const tcErrors = tcInfo.filter((i) => i.error);

  // ── Callbox configs: only a topology binds a callbox ──
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
        if (!editing && optsNonce === 0) setCfg(foldCfg(j.current));
      })
      .catch(() => { if (!cancelled) setOpts(null); })
      .finally(() => { if (!cancelled) setOptsLoading(false); });
    return () => { cancelled = true; };
  }, [topologyId, optsNonce]);

  // The subscriber DB the chosen MME config pulls in — shown, not chosen.
  const ueDb = cfg.mme ? (opts?.ueDb?.[cfg.mme] ?? []) : [];

  async function save() {
    if (!name.trim() || !testcaseId || !target) return;
    setSaving(true);
    try {
      const picked = tcs?.find((t) => t.id === testcaseId);
      const kept = existing?.testcaseId === testcaseId ? existing : undefined;
      const r = await fetch(
        editing ? `/api/scenarios/${encodeURIComponent(existing!.id)}` : '/api/scenarios',
        {
        method: editing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(), testcaseId,
          testcaseName: picked?.name ?? kept?.testcaseName,
          testcaseSystemId: picked?.systemId ?? kept?.testcaseSystemId,
          // Topology XOR system. On an edit the other kind goes as an explicit
          // null so switching clears it — undefined is dropped by
          // JSON.stringify, which the PUT would read as "leave it pinned".
          topologyId: target.kind === 'topology' ? target.id : (editing ? null : undefined),
          systemId: target.kind === 'system' ? target.id : (editing ? null : undefined),
          cfgSelection: target.kind === 'topology' && Object.values(cfg).some(Boolean)
            ? cfg
            : (editing ? null : undefined),
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
          <Field label="Name" hint="what the row shows, e.g. DishDemo">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="DishDemo" />
          </Field>
          <Field
            label="Run on"
            hint={target?.kind === 'system'
              ? 'single system — its own testcases, run against the box as it is'
              : target?.kind === 'topology'
                ? 'end to end — testcases from every box in the topology, plus callbox configs'
                : 'a topology (end to end) or a single system'}
          >
            <select value={targetValue} onChange={(e) => setTargetValue(e.target.value)} className={cn(SELECT_CLS, 'w-full')}>
              <option value="">— choose —</option>
              {targetOptions}
            </select>
          </Field>
        </div>

        <Field label="Test case" hint={tcHint}>
          <SearchableSelect
            value={testcaseId}
            onChange={(v) => { setTestcaseId(v); setTcGone(null); }}
            options={tcOptions}
            disabled={!target || !tcs}
            noun="testcase"
            placeholder={`Search ${tcOptions.length} testcases by name or id…`}
            valueLabel={existing?.testcaseId === testcaseId ? existing?.testcaseName : undefined}
            ariaLabel="Test case"
          />
        </Field>
        {tcGone ? (
          <p className="-mt-2 text-[11px] text-amber-700">
            &ldquo;{tcGone}&rdquo; isn&apos;t on this target&apos;s boxes, so it was cleared — pick a testcase from this list.
          </p>
        ) : null}
        {tcErrors.length ? (
          <div className="-mt-1 flex items-start justify-between gap-3 rounded-md border border-amber-600/25 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-800">
            <span>
              Couldn&apos;t list testcases from {tcErrors.map((i) => `${i.sys.host}: ${i.error}`).join('; ')}
            </span>
            <button
              type="button"
              onClick={() => setTcNonce((n) => n + 1)}
              className="shrink-0 font-medium text-amber-900 underline hover:no-underline"
            >Retry</button>
          </div>
        ) : null}

        {/* Callbox config set — only a topology binds a callbox to link on. */}
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
            {opts?.readErrors?.length ? (
              <div className="mb-2 flex items-start justify-between gap-3 rounded-md border border-amber-600/25 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-800">
                <span>
                  Couldn&apos;t read part of the callbox, so a list below may be incomplete rather than
                  genuinely empty — {opts.readErrors.join('; ')}
                </span>
                <button
                  type="button"
                  onClick={() => setOptsNonce((n) => n + 1)}
                  className="shrink-0 font-medium text-amber-900 underline hover:no-underline"
                >Retry</button>
              </div>
            ) : null}
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
          <Button size="sm" onClick={save} disabled={saving || !name.trim() || !testcaseId || !target}>
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Save scenario'}
          </Button>
          <Button size="sm" variant="secondary" onClick={onCancel}>Cancel</Button>
        </div>
      </CardBody>
    </Card>
  );
}

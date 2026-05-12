'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Header } from '@/components/Header';
import { Card, CardBody, Button, Input, Field, Badge } from '@/components/ui';
import {
  Plus, Trash2, Pencil, Check, X, ShieldCheck, Cpu, Server, Network,
  Globe, Database, Radio, ArrowRight, ExternalLink, AlertTriangle, Layers,
} from 'lucide-react';
import { RunValidateTab } from './RunValidateTab';

// ───────────── Types (mirrors src/lib/inventory.ts) ─────────────

interface InventorySystem {
  id: string;
  type: string;
  name: string;
  host: string;
}

interface TestSetup {
  id: string;
  name: string;
  simnovator?: string;
  uesim: string;
  callbox?: string;
  ims?: string;
  mme?: string;
  appserver?: string;
  notes?: string;
}

// Anything else on the inventory we PUT back unchanged.
interface InventoryDoc {
  systems:  InventorySystem[];
  profiles: TestSetup[];
  suites?:  any[];
}

// ───────────── Role catalog ─────────────

interface RoleDef {
  key: keyof TestSetup;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** What system types are eligible for this role. */
  types: string[];
  required: boolean;
  /** Whether the "same as callbox" shortcut is available. */
  shareable: boolean;
  tone: 'orange' | 'sky' | 'violet' | 'amber' | 'emerald' | 'rose';
}

// Role requirements were redesigned 2026-05-12: only Simnovator stays
// required. UESIM, Callbox, IMS, MME, AppServer are all optional now.
//
// Why: this form is the input to the SSH-deploy workflow (Automation page
// generates gnb.cfg / mme.cfg locally and pushes to the bound systems).
// Customer-style installs don't have a separate callbox / MME / etc. —
// they just want to trigger testcases that already live on the Simnovator
// box via REST (use the top-level Run & Validate page for that). For those
// users, this whole page is optional. For the smaller distributed-lab
// audience, they fill in whichever role-slots their topology actually has.
const ROLES: readonly RoleDef[] = [
  { key: 'simnovator', label: 'Simnovator', icon: ShieldCheck, types: ['SIMNOVATOR'],          required: true,  shareable: false, tone: 'orange'  },
  { key: 'uesim',      label: 'UESIM',      icon: Cpu,         types: ['SIMNOVATOR', 'UESIM'], required: false, shareable: false, tone: 'sky'     },
  { key: 'callbox',    label: 'Callbox',    icon: Server,      types: ['CALLBOX'],             required: false, shareable: false, tone: 'violet'  },
  { key: 'ims',        label: 'IMS',        icon: Globe,       types: ['IMS', 'CALLBOX'],      required: false, shareable: true,  tone: 'amber'   },
  { key: 'mme',        label: 'MME',        icon: Network,     types: ['MME', 'CALLBOX'],      required: false, shareable: true,  tone: 'emerald' },
  { key: 'appserver',  label: 'App server', icon: Database,    types: ['APPSERVER', 'CALLBOX'], required: false, shareable: true,  tone: 'rose'   },
] as const;

const TONE_CLASSES: Record<RoleDef['tone'], { bg: string; text: string; ring: string; soft: string }> = {
  orange:  { bg: 'bg-orange-100',  text: 'text-orange-700',  ring: 'ring-orange-200',  soft: 'bg-orange-50' },
  sky:     { bg: 'bg-sky-100',     text: 'text-sky-700',     ring: 'ring-sky-200',     soft: 'bg-sky-50' },
  violet:  { bg: 'bg-violet-100',  text: 'text-violet-700',  ring: 'ring-violet-200',  soft: 'bg-violet-50' },
  amber:   { bg: 'bg-amber-100',   text: 'text-amber-700',   ring: 'ring-amber-200',   soft: 'bg-amber-50' },
  emerald: { bg: 'bg-emerald-100', text: 'text-emerald-700', ring: 'ring-emerald-200', soft: 'bg-emerald-50' },
  rose:    { bg: 'bg-rose-100',    text: 'text-rose-700',    ring: 'ring-rose-200',    soft: 'bg-rose-50' },
};

const SELECT_CLS =
  'h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 ' +
  'focus:outline-none focus:ring-2 focus:ring-primary-300 focus:border-primary-400';

// ───────────── Page ─────────────

export default function EndToEndPage() {
  const [doc, setDoc] = useState<InventoryDoc>({ systems: [], profiles: [] });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<TestSetup | null>(null);
  const [tab, setTab] = useState<'setups' | 'validate'>('setups');

  useEffect(() => {
    fetch('/api/inventory')
      .then((r) => r.json())
      .then((d: InventoryDoc) => setDoc({ systems: d.systems ?? [], profiles: d.profiles ?? [], suites: d.suites }))
      .finally(() => setLoading(false));
  }, []);

  const flash = (kind: 'ok' | 'err', text: string) => {
    setMsg({ kind, text });
    setTimeout(() => setMsg(null), 1800);
  };

  async function persist(next: InventoryDoc): Promise<boolean> {
    setSaving(true);
    try {
      const r = await fetch('/api/inventory', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
      const j = await r.json();
      if (!r.ok || j.error) throw new Error(j.error ?? `HTTP ${r.status}`);
      setDoc(next);
      return true;
    } catch (e: any) {
      flash('err', `Save failed: ${e?.message ?? e}`);
      return false;
    } finally {
      setSaving(false);
    }
  }

  function startNew() {
    const sn = doc.systems.find((s) => s.type === 'SIMNOVATOR');
    const ue = doc.systems.find((s) => s.type === 'UESIM' || s.type === 'SIMNOVATOR');
    const cb = doc.systems.find((s) => s.type === 'CALLBOX');
    const id = `setup-${Date.now().toString(36)}`;
    setDraft({
      id,
      name: `QA Test Setup ${doc.profiles.length + 1}`,
      simnovator: sn?.id,
      uesim: ue?.id ?? '',
      callbox: cb?.id,
      // shareable roles default to "same as callbox"
      ims: cb?.id,
      mme: cb?.id,
      appserver: cb?.id,
    });
    setEditingId(id);
  }

  function startEdit(s: TestSetup) {
    setDraft({ ...s });
    setEditingId(s.id);
  }

  function cancelEdit() {
    setDraft(null);
    setEditingId(null);
  }

  async function saveDraft() {
    if (!draft) return;
    if (!draft.simnovator) { flash('err', 'Pick a Simnovator system'); return; }
    if (!draft.uesim)      { flash('err', 'Pick a UESIM system'); return; }
    if (!draft.callbox)    { flash('err', 'Pick a Callbox system'); return; }

    const isNew = !doc.profiles.some((p) => p.id === draft.id);
    const next: InventoryDoc = {
      ...doc,
      profiles: isNew ? [...doc.profiles, draft] : doc.profiles.map((p) => (p.id === draft.id ? draft : p)),
    };
    const ok = await persist(next);
    if (ok) {
      flash('ok', isNew ? 'Setup created' : 'Setup updated');
      cancelEdit();
    }
  }

  async function deleteSetup(id: string) {
    const next: InventoryDoc = { ...doc, profiles: doc.profiles.filter((p) => p.id !== id) };
    const ok = await persist(next);
    if (ok) flash('ok', 'Setup deleted');
  }

  if (loading) {
    return (
      <>
        <Header title="End to End" subtitle="QA Test Setups — bind systems together for a complete test topology" />
        <main className="p-6">
          <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500 shadow-sm">Loading…</div>
        </main>
      </>
    );
  }

  return (
    <>
      <Header
        title="Topology Setups"
        subtitle={tab === 'setups'
          ? 'Advanced — bind systems into a topology for the Generate + Push workflow. Most users want Run & Validate instead.'
          : 'Run & validate — execute a testcase end-to-end (also available as a top-level sidebar entry)'
        }
        right={tab === 'setups' ? (
          <div className="flex items-center gap-2">
            {msg ? (
              <span className={`text-xs ${msg.kind === 'err' ? 'text-red-600' : 'text-emerald-600'}`}>{msg.text}</span>
            ) : null}
            <Button size="sm" onClick={startNew} disabled={!!editingId || saving}>
              <Plus className="h-4 w-4" /> New setup
            </Button>
          </div>
        ) : null}
      />

      {/* Tab strip — Test setups vs Run & validate. Sticky just under the
          page header so it's always visible. */}
      <div className="border-b border-slate-200 bg-white px-6">
        <div className="flex gap-1 -mb-px">
          <TabButton active={tab === 'setups'}   onClick={() => setTab('setups')}>Test setups</TabButton>
          <TabButton active={tab === 'validate'} onClick={() => setTab('validate')}>Run &amp; validate</TabButton>
        </div>
      </div>

      {tab === 'validate' ? <RunValidateTab /> : null}

      {tab === 'setups' ? (
      <main
        className="relative min-h-[calc(100vh-3.5rem)] p-6 space-y-6"
        style={{
          backgroundImage:
            'radial-gradient(1200px 600px at 80% -10%, rgba(255,106,0,0.06), transparent 60%),' +
            'radial-gradient(900px 500px at -10% 110%, rgba(56,189,248,0.06), transparent 55%)',
          backgroundColor: 'rgb(249 250 251)',
        }}
      >
        {/* Customer-style installs don't need this page. Make sure they know
            before they fill out a multi-row form for nothing. */}
        <Banner
          tone="amber"
          title="Topology setups are only for distributed labs"
          text={
            <span>
              If your Simnovator box is integrated (testcases already on the
              box, no separate Callbox / MME / IMS), skip this page and use{' '}
              <Link className="underline hover:no-underline font-semibold" href="/run-validate">Run &amp; Validate</Link>{' '}
              instead — REST-only execution, no topology required. This page
              is only useful when simqa generates cfgs locally and SSH-pushes
              them to a distributed lab.
            </span>
          }
        />

        {/* Inventory sanity check */}
        {!hasMinimumSystems(doc.systems) ? (
          <Banner
            tone="orange"
            title="Inventory looks light"
            text={
              <span>
                You'll want at least one <span className="font-semibold">Simnovator</span> system in inventory before building a topology setup.
                {' '}<Link className="underline hover:no-underline font-medium" href="/inventory">Go to Inventory</Link>.
              </span>
            }
          />
        ) : null}

        {/* New / edit form (rendered inline at top when active and the setup isn't already a saved card) */}
        {draft && !doc.profiles.some((p) => p.id === draft.id) ? (
          <SetupForm
            draft={draft}
            systems={doc.systems}
            onChange={setDraft}
            onCancel={cancelEdit}
            onSave={saveDraft}
            saving={saving}
            isNew
          />
        ) : null}

        {/* List of saved setups */}
        {doc.profiles.length === 0 && !draft ? (
          <Empty />
        ) : (
          <div className="grid grid-cols-1 gap-4">
            {doc.profiles.map((s) =>
              editingId === s.id && draft ? (
                <SetupForm
                  key={s.id}
                  draft={draft}
                  systems={doc.systems}
                  onChange={setDraft}
                  onCancel={cancelEdit}
                  onSave={saveDraft}
                  saving={saving}
                />
              ) : (
                <SetupCard
                  key={s.id}
                  setup={s}
                  systems={doc.systems}
                  onEdit={() => startEdit(s)}
                  onDelete={() => deleteSetup(s.id)}
                  busy={saving}
                />
              )
            )}
          </div>
        )}
      </main>
      ) : null}
    </>
  );
}

// ───────────── Tab button + Run-validate tab body ─────────────

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={
        'px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ' +
        (active
          ? 'border-primary-600 text-primary-700'
          : 'border-transparent text-slate-600 hover:text-slate-900 hover:border-slate-300')
      }
    >
      {children}
    </button>
  );
}

// ───────────── Subcomponents ─────────────

function hasMinimumSystems(sys: InventorySystem[]): boolean {
  // Only Simnovator is required now. Callbox / MME / IMS / AppServer are
  // optional — most users (anyone running customer-style integrated
  // Simnovator installs) won't have a separate callbox at all. They'll
  // skip this page entirely and use /run-validate instead.
  return sys.some((s) => s.type === 'SIMNOVATOR');
}

function Banner({ tone, title, text }: { tone: 'orange' | 'amber'; title: string; text: React.ReactNode }) {
  const cls = tone === 'orange' ? 'border-orange-200 bg-orange-50 text-orange-900' : 'border-amber-200 bg-amber-50 text-amber-900';
  return (
    <div className={`flex gap-3 rounded-xl border ${cls} p-3.5 text-sm`}>
      <AlertTriangle className="h-4 w-4 mt-0.5 flex-none" />
      <div>
        <div className="font-medium">{title}</div>
        <div className="text-[12.5px] mt-0.5 opacity-90">{text}</div>
      </div>
    </div>
  );
}

function Empty() {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-white/60 p-10 text-center">
      <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-slate-100">
        <Layers className="h-5 w-5 text-slate-400" />
      </div>
      <div className="text-sm font-medium text-slate-700">No QA test setups yet</div>
      <div className="mt-1 text-xs text-slate-500 max-w-md mx-auto">
        Click <span className="font-medium">New setup</span> in the top-right to bind a Simnovator + UESIM + Callbox (and optional IMS / MME / App-server) into one named end-to-end topology.
      </div>
    </div>
  );
}

function lookupSystem(systems: InventorySystem[], id?: string): InventorySystem | undefined {
  if (!id) return undefined;
  return systems.find((s) => s.id === id);
}

// ───── card view ─────

function SetupCard({
  setup, systems, onEdit, onDelete, busy,
}: {
  setup: TestSetup;
  systems: InventorySystem[];
  onEdit: () => void;
  onDelete: () => void;
  busy: boolean;
}) {
  const callboxId = setup.callbox;
  return (
    <div className="group relative rounded-xl border border-slate-200 bg-white shadow-sm transition-shadow hover:shadow-md">
      <div className="absolute top-0 left-0 right-0 h-1 rounded-t-xl bg-gradient-to-r from-orange-500 via-amber-400 to-sky-400" />
      <div className="p-5">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="inline-flex items-center gap-1.5 rounded-md bg-slate-100 text-slate-700 ring-1 ring-slate-200 px-2 py-0.5 text-[10px] uppercase tracking-wider font-medium">
                <Layers className="h-3 w-3" /> Setup
              </span>
              <span className="text-base font-semibold text-slate-900 truncate">{setup.name || setup.id}</span>
            </div>
            <div className="mt-1 text-[11px] text-slate-500 font-mono">{setup.id}</div>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={onEdit}
              className="opacity-60 hover:opacity-100 rounded-md p-1.5 text-slate-600 hover:bg-slate-100"
              title="Edit"
            ><Pencil className="h-4 w-4" /></button>
            <button
              onClick={onDelete}
              disabled={busy}
              className="opacity-60 hover:opacity-100 rounded-md p-1.5 text-slate-600 hover:bg-red-50 hover:text-red-600 disabled:opacity-30"
              title="Delete"
            ><Trash2 className="h-4 w-4" /></button>
          </div>
        </div>

        {/* Topology row */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-3">
          {ROLES.map((role, idx) => {
            const refId = setup[role.key] as string | undefined;
            const isShared = role.shareable && callboxId && refId === callboxId;
            const sys = lookupSystem(systems, refId);
            return (
              <div key={role.key} className="flex items-center gap-2">
                <RoleChip
                  role={role}
                  system={sys}
                  shared={!!isShared}
                  missing={role.required && !sys}
                />
                {idx < ROLES.length - 1 ? (
                  <ArrowRight className="h-3.5 w-3.5 text-slate-300 hidden md:inline" />
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function RoleChip({
  role, system, shared, missing,
}: {
  role: RoleDef;
  system?: InventorySystem;
  shared?: boolean;
  missing?: boolean;
}) {
  const Icon = role.icon;
  const t = TONE_CLASSES[role.tone];
  if (missing) {
    return (
      <div className="rounded-lg border border-dashed border-red-300 bg-red-50/70 px-3 py-1.5 text-[11px]">
        <div className="flex items-center gap-1.5 text-red-700 font-medium">
          <Icon className="h-3.5 w-3.5" />
          {role.label}
        </div>
        <div className="text-red-600 text-[10px] mt-0.5">missing</div>
      </div>
    );
  }
  if (!system) {
    return (
      <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-[11px]">
        <div className="flex items-center gap-1.5 text-slate-500">
          <Icon className="h-3.5 w-3.5" />
          {role.label}
        </div>
        <div className="text-slate-400 text-[10px] mt-0.5">— not set —</div>
      </div>
    );
  }
  return (
    <div className={`rounded-lg border ${t.ring.replace('ring-', 'border-')} ${t.soft} px-3 py-1.5`}>
      <div className={`flex items-center gap-1.5 ${t.text} text-[11px] font-medium`}>
        <Icon className="h-3.5 w-3.5" />
        {role.label}
        {shared ? <span className="ml-1 text-[9px] uppercase tracking-wider opacity-75">↪ shared</span> : null}
      </div>
      <div className="text-[12px] text-slate-900 font-medium leading-tight mt-0.5 truncate max-w-[14rem]">{system.name || system.id}</div>
      <div className="text-[10px] text-slate-500 font-mono">{system.host}</div>
    </div>
  );
}

// ───── form view ─────

function SetupForm({
  draft, systems, onChange, onCancel, onSave, saving, isNew,
}: {
  draft: TestSetup;
  systems: InventorySystem[];
  onChange: (d: TestSetup) => void;
  onCancel: () => void;
  onSave: () => void;
  saving: boolean;
  isNew?: boolean;
}) {
  const patch = (p: Partial<TestSetup>) => onChange({ ...draft, ...p });
  const callboxId = draft.callbox;
  const callbox = lookupSystem(systems, callboxId);

  return (
    <div className="rounded-xl border border-orange-200 bg-white shadow-sm">
      <div className="absolute" />
      <div className="border-b border-slate-100 bg-orange-50/50 px-5 py-3 rounded-t-xl flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm">
          <Layers className="h-4 w-4 text-orange-600" />
          <span className="font-medium text-slate-900">{isNew ? 'New QA Test Setup' : `Edit: ${draft.name || draft.id}`}</span>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" onClick={onCancel} disabled={saving}>
            <X className="h-4 w-4" /> Cancel
          </Button>
          <Button size="sm" onClick={onSave} disabled={saving}>
            <Check className="h-4 w-4" /> {saving ? 'Saving…' : 'Save setup'}
          </Button>
        </div>
      </div>

      <div className="p-5 space-y-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Name *">
            <Input value={draft.name} onChange={(e) => patch({ name: e.target.value })} placeholder="QA Test Setup 1" />
          </Field>
          <Field label="ID" hint="auto-generated; only change if you know what you're doing">
            <Input value={draft.id} onChange={(e) => patch({ id: e.target.value })} />
          </Field>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {ROLES.map((role) => (
            <RoleSelector
              key={role.key}
              role={role}
              draft={draft}
              systems={systems}
              callbox={callbox}
              onChange={(value) => patch({ [role.key]: value } as any)}
            />
          ))}
        </div>

        <Field label="Notes (optional)">
          <Input value={draft.notes ?? ''} onChange={(e) => patch({ notes: e.target.value })} placeholder="e.g. dual-cell handover regression bench" />
        </Field>
      </div>
    </div>
  );
}

function RoleSelector({
  role, draft, systems, callbox, onChange,
}: {
  role: RoleDef;
  draft: TestSetup;
  systems: InventorySystem[];
  callbox?: InventorySystem;
  onChange: (val?: string) => void;
}) {
  const Icon = role.icon;
  const t = TONE_CLASSES[role.tone];
  const candidates = systems.filter((s) => role.types.includes(s.type));
  const value = draft[role.key] as string | undefined;
  const usingCallbox = role.shareable && callbox && value === callbox.id;
  const setUsingCallbox = (yes: boolean) => {
    if (yes) onChange(callbox?.id);
    else onChange(undefined);
  };

  return (
    <div className={`rounded-xl border border-slate-200 bg-white p-4 transition-colors`}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className={`flex h-7 w-7 items-center justify-center rounded-md ${t.bg} ${t.text}`}>
            <Icon className="h-4 w-4" />
          </span>
          <span className="text-sm font-semibold text-slate-900">{role.label}</span>
          {role.required ? <span className="text-[10px] uppercase tracking-wider text-red-500 font-medium">required</span> : null}
        </div>
        {role.shareable && callbox ? (
          <label className="flex items-center gap-1.5 text-[11px] text-slate-600 cursor-pointer">
            <input
              type="checkbox"
              checked={!!usingCallbox}
              onChange={(e) => setUsingCallbox(e.target.checked)}
            />
            same as callbox
          </label>
        ) : null}
      </div>

      {usingCallbox ? (
        <div className={`rounded-lg ${t.soft} ring-1 ${t.ring} px-3 py-2 text-[12px]`}>
          <div className="flex items-center gap-2 text-slate-700">
            <ArrowRight className="h-3.5 w-3.5 text-slate-400" />
            <span>Routed to <span className="font-medium">{callbox?.name || callbox?.id}</span></span>
            <span className="font-mono text-slate-500 text-[11px]">{callbox?.host}</span>
          </div>
        </div>
      ) : (
        <select
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value || undefined)}
          className={SELECT_CLS}
          disabled={candidates.length === 0}
        >
          <option value="">{role.required ? '— pick a system —' : '— none —'}</option>
          {candidates.map((s) => (
            <option key={s.id} value={s.id}>{(s.name || s.id) + ' · ' + s.host}</option>
          ))}
        </select>
      )}

      {candidates.length === 0 ? (
        <div className="mt-2 text-[11px] text-slate-500">
          No <span className="font-mono">{role.types.join(' / ')}</span> systems in inventory.{' '}
          <Link href="/inventory" className="underline hover:no-underline">Add one</Link>.
        </div>
      ) : null}
    </div>
  );
}

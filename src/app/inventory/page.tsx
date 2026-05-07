'use client';

import { useEffect, useMemo, useState } from 'react';
import { Header } from '@/components/Header';
import { Card, CardBody, CardHeader, CardTitle, Button, Input, Field, Badge } from '@/components/ui';
import { Plus, Trash2, Server, Radio, Cpu, Network, Globe, Database, ShieldCheck, Layers } from 'lucide-react';

interface InventorySystem {
  id: string;
  type: string;
  name: string;
  host: string;
  roles?: string[];
  sshPort?: number;
  username?: string;
  authMode?: 'password' | 'privateKey';
  password?: string;
  privateKey?: string;
  passphrase?: string;
  sudoPassword?: string;
  vendor?: string;
  uesim?: { username?: string; password?: string };
  cockpitPort?: number;
  cockpitUser?: string;
  cockpitPassword?: string;
  notes?: string;
}

const COCKPIT_DEFAULT_USER = 'simnovus';
const COCKPIT_DEFAULT_PASSWORD = 'admin@123';
const COCKPIT_DEFAULT_PORT = 9090;

interface TopologyProfile {
  id: string;
  name: string;
  uesim: string;
  callbox?: string;
  enb?: string;
  gnb?: string;
  mme?: string;
  ims?: string;
  appserver?: string;
  notes?: string;
}

const PROFILE_ROLES = [
  // The "uesim" role accepts any UESIM-capable box — Simnovator OR generic UESIM.
  { key: 'uesim',     label: 'UESIM',      types: ['SIMNOVATOR', 'UESIM'],     required: true },
  { key: 'callbox',   label: 'Callbox',    types: ['CALLBOX'],                  required: false },
  { key: 'enb',       label: 'eNB',        types: ['ENB', 'CALLBOX'],           required: false },
  { key: 'gnb',       label: 'gNB',        types: ['GNB', 'CALLBOX'],           required: false },
  { key: 'mme',       label: 'MME',        types: ['MME', 'CALLBOX'],           required: false },
  { key: 'ims',       label: 'IMS',        types: ['IMS', 'CALLBOX'],           required: false },
  { key: 'appserver', label: 'App server', types: ['APPSERVER', 'CALLBOX'],     required: false },
] as const;

// Order matters — Simnovator first because it's the default install target for Build Check.
const SYSTEM_TYPES = ['SIMNOVATOR', 'UESIM', 'CALLBOX', 'ENB', 'GNB', 'MME', 'IMS', 'APPSERVER'];

const TYPE_META: Record<string, { icon: React.ComponentType<{ className?: string }>; ring: string; bg: string; text: string; label: string }> = {
  SIMNOVATOR: { icon: ShieldCheck, ring: 'ring-orange-200', bg: 'bg-orange-50',   text: 'text-orange-700',   label: 'Simnovator' },
  UESIM:      { icon: Cpu,         ring: 'ring-sky-200',    bg: 'bg-sky-50',      text: 'text-sky-700',      label: 'UESIM' },
  CALLBOX:    { icon: Server,      ring: 'ring-violet-200', bg: 'bg-violet-50',   text: 'text-violet-700',   label: 'Callbox' },
  ENB:        { icon: Radio,       ring: 'ring-slate-200',  bg: 'bg-slate-50',    text: 'text-slate-700',    label: 'eNB' },
  GNB:        { icon: Radio,       ring: 'ring-slate-200',  bg: 'bg-slate-50',    text: 'text-slate-700',    label: 'gNB' },
  MME:        { icon: Network,     ring: 'ring-slate-200',  bg: 'bg-slate-50',    text: 'text-slate-700',    label: 'MME' },
  IMS:        { icon: Globe,       ring: 'ring-slate-200',  bg: 'bg-slate-50',    text: 'text-slate-700',    label: 'IMS' },
  APPSERVER:  { icon: Database,    ring: 'ring-slate-200',  bg: 'bg-slate-50',    text: 'text-slate-700',    label: 'App Server' },
};

function TypeChip({ type }: { type: string }) {
  const m = TYPE_META[type] ?? TYPE_META.UESIM;
  const Icon = m.icon;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ${m.bg} ${m.text} ring-1 ${m.ring}`}>
      <Icon className="h-3.5 w-3.5" />
      <span className="tracking-wide uppercase">{m.label}</span>
    </span>
  );
}

const SELECT_CLS =
  'h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 ' +
  'focus:outline-none focus:ring-2 focus:ring-primary-300 focus:border-primary-400';

export default function InventoryPage() {
  const [systems, setSystems]   = useState<InventorySystem[]>([]);
  const [profiles, setProfiles] = useState<TopologyProfile[]>([]);
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [msg, setMsg]           = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/inventory').then((r) => r.json()).then((d) => {
      setSystems(d.systems ?? []);
      setProfiles(d.profiles ?? []);
    }).finally(() => setLoading(false));
  }, []);

  async function save() {
    setSaving(true); setMsg(null);
    try {
      const r = await fetch('/api/inventory', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ systems, profiles }),
      });
      const j = await r.json();
      if (!r.ok || j.error) throw new Error(j.error ?? `HTTP ${r.status}`);
      setMsg('Saved');
      setTimeout(() => setMsg(null), 1500);
    } catch (e: any) {
      setMsg(`Error: ${e?.message ?? e}`);
    } finally {
      setSaving(false);
    }
  }

  function addSystem() {
    setSystems((s) => [
      ...s,
      { id: `sys-${s.length + 1}`, type: 'SIMNOVATOR', name: '', host: '' },
    ]);
  }
  function removeSystem(idx: number) {
    setSystems((s) => s.filter((_, i) => i !== idx));
  }
  function patchSystem(idx: number, patch: Partial<InventorySystem>) {
    setSystems((s) => s.map((x, i) => (i === idx ? { ...x, ...patch } : x)));
  }

  function addProfile() {
    const uesim = systems.find((s) => s.type === 'SIMNOVATOR' || s.type === 'UESIM');
    if (!uesim) {
      setMsg('Add a Simnovator (or UESIM) system first');
      return;
    }
    setProfiles((p) => [
      ...p,
      { id: `topo-${p.length + 1}`, name: `Topology ${p.length + 1}`, uesim: uesim.id },
    ]);
  }
  function removeProfile(idx: number) {
    setProfiles((p) => p.filter((_, i) => i !== idx));
  }
  function patchProfile(idx: number, patch: Partial<TopologyProfile>) {
    setProfiles((p) => p.map((x, i) => (i === idx ? { ...x, ...patch } : x)));
  }

  // Quick stats banner content
  const stats = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const s of systems) counts[s.type] = (counts[s.type] ?? 0) + 1;
    return {
      total: systems.length,
      simnovator: counts.SIMNOVATOR ?? 0,
      uesim: counts.UESIM ?? 0,
      callbox: counts.CALLBOX ?? 0,
      profiles: profiles.length,
    };
  }, [systems, profiles]);

  return (
    <>
      <Header
        title="Systems Management"
        subtitle="Lab systems and topology profiles · click any field to edit, then Save"
        right={
          <div className="flex items-center gap-2">
            {msg ? (
              <span className={`text-xs ${msg.startsWith('Error') ? 'text-red-600' : 'text-emerald-600'}`}>{msg}</span>
            ) : null}
            <Button size="sm" variant="secondary" onClick={addSystem}><Plus className="h-4 w-4" />Add system</Button>
            <Button size="sm" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
          </div>
        }
      />

      <main
        className="relative min-h-[calc(100vh-3.5rem)] p-6 space-y-6"
        style={{
          backgroundImage:
            'radial-gradient(1200px 600px at 80% -10%, rgba(255,106,0,0.06), transparent 60%),' +
            'radial-gradient(900px 500px at -10% 110%, rgba(56,189,248,0.06), transparent 55%)',
          backgroundColor: 'rgb(249 250 251)',
        }}
      >
        {loading ? (
          <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500 shadow-sm">Loading…</div>
        ) : (
          <>
            {/* How-to-edit hint */}
            <div className="rounded-xl border border-sky-200 bg-sky-50/70 px-4 py-2.5 flex items-start gap-3 text-[12px] text-sky-900">
              <div className="mt-0.5 flex h-6 w-6 flex-none items-center justify-center rounded-full bg-sky-100 text-sky-700 font-semibold">?</div>
              <div className="leading-relaxed">
                <span className="font-semibold">Editing systems:</span>{' '}
                click into any field on a card below — ID, Name, Type, Host/IP, credentials — change the value, then click{' '}
                <span className="rounded bg-white px-1.5 py-0.5 border border-sky-200 font-medium">Save</span>{' '}
                at the top-right. Nothing persists to <span className="font-mono">inventory.yaml</span> until you save.{' '}
                Use the <Trash2 className="inline h-3 w-3" /> on a card to remove a system.
              </div>
            </div>

            {/* Stats strip */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <StatCard icon={ShieldCheck} tone="orange" label="Simnovator"   value={stats.simnovator} />
              <StatCard icon={Cpu}         tone="sky"    label="UESIM"        value={stats.uesim} />
              <StatCard icon={Server}      tone="violet" label="Callboxes"    value={stats.callbox} />
              <StatCard icon={Layers}      tone="slate"  label="Topologies"   value={stats.profiles} />
            </div>

            {/* SYSTEMS */}
            <section>
              <div className="flex items-end justify-between mb-3">
                <div>
                  <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-500">Systems</h2>
                  <p className="text-xs text-slate-500">Mark a box as <span className="text-orange-700 font-medium">Simnovator</span> to allow Build Check to install onto it.</p>
                </div>
              </div>

              {systems.length === 0 ? (
                <EmptyCard
                  icon={<Server className="h-5 w-5 text-slate-400" />}
                  title="No systems yet"
                  desc='Click "Add system" above to register your first lab box.'
                />
              ) : (
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                  {systems.map((sys, idx) => (
                    <SystemCard
                      key={idx}
                      sys={sys}
                      onPatch={(p) => patchSystem(idx, p)}
                      onRemove={() => removeSystem(idx)}
                    />
                  ))}
                </div>
              )}
            </section>

            {/* TOPOLOGY PROFILES */}
            <section>
              <div className="flex items-end justify-between mb-3">
                <div>
                  <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-500">Topology profiles</h2>
                  <p className="text-xs text-slate-500">Bind one UESIM-capable system to its deploy targets so the runner knows where to push generated cfgs.</p>
                </div>
                <Button size="sm" variant="secondary" onClick={addProfile}><Plus className="h-4 w-4" />Add profile</Button>
              </div>

              {profiles.length === 0 ? (
                <EmptyCard
                  icon={<Layers className="h-5 w-5 text-slate-400" />}
                  title="No profiles yet"
                  desc="A profile binds one UESIM (Simnovator) with one or more deploy targets — callbox, or separate eNB / MME / IMS / AppServer. The Automation page references profiles to know where to push generated cfgs."
                />
              ) : (
                <div className="grid grid-cols-1 gap-4">
                  {profiles.map((p, idx) => (
                    <ProfileCard
                      key={idx}
                      profile={p}
                      systems={systems}
                      onPatch={(patch) => patchProfile(idx, patch)}
                      onRemove={() => removeProfile(idx)}
                    />
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </main>
    </>
  );
}

// ───────────────────── Components ─────────────────────

function StatCard({
  icon: Icon, tone, label, value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  tone: 'orange' | 'sky' | 'violet' | 'slate';
  label: string;
  value: number;
}) {
  const tones = {
    orange: { bg: 'bg-orange-50',   text: 'text-orange-700',   ring: 'ring-orange-200' },
    sky:    { bg: 'bg-sky-50',      text: 'text-sky-700',      ring: 'ring-sky-200' },
    violet: { bg: 'bg-violet-50',   text: 'text-violet-700',   ring: 'ring-violet-200' },
    slate:  { bg: 'bg-slate-50',    text: 'text-slate-700',    ring: 'ring-slate-200' },
  } as const;
  const t = tones[tone];
  return (
    <div className="relative rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center gap-3">
        <div className={`flex h-9 w-9 items-center justify-center rounded-lg ring-1 ${t.bg} ${t.text} ${t.ring}`}>
          <Icon className="h-4 w-4" />
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wider text-slate-500">{label}</div>
          <div className="text-2xl font-semibold text-slate-900 leading-none mt-0.5">{value}</div>
        </div>
      </div>
    </div>
  );
}

function EmptyCard({ icon, title, desc }: { icon: React.ReactNode; title: string; desc: string }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-white/60 p-8 text-center">
      <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-slate-100">
        {icon}
      </div>
      <div className="text-sm font-medium text-slate-700">{title}</div>
      <div className="mt-1 text-xs text-slate-500 max-w-md mx-auto">{desc}</div>
    </div>
  );
}

function SystemCard({
  sys, onPatch, onRemove,
}: {
  sys: InventorySystem;
  onPatch: (p: Partial<InventorySystem>) => void;
  onRemove: () => void;
}) {
  const isUesimLike = sys.type === 'SIMNOVATOR' || sys.type === 'UESIM';
  return (
    <div className="group relative rounded-xl border border-slate-200 bg-white shadow-sm transition-shadow hover:shadow-md">
      {/* Top accent stripe — orange for Simnovator install targets */}
      {sys.type === 'SIMNOVATOR' ? (
        <div className="absolute top-0 left-0 right-0 h-1 rounded-t-xl bg-gradient-to-r from-orange-500 via-orange-400 to-amber-300" />
      ) : null}

      <div className="p-5 space-y-4">
        {/* Header row */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1 flex items-center gap-2 flex-wrap">
            <TypeChip type={sys.type} />
            <span className="text-base font-semibold text-slate-900 truncate">{sys.name || sys.id}</span>
            {sys.host ? <span className="text-xs font-mono text-slate-500">{sys.host}</span> : null}
          </div>
          <button
            onClick={onRemove}
            className="opacity-50 group-hover:opacity-100 transition-opacity rounded-md p-1.5 text-slate-500 hover:bg-red-50 hover:text-red-600"
            aria-label="Remove"
          ><Trash2 className="h-4 w-4" /></button>
        </div>

        {/* Identity row */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <Field label="ID"><Input value={sys.id} onChange={(e) => onPatch({ id: e.target.value })} /></Field>
          <Field label="Name"><Input value={sys.name} onChange={(e) => onPatch({ name: e.target.value })} /></Field>
          <Field label="Type">
            <select
              value={sys.type}
              onChange={(e) => onPatch({ type: e.target.value })}
              className={SELECT_CLS}
            >
              {SYSTEM_TYPES.map((t) => (
                <option key={t} value={t}>{TYPE_META[t]?.label ?? t}</option>
              ))}
            </select>
          </Field>
          <Field label="Host / IP">
            <Input value={sys.host} onChange={(e) => onPatch({ host: e.target.value })} placeholder="192.168.1.95" />
          </Field>
        </div>

        <div className="border-t border-slate-100" />

        {/* ── UESIM REST API credentials ── (SIMNOVATOR + UESIM types) */}
        {isUesimLike ? (
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-2">UESIM REST API</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="API user">
                <Input value={sys.uesim?.username ?? ''} onChange={(e) => onPatch({ uesim: { ...(sys.uesim ?? {}), username: e.target.value } })} placeholder="admin" />
              </Field>
              <Field label="API password">
                <Input type="password" value={sys.uesim?.password ?? ''} onChange={(e) => onPatch({ uesim: { ...(sys.uesim ?? {}), password: e.target.value } })} placeholder="••••" />
              </Field>
            </div>
          </div>
        ) : null}

        {/* ── Cockpit credentials ── (SIMNOVATOR only) */}
        {sys.type === 'SIMNOVATOR' ? (
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-2">Cockpit (web admin UI)</div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Field label="User" hint={`default ${COCKPIT_DEFAULT_USER}`}>
                <Input
                  value={sys.cockpitUser ?? ''}
                  onChange={(e) => onPatch({ cockpitUser: e.target.value || undefined })}
                  placeholder={COCKPIT_DEFAULT_USER}
                />
              </Field>
              <Field label="Password" hint={`default ${COCKPIT_DEFAULT_PASSWORD}`}>
                <Input
                  type="password"
                  value={sys.cockpitPassword ?? ''}
                  onChange={(e) => onPatch({ cockpitPassword: e.target.value || undefined })}
                  placeholder={COCKPIT_DEFAULT_PASSWORD}
                />
              </Field>
              <Field label="Port" hint={`default ${COCKPIT_DEFAULT_PORT}`}>
                <Input
                  value={sys.cockpitPort?.toString() ?? ''}
                  onChange={(e) => onPatch({ cockpitPort: e.target.value ? Number(e.target.value) : undefined })}
                  placeholder={String(COCKPIT_DEFAULT_PORT)}
                />
              </Field>
            </div>
            <div className="mt-3 rounded-lg border border-orange-200 bg-orange-50/60 px-3 py-2 text-[11px] text-orange-800 leading-relaxed">
              <span className="font-medium">Simnovator install target.</span>{' '}
              Build Check deep-links you into Cockpit Terminal at
              {' '}<span className="font-mono">https://{sys.host || '<host>'}:{sys.cockpitPort ?? COCKPIT_DEFAULT_PORT}/system/terminal</span>{' '}
              with the wget + tar + ./install commands pre-filled. The user/password above are shown so you can copy-paste them into the Cockpit login screen — this app never logs in for you.
            </div>
          </div>
        ) : null}

        {/* ── SSH credentials ── (everything except SIMNOVATOR/UESIM) */}
        {!isUesimLike ? (
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-2">SSH credentials</div>
            <SshCredentialsBlock sys={sys} onPatch={onPatch} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function SshCredentialsBlock({
  sys, onPatch,
}: { sys: InventorySystem; onPatch: (p: Partial<InventorySystem>) => void }) {
  const authMode = sys.authMode ?? 'password';
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
      <Field label="SSH user"><Input value={sys.username ?? ''} onChange={(e) => onPatch({ username: e.target.value })} /></Field>
      <Field label="SSH port" hint="default 22">
        <Input value={sys.sshPort?.toString() ?? ''} onChange={(e) => onPatch({ sshPort: e.target.value ? Number(e.target.value) : undefined })} />
      </Field>
      <Field label="Auth mode">
        <select
          value={authMode}
          onChange={(e) => onPatch({ authMode: e.target.value as 'password' | 'privateKey' })}
          className={SELECT_CLS}
        >
          <option value="password">Password</option>
          <option value="privateKey">Private key</option>
        </select>
      </Field>
      <Field label="Vendor">
        <select
          value={sys.vendor ?? ''}
          onChange={(e) => onPatch({ vendor: e.target.value || undefined })}
          className={SELECT_CLS}
        >
          <option value="">—</option>
          <option value="simnovus">simnovus</option>
          <option value="amarisoft">amarisoft</option>
          <option value="srsran">srsran</option>
          <option value="oai">oai</option>
          <option value="other">other</option>
        </select>
      </Field>
      {authMode === 'password' ? (
        <Field label="SSH password" hint="local-lab convenience only">
          <Input type="password" value={sys.password ?? ''} onChange={(e) => onPatch({ password: e.target.value })} />
        </Field>
      ) : (
        <>
          <div className="sm:col-span-2 lg:col-span-4">
            <Field label="Private key" hint="paste contents (-----BEGIN ...) or filesystem path on this host (e.g. ~/.ssh/id_rsa)">
              <textarea
                value={sys.privateKey ?? ''}
                onChange={(e) => onPatch({ privateKey: e.target.value })}
                rows={4}
                placeholder={'-----BEGIN OPENSSH PRIVATE KEY-----\n... or /home/user/.ssh/id_rsa'}
                className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-mono text-slate-900 focus:outline-none focus:ring-2 focus:ring-primary-300 focus:border-primary-400"
              />
            </Field>
          </div>
          <Field label="Key passphrase" hint="if encrypted">
            <Input type="password" value={sys.passphrase ?? ''} onChange={(e) => onPatch({ passphrase: e.target.value })} />
          </Field>
        </>
      )}
      <Field label="sudo password" hint="needed for /root/* mv + systemctl restart unless NOPASSWD">
        <Input type="password" value={sys.sudoPassword ?? ''} onChange={(e) => onPatch({ sudoPassword: e.target.value })} />
      </Field>
    </div>
  );
}

function ProfileCard({
  profile, systems, onPatch, onRemove,
}: {
  profile: TopologyProfile;
  systems: InventorySystem[];
  onPatch: (p: Partial<TopologyProfile>) => void;
  onRemove: () => void;
}) {
  return (
    <div className="group relative rounded-xl border border-slate-200 bg-white shadow-sm transition-shadow hover:shadow-md">
      <div className="p-5 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-slate-100 text-slate-600">
              <Layers className="h-3.5 w-3.5" />
            </div>
            <span className="text-base font-semibold text-slate-900 truncate">{profile.name || profile.id}</span>
          </div>
          <button
            onClick={onRemove}
            className="opacity-50 group-hover:opacity-100 transition-opacity rounded-md p-1.5 text-slate-500 hover:bg-red-50 hover:text-red-600"
            aria-label="Remove"
          ><Trash2 className="h-4 w-4" /></button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <Field label="ID"><Input value={profile.id} onChange={(e) => onPatch({ id: e.target.value })} /></Field>
          <Field label="Name"><Input value={profile.name} onChange={(e) => onPatch({ name: e.target.value })} /></Field>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {PROFILE_ROLES.map(({ key, label, types, required }) => {
            const candidates = systems.filter((s) => (types as readonly string[]).includes(s.type));
            const value = (profile as any)[key] as string | undefined;
            return (
              <Field key={key} label={label + (required ? ' *' : '')} hint={candidates.length === 0 ? `no ${types.join(' / ')} systems yet` : undefined}>
                <select
                  value={value ?? ''}
                  onChange={(e) => onPatch({ [key]: e.target.value || undefined } as any)}
                  className={SELECT_CLS}
                  disabled={candidates.length === 0 && !value}
                >
                  <option value="">{required ? '— choose —' : '— none —'}</option>
                  {candidates.map((s) => (
                    <option key={s.id} value={s.id}>{s.name || s.id} ({s.host})</option>
                  ))}
                </select>
              </Field>
            );
          })}
        </div>
      </div>
    </div>
  );
}

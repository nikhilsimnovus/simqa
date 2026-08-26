'use client';

// Systems Management — the single place lab hardware is registered and wired
// into topologies.
//
// Layout rule: a system row shows NAME and HOST/IP only. Everything else —
// id, type, REST credentials, Cockpit, SSH — lives behind that row's Advanced
// disclosure. Most visits are "which boxes do I have", not "let me re-enter an
// SSH key", so the credential blocks stay collapsed until asked for.
//
// The Topology tab absorbed the old /end-to-end "Topology Setups" screen. Both
// used to edit this same profiles[] array with contradicting validation; the
// rules now live once, in lib/topology.ts.

import { useEffect, useMemo, useState, useCallback, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { Header } from '@/components/Header';
import { Button, Input, Field, Kicker } from '@/components/ui';
import {
  Plus, Trash2, Server, ChevronRight, Layers, AlertTriangle, Check, KeyRound,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import {
  SYSTEM_TYPES, typeMeta, isUesimCapable, ROLES, profileIssues, migrateProfile,
} from '@/lib/topology';

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

interface SshDefaults {
  username?: string;
  sshPort?: number;
  authMode?: 'password' | 'privateKey';
  password?: string;
  privateKey?: string;
  passphrase?: string;
  sudoPassword?: string;
}

/** Mirrors SSH_FIELDS in lib/inventory.ts. */
const SSH_FIELDS = ['username', 'sshPort', 'authMode', 'password', 'privateKey', 'passphrase', 'sudoPassword'] as const;

function isSet(v: unknown): boolean {
  return v !== undefined && v !== null && v !== '';
}

/** SSH fields this system sets for itself rather than inheriting. */
function ownSshFields(sys: InventorySystem): string[] {
  return SSH_FIELDS.filter((k) => isSet((sys as any)[k]));
}

interface TopologyProfile {
  id: string;
  name: string;
  simnovator?: string;
  uesim?: string;
  /** Legacy — migrated into enb/gnb on load, never written back. */
  callbox?: string;
  enb?: string;
  gnb?: string;
  mme?: string;
  ims?: string;
  appserver?: string;
  notes?: string;
}

const COCKPIT_DEFAULT_USER = 'simnovus';
const COCKPIT_DEFAULT_PASSWORD = 'admin@123';
const COCKPIT_DEFAULT_PORT = 9090;

const SELECT_CLS =
  'h-9 w-full rounded-lg border border-line-strong bg-surface px-3 text-sm text-slate-900 ' +
  'transition-colors focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/25';

/**
 * useSearchParams() opts the subtree out of static prerendering, so Next
 * requires a Suspense boundary above it — without one `next build` fails on
 * this route. The fallback renders the page chrome so the shell is stable.
 */
export default function InventoryPage() {
  return (
    <Suspense fallback={
      <>
        <Header title="Systems Management" subtitle="Lab boxes and the topologies that wire them together" />
        <main className="p-5">
          <div className="rounded-xl border border-line bg-surface p-5 text-sm text-slate-500">Loading…</div>
        </main>
      </>
    }>
      <InventoryEditor />
    </Suspense>
  );
}

function InventoryEditor() {
  const params = useSearchParams();
  const qTab = params?.get('tab');
  const [tab, setTab] = useState<'systems' | 'topology' | 'credentials'>(
    qTab === 'topology' ? 'topology' : qTab === 'credentials' ? 'credentials' : 'systems',
  );

  const [systems, setSystems]   = useState<InventorySystem[]>([]);
  const [profiles, setProfiles] = useState<TopologyProfile[]>([]);
  const [sshDefaults, setSshDefaults] = useState<SshDefaults>({});
  /** Siblings of `defaults.ssh` this screen doesn't edit — round-tripped. */
  const [defaultsRest, setDefaultsRest] = useState<Record<string, unknown>>({});
  const [rest, setRest]         = useState<Record<string, unknown>>({});
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [dirty, setDirty]       = useState(false);
  const [msg, setMsg]           = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    fetch('/api/inventory').then((r) => r.json()).then((d) => {
      const { systems: sys, profiles: pro, defaults, ...others } = d ?? {};
      setSystems(sys ?? []);
      // Fold any legacy `callbox` binding into eNB/gNB — the Callbox role no
      // longer exists, and we don't want that value stranded in the file.
      setProfiles((pro ?? []).map(migrateProfile));
      const { ssh, ...defaultsOthers } = defaults ?? {};
      setSshDefaults(ssh ?? {});
      setDefaultsRest(defaultsOthers);
      // Anything else in the document (suites, …) is round-tripped untouched
      // so saving from this screen can't drop a sibling section.
      setRest(others ?? {});
    }).finally(() => setLoading(false));
  }, []);

  const flash = useCallback((kind: 'ok' | 'err', text: string) => {
    setMsg({ kind, text });
    window.setTimeout(() => setMsg(null), 2000);
  }, []);

  async function save() {
    setSaving(true);
    const hasSsh = Object.values(sshDefaults).some(isSet);
    try {
      const r = await fetch('/api/inventory', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        // Drop an all-empty defaults block rather than writing `ssh: {}`.
        body: JSON.stringify({
          ...rest,
          systems,
          profiles,
          defaults: hasSsh || Object.keys(defaultsRest).length
            ? { ...defaultsRest, ...(hasSsh ? { ssh: sshDefaults } : {}) }
            : undefined,
        }),
      });
      const j = await r.json();
      if (!r.ok || j.error) throw new Error(j.error ?? `HTTP ${r.status}`);
      setDirty(false);
      flash('ok', 'Saved to inventory.yaml');
    } catch (e: any) {
      flash('err', `${e?.message ?? e}`);
    } finally {
      setSaving(false);
    }
  }

  // Every mutation funnels through these so `dirty` can't drift out of sync.
  const mutSystems = useCallback((fn: (s: InventorySystem[]) => InventorySystem[]) => {
    setSystems(fn); setDirty(true);
  }, []);
  const mutProfiles = useCallback((fn: (p: TopologyProfile[]) => TopologyProfile[]) => {
    setProfiles(fn); setDirty(true);
  }, []);

  const addSystem = useCallback(() => {
    mutSystems((s) => [...s, { id: uniqueId('sys', s.map((x) => x.id)), type: 'SIMNOVATOR', name: '', host: '' }]);
    setTab('systems');
  }, [mutSystems]);

  const addProfile = useCallback(() => {
    mutProfiles((p) => {
      const sim = systems.find((s) => s.type === 'SIMNOVATOR') ?? systems.find((s) => isUesimCapable(s.type));
      return [...p, {
        id: uniqueId('topo', p.map((x) => x.id)),
        name: `Topology ${p.length + 1}`,
        ...(sim ? (sim.type === 'SIMNOVATOR' ? { simnovator: sim.id } : { uesim: sim.id }) : {}),
      }];
    });
    setTab('topology');
  }, [mutProfiles, systems]);

  const counts = useMemo(() => ({
    systems: systems.length,
    topologies: profiles.length,
    broken: profiles.filter((p) => profileIssues(p as any).length > 0).length,
    overrides: systems.filter((s) => ownSshFields(s).length > 0).length,
  }), [systems, profiles]);

  return (
    <>
      <Header
        title="Systems Management"
        subtitle="Lab boxes and the topologies that wire them together"
        right={
          <div className="flex items-center gap-2">
            {msg ? (
              <span className={cn('text-xs font-medium', msg.kind === 'err' ? 'text-red-600' : 'text-emerald-600')}>
                {msg.text}
              </span>
            ) : dirty ? (
              <span className="text-xs text-amber-700">Unsaved changes</span>
            ) : null}
            {tab !== 'credentials' ? (
              <Button size="sm" variant="secondary" onClick={tab === 'systems' ? addSystem : addProfile}>
                <Plus className="h-4 w-4" />{tab === 'systems' ? 'Add system' : 'Add topology'}
              </Button>
            ) : null}
            <Button size="sm" onClick={save} disabled={saving || !dirty}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        }
      />

      <main className="p-5 space-y-4">
        <div className="flex w-max gap-1 rounded-lg border border-line bg-panel p-1">
          <TabButton active={tab === 'systems'} onClick={() => setTab('systems')}
            icon={Server} label="Systems" count={counts.systems} />
          <TabButton active={tab === 'topology'} onClick={() => setTab('topology')}
            icon={Layers} label="Topology" count={counts.topologies}
            warn={counts.broken > 0 ? counts.broken : undefined} />
          <TabButton active={tab === 'credentials'} onClick={() => setTab('credentials')}
            icon={KeyRound} label="Credentials" count={counts.overrides}
            countLabel="overrides" />
        </div>

        {loading ? (
          <div className="rounded-xl border border-line bg-surface p-5 text-sm text-slate-500">Loading…</div>
        ) : tab === 'systems' ? (
          <SystemsTab
            systems={systems}
            onAdd={addSystem}
            onPatch={(i, patch) => mutSystems((s) => s.map((x, k) => (k === i ? { ...x, ...patch } : x)))}
            onRemove={(i) => mutSystems((s) => s.filter((_, k) => k !== i))}
          />
        ) : tab === 'topology' ? (
          <TopologyTab
            profiles={profiles}
            systems={systems}
            onAdd={addProfile}
            onPatch={(i, patch) => mutProfiles((p) => p.map((x, k) => (k === i ? { ...x, ...patch } : x)))}
            onRemove={(i) => mutProfiles((p) => p.filter((_, k) => k !== i))}
          />
        ) : (
          <CredentialsTab
            defaults={sshDefaults}
            systems={systems}
            onPatch={(patch) => { setSshDefaults((d) => ({ ...d, ...patch })); setDirty(true); }}
            onClearOverride={(idx) => mutSystems((arr) => arr.map((x, k) => {
              if (k !== idx) return x;
              const next: any = { ...x };
              for (const f of SSH_FIELDS) delete next[f];
              return next;
            }))}
          />
        )}
      </main>
    </>
  );
}

/** Stable, collision-free default id for a newly added row. */
function uniqueId(prefix: string, taken: string[]): string {
  let n = taken.length + 1;
  while (taken.includes(`${prefix}-${n}`)) n += 1;
  return `${prefix}-${n}`;
}

// ───────────────────── Tab chrome ─────────────────────

function TabButton({
  active, onClick, icon: Icon, label, count, warn, countLabel,
}: {
  active: boolean; onClick: () => void;
  icon: React.ComponentType<{ className?: string }>;
  label: string; count: number; warn?: number; countLabel?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-selected={active}
      className={cn(
        'inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
        active ? 'bg-surface text-slate-900 shadow-glow' : 'text-slate-500 hover:text-slate-900',
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
      <span className="num text-[11px] text-slate-500" title={countLabel}>{count}</span>
      {warn ? (
        <span className="inline-flex items-center gap-1 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">
          <AlertTriangle className="h-2.5 w-2.5" />{warn}
        </span>
      ) : null}
    </button>
  );
}

function EmptyState({ icon, title, desc, action }: {
  icon: React.ReactNode; title: string; desc: string; action?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-dashed border-line-strong bg-surface/60 p-8 text-center">
      <div className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-full bg-slate-100">{icon}</div>
      <div className="text-sm font-medium text-slate-700">{title}</div>
      <div className="mx-auto mt-1 max-w-md text-xs font-light text-slate-500">{desc}</div>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2 flex items-baseline gap-2">
        <Kicker>{title}</Kicker>
        {note ? <span className="text-[11px] font-light text-slate-500">{note}</span> : null}
      </div>
      {children}
    </div>
  );
}

// ───────────────────── Systems tab ─────────────────────

function SystemsTab({
  systems, onAdd, onPatch, onRemove,
}: {
  systems: InventorySystem[];
  onAdd: () => void;
  onPatch: (idx: number, patch: Partial<InventorySystem>) => void;
  onRemove: (idx: number) => void;
}) {
  const [open, setOpen] = useState<Record<number, boolean>>({});
  if (systems.length === 0) {
    return (
      <EmptyState
        icon={<Server className="h-5 w-5 text-slate-400" />}
        title="No systems yet"
        desc="Register a lab box to get started. Only a name and an IP are required — credentials can wait."
        action={<Button size="sm" onClick={onAdd}><Plus className="h-4 w-4" />Add system</Button>}
      />
    );
  }
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface">
      {/* Column header mirrors the fields a collapsed row actually shows. */}
      <div className="hidden grid-cols-[1fr_170px_200px_104px] gap-3 border-b border-line bg-panel px-3 py-2 sm:grid">
        <Kicker>Name</Kicker>
        <Kicker>Type</Kicker>
        <Kicker>Host / IP</Kicker>
        <Kicker className="text-right">Advanced</Kicker>
      </div>
      <ul className="divide-y divide-line">
        {systems.map((sys, idx) => (
          <SystemRow
            key={idx}
            sys={sys}
            open={!!open[idx]}
            onToggle={() => setOpen((o) => ({ ...o, [idx]: !o[idx] }))}
            onPatch={(p) => onPatch(idx, p)}
            onRemove={() => onRemove(idx)}
          />
        ))}
      </ul>
    </div>
  );
}

function SystemRow({
  sys, open, onToggle, onPatch, onRemove,
}: {
  sys: InventorySystem; open: boolean; onToggle: () => void;
  onPatch: (p: Partial<InventorySystem>) => void; onRemove: () => void;
}) {
  const meta = typeMeta(sys.type);
  const Icon = meta.icon;
  // What is configured beyond the basics — surfaced as a hint so a collapsed
  // row still tells you whether credentials exist.
  const extras = [
    sys.uesim?.username ? 'REST' : null,
    sys.username ? 'SSH' : null,
    sys.cockpitUser ? 'Cockpit' : null,
  ].filter(Boolean) as string[];

  return (
    <li className={cn('group', open && 'bg-panel')}>
      <div className="grid grid-cols-1 items-center gap-2 px-3 py-2 sm:grid-cols-[1fr_170px_200px_104px] sm:gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={cn('inline-flex flex-none items-center rounded-md p-1 ring-1 ring-inset', meta.chip)}
            title={meta.label}
          >
            <Icon className="h-3.5 w-3.5" />
          </span>
          <Input
            value={sys.name}
            onChange={(e) => onPatch({ name: e.target.value })}
            placeholder={sys.id}
            aria-label="System name"
            className="h-8 border-transparent bg-transparent px-1.5 font-medium hover:border-line-strong focus:bg-surface"
          />
        </div>

        {/* What the box IS. Lives in the row rather than behind Advanced —
            it drives which topology slots the box is eligible for, so it is
            identity, not configuration. Editable here and ONLY here; keeping
            a second copy in the Advanced panel would be two editors for one
            field, which is the trap the topology screens fell into. */}
        <select
          value={sys.type}
          onChange={(e) => onPatch({ type: e.target.value })}
          aria-label="System type"
          className="h-8 w-full rounded-md border border-transparent bg-transparent px-1.5 text-[13px] font-medium text-slate-700 transition-colors hover:border-line-strong focus:border-primary-500 focus:bg-surface focus:outline-none focus:ring-2 focus:ring-primary-500/25"
        >
          {SYSTEM_TYPES.map((t) => <option key={t} value={t}>{typeMeta(t).label}</option>)}
        </select>

        <Input
          value={sys.host}
          onChange={(e) => onPatch({ host: e.target.value })}
          placeholder="192.168.1.95"
          aria-label="Host or IP"
          className="h-8 border-transparent bg-transparent px-1.5 font-mono text-[13px] hover:border-line-strong focus:bg-surface"
        />

        <div className="flex items-center justify-end gap-1">
          {/* Which credential blocks are filled in, so a collapsed row still
              says what is configured. nowrap + xl-only: it must never wrap
              onto a second line and stretch the row. */}
          {!open && extras.length ? (
            <span
              className="num hidden whitespace-nowrap text-[10px] text-slate-400 xl:inline"
              title={`configured: ${extras.join(', ')}`}
            >
              {extras.join(' ')}
            </span>
          ) : null}
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            aria-label={`${open ? 'Hide' : 'Show'} advanced settings for ${sys.name || sys.id}`}
            className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-900"
            title="Advanced — id, type, credentials"
          >
            <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-90')} />
          </button>
          <button
            type="button"
            onClick={onRemove}
            className="rounded-md p-1.5 text-slate-400 opacity-0 transition-opacity hover:bg-red-50 hover:text-red-600 focus:opacity-100 group-hover:opacity-100"
            aria-label={`Remove ${sys.name || sys.id}`}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {open ? <SystemAdvanced sys={sys} onPatch={onPatch} /> : null}
    </li>
  );
}

/** Everything that is not name or host. Collapsed by default. */
function SystemAdvanced({
  sys, onPatch,
}: { sys: InventorySystem; onPatch: (p: Partial<InventorySystem>) => void }) {
  const authMode = sys.authMode ?? 'password';
  return (
    <div className="space-y-4 border-t border-line px-3 pb-4 pt-3">
      {/* Type is deliberately absent here — it is edited in the row itself. */}
      <Section title="Identity">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="ID" hint="referenced by topologies">
            <Input value={sys.id} onChange={(e) => onPatch({ id: e.target.value })} />
          </Field>
          <Field label="Vendor">
            <select value={sys.vendor ?? ''} onChange={(e) => onPatch({ vendor: e.target.value || undefined })} className={SELECT_CLS}>
              <option value="">—</option>
              {['simnovus', 'amarisoft', 'srsran', 'oai', 'other'].map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </Field>
        </div>
      </Section>

      {isUesimCapable(sys.type) ? (
        <Section title="UESIM REST API">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="API user">
              <Input value={sys.uesim?.username ?? ''} placeholder="admin"
                onChange={(e) => onPatch({ uesim: { ...(sys.uesim ?? {}), username: e.target.value } })} />
            </Field>
            <Field label="API password">
              <Input type="password" value={sys.uesim?.password ?? ''} placeholder="••••"
                onChange={(e) => onPatch({ uesim: { ...(sys.uesim ?? {}), password: e.target.value } })} />
            </Field>
          </div>
        </Section>
      ) : null}

      {sys.type === 'SIMNOVATOR' ? (
        <Section title="Cockpit (web admin)">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="User" hint={`default ${COCKPIT_DEFAULT_USER}`}>
              <Input value={sys.cockpitUser ?? ''} placeholder={COCKPIT_DEFAULT_USER}
                onChange={(e) => onPatch({ cockpitUser: e.target.value || undefined })} />
            </Field>
            <Field label="Password" hint={`default ${COCKPIT_DEFAULT_PASSWORD}`}>
              <Input type="password" value={sys.cockpitPassword ?? ''} placeholder={COCKPIT_DEFAULT_PASSWORD}
                onChange={(e) => onPatch({ cockpitPassword: e.target.value || undefined })} />
            </Field>
            <Field label="Port" hint={`default ${COCKPIT_DEFAULT_PORT}`}>
              <Input value={sys.cockpitPort?.toString() ?? ''} placeholder={String(COCKPIT_DEFAULT_PORT)}
                onChange={(e) => onPatch({ cockpitPort: e.target.value ? Number(e.target.value) : undefined })} />
            </Field>
          </div>
          <p className="mt-2 text-[11px] font-light leading-relaxed text-slate-500">
            Build Check deep-links into Cockpit Terminal at{' '}
            <span className="font-mono text-slate-700">
              https://{sys.host || '<host>'}:{sys.cockpitPort ?? COCKPIT_DEFAULT_PORT}/system/terminal
            </span>{' '}
            with the install commands pre-filled. These credentials are shown so you can paste them
            into Cockpit yourself — this app never logs in for you.
          </p>
        </Section>
      ) : null}

      <Section
        title="SSH"
        note={ownSshFields(sys).length === 0
          ? 'Empty means this system uses the lab default from the Credentials tab. Fill a field only to override it here.'
          : `Overriding the lab default: ${ownSshFields(sys).join(', ')}`}
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="User">
            <Input value={sys.username ?? ''} onChange={(e) => onPatch({ username: e.target.value })} />
          </Field>
          <Field label="Port" hint="default 22">
            <Input value={sys.sshPort?.toString() ?? ''}
              onChange={(e) => onPatch({ sshPort: e.target.value ? Number(e.target.value) : undefined })} />
          </Field>
          <Field label="Auth mode">
            <select value={authMode} onChange={(e) => onPatch({ authMode: e.target.value as 'password' | 'privateKey' })} className={SELECT_CLS}>
              <option value="password">Password</option>
              <option value="privateKey">Private key</option>
            </select>
          </Field>
          <Field label="sudo password" hint="unless NOPASSWD">
            <Input type="password" value={sys.sudoPassword ?? ''} onChange={(e) => onPatch({ sudoPassword: e.target.value })} />
          </Field>
          {authMode === 'password' ? (
            <Field label="Password" hint="local-lab convenience only">
              <Input type="password" value={sys.password ?? ''} onChange={(e) => onPatch({ password: e.target.value })} />
            </Field>
          ) : (
            <>
              <div className="sm:col-span-2 lg:col-span-4">
                <Field label="Private key" hint="paste contents, or a path on this host (~/.ssh/id_rsa)">
                  <textarea
                    value={sys.privateKey ?? ''}
                    onChange={(e) => onPatch({ privateKey: e.target.value })}
                    rows={4}
                    placeholder={'-----BEGIN OPENSSH PRIVATE KEY-----\n... or /home/user/.ssh/id_rsa'}
                    className="w-full rounded-lg border border-line-strong bg-surface px-3 py-2 font-mono text-xs text-slate-900 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/25"
                  />
                </Field>
              </div>
              <Field label="Key passphrase" hint="if encrypted">
                <Input type="password" value={sys.passphrase ?? ''} onChange={(e) => onPatch({ passphrase: e.target.value })} />
              </Field>
            </>
          )}
        </div>
      </Section>
    </div>
  );
}

// ───────────────────── Credentials tab ─────────────────────

/**
 * The shared SSH identity, set once for the whole lab.
 *
 * One key normally opens every box, so this is the default and each system
 * inherits it. A system can still override any single field from its own
 * Advanced → SSH panel; the merge in lib/inventory.ts is per-field, so a box
 * with a different username still inherits the shared key.
 */
function CredentialsTab({
  defaults, systems, onPatch, onClearOverride,
}: {
  defaults: SshDefaults;
  systems: InventorySystem[];
  onPatch: (p: Partial<SshDefaults>) => void;
  onClearOverride: (idx: number) => void;
}) {
  const authMode = defaults.authMode ?? 'privateKey';
  const overriding = systems
    .map((s, idx) => ({ s, idx, own: ownSshFields(s) }))
    .filter((x) => x.own.length > 0);
  const inheriting = systems.length - overriding.length;

  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-xl border border-line bg-surface">
        <div className="flex items-center gap-2 border-b border-line px-3 py-2">
          <span className="grid h-6 w-6 flex-none place-items-center rounded-md bg-primary-50 text-primary-700 ring-1 ring-inset ring-primary-500/25">
            <KeyRound className="h-3.5 w-3.5" />
          </span>
          <span className="text-sm font-medium text-slate-900">Lab SSH default</span>
          <span className="text-[11px] font-light text-slate-500">
            used by {inheriting} of {systems.length} system{systems.length === 1 ? '' : 's'}
          </span>
        </div>

        <div className="space-y-4 p-3">
          <Section title="Identity" note="applies to every system that does not set its own">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label="SSH user" hint="e.g. sysadmin">
                <Input
                  value={defaults.username ?? ''}
                  onChange={(e) => onPatch({ username: e.target.value || undefined })}
                  placeholder="sysadmin"
                />
              </Field>
              <Field label="SSH port" hint="default 22">
                <Input
                  value={defaults.sshPort?.toString() ?? ''}
                  onChange={(e) => onPatch({ sshPort: e.target.value ? Number(e.target.value) : undefined })}
                  placeholder="22"
                />
              </Field>
              <Field label="Auth mode">
                <select
                  value={authMode}
                  onChange={(e) => onPatch({ authMode: e.target.value as 'password' | 'privateKey' })}
                  className={SELECT_CLS}
                >
                  <option value="privateKey">Private key</option>
                  <option value="password">Password</option>
                </select>
              </Field>
            </div>
          </Section>

          <Section title={authMode === 'privateKey' ? 'Private key' : 'Password'}>
            {authMode === 'privateKey' ? (
              <div className="grid grid-cols-1 gap-3">
                <Field
                  label="Key"
                  hint="paste the key contents, or give a path to the key file on this host"
                >
                  <textarea
                    value={defaults.privateKey ?? ''}
                    onChange={(e) => onPatch({ privateKey: e.target.value || undefined })}
                    rows={5}
                    placeholder={'-----BEGIN OPENSSH PRIVATE KEY-----\n... or a path to the key file'}
                    className="w-full rounded-lg border border-line-strong bg-surface px-3 py-2 font-mono text-xs text-slate-900 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/25"
                  />
                </Field>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="Key passphrase" hint="only if the key is encrypted">
                    <Input
                      type="password"
                      value={defaults.passphrase ?? ''}
                      onChange={(e) => onPatch({ passphrase: e.target.value || undefined })}
                    />
                  </Field>
                  <Field label="sudo password" hint="unless the user has NOPASSWD">
                    <Input
                      type="password"
                      value={defaults.sudoPassword ?? ''}
                      onChange={(e) => onPatch({ sudoPassword: e.target.value || undefined })}
                    />
                  </Field>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="SSH password" hint="local-lab convenience only">
                  <Input
                    type="password"
                    value={defaults.password ?? ''}
                    onChange={(e) => onPatch({ password: e.target.value || undefined })}
                  />
                </Field>
                <Field label="sudo password" hint="falls back to the SSH password">
                  <Input
                    type="password"
                    value={defaults.sudoPassword ?? ''}
                    onChange={(e) => onPatch({ sudoPassword: e.target.value || undefined })}
                  />
                </Field>
              </div>
            )}
          </Section>
        </div>
      </div>

      {/* Who is NOT using the shared key, and a one-click way back. */}
      <div className="overflow-hidden rounded-xl border border-line bg-surface">
        <div className="border-b border-line px-3 py-2">
          <Kicker>Systems overriding the default</Kicker>
        </div>
        {overriding.length === 0 ? (
          <div className="p-4 text-[13px] text-slate-500">
            None — every system uses the lab default above.
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {overriding.map(({ s, idx, own }) => (
              <li key={idx} className="flex items-center gap-3 px-3 py-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-900">
                  {s.name || s.id}
                  <span className="ml-2 font-mono text-[11px] font-normal text-slate-500">{s.host}</span>
                </span>
                <span className="num hidden text-[10px] text-slate-500 sm:inline">{own.join(' ')}</span>
                <Button size="sm" variant="secondary" onClick={() => onClearOverride(idx)}>
                  Use lab default
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ───────────────────── Topology tab ─────────────────────

function TopologyTab({
  profiles, systems, onAdd, onPatch, onRemove,
}: {
  profiles: TopologyProfile[];
  systems: InventorySystem[];
  onAdd: () => void;
  onPatch: (idx: number, patch: Partial<TopologyProfile>) => void;
  onRemove: (idx: number) => void;
}) {
  if (profiles.length === 0) {
    return (
      <EmptyState
        icon={<Layers className="h-5 w-5 text-slate-400" />}
        title="No topologies yet"
        desc="A topology binds one UESIM-capable box to the rest of the chain — callbox, or separate eNB / gNB / MME / IMS / app server. Automation reads these to know where to push generated cfgs."
        action={<Button size="sm" onClick={onAdd}><Plus className="h-4 w-4" />Add topology</Button>}
      />
    );
  }
  return (
    <div className="space-y-3">
      {profiles.map((p, idx) => (
        <ProfileCard
          key={idx}
          profile={p}
          systems={systems}
          onPatch={(patch) => onPatch(idx, patch)}
          onRemove={() => onRemove(idx)}
        />
      ))}
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
  const issues = profileIssues(profile as any);
  const filled = ROLES.filter((r) => (profile as any)[r.key]).length;

  return (
    <div className="group overflow-hidden rounded-xl border border-line bg-surface">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="grid h-6 w-6 flex-none place-items-center rounded-md bg-slate-100 text-slate-600">
          <Layers className="h-3.5 w-3.5" />
        </span>
        <Input
          value={profile.name}
          onChange={(e) => onPatch({ name: e.target.value })}
          placeholder={profile.id}
          aria-label="Topology name"
          className="h-8 border-transparent bg-transparent px-1.5 font-medium hover:border-line-strong focus:bg-surface"
        />
        {issues.length === 0 ? (
          <span className="inline-flex flex-none items-center gap-1 rounded-md bg-emerald-50 px-2 py-1 text-[10px] font-semibold uppercase tracking-label text-emerald-700 ring-1 ring-inset ring-emerald-600/25">
            <Check className="h-3 w-3" />{filled} bound
          </span>
        ) : (
          <span
            className="inline-flex flex-none items-center gap-1 rounded-md bg-amber-50 px-2 py-1 text-[10px] font-semibold uppercase tracking-label text-amber-700 ring-1 ring-inset ring-amber-600/25"
            title={issues.join(' · ')}
          >
            <AlertTriangle className="h-3 w-3" />Incomplete
          </span>
        )}
        <button
          type="button"
          onClick={onRemove}
          className="rounded-md p-1.5 text-slate-400 opacity-0 transition-opacity hover:bg-red-50 hover:text-red-600 focus:opacity-100 group-hover:opacity-100"
          aria-label={`Remove ${profile.name || profile.id}`}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {issues.length ? (
        <div className="border-b border-line bg-amber-50 px-3 py-1.5 text-[11px] text-amber-800">
          {issues.join(' · ')}
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-2 p-3 sm:grid-cols-2 lg:grid-cols-4">
        {ROLES.map(({ key, label, icon: Icon, types, hint }) => {
          const candidates = systems.filter((s) => types.includes(s.type));
          const value = (profile as any)[key] as string | undefined;
          return (
            <label key={key} className="block">
              <span className="mb-1 flex items-center gap-1.5 text-xs font-medium text-slate-700">
                <Icon className="h-3.5 w-3.5 text-slate-400" />{label}
              </span>
              <select
                value={value ?? ''}
                onChange={(e) => onPatch({ [key]: e.target.value || undefined } as any)}
                className={SELECT_CLS}
                disabled={candidates.length === 0 && !value}
                title={hint}
              >
                <option value="">{candidates.length === 0 ? `no ${types.join(' / ')} registered` : '— none —'}</option>
                {candidates.map((s) => (
                  <option key={s.id} value={s.id}>{s.name || s.id} · {s.host}</option>
                ))}
              </select>
            </label>
          );
        })}
      </div>
    </div>
  );
}

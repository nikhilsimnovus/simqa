'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Header } from '@/components/Header';
import { Card, CardBody, CardHeader, CardTitle, Button, Input, Field, Badge } from '@/components/ui';
import {
  Plus, Trash2, Server, Radio, Cpu, Network, Globe, Database, ShieldCheck, Layers, ArrowLeft,
  Pencil, Check, X, ArrowRight, ChevronDown, ChevronRight,
} from 'lucide-react';
import Link from 'next/link';

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
  // Was missing here (present in the real shape in src/lib/inventory.ts) —
  // `uesim` was also wrongly required rather than optional. Neither error
  // surfaced before because every read/write went through `(profile as
  // any)[key]`, which bypasses the type checker entirely.
  simnovator?: string;
  uesim?: string;
  callbox?: string;
  enb?: string;
  gnb?: string;
  mme?: string;
  ims?: string;
  /** Set when this chain's role bindings were guessed positionally rather than
   *  chosen by a person. Shown as a badge; cleared on the first human edit. */
  autoLinked?: boolean;
  /** ISO timestamp of the last save. Absent on chains that predate this field —
   *  the card says "not recorded yet" for those rather than showing a
   *  made-up date. Stamped on creation and on every edit from here on. */
  updatedAt?: string;
  appserver?: string;
  notes?: string;
}

// Role catalogue for one topology setup. Same data model as before — the
// required flags and type lists are unchanged (still 8 roles, still Simnovator
// AND UESIM required — see the comments this used to carry, preserved below —
// only the presentation grew: an icon, a tone (for the colour-coded chips) and
// whether the role offers the "same as callbox" shortcut. eNB/gNB are new to
// having that shortcut; the old editor only had it on IMS/MME/App-server, but
// in this lab all four commonly live on the one callbox, so the pattern
// extends naturally.
interface TopologyRoleDef {
  key: 'simnovator' | 'uesim' | 'callbox' | 'enb' | 'gnb' | 'mme' | 'ims' | 'appserver';
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  types: readonly string[];
  required: boolean;
  shareable: boolean;
  tone: 'orange' | 'sky' | 'violet' | 'rose';
}

// The chain one topology setup describes: Simnovator → UESIM → Callbox → App
// server. That is the shape of this lab, and it mirrors the four system types
// offered in the Systems section above, so whatever you register there has a
// slot here.
//
// eNB / gNB / MME / IMS used to be separate roles. They are gone from the
// editor because on this bench the callbox IS all four — and the deploy step
// already knows that: runner.ts filesForTarget() pushes mme.cfg, ims.cfg,
// enb.cfg, gnb.cfg AND ue_db.cfg to any CALLBOX target, so binding the callbox
// covers every one of them. Splitting them out only ever mattered for a
// distributed lab with four separate machines.
//
// Any enb/gnb/mme/ims value already saved in inventory.yaml is preserved on
// edit (the draft spreads the whole existing profile), and runner.ts still
// reads them — they are simply not editable here any more.
const PROFILE_ROLES: readonly TopologyRoleDef[] = [
  // Simnovator FIRST and required: it is the only field that binds a setup to
  // a box. The dashboard finds "the UE / callbox / app server for THIS
  // Simnovator" by matching profile.simnovator, so a setup without it can
  // never be attached to anything — it silently shows "No topology setup for
  // this box". This role was missing from an earlier editor entirely, which is
  // exactly how profiles got saved in that unusable state.
  { key: 'simnovator', label: 'Simnovator', icon: ShieldCheck, types: ['SIMNOVATOR', 'SIMNOVATOR_GUI'],        required: true,  shareable: false, tone: 'orange'  },
  // The "uesim" role accepts any UESIM-capable box — Simnovator OR generic UESIM.
  { key: 'uesim',      label: 'UE',         icon: Cpu,        types: ['SIMNOVATOR', 'SIMNOVATOR_GUI', 'UESIM'], required: true,  shareable: false, tone: 'sky'     },
  { key: 'callbox',    label: 'Callbox',    icon: Server,     types: ['CALLBOX'],              required: false, shareable: false, tone: 'violet'  },
  // Kept shareable: an integrated bench can route the app server to the
  // callbox, while this lab points it at its own machine.
  { key: 'appserver',  label: 'App server', icon: Database,   types: ['APPSERVER', 'CALLBOX'],  required: false, shareable: true,  tone: 'rose'    },
] as const;

const TOPOLOGY_TONE_CLASSES: Record<TopologyRoleDef['tone'], { bg: string; text: string; ring: string; soft: string }> = {
  orange:  { bg: 'bg-orange-100',  text: 'text-orange-700',  ring: 'ring-orange-200',  soft: 'bg-orange-50' },
  sky:     { bg: 'bg-sky-100',     text: 'text-sky-700',     ring: 'ring-sky-200',     soft: 'bg-sky-50' },
  violet:  { bg: 'bg-violet-100',  text: 'text-violet-700',  ring: 'ring-violet-200',  soft: 'bg-violet-50' },
  rose:    { bg: 'bg-rose-100',    text: 'text-rose-700',    ring: 'ring-rose-200',    soft: 'bg-rose-50' },
};

// The four types this lab actually runs, and the four the Topology Setup chain
// below has slots for: Simnovator → UE → Callbox → App server.
//
// The standalone radio/core types (ENB, GNB, MME, IMS) are not offered — in
// this lab they all live on the callbox. "Cockpit" (the SIMNOVATOR type) is
// not offered either: it exists only as Build Check's install target, this lab
// has none registered, and every station here is a SIMNOVATOR_GUI. Offering it
// invited a choice that looked meaningful and wasn't.
//
// Existing entries of any unlisted type still render and keep their value —
// see typeOptions() below, which appends whatever the system already is.
const SYSTEM_TYPES = ['SIMNOVATOR_GUI', 'UESIM', 'CALLBOX', 'APPSERVER'];

/** Options for one card's Type select: the offered list, plus whatever this
 *  system already is, so an older ENB/MME entry never silently reads as blank. */
function typeOptions(current?: string): string[] {
  return current && !SYSTEM_TYPES.includes(current) ? [...SYSTEM_TYPES, current] : SYSTEM_TYPES;
}

const TYPE_META: Record<string, { icon: React.ComponentType<{ className?: string }>; ring: string; bg: string; text: string; label: string }> = {
  // SIMNOVATOR is the Build Check install target — surfaced as "Cockpit",
  // since that's the admin UI the install actually goes through.
  SIMNOVATOR:     { icon: ShieldCheck, ring: 'ring-orange-200', bg: 'bg-orange-50', text: 'text-orange-700', label: 'Cockpit' },
  SIMNOVATOR_GUI: { icon: ShieldCheck, ring: 'ring-amber-200',  bg: 'bg-amber-50',  text: 'text-amber-700',  label: 'Simnovator' },
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
  /** True when the dashboard sent us here (?from=dashboard). Read from the URL
   *  in an effect rather than via useSearchParams, which would force this page
   *  behind a Suspense boundary just to answer one boolean. */
  const [cameFromDashboard, setCameFromDashboard] = useState(false);
  /**
   * Everything in inventory.yaml that this page does NOT edit (currently
   * `suites`, written by the Generate + Push page).
   *
   * PUT /api/inventory is a full-document replace — saveInventory() writes
   * exactly what it is handed — so sending only { systems, profiles } deletes
   * every other top-level key. Holding the rest here and spreading it back on
   * save keeps this page from destroying data it never showed the user.
   */
  const [otherDoc, setOtherDoc] = useState<Record<string, unknown>>({});
  /** Serialized systems as last persisted, for the unsaved-changes indicator. */
  const [savedSystems, setSavedSystems] = useState<string>('[]');

  useEffect(() => {
    if (typeof window === 'undefined') return;
    setCameFromDashboard(new URLSearchParams(window.location.search).get('from') === 'dashboard');
  }, []);

  useEffect(() => {
    // no-store: the browser was serving a cached inventory, so a system added
    // in another tab (or on disk) did not appear and its chain was never
    // derived — the page looked broken when it was merely stale.
    fetch('/api/inventory', { cache: 'no-store' }).then((r) => r.json()).then((d) => {
      const { systems: sys, profiles: prof, ...rest } = d ?? {};
      setSystems(sys ?? []);
      setProfiles(prof ?? []);
      setOtherDoc(rest ?? {});
      // Baseline for the unsaved-changes indicator. Systems are edited locally
      // and only persisted on Save, so without this the button gives no signal
      // about whether there is anything to save.
      setSavedSystems(JSON.stringify(sys ?? []));
    }).finally(() => setLoading(false));
  }, []);

  // Honour #topology ourselves. The browser's own hash scrolling targets the
  // window, but the content column is the scroll container — so a plain anchor
  // link lands at the top of the page instead of the profiles section. Runs
  // after loading, since the systems list above it determines the offset.
  useEffect(() => {
    if (loading || typeof window === 'undefined') return;
    if (window.location.hash !== '#topology') return;
    const id = window.setTimeout(
      () => document.getElementById('topology')?.scrollIntoView({ block: 'start', behavior: 'smooth' }),
      50,
    );
    return () => window.clearTimeout(id);
  }, [loading, systems.length, profiles.length]);

  async function save() {
    setSaving(true); setMsg(null);
    try {
      const r = await fetch('/api/inventory', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...otherDoc, systems, profiles }),
      });
      const j = await r.json();
      if (!r.ok || j.error) throw new Error(j.error ?? `HTTP ${r.status}`);
      setSavedSystems(JSON.stringify(systems));
      setMsg('Saved');
      setTimeout(() => setMsg(null), 1500);
    } catch (e: any) {
      setMsg(`Error: ${e?.message ?? e}`);
    } finally {
      setSaving(false);
    }
  }

  function addSystem() {
    setSystems((s) => {
      // Was `sys-${s.length + 1}`, which collides: ids start at sys-2, so
      // length+1 undercounts by one and re-mints an id that already exists.
      // That is how CSI (192.168.1.94) ended up sharing sys-9 with the app
      // server at .124 — getSystem() returns the first match, so the CSI
      // bench's topology silently resolved to the wrong machine and Job
      // Tracker refused to install on it. Scan for a genuinely free id.
      const used = new Set(s.map((x) => x.id));
      let n = s.length + 1;
      while (used.has(`sys-${n}`)) n += 1;
      return [...s, { id: `sys-${n}`, type: 'SIMNOVATOR_GUI', name: '', host: '' }];
    });
  }
  function removeSystem(idx: number) {
    setSystems((s) => s.filter((_, i) => i !== idx));
  }
  function patchSystem(idx: number, patch: Partial<InventorySystem>) {
    setSystems((s) => s.map((x, i) => (i === idx ? { ...x, ...patch } : x)));
  }

  // Topology Setup used to share the page's addProfile/removeProfile/
  // patchProfile + one page-wide Save button, the same pattern the Systems
  // section still uses. It's now TopologySetupSection below, a self-contained
  // editor with its own draft/Save-per-card/Cancel flow that persists
  // immediately — see that component for why.

  /**
   * System ids used by more than one system.
   *
   * Every lookup in the app is `systems.find(s => s.id === id)` — first match
   * wins — so a collision does not error, it silently resolves to the wrong
   * machine. Topology bindings, the install command, and station history all
   * follow that wrong resolution. Surfacing it is the only way it gets noticed.
   */
  /** True when the Systems list differs from what was last persisted. */
  const dirty = useMemo(() => JSON.stringify(systems) !== savedSystems, [systems, savedSystems]);

  const duplicateIds = useMemo(() => {
    const seen = new Map<string, number>();
    for (const s of systems) seen.set(s.id, (seen.get(s.id) ?? 0) + 1);
    return [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id);
  }, [systems]);

  // Quick stats banner content
  const stats = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const s of systems) counts[s.type] = (counts[s.type] ?? 0) + 1;
    return {
      total: systems.length,
      simnovator: counts.SIMNOVATOR_GUI ?? 0,
      uesim: counts.UESIM ?? 0,
      callbox: counts.CALLBOX ?? 0,
      profiles: profiles.length,
    };
  }, [systems, profiles]);

  return (
    <>
      <Header
        title="Systems Management"
        subtitle="Systems and Topology Setup · click add system or any field to edit then Save"
        right={
          <div className="flex items-center gap-2">
            {msg ? (
              <span className={`text-xs ${msg.startsWith('Error') ? 'text-red-600' : 'text-emerald-600'}`}>{msg}</span>
            ) : dirty ? (
              <span className="text-xs text-amber-600">Unsaved changes</span>
            ) : null}
            {/* Only when we got here from the dashboard. Reached from the sidebar
                there is nothing to go "back" to, so no link is offered. */}
            {cameFromDashboard && (
              <Link href="/" className="inline-flex items-center gap-1 text-xs text-slate-600 hover:text-slate-900 hover:underline mr-1">
                <ArrowLeft className="h-3.5 w-3.5" /> Back to Dashboard
              </Link>
            )}
            <Button size="sm" variant="secondary" onClick={addSystem}><Plus className="h-4 w-4" />Add system</Button>
            {/* Blocked while ids collide — saving would persist a document in
                which lookups resolve to the wrong machine. */}
            <Button size="sm" onClick={save} disabled={saving || duplicateIds.length > 0 || !dirty}>
              {saving ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
            </Button>
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
            {duplicateIds.length > 0 ? (
              <div className="rounded-xl border border-red-300 bg-red-50 p-4 text-sm">
                <div className="font-semibold text-red-800">
                  Duplicate system {duplicateIds.length === 1 ? 'ID' : 'IDs'}: {duplicateIds.join(', ')}
                </div>
                <div className="mt-1 text-[12.5px] text-red-700 leading-relaxed">
                  Two systems share an ID. Every lookup takes the first match, so the topology
                  chain, install command and station history for the later one all resolve to the
                  wrong machine — without any error. Give each system a unique ID; Save is blocked
                  until they differ.
                </div>
              </div>
            ) : null}

            {/* Stats strip. No Cockpit tile: it counted SIMNOVATOR-typed
                systems specifically, which this lab has none of (both
                stations are registered as SIMNOVATOR_GUI) — the tile always
                read "Cockpit 0" and told nobody anything. Cockpit credentials
                are still editable per-system below when a system IS typed
                SIMNOVATOR; only the always-empty summary tile is gone. */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <StatCard icon={ShieldCheck} tone="orange" label="Simnovator"   value={stats.simnovator} />
              <StatCard icon={Cpu}         tone="sky"    label="UESIM"        value={stats.uesim} />
              <StatCard icon={Server}      tone="violet" label="Callboxes"    value={stats.callbox} />
              <StatCard icon={Layers}      tone="slate"  label="Topology Setups" value={stats.profiles} />
            </div>

            {/* SYSTEMS */}
            <section>
              <div className="flex items-end justify-between mb-3">
                <div>
                  <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-500">Systems</h2>
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

            {/* TOPOLOGY SETUP — id is the anchor the dashboard tile links to
                and what /end-to-end now redirects to. This used to be a
                second, separate page (Advanced → Topology Setups) with its
                own colour-coded role-chip cards and per-card Save/Cancel —
                consolidated here so there's one place to manage it, but kept
                its card design rather than the plainer always-editable grid
                this section had briefly used in between. */}
            <section id="topology" className="scroll-mt-20">
              <TopologySetupSection
                systems={systems}
                profiles={profiles}
                otherDoc={otherDoc}
                onProfilesChange={setProfiles}
              />
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

/**
 * A collapsible block inside a system card.
 *
 * Every field a system has is still here — the card used to render all of them
 * at once, which on a SIMNOVATOR meant four credential groups and ~14 inputs
 * competing with the four fields anyone actually scans for. Credentials start
 * folded, with a summary chip saying whether they are configured, so the card
 * reads at a glance and opens to the full form on demand.
 */
function CardSection({
  title, hint, summary, tone = 'slate', defaultOpen = false, children,
}: {
  title: string;
  hint?: string;
  /** Short "is this configured?" chip shown while collapsed. */
  summary?: { text: string; ok: boolean };
  tone?: 'slate' | 'orange';
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div className={`rounded-lg border ${tone === 'orange' ? 'border-orange-200 bg-orange-50/30' : 'border-slate-200 bg-slate-50/50'}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3.5 py-2.5 text-left hover:bg-slate-100/60 rounded-lg transition-colors"
        aria-expanded={open}
      >
        <Chevron className="h-4 w-4 shrink-0 text-slate-400" />
        <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-600">{title}</span>
        {hint ? <span className="text-[11px] text-slate-400 truncate hidden sm:inline">· {hint}</span> : null}
        {summary && !open ? (
          <span
            className={
              'ml-auto shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ' +
              (summary.ok ? 'bg-success-100 text-success-700' : 'bg-slate-200 text-slate-600')
            }
          >
            {summary.text}
          </span>
        ) : null}
      </button>
      {open ? <div className="px-3.5 pb-3.5 pt-0.5">{children}</div> : null}
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
  const isUesimLike = sys.type === 'SIMNOVATOR' || sys.type === 'SIMNOVATOR_GUI' || sys.type === 'UESIM';
  const hasApi = !!(sys.uesim?.username || sys.uesim?.password);
  const hasSsh = !!(sys.username && (sys.password || sys.privateKey));
  const hasCockpit = !!(sys.cockpitUser || sys.cockpitPassword || sys.cockpitPort);
  const dupWarn = !sys.id.trim() || !sys.host.trim();

  return (
    <div className="group relative rounded-xl border border-slate-200 bg-white shadow-sm transition-shadow hover:shadow-md flex flex-col">
      {/* Top accent stripe — orange for Simnovator install targets */}
      {sys.type === 'SIMNOVATOR' ? (
        <div className="absolute top-0 left-0 right-0 h-1 rounded-t-xl bg-gradient-to-r from-orange-500 via-orange-400 to-amber-300" />
      ) : null}

      {/* ── Identity header: the four things anyone scans for ───────────── */}
      <div className="px-5 pt-5 pb-4 border-b border-slate-100">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div className="min-w-0 flex-1 flex items-center gap-2 flex-wrap">
            <TypeChip type={sys.type} />
            <span className="text-base font-semibold text-slate-900 truncate">{sys.name || sys.id}</span>
            {sys.host ? <span className="text-xs font-mono text-slate-500">{sys.host}</span> : null}
            {dupWarn ? (
              <span className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-amber-100 text-amber-800">
                incomplete
              </span>
            ) : null}
          </div>
          <button
            onClick={onRemove}
            className="shrink-0 opacity-50 group-hover:opacity-100 transition-opacity rounded-md p-1.5 text-slate-500 hover:bg-red-50 hover:text-red-600"
            aria-label="Remove"
          ><Trash2 className="h-4 w-4" /></button>
        </div>

        {/* Two balanced columns rather than four cramped ones — each field
            keeps a full-width input at every breakpoint the card is used in. */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
          <Field label="ID"><Input value={sys.id} onChange={(e) => onPatch({ id: e.target.value })} /></Field>
          <Field label="Name"><Input value={sys.name} onChange={(e) => onPatch({ name: e.target.value })} /></Field>
          <Field label="Type">
            <select
              value={sys.type}
              onChange={(e) => onPatch({ type: e.target.value })}
              className={SELECT_CLS}
            >
              {typeOptions(sys.type).map((t) => (
                <option key={t} value={t}>{TYPE_META[t]?.label ?? t}</option>
              ))}
            </select>
          </Field>
          <Field label="IP address">
            <Input value={sys.host} onChange={(e) => onPatch({ host: e.target.value })} placeholder="192.168.1.95" />
          </Field>
        </div>
      </div>

      {/* ── Everything else, folded away by default ─────────────────────── */}
      <div className="p-4 space-y-2.5">
        {/* UESIM REST API — SIMNOVATOR + UESIM types only */}
        {isUesimLike ? (
          <CardSection
            title="REST API"
            hint="how SimQA talks to this box"
            summary={{ text: hasApi ? 'configured' : 'defaults', ok: hasApi }}
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
              <Field label="API user">
                <Input value={sys.uesim?.username ?? ''} onChange={(e) => onPatch({ uesim: { ...(sys.uesim ?? {}), username: e.target.value } })} placeholder="admin" />
              </Field>
              <Field label="API password">
                <Input type="password" value={sys.uesim?.password ?? ''} onChange={(e) => onPatch({ uesim: { ...(sys.uesim ?? {}), password: e.target.value } })} placeholder="••••" />
              </Field>
            </div>
          </CardSection>
        ) : null}

        {/* Cockpit — SIMNOVATOR only */}
        {sys.type === 'SIMNOVATOR' ? (
          <CardSection
            title="Cockpit"
            hint="web admin UI · install target"
            tone="orange"
            summary={{ text: hasCockpit ? 'configured' : 'defaults', ok: hasCockpit }}
          >
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-x-4 gap-y-3">
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
          </CardSection>
        ) : null}

        {/* SSH — always available. For non-Simnovator/UESIM types (Callbox,
            App-server, …) it's the primary access surface; for UESIM +
            SIMNOVATOR it's optional but unlocks the cfg patcher, config-
            fidelity ue.cfg pull, gNB/MME cfg backup and container health.
            Starts folded either way — every card should read the same way
            at a glance, with the "primary" vs "optional" hint text (not a
            different starting state) carrying that distinction. */}
        <CardSection
          title="SSH credentials"
          hint={isUesimLike ? 'optional — cfg patcher, ue.cfg pull, gNB backup' : 'primary access for this system'}
          summary={{ text: hasSsh ? 'configured' : 'not set', ok: hasSsh }}
        >
          <SshCredentialsBlock sys={sys} onPatch={onPatch} />
        </CardSection>
      </div>
    </div>
  );
}

function SshCredentialsBlock({
  sys, onPatch,
}: { sys: InventorySystem; onPatch: (p: Partial<InventorySystem>) => void }) {
  const authMode = sys.authMode ?? 'password';
  return (
    // Two columns to match the identity grid above, so labels and inputs line
    // up down the whole card instead of switching rhythm partway.
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
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
          <div className="sm:col-span-2">
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

// ───────────────────── Topology Setup ─────────────────────
//
// A self-contained editor: its own draft/editingId/saving/msg state, and its
// own persistence. Each Save/Delete is an immediate PUT to /api/inventory
// (carrying the current `systems` array along, same as the Systems section's
// data model — one inventory.yaml document, both sections write to it) rather
// than waiting for a page-wide Save click. That was the previous, separate
// page's actual behaviour, kept here rather than folded into the Systems
// section's "edit locally, Save once for everything" pattern, since a single
// obviously-wrong topology edit shouldn't have to wait behind whatever else
// is mid-edit in a System card, and vice versa.

function lookupSystem(systems: InventorySystem[], id?: string): InventorySystem | undefined {
  if (!id) return undefined;
  return systems.find((s) => s.id === id);
}

/**
 * Derive the topology chains from the registered systems.
 *
 * One setup per Simnovator, with the other roles paired by position: the Nth
 * Simnovator gets the Nth UE, the Nth callbox and the Nth app server, each in
 * inventory order. On this bench that reproduces the hand-made bindings
 * exactly (.102 → .101/.106/.100 and .95 → .121/.122/.124).
 *
 * It is a heuristic, not a fact — with uneven counts, or a machine inserted in
 * the middle, position is only a guess. So it is applied ONLY to fill gaps:
 * an existing setup keeps every binding it already has, and each role is
 * editable. Nothing already chosen is ever overwritten by the guess.
 */
function deriveProfiles(systems: InventorySystem[], existing: TopologyProfile[]): TopologyProfile[] {
  const isSimnovator = (s: InventorySystem) => s.type === 'SIMNOVATOR' || s.type === 'SIMNOVATOR_GUI';
  const simnovators = systems.filter(isSimnovator);
  // Only DEDICATED UE boxes are positionally paired. Concatenating the
  // Simnovators onto this list (to express "a Simnovator can be its own UE")
  // was wrong: index N could then land on a DIFFERENT Simnovator, binding
  // bench 3's UE slot to bench 1's station. The integrated-install case is
  // handled by falling back to the SAME Simnovator below, never another one.
  const dedicatedUes = systems.filter((s) => s.type === 'UESIM');
  const callboxes = systems.filter((s) => s.type === 'CALLBOX');
  const appservers = systems.filter((s) => s.type === 'APPSERVER');

  const out: TopologyProfile[] = [];
  const claimed = new Set<string>();
  simnovators.forEach((sim, i) => {
    // No dedicated UE for this position → integrated install, where the
    // Simnovator IS the UE. Same rule setups.ts already applies. Never another
    // Simnovator: binding bench 3's UE slot to bench 1's station would send
    // the installer's --ue at the wrong machine.
    const ueForThisBench = dedicatedUes[i]?.id ?? sim.id;
    const prior = existing.find((p) => p.simnovator === sim.id);
    if (prior) {
      claimed.add(prior.id);
      // Keep the record as-is, only filling roles that were never set. This is
      // what protects a corrected pairing from being reverted by the guess on
      // the next load.
      const filled: TopologyProfile = {
        ...prior,
        uesim: prior.uesim ?? ueForThisBench,
        callbox: prior.callbox ?? callboxes[i]?.id,
        appserver: prior.appserver ?? appservers[i]?.id,
      };
      out.push(filled);
      return;
    }
    out.push({
      id: `topo-${sim.id}`,
      name: sim.name || sim.host || `Topology ${i + 1}`,
      simnovator: sim.id,
      uesim: ueForThisBench,
      callbox: callboxes[i]?.id,
      appserver: appservers[i]?.id,
      updatedAt: new Date().toISOString(),
      // Positional pairing is a guess. Flagged so the card can say so, because
      // these bindings become the installer's --ue / --app: a wrong-but-
      // plausible pair installs a build onto the wrong lab machines silently.
      // Cleared the moment a human edits and saves the chain.
      autoLinked: true,
    });
  });

  // Anything that did not correspond to a live Simnovator is KEPT, not
  // dropped. Deleting a chain here would be silent and unrecoverable, and
  // runner.ts treats a missing topology as "deploy skipped — ok", so a run
  // would report passed having deployed nothing.
  for (const p of existing) if (!claimed.has(p.id)) out.push(p);
  return out;
}

/** Same set of chains, ignoring key order — used to avoid a pointless PUT. */
function sameProfiles(a: TopologyProfile[], b: TopologyProfile[]): boolean {
  if (a.length !== b.length) return false;
  const norm = (p: TopologyProfile) => JSON.stringify(Object.entries(p).filter(([, v]) => v !== undefined).sort());
  const as = a.map(norm).sort();
  const bs = b.map(norm).sort();
  return as.every((x, i) => x === bs[i]);
}

function TopologySetupSection({
  systems, profiles, otherDoc, onProfilesChange,
}: {
  systems: InventorySystem[];
  profiles: TopologyProfile[];
  otherDoc: Record<string, unknown>;
  onProfilesChange: (next: TopologyProfile[]) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<TopologyProfile | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const syncedRef = useRef(false);

  const flash = (kind: 'ok' | 'err', text: string) => {
    setMsg({ kind, text });
    setTimeout(() => setMsg(null), 2600);
  };

  async function persist(nextProfiles: TopologyProfile[]): Promise<boolean> {
    setSaving(true);
    try {
      const r = await fetch('/api/inventory', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        // otherDoc carries every top-level key this page does not edit. PUT is
        // a full replace, so omitting it would delete that data.
        body: JSON.stringify({ ...otherDoc, systems, profiles: nextProfiles }),
      });
      const j = await r.json();
      if (!r.ok || j.error) throw new Error(j.error ?? `HTTP ${r.status}`);
      onProfilesChange(nextProfiles);
      return true;
    } catch (e: any) {
      flash('err', `Save failed: ${e?.message ?? e}`);
      return false;
    } finally {
      setSaving(false);
    }
  }

  // Bring the chains in line with the registered systems, once, after load.
  //
  // Gated on syncedRef so it cannot loop: persist() updates `profiles`, which
  // re-runs this effect. Gated on `systems.length` so it does not fire against
  // the empty pre-fetch state and wipe every setup.
  useEffect(() => {
    if (syncedRef.current || systems.length === 0) return;
    const derived = deriveProfiles(systems, profiles);
    if (sameProfiles(derived, profiles)) { syncedRef.current = true; return; }
    syncedRef.current = true;
    const added = derived.length - profiles.length;
    persist(derived).then((ok) => {
      if (ok) {
        flash('ok', added > 0
          ? `Linked ${added} new setup${added === 1 ? '' : 's'} from your systems`
          : 'Chains updated from your systems');
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [systems, profiles]);

  function startEdit(p: TopologyProfile) {
    setDraft({ ...p });
    setEditingId(p.id);
  }

  function cancelEdit() {
    setDraft(null);
    setEditingId(null);
  }

  async function saveDraft() {
    if (!draft) return;
    if (!draft.simnovator) { flash('err', 'Pick a Simnovator system'); return; }
    if (!draft.uesim) { flash('err', 'Pick a UE system'); return; }
    if (!draft.name?.trim()) { flash('err', 'Give the setup a name'); return; }

    // A human has now chosen these bindings, so the "auto-linked" caveat no
    // longer applies.
    const confirmed: TopologyProfile = {
      ...draft, autoLinked: undefined, updatedAt: new Date().toISOString(),
    };
    const ok = await persist(profiles.map((p) => (p.id === draft.id ? confirmed : p)));
    if (ok) {
      flash('ok', 'Setup updated');
      cancelEdit();
    }
  }

  return (
    <>
      <div className="flex items-end justify-between mb-3">
        <div>
          <h2 className="text-base font-bold uppercase tracking-wide text-slate-800">Topology Setup</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            The systems you register are linked together, so the Dashboard and Test Runners know
            which machines belong to the same test bench.
          </p>
        </div>
        {/* No "New setup" button: a chain exists for each Simnovator you
            register, created automatically. Editing a chain is still possible —
            the automatic pairing is positional and can guess wrong. */}
        {msg ? <span className={`text-xs shrink-0 ${msg.kind === 'err' ? 'text-red-600' : 'text-emerald-600'}`}>{msg.text}</span> : null}
      </div>

      {profiles.length === 0 ? (
        <EmptyCard
          icon={<Layers className="h-5 w-5 text-slate-400" />}
          title="No test benches yet"
          desc="Register a Simnovator in the Systems section above and its chain appears here automatically — UE, callbox and app server linked in."
        />
      ) : (
        <div className="grid grid-cols-1 gap-4">
          {profiles.map((p) =>
            editingId === p.id && draft ? (
              <SetupForm
                key={p.id}
                draft={draft}
                systems={systems}
                onChange={setDraft}
                onCancel={cancelEdit}
                onSave={saveDraft}
                saving={saving}
              />
            ) : (
              <SetupCard
                key={p.id}
                setup={p}
                systems={systems}
                onEdit={() => startEdit(p)}
                busy={saving}
              />
            ),
          )}
        </div>
      )}
    </>
  );
}

// ───── card view ─────

function SetupCard({
  setup, systems, onEdit, busy,
}: {
  setup: TopologyProfile;
  systems: InventorySystem[];
  onEdit: () => void;
  busy: boolean;
}) {
  const callboxId = setup.callbox;
  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm transition-shadow hover:shadow-md overflow-hidden">
      <div className="p-5">
        <div className="flex items-start justify-between gap-3 mb-5">
          <div className="min-w-0 flex items-center gap-3 flex-wrap">
            <span className="inline-flex items-center gap-1.5 rounded-md bg-indigo-50 text-indigo-700 ring-1 ring-indigo-100 px-2.5 py-1 text-[10px] uppercase tracking-wider font-semibold">
              <Layers className="h-3.5 w-3.5" /> Setup
            </span>
            <span className="text-lg font-bold text-slate-900 truncate">{setup.name || setup.id}</span>
            <span className="text-slate-300" aria-hidden>|</span>
            <span className="text-xs text-slate-500 font-mono">ID: {setup.id}</span>
            {setup.autoLinked ? (
              <span
                className="inline-flex items-center rounded-md bg-amber-100 text-amber-800 ring-1 ring-amber-200 px-2 py-0.5 text-[10px] uppercase tracking-wider font-medium"
                title="These machines were paired automatically by position, which is a guess. Check them before running a build install against this bench — the UE and app server become the installer's --ue and --app."
              >
                auto-linked · check
              </span>
            ) : null}
          </div>
          {/* Edit only — no delete. A chain belongs to a Simnovator; remove the
              Simnovator in the Systems section and its chain goes with it. A
              delete button here would just be undone by the next auto-sync. */}
          <button
            onClick={onEdit}
            disabled={busy}
            className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 h-9 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40"
          >
            <Pencil className="h-4 w-4" /> Edit
          </button>
        </div>

        <div className="flex flex-wrap items-stretch gap-y-3">
          {PROFILE_ROLES.map((role, idx) => {
            const refId = (setup as any)[role.key] as string | undefined;
            const isShared = role.shareable && !!callboxId && refId === callboxId;
            const sys = lookupSystem(systems, refId);
            return (
              <div key={role.key} className="flex items-center">
                <RoleChip role={role} system={sys} shared={isShared} missing={role.required && !sys} />
                {idx < PROFILE_ROLES.length - 1 ? (
                  <ArrowRight className="h-5 w-5 text-slate-300 mx-3 shrink-0" />
                ) : null}
              </div>
            );
          })}
        </div>
      </div>

      {/* When this chain was last written. Absent on chains that predate the
          field — said plainly rather than shown as a plausible-looking date. */}
      <div className="border-t border-slate-100 bg-slate-50/60 px-5 py-2.5 text-xs text-slate-500">
        Last Updated:{' '}
        {setup.updatedAt
          ? <span className="text-slate-700">{formatUpdated(setup.updatedAt)}</span>
          : <span className="italic text-slate-400">not recorded yet</span>}
      </div>
    </div>
  );
}

/** "May 15, 2024 10:24 AM" — no comma before the time, matching the design. */
function formatUpdated(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'not recorded yet';
  const date = d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
  return `${date} ${time}`;
}

function RoleChip({
  role, system, shared, missing,
}: {
  role: TopologyRoleDef;
  system?: InventorySystem;
  shared?: boolean;
  missing?: boolean;
}) {
  const Icon = role.icon;
  const t = TOPOLOGY_TONE_CLASSES[role.tone];
  const BOX = 'rounded-xl border px-4 py-3 min-w-[190px]';

  if (missing) {
    return (
      <div className={`${BOX} border-dashed border-red-300 bg-red-50/70`}>
        <div className="flex items-center gap-1.5 text-red-700 text-sm font-semibold">
          <Icon className="h-4 w-4" />{role.label}
        </div>
        <div className="text-red-600 text-xs mt-1.5 font-medium">missing</div>
      </div>
    );
  }
  if (!system) {
    return (
      <div className={`${BOX} border-slate-200 bg-slate-50`}>
        <div className="flex items-center gap-1.5 text-slate-500 text-sm font-semibold">
          <Icon className="h-4 w-4" />{role.label}
        </div>
        <div className="text-slate-400 text-xs mt-1.5">— not set —</div>
      </div>
    );
  }
  return (
    <div className={`${BOX} ${t.ring.replace('ring-', 'border-')} ${t.soft}`}>
      <div className={`flex items-center gap-1.5 ${t.text} text-sm font-semibold`}>
        <Icon className="h-4 w-4" />
        {role.label}
        {shared ? <span className="ml-1 text-[9px] uppercase tracking-wider opacity-75">↪ shared</span> : null}
      </div>
      <div className="text-[15px] text-slate-900 font-semibold leading-tight mt-1.5 truncate max-w-[16rem]">
        {system.name || system.id}
      </div>
      <div className="text-xs text-slate-500 font-mono mt-0.5">{system.host}</div>
    </div>
  );
}

// ───── form view ─────

function SetupForm({
  draft, systems, onChange, onCancel, onSave, saving, isNew,
}: {
  draft: TopologyProfile;
  systems: InventorySystem[];
  onChange: (d: TopologyProfile) => void;
  onCancel: () => void;
  onSave: () => void;
  saving: boolean;
  isNew?: boolean;
}) {
  const patch = (p: Partial<TopologyProfile>) => onChange({ ...draft, ...p });
  const callboxId = draft.callbox;
  const callbox = lookupSystem(systems, callboxId);

  return (
    <div className="rounded-xl border border-orange-200 bg-white shadow-sm">
      <div className="border-b border-slate-100 bg-orange-50/50 px-5 py-3 rounded-t-xl flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm">
          <Layers className="h-4 w-4 text-orange-600" />
          <span className="font-medium text-slate-900">{isNew ? 'New Topology Setup' : `Edit: ${draft.name || draft.id}`}</span>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" onClick={onCancel} disabled={saving}><X className="h-4 w-4" /> Cancel</Button>
          <Button size="sm" onClick={onSave} disabled={saving}><Check className="h-4 w-4" /> {saving ? 'Saving…' : 'Save setup'}</Button>
        </div>
      </div>

      <div className="p-5 space-y-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Name *"><Input value={draft.name} onChange={(e) => patch({ name: e.target.value })} placeholder="Topology 1" /></Field>
          <Field label="ID" hint="auto-generated; only change if you know what you're doing">
            <Input value={draft.id} onChange={(e) => patch({ id: e.target.value })} />
          </Field>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {PROFILE_ROLES.map((role) => (
            <RoleSelector key={role.key} role={role} draft={draft} systems={systems} callbox={callbox} onChange={(value) => patch({ [role.key]: value } as any)} />
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
  role: TopologyRoleDef;
  draft: TopologyProfile;
  systems: InventorySystem[];
  callbox?: InventorySystem;
  onChange: (val?: string) => void;
}) {
  const Icon = role.icon;
  const t = TOPOLOGY_TONE_CLASSES[role.tone];
  const candidates = systems.filter((s) => (role.types as readonly string[]).includes(s.type));
  const value = (draft as any)[role.key] as string | undefined;
  const usingCallbox = role.shareable && !!callbox && value === callbox.id;
  const setUsingCallbox = (yes: boolean) => onChange(yes ? callbox?.id : undefined);

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 transition-colors">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className={`flex h-7 w-7 items-center justify-center rounded-md ${t.bg} ${t.text}`}><Icon className="h-4 w-4" /></span>
          <span className="text-sm font-semibold text-slate-900">{role.label}</span>
          {role.required ? <span className="text-[10px] uppercase tracking-wider text-red-500 font-medium">required</span> : null}
        </div>
        {role.shareable && callbox ? (
          <label className="flex items-center gap-1.5 text-[11px] text-slate-600 cursor-pointer">
            <input type="checkbox" checked={usingCallbox} onChange={(e) => setUsingCallbox(e.target.checked)} />
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
          {candidates.map((s) => <option key={s.id} value={s.id}>{(s.name || s.id) + ' · ' + s.host}</option>)}
        </select>
      )}

      {candidates.length === 0 ? (
        <div className="mt-2 text-[11px] text-slate-500">
          No <span className="font-mono">{role.types.join(' / ')}</span> systems in inventory.
        </div>
      ) : null}
    </div>
  );
}

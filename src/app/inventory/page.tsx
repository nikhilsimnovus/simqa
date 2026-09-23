'use client';

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Header } from '@/components/Header';
import { BackToDashboard } from '@/components/BackToDashboard';
import { Card, CardBody, CardHeader, CardTitle, Button, Input, PasswordInput, Field, Badge } from '@/components/ui';
import {
  Plus, Trash2, Server, Radio, Cpu, Network, Globe, Database, ShieldCheck, Layers,
  Pencil, Check, X, ArrowRight, ChevronDown, ChevronRight, Search } from 'lucide-react';

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
  /** Box logins this setup offers, so different people execute as themselves.
   *  Mirrors BoxUser in lib/inventory.ts. */
  uesimUsers?: Array<{ id: string; username: string; password: string; label?: string }>;
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

/**
 * Does this setup have a box login at all?
 *
 * Only the Simnovator serves the REST API that executions authenticate
 * against. A UE, callbox or app server is never logged into with a box
 * account — SimQA only shells into those — so offering a username and
 * password beside their IP collects credentials nothing would ever use, and
 * makes the "no credentials yet" warning fire on setups that need none.
 *
 * A setup registered before this rule keeps the block if it already carries
 * a login, so existing credentials stay editable instead of being stranded
 * in the file with no field that reaches them.
 */
function wantsBoxLogin(sys: InventorySystem): boolean {
  if (sys.type === 'SIMNOVATOR_GUI' || sys.type === 'SIMNOVATOR') return true;
  return !!(sys.uesim?.username || sys.uesim?.password || (sys.uesimUsers ?? []).length);
}

/** True once a box-login setup names at least one account it can execute as. */
function hasCreds(sys: InventorySystem): boolean {
  return !!(sys.uesimUsers ?? []).some((u) => u.username.trim()) || !!sys.uesim?.username;
}

/**
 * A system has no name.
 *
 * One used to be generated from type + last IP octet — "Simnovator-95",
 * "Callbox-107" — which only repeated the two things already on screen, and
 * then followed the system into every picker, message and topology setup. The
 * IP identifies the machine; that is what is shown everywhere now.
 *
 * A name generated by the old rule is cleared when the system is next saved,
 * so the file stops carrying it too. A name somebody typed themselves (say
 * "CSI") is not touched — it was never this function's to remove.
 */
function looksGenerated(name: string | undefined, type?: string, host?: string): boolean {
  if (!name) return true;
  const label = TYPE_META[type ?? '']?.label ?? 'System';
  const octet = String(host ?? '').split('.').filter(Boolean).pop();
  return name === label || (!!octet && name === `${label}-${octet}`);
}

/** A patch that also drops a generated name, leaving a hand-typed one alone. */
function withAutoName(sys: InventorySystem, patch: Partial<InventorySystem>): Partial<InventorySystem> {
  return looksGenerated(sys.name, sys.type, sys.host) ? { ...patch, name: '' } : patch;
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
  // A system added but not yet given a type. Its own entry, not the UESIM
  // fallback below, so an untyped row never reads as a real type.
  '':         { icon: Server,      ring: 'ring-red-200',    bg: 'bg-red-50',      text: 'text-red-700',      label: 'No type' },
};

/**
 * Does this topology still have the machine it exists for?
 *
 * A topology is a bench built AROUND a Simnovator (or, on older labs, a
 * UESIM) — the id, the name and every run resolve through it. The callbox and
 * app server hang off it and are often shared: one app server at .100 was
 * bound into four benches. So "keep it while any system survives" left a bench
 * alive after its Simnovator was deleted, held up only by a shared app server
 * it merely pointed at — a card that can never run anything, which is exactly
 * what deleting the Simnovator was meant to remove.
 *
 * The runner applies the same test (topology.ts refuses a profile with neither
 * a simnovator nor a uesim), so this only removes benches it would reject.
 */
function hasAnchor(p: TopologyProfile, liveIds: Set<string>): boolean {
  return [p.simnovator, p.uesim].some((id) => !!id && liveIds.has(id));
}

/** Every topology field that holds a system id. */
const PROFILE_REF_KEYS = ['simnovator', 'uesim', 'callbox', 'appserver', 'enb', 'gnb', 'mme', 'ims'] as const;

/**
 * Old id -> new id for systems whose ID was edited, matched by IP address.
 *
 * Topologies refer to systems by id, so a rename used to leave every chain
 * pointing at an id that no longer exists. Matched only when exactly one NEW
 * id carries the old host; a box whose id AND address both changed is not
 * guessed at — the topology editor shows that reference as not registered.
 */
function idRenames(before: InventorySystem[], after: InventorySystem[]): Map<string, string> {
  const afterIds = new Set(after.map((s) => s.id));
  const beforeIds = new Set(before.map((s) => s.id));
  const out = new Map<string, string>();
  for (const old of before) {
    if (afterIds.has(old.id) || !old.host) continue;
    const matches = after.filter((s) => s.host === old.host && !beforeIds.has(s.id));
    if (matches.length === 1) out.set(old.id, matches[0].id);
  }
  return out;
}

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
  'h-9 w-full rounded-md border border-slate-300 bg-surface px-3 text-sm text-slate-900 ' +
  'focus:outline-none focus:ring-2 focus:ring-primary-300 focus:border-primary-400';

export default function InventoryPage() {
  /** Systems and Topology were stacked sections, so Topology lived a long
   *  scroll below a grid of system cards — findable only if you knew it was
   *  there. Tabs put both one click away and keep the page a screenful.
   *  The #topology anchor (dashboard tile, /end-to-end redirect) still works:
   *  the effect below opens the tab instead of scrolling to it. */
  const [tab, setTab] = useState<'systems' | 'topology'>('systems');
  const [systems, setSystems]   = useState<InventorySystem[]>([]);
  /** Filters over the systems list, and which row is expanded for editing.
   *  Only one row edits at a time — twelve open editors is the layout this
   *  replaced. */
  const [sysQuery, setSysQuery] = useState('');
  const [sysType, setSysType]   = useState('');
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [profiles, setProfiles] = useState<TopologyProfile[]>([]);
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [msg, setMsg]           = useState<string | null>(null);
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
    // #topology used to scroll to a section further down the page. Now that
    // Topology is a tab, the anchor has to OPEN it — otherwise the dashboard
    // tile and the /end-to-end redirect both land on Systems with nothing to
    // show for the fragment.
    if (window.location.hash === '#topology') setTab('topology');
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
      // Carry renamed system ids into the topologies that reference them.
      let savedBefore: InventorySystem[] = [];
      try { savedBefore = JSON.parse(savedSystems); } catch { /* baseline unreadable — no cascade */ }
      const renames = idRenames(savedBefore, systems);
      const nextProfiles = renames.size === 0 ? profiles : profiles.map((p) => {
        const q: Record<string, unknown> = { ...p };
        for (const k of PROFILE_REF_KEYS) {
          const v = q[k];
          if (typeof v === 'string' && renames.has(v)) q[k] = renames.get(v);
        }
        return q as unknown as TopologyProfile;
      });
      // Carry REMOVALS into the topologies too. Clearing the systems list
      // alone left every topology still naming the deleted box: the role
      // looked filled, resolved to nothing at run time, and the only hint was
      // a run failing later. A reference to a system that no longer exists is
      // not a binding, so it is dropped here rather than kept as a ghost.
      const liveIds = new Set(systems.map((x) => x.id));
      let clearedRefs = 0;
      let droppedProfiles = 0;
      const cascaded = nextProfiles
        .map((prof) => {
          const q: Record<string, unknown> = { ...prof };
          for (const k of PROFILE_REF_KEYS) {
            const v = q[k];
            if (typeof v === 'string' && v && !liveIds.has(v)) { delete q[k]; clearedRefs += 1; }
          }
          return q as unknown as TopologyProfile;
        })
        // A bench whose Simnovator (and UESIM) are gone is removed with them,
        // even if a shared callbox or app server is still bound into it — see
        // hasAnchor. Its remaining links are to machines other benches use.
        .filter((prof) => {
          if (!hasAnchor(prof, liveIds)) { droppedProfiles += 1; return false; }
          return true;
        });

      const r = await fetch('/api/inventory', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...otherDoc, systems, profiles: cascaded }),
      });
      const j = await r.json();
      if (!r.ok || j.error) throw new Error(j.error ?? `HTTP ${r.status}`);
      setSavedSystems(JSON.stringify(systems));
      setProfiles(cascaded);
      // Collapse the open row. Add system opens an editor to type the details
      // into; once those details are saved the form has done its job, and
      // leaving it expanded reads as "not saved yet".
      setEditingIdx(null);
      const notes: string[] = [];
      if (renames.size) notes.push(`${renames.size} renamed ID${renames.size === 1 ? '' : 's'} carried into topologies`);
      if (clearedRefs) notes.push(`${clearedRefs} topology reference${clearedRefs === 1 ? '' : 's'} to removed systems cleared`);
      if (droppedProfiles) notes.push(`${droppedProfiles} empty topolog${droppedProfiles === 1 ? 'y' : 'ies'} removed`);
      setMsg(notes.length ? `Saved — ${notes.join(', ')}` : 'Saved');
      setTimeout(() => setMsg(null), notes.length ? 5000 : 1500);
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
      // Open the new row straight away — Add system exists to enter details,
      // and a blank row appended silently under an active filter is easy to
      // miss entirely. Clearing the filters guarantees it is on screen.
      setEditingIdx(s.length);
      setSysQuery('');
      setSysType('');
      setTab('systems');
      // No default type. It used to start as SIMNOVATOR_GUI, so a box saved
      // without touching Type silently became a Simnovator — and got a bench
      // of its own from the auto-sync. That is how the app server at .124 was
      // registered as a Simnovator and never appeared in the App server picker.
      // Save is blocked until a type is chosen (see `untyped`).
      return [...s, { id: `sys-${n}`, type: '', name: '', host: '' }];
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

  /** Systems with no type chosen yet — Save waits for them. */
  const untyped = useMemo(() => systems.filter((s) => !s.type), [systems]);

  /** Filtered rows, each carrying its index in the UNFILTERED array — every
   *  handler addresses systems by position, so filtering must not renumber
   *  them or Edit would patch the wrong box. */
  const visibleSystems = useMemo(() => {
    const q = sysQuery.trim().toLowerCase();
    return systems
      .map((sys, idx) => ({ sys, idx }))
      .filter(({ sys }) => {
        if (sysType && sys.type !== sysType) return false;
        if (!q) return true;
        return `${sys.name ?? ''} ${sys.host ?? ''} ${sys.id ?? ''}`.toLowerCase().includes(q);
      });
  }, [systems, sysQuery, sysType]);

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
        subtitle="Systems and Topology Setup · Add system to register a box, Edit to change one, then Save"
        right={
          <div className="flex items-center gap-2">
            {msg ? (
              <span className={`text-xs ${msg.startsWith('Error') ? 'text-red-600' : 'text-emerald-600'}`}>{msg}</span>
            ) : untyped.length ? (
              <span className="text-xs text-red-600">
                Choose a type for {untyped.map((s) => s.host || s.id).join(', ')}
              </span>
            ) : dirty ? (
              <span className="text-xs text-amber-600">Unsaved changes</span>
            ) : null}
            {/* The shared control, so this reads as the same affordance as the
                one on Run History rather than muted grey text next to it. It
                also goes back through history, which returns to the dashboard
                tile that was selected — the plain href="/" it replaces landed
                on the unfiltered dashboard whichever box you came from. */}
            <BackToDashboard />
            <Button size="sm" variant="secondary" onClick={addSystem}><Plus className="h-4 w-4" />Add system</Button>
            {/* Blocked while ids collide — saving would persist a document in
                which lookups resolve to the wrong machine — or while a system
                has no type, which no role or runner can use. */}
            <Button size="sm" onClick={save} disabled={saving || duplicateIds.length > 0 || untyped.length > 0 || !dirty}>
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
          <div className="rounded-xl border border-line bg-surface p-6 text-sm text-slate-500 shadow-sm">Loading…</div>
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

            {/* Tabs. Counts sit on the tab itself so you can see there ARE
                topology setups without switching to find out. */}
            <div className="flex items-center gap-1 border-b border-line">
              {([
                { id: 'systems',  label: 'Systems',  count: systems.length },
                { id: 'topology', label: 'Topology', count: profiles.length },
              ] as const).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTab(t.id)}
                  className={
                    'relative px-4 h-9 text-sm font-medium transition-colors -mb-px border-b-2 ' +
                    (tab === t.id
                      ? 'border-primary-600 text-slate-900'
                      : 'border-transparent text-slate-500 hover:text-slate-800')
                  }
                >
                  {t.label}
                  <span className={'ml-1.5 text-[11px] tabular-nums ' + (tab === t.id ? 'text-slate-500' : 'text-slate-400')}>
                    {t.count}
                  </span>
                </button>
              ))}
            </div>

            {/* SYSTEMS — one line each.
                Twelve always-open cards made this page a very long scroll for
                information you rarely change: the fields you read (type, name,
                IP, whether REST/SSH are set) fit on a row, and the fields you
                edit belong behind Edit. The card editor is unchanged and still
                does the work — it is just no longer the default view. */}
            <section className={tab === 'systems' ? '' : 'hidden'}>
              <div className="flex flex-wrap items-center gap-2 mb-3">
                <div className="relative">
                  <Search className="h-3.5 w-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                  <input
                    value={sysQuery}
                    onChange={(e) => setSysQuery(e.target.value)}
                    placeholder="Filter by name or IP…"
                    className="h-8 w-56 rounded-md border border-slate-300 bg-surface pl-8 pr-2 text-xs"
                  />
                </div>
                <select
                  value={sysType}
                  onChange={(e) => setSysType(e.target.value)}
                  className="h-8 rounded-md border border-slate-300 bg-surface px-2 text-xs"
                >
                  <option value="">All types</option>
                  {SYSTEM_TYPES.map((t) => (
                    <option key={t} value={t}>{TYPE_META[t]?.label ?? t}</option>
                  ))}
                </select>
                <span className="text-[11px] text-slate-400">
                  {visibleSystems.length} of {systems.length}
                </span>
              </div>

              {systems.length === 0 ? (
                <EmptyCard
                  icon={<Server className="h-5 w-5 text-slate-400" />}
                  title="No systems yet"
                  desc="Click Add system above to register your first lab box."
                />
              ) : visibleSystems.length === 0 ? (
                <div className="rounded-lg border border-line bg-surface px-4 py-6 text-sm text-slate-500">
                  No system matches those filters.
                </div>
              ) : (
                <div className="rounded-lg border border-line bg-surface overflow-hidden">
                  <table className="min-w-full text-xs">
                    <thead className="bg-panel text-slate-500 border-b border-line">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium">Type</th>
                        <th className="px-3 py-2 text-left font-medium">IP address</th>
                        <th className="px-3 py-2 text-left font-medium">Id</th>
                        <th className="px-3 py-2 text-left font-medium">Access</th>
                        <th className="px-3 py-2 text-right font-medium">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {visibleSystems.map(({ sys, idx }) => {
                        const meta = TYPE_META[sys.type] ?? TYPE_META.UESIM;
                        const Icon = meta.icon;
                        const open = editingIdx === idx;
                        return (
                          <Fragment key={idx}>
                            <tr className={open ? 'bg-primary-50/40' : 'hover:bg-slate-50'}>
                              <td className="px-3 py-1.5 whitespace-nowrap">
                                <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${meta.bg} ${meta.text}`}>
                                  <Icon className="h-3 w-3" />{meta.label}
                                </span>
                              </td>
                              <td className="px-3 py-1.5 font-mono text-[11px] text-slate-600">{sys.host || <span className="font-sans text-slate-400">no IP</span>}</td>
                              <td className="px-3 py-1.5 font-mono text-[11px] text-slate-400">{sys.id}</td>
                              <td className="px-3 py-1.5">
                                {/* At-a-glance: is this box actually usable. A
                                    system with neither is why a run fails later. */}
                                <span className="inline-flex gap-1">
                                  <span className={'rounded px-1.5 py-0.5 text-[10px] ' + (sys.uesim?.username ? 'bg-success-50 text-success-700' : 'bg-slate-100 text-slate-400')}>REST</span>
                                  <span className={'rounded px-1.5 py-0.5 text-[10px] ' + (sys.password || sys.privateKey ? 'bg-success-50 text-success-700' : 'bg-slate-100 text-slate-400')}>SSH</span>
                                </span>
                              </td>
                              <td className="px-3 py-1.5 text-right whitespace-nowrap">
                                <button
                                  type="button"
                                  onClick={() => setEditingIdx(open ? null : idx)}
                                  className="text-[11px] text-primary-700 hover:underline"
                                >
                                  {open ? 'Close' : 'Edit'}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => { if (editingIdx === idx) setEditingIdx(null); removeSystem(idx); }}
                                  className="ml-3 text-[11px] text-red-600 hover:underline"
                                >
                                  Remove
                                </button>
                              </td>
                            </tr>
                            {open ? (
                              <tr>
                                <td colSpan={6} className="p-3 bg-slate-50/60">
                                  <SystemCard
                                    sys={sys}
                                    onPatch={(p) => patchSystem(idx, p)}
                                    onRemove={() => { setEditingIdx(null); removeSystem(idx); }}
                                  />
                                </td>
                              </tr>
                            ) : null}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
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
            <section id="topology" className={tab === 'topology' ? 'scroll-mt-20' : 'hidden'}>
              <TopologySetupSection
                systems={systems}
                profiles={profiles}
                otherDoc={otherDoc}
                onProfilesChange={setProfiles}
                savedSystemsSig={savedSystems}
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
    <div className="relative rounded-xl border border-line bg-surface p-4 shadow-sm">
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
    <div className={`rounded-lg border ${tone === 'orange' ? 'border-orange-200 bg-orange-50/30' : 'border-line bg-slate-50/50'}`}>
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
    <div className="rounded-xl border border-dashed border-slate-300 bg-surface/60 p-8 text-center">
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
  const hasSsh = !!(sys.username && (sys.password || sys.privateKey));
  const hasCockpit = !!(sys.cockpitUser || sys.cockpitPassword || sys.cockpitPort);
  const dupWarn = !sys.id.trim() || !sys.host.trim();

  return (
    <div className="group relative rounded-xl border border-line bg-surface shadow-sm transition-shadow hover:shadow-md flex flex-col">
      {/* Top accent stripe — orange for Simnovator install targets */}
      {sys.type === 'SIMNOVATOR' ? (
        <div className="absolute top-0 left-0 right-0 h-1 rounded-t-xl bg-gradient-to-r from-orange-500 via-orange-400 to-amber-300" />
      ) : null}

      {/* ── Identity header: the four things anyone scans for ───────────── */}
      <div className="px-5 pt-5 pb-4 border-b border-slate-100">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div className="min-w-0 flex-1 flex items-center gap-2 flex-wrap">
            <TypeChip type={sys.type} />
            <span className="text-base font-semibold text-slate-900 truncate font-mono">{sys.host || sys.id}</span>
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
          {/* Allocated by Add system and never typed: runs, topologies and
              scenarios all refer to a setup by this id, so letting it be edited
              silently re-points them. (Editing it is how CSI once collided with
              sys-9 and resolved to the wrong machine.) */}
          <Field label="ID" hint="allocated automatically — everything refers to a setup by this id">
            <Input value={sys.id} readOnly disabled />
          </Field>
          <Field label="Type">
            <select
              value={sys.type}
              onChange={(e) => onPatch(withAutoName(sys, { type: e.target.value }))}
              className={SELECT_CLS}
            >
              {!sys.type ? <option value="">— choose type —</option> : null}
              {typeOptions(sys.type).map((t) => (
                <option key={t} value={t}>{TYPE_META[t]?.label ?? t}</option>
              ))}
            </select>
          </Field>
          <Field label="IP address">
            <Input value={sys.host} onChange={(e) => onPatch(withAutoName(sys, { host: e.target.value }))} placeholder="192.168.1.95" />
          </Field>
        </div>

        {/* Logins live in this same block rather than behind a fold: a
            Simnovator with no account cannot execute anything, and every
            execution now picks one of these people. Any number of them —
            the first is what runs when a job does not name a user. */}
        {wantsBoxLogin(sys) ? <BoxUsersEditor sys={sys} onPatch={onPatch} /> : null}
        {/* Said rather than enforced: blocking Save would trap anyone editing a
            setup registered before credentials were required. */}
        {wantsBoxLogin(sys) && sys.host && !hasCreds(sys) ? (
          <div className="mt-2 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
            No login yet — executions on this setup would fall back to admin/admin and may be rejected.
          </div>
        ) : null}
      </div>

      {/* ── Everything else, folded away by default ─────────────────────── */}
      <div className="p-4 space-y-2.5">
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
                <PasswordInput
                  
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
          <PasswordInput  value={sys.password ?? ''} onChange={(e) => onPatch({ password: e.target.value })} />
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
                className="w-full rounded-md border border-slate-300 bg-surface px-3 py-2 text-xs font-mono text-slate-900 focus:outline-none focus:ring-2 focus:ring-primary-300 focus:border-primary-400"
              />
            </Field>
          </div>
          <Field label="Key passphrase" hint="if encrypted">
            <PasswordInput  value={sys.passphrase ?? ''} onChange={(e) => onPatch({ passphrase: e.target.value })} />
          </Field>
        </>
      )}
      <Field label="sudo password" hint="needed for /root/* mv + systemctl restart unless NOPASSWD">
        <PasswordInput  value={sys.sudoPassword ?? ''} onChange={(e) => onPatch({ sudoPassword: e.target.value })} />
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
        // An auto-linked setup is named after its Simnovator. Systems no
        // longer carry a name, so one saved as "Simnovator-95" becomes its IP
        // — a hand-typed name (autoLinked cleared) is left alone.
        name: prior.autoLinked && sim.host ? sim.host : prior.name,
        uesim: prior.uesim ?? ueForThisBench,
        callbox: prior.callbox ?? callboxes[i]?.id,
        appserver: prior.appserver ?? appservers[i]?.id,
      };
      out.push(filled);
      return;
    }
    out.push({
      id: `topo-${sim.id}`,
      name: sim.host || `Topology ${i + 1}`,
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
  //
  // ORPHANS are the one exception. A chain every one of whose four systems has
  // been removed from the inventory points at nothing: it can never match a
  // run, the installer can never resolve a host from it, and every role on its
  // card renders empty. Keeping it protects nothing — the reasoning above is
  // about a chain whose machines still exist — while showing it puts a bench
  // in Systems Management that is not there. The lab had exactly one, a chain
  // named "192.168.1.01" still bound to sys-14/15/16/17 after those four were
  // deleted. A chain with even ONE surviving system is still kept.
  // Anchored on the Simnovator/UESIM, not "any surviving system" — a bench
  // held up only by a shared app server is still an orphan. See hasAnchor.
  const liveIds = new Set(systems.map((s) => s.id));
  const isOrphan = (p: TopologyProfile) => !hasAnchor(p, liveIds);

  // RETYPED is the other exception: a chain whose Simnovator is still
  // registered but is no longer typed as one (changed to App Server, say).
  // Nothing above claims it, and with no Delete on the cards it would stay
  // forever — a bench for a machine that is not a Simnovator. The app server
  // at .124, saved under the old Simnovator default, got exactly that.
  const isRetyped = (p: TopologyProfile) => {
    const s = p.simnovator ? systems.find((x) => x.id === p.simnovator) : undefined;
    return !!s && !isSimnovator(s);
  };

  for (const p of existing) if (!claimed.has(p.id) && !isOrphan(p) && !isRetyped(p)) out.push(p);
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
  systems, profiles, otherDoc, onProfilesChange, savedSystemsSig,
}: {
  systems: InventorySystem[];
  profiles: TopologyProfile[];
  otherDoc: Record<string, unknown>;
  onProfilesChange: (next: TopologyProfile[]) => void;
  /** Changes every time the Systems list is SAVED — the signal to re-derive
   *  the chains. Deliberately not `systems` itself: that state changes on
   *  every keystroke while a row is being edited, and re-deriving mid-typing
   *  would write a chain to disk for a half-entered box. */
  savedSystemsSig: string;
}) {
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const lastSyncSig = useRef<string | null>(null);
  /** Id of the chain open in the editor — the SAVED id, which the form cannot change. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<TopologyProfile | null>(null);

  const flash = (kind: 'ok' | 'err', text: string) => {
    setMsg({ kind, text });
    setTimeout(() => setMsg(null), 2600);
  };

  async function persist(nextProfiles: TopologyProfile[]): Promise<boolean> {
    // NEVER let a topology save blank the systems list.
    //
    // PUT is a full-document replace and this function sends `systems` straight
    // from its props. The auto-sync below fires on load, which races the two
    // GETs that populate those props — so a sync landing before the systems
    // arrive writes `systems: []` and erases every registered box. Observed
    // doing exactly that: 12 systems gone, profiles left pointing at ids that
    // no longer existed. Nothing this function legitimately does can empty the
    // list, so an empty one is a bug, not an intention.
    if (systems.length === 0) {
      flash('err', 'Not saved — the systems list was still loading. Reload and try again.');
      return false;
    }
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

  // Bring the chains in line with the registered systems — after load, and
  // again after every save of the Systems list.
  //
  // This used to run ONCE per page load, so a system added and saved did not
  // get a chain until the page was reloaded. Gating on the saved-systems
  // signature instead keeps that loop-safety (persist() updates `profiles`,
  // which re-runs this effect; the signature is unchanged by then, so it
  // stops) while still reacting to a new box. `systems.length` guards the
  // empty pre-fetch state, which would otherwise wipe every setup.
  useEffect(() => {
    if (systems.length === 0) return;
    if (lastSyncSig.current === savedSystemsSig) return;
    lastSyncSig.current = savedSystemsSig;
    const derived = deriveProfiles(systems, profiles);
    if (sameProfiles(derived, profiles)) return;
    const delta = derived.length - profiles.length;
    persist(derived).then((ok) => {
      if (!ok) return;
      if (delta > 0) {
        flash('ok', `Linked ${delta} new setup${delta === 1 ? '' : 's'} from your systems`);
      } else if (delta < 0) {
        // Say so. deriveProfiles now drops chains whose systems have all been
        // removed, and a chain disappearing from the page with no explanation
        // is exactly the silent deletion the derivation warns about.
        const n = -delta;
        flash('ok', `Removed ${n} setup${n === 1 ? '' : 's'} with no registered Simnovator`);
      } else {
        flash('ok', 'Chains updated from your systems');
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedSystemsSig, systems, profiles]);

  // Editing is safe alongside the auto-sync above: deriveProfiles keeps every
  // binding an existing chain already has and only fills EMPTY roles, so a
  // corrected pairing is not reverted by the next sync. (Edit was removed on
  // 2026-09-10 on the belief that it would be — which left a wrong positional
  // guess, badged "auto-linked · check", with no way to correct it short of
  // hand-editing inventory.yaml.)
  function startEdit(p: TopologyProfile) {
    setDraft({ ...p });
    setEditingId(p.id);
  }

  function cancelEdit() {
    setDraft(null);
    setEditingId(null);
  }

  async function saveDraft() {
    if (!draft || !editingId) return;
    const before = profiles.find((p) => p.id === editingId);
    if (!before) {
      flash('err', 'This setup was removed while you were editing it');
      cancelEdit();
      return;
    }
    if (!draft.uesim) { flash('err', 'Pick a UE system'); return; }
    if (!draft.name?.trim()) { flash('err', 'Give the setup a name'); return; }

    // The eNB/gNB/MME/IMS slots are not in the editor, but callboxForProfile
    // (src/lib/inventory.ts) reads enb/gnb BEFORE callbox. A slot still naming
    // the old callbox would keep Scenarios linking configs on the box you just
    // moved this setup away from. So any slot that followed the old callbox
    // follows it to the new one (or is cleared with it).
    const followed: Partial<TopologyProfile> = {};
    if (before.callbox !== draft.callbox) {
      for (const k of ['enb', 'gnb', 'mme', 'ims'] as const) {
        if (before[k] && before[k] === before.callbox) followed[k] = draft.callbox || undefined;
      }
    }

    // A human has now chosen these bindings, so the "auto-linked" caveat no
    // longer applies. id and simnovator come from the SAVED record: both are
    // locked in the form, and the write is matched on editingId. The old
    // editor matched on draft.id with an editable ID field, so changing the id
    // matched nothing — it said "Setup updated" and saved nothing.
    const confirmed: TopologyProfile = {
      ...draft,
      ...followed,
      id: before.id,
      simnovator: before.simnovator,
      name: draft.name.trim(),
      // "— none —" is stored as '' rather than dropped. deriveProfiles fills
      // any role that is ABSENT (prior.callbox ?? positional guess), so a
      // dropped key would get the guessed box put back on the next Systems
      // save. '' survives that `??`, and every reader treats it as unset
      // (callboxForProfile filters Boolean; runner/setups/buildValidation
      // check truthiness).
      callbox: draft.callbox || '',
      appserver: draft.appserver || '',
      autoLinked: undefined,
      updatedAt: new Date().toISOString(),
    };
    const ok = await persist(profiles.map((p) => (p.id === editingId ? confirmed : p)));
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
            register, created automatically. Each one is editable, because the
            automatic pairing is positional and can guess wrong. */}
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
                // One chain open at a time: a second open draft would be saved
                // over by whichever Save lands last.
                busy={saving || !!editingId}
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
  /** Disables Edit while a save is in flight or another chain is open. */
  busy: boolean;
}) {
  const callboxId = setup.callbox;
  return (
    <div className="rounded-xl border border-line bg-surface shadow-sm transition-shadow hover:shadow-md overflow-hidden">
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
          {/* A chain belongs to a Simnovator and follows it: it is derived
              from the Systems list, so it is changed there, not here. */}
        </div>

        <div className="flex flex-wrap items-stretch gap-y-3">
          {PROFILE_ROLES.map((role, idx) => {
            const refId = (setup as any)[role.key] as string | undefined;
            const isShared = role.shareable && !!callboxId && refId === callboxId;
            const sys = lookupSystem(systems, refId);
            return (
              <div key={role.key} className="flex items-center">
                <RoleChip
                  role={role} system={sys} shared={isShared} missing={role.required && !sys}
                  dangling={refId && !sys ? refId : undefined}
                />
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
  role, system, shared, missing, dangling,
}: {
  role: TopologyRoleDef;
  system?: InventorySystem;
  shared?: boolean;
  missing?: boolean;
  /** An id this role is bound to that is not in the Systems list. */
  dangling?: string;
}) {
  const Icon = role.icon;
  const t = TOPOLOGY_TONE_CLASSES[role.tone];
  const BOX = 'rounded-xl border px-4 py-3 min-w-[190px]';

  // Said plainly. This used to render as "— not set —", indistinguishable from
  // a role nobody bound, while the chain still pointed at a removed system.
  if (dangling) {
    return (
      <div
        className={`${BOX} border-dashed border-amber-300 bg-amber-50/70`}
        title="This setup points at a system ID that is not in the Systems list — it was removed, or its ID and address both changed. Edit the setup to pick it again."
      >
        <div className="flex items-center gap-1.5 text-amber-800 text-sm font-semibold">
          <Icon className="h-4 w-4" />{role.label}
        </div>
        <div className="text-amber-700 text-xs mt-1.5 font-medium">&ldquo;{dangling}&rdquo; not registered</div>
      </div>
    );
  }

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
      <div className={`${BOX} border-line bg-slate-50`}>
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
      {/* The IP names the machine — systems carry no name of their own. */}
      <div className="text-[15px] text-slate-900 font-semibold leading-tight mt-1.5 truncate max-w-[16rem] font-mono">
        {system.host || system.id}
      </div>
      <div className="text-xs text-slate-500 mt-0.5">{system.id}</div>
    </div>
  );
}

// ───── form view ─────

/** Edits one chain in place of its card. The ID and the Simnovator are shown
 *  but locked: Scenarios and runs refer to a setup by id, and a chain belongs
 *  to its Simnovator — pointing it at another would make the auto-sync create
 *  a second chain for the one left behind. */
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
    <div className="rounded-xl border border-orange-200 bg-surface shadow-sm">
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
          <Field label="ID" hint="fixed — Scenarios and runs refer to a setup by this id">
            <Input value={draft.id} readOnly disabled />
          </Field>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {PROFILE_ROLES.map((role) => (
            <RoleSelector
              key={role.key} role={role} draft={draft} systems={systems} callbox={callbox}
              locked={!isNew && role.key === 'simnovator'}
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
  role, draft, systems, callbox, onChange, locked,
}: {
  role: TopologyRoleDef;
  draft: TopologyProfile;
  systems: InventorySystem[];
  callbox?: InventorySystem;
  onChange: (val?: string) => void;
  /** Show the bound system without a picker — see SetupForm. */
  locked?: boolean;
}) {
  const Icon = role.icon;
  const t = TOPOLOGY_TONE_CLASSES[role.tone];
  const candidates = systems.filter((s) => (role.types as readonly string[]).includes(s.type));
  const value = (draft as any)[role.key] as string | undefined;
  const usingCallbox = role.shareable && !!callbox && value === callbox.id;
  const setUsingCallbox = (yes: boolean) => onChange(yes ? callbox?.id : undefined);
  // The bound value when it is NOT one of the offered systems: removed from
  // inventory, or registered under a type this role does not take. A native
  // <select> with a value matching no option silently displays another row,
  // so it gets its own option and a line saying why.
  const current = lookupSystem(systems, value);
  const offPicklist = !!value && !candidates.some((s) => s.id === value);
  const typesLabel = role.types.map((ty) => TYPE_META[ty]?.label ?? ty).join(', ');

  return (
    <div className="rounded-xl border border-line bg-surface p-4 transition-colors">
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

      {locked ? (
        <div className="rounded-lg bg-slate-50 ring-1 ring-line px-3 py-2 text-[12px] text-slate-700">
          <span className="font-medium">{lookupSystem(systems, value)?.name || value || '—'}</span>{' '}
          <span className="font-mono text-[11px] text-slate-500">{lookupSystem(systems, value)?.host}</span>
          <div className="mt-1 text-[11px] text-slate-500">
            Fixed — this setup belongs to this Simnovator. Its chain follows the Systems list above.
          </div>
        </div>
      ) : usingCallbox ? (
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
          disabled={candidates.length === 0 && !offPicklist}
        >
          <option value="">{role.required ? '— pick a system —' : '— none —'}</option>
          {offPicklist ? (
            <option value={value}>
              {current
                ? `${current.host || current.id} — registered as ${TYPE_META[current.type]?.label ?? current.type}`
                : `${value} — not registered`}
            </option>
          ) : null}
          {candidates.map((s) => <option key={s.id} value={s.id}>{s.host || s.id}</option>)}
        </select>
      )}

      {/* Why a box is or isn't in the list — the question behind "my app
          server isn't showing up": the list is filtered by system TYPE. */}
      {!locked && !usingCallbox ? (
        offPicklist ? (
          <div className="mt-2 text-[11px] text-amber-700">
            {current
              ? `This role takes ${typesLabel} systems, and ${current.name || current.id} is registered as ${TYPE_META[current.type]?.label ?? current.type}. Change its type under Systems, or pick another.`
              : `“${value}” is not in the Systems list — removed, or its ID changed. Pick the system again.`}
          </div>
        ) : candidates.length > 0 ? (
          <div className="mt-1.5 text-[11px] text-slate-400">Lists {typesLabel} systems</div>
        ) : null
      ) : null}

      {candidates.length === 0 && !locked ? (
        <div className="mt-2 text-[11px] text-slate-500">
          No <span className="font-mono">{role.types.join(' / ')}</span> systems in inventory.
        </div>
      ) : null}
    </div>
  );
}

/**
 * The logins a Simnovator executes under — any number of them.
 *
 * One box, several people, each with their own account: this is the list every
 * execution surface picks a "Run as" from. The FIRST row is the setup default,
 * used by anything that does not name a user, and it is mirrored into the
 * legacy single-pair field so the older code paths that read it directly
 * (validator, runner, box reachability) resolve the same account rather than
 * quietly falling back to admin/admin.
 *
 * A setup saved before the list existed shows its old pair as row one, so its
 * credentials stay visible and editable instead of being stranded in the file.
 */
function BoxUsersEditor({
  sys,
  onPatch,
}: {
  sys: InventorySystem;
  onPatch: (patch: Partial<InventorySystem>) => void;
}) {
  // Legacy pair shown as row one until the list is written for the first time.
  const users: NonNullable<InventorySystem['uesimUsers']> =
    sys.uesimUsers
    ?? (sys.uesim?.username || sys.uesim?.password
      ? [{ id: 'default', username: sys.uesim.username ?? '', password: sys.uesim.password ?? '' }]
      // A new Simnovator opens with one blank Username/Password row rather
      // than an empty list behind an Add button: picking the type is the
      // moment to say which account executes, so the fields are just there.
      // Typing into it creates the first login; nothing is saved while blank.
      : [{ id: 'default', username: '', password: '' }]);

  const setUsers = (next: NonNullable<InventorySystem['uesimUsers']>) =>
    onPatch({
      uesimUsers: next,
      // Keep the default in step with row one.
      uesim: next.length
        ? { ...(sys.uesim ?? {}), username: next[0].username, password: next[0].password }
        : sys.uesim,
    });

  const addUser = () => {
    // Random id, not an index: rows get removed, and an index-based id would
    // silently re-point a suite's saved selection at a different person.
    const id = `bu-${Math.random().toString(36).slice(2, 9)}`;
    setUsers([...users, { id, username: '', password: '' }]);
  };
  const patchUser = (id: string, patch: Partial<{ username: string; password: string; label: string }>) =>
    setUsers(users.map((u) => (u.id === id ? { ...u, ...patch } : u)));
  const removeUser = (id: string) => setUsers(users.filter((u) => u.id !== id));

  const dupes = new Set(
    users
      .map((u) => u.username.trim().toLowerCase())
      .filter((n, i, all) => n && all.indexOf(n) !== i),
  );

  return (
    <div className="mt-4 rounded-lg border border-line bg-slate-50/60 px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-xs font-medium text-slate-700">
            Simnovator Logins{users.some((u) => u.username.trim()) ? <span className="ml-1.5 text-slate-400 font-normal">{users.filter((u) => u.username.trim()).length}</span> : null}
          </div>
          <div className="text-[11px] text-slate-500">
            Add as many as execute on this box — each person runs under their own account.
          </div>
        </div>
        <Button size="sm" variant="secondary" onClick={addUser} className="shrink-0">Credentials</Button>
      </div>

      {users.length === 0 ? (
        <div className="mt-2 text-[11px] text-slate-400">
          None yet — add the account SimQA should execute as.
        </div>
      ) : (
        <div className="mt-2.5 space-y-2">
          {users.map((u, i) => {
            const dupe = !!u.username.trim() && dupes.has(u.username.trim().toLowerCase());
            return (
              <div key={u.id} className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-2 items-end">
                <Field label="Username">
                  <Input
                    value={u.username}
                    onChange={(e) => patchUser(u.id, { username: e.target.value })}
                    placeholder="simuser"
                  />
                </Field>
                <Field label="Password">
                  <PasswordInput
                    value={u.password}
                    onChange={(e) => patchUser(u.id, { password: e.target.value })}
                    placeholder="••••"
                  />
                </Field>
                <button
                  type="button"
                  onClick={() => removeUser(u.id)}
                  className="mb-1 rounded border border-red-300 text-red-600 hover:bg-red-50 text-xs px-2 py-1.5"
                >
                  Remove
                </button>
                {/* Two rows with the same username would resolve to whichever
                    came first — a silent wrong-account execution. */}
                {dupe ? (
                  <div className="sm:col-span-3 -mt-1 text-[11px] text-amber-700">
                    “{u.username.trim()}” is listed twice — executions would always pick the first one.
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

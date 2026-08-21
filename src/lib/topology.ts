// Canonical model for lab systems and topology roles.
//
// This module exists because the same `profiles` array in inventory.yaml used
// to be edited by two different screens with two different, contradicting
// lenses: /inventory marked `uesim` required and exposed enb/gnb, while
// /end-to-end marked `simnovator` required and hid them. Same data, two
// mutually exclusive ideas of what "valid" meant.
//
// The schema in lib/inventory.ts is the truth — every role is optional — so
// the rule is expressed once, here, and imported by the UI. If you add a role,
// add it to TopologyProfile in lib/inventory.ts and to ROLES below; nowhere else.

import {
  ShieldCheck, Cpu, Server, Radio, Network, Globe, Database,
  type LucideIcon,
} from 'lucide-react';

/** System types a box can be registered as. Simnovator first — it's the
 *  default install target for Build Check. */
export const SYSTEM_TYPES = [
  'SIMNOVATOR', 'UESIM', 'CALLBOX', 'ENB', 'GNB', 'MME', 'IMS', 'APPSERVER',
] as const;
export type SystemType = (typeof SYSTEM_TYPES)[number];

export interface TypeMeta {
  icon: LucideIcon;
  label: string;
  /** Tailwind classes for the type chip. Brand scales only — see
   *  tailwind.config.ts; literal hex would not follow the dark theme. */
  chip: string;
}

export const TYPE_META: Record<string, TypeMeta> = {
  SIMNOVATOR: { icon: ShieldCheck, label: 'Simnovator', chip: 'bg-primary-50 text-primary-700 ring-primary-500/25' },
  UESIM:      { icon: Cpu,         label: 'UESIM',      chip: 'bg-blue-50 text-blue-700 ring-blue-500/25' },
  CALLBOX:    { icon: Server,      label: 'Callbox',    chip: 'bg-emerald-50 text-emerald-700 ring-emerald-600/25' },
  ENB:        { icon: Radio,       label: 'eNB',        chip: 'bg-slate-100 text-slate-700 ring-line' },
  GNB:        { icon: Radio,       label: 'gNB',        chip: 'bg-slate-100 text-slate-700 ring-line' },
  MME:        { icon: Network,     label: 'MME',        chip: 'bg-slate-100 text-slate-700 ring-line' },
  IMS:        { icon: Globe,       label: 'IMS',        chip: 'bg-slate-100 text-slate-700 ring-line' },
  APPSERVER:  { icon: Database,    label: 'App server', chip: 'bg-slate-100 text-slate-700 ring-line' },
};

export function typeMeta(type: string): TypeMeta {
  return TYPE_META[type] ?? TYPE_META.UESIM;
}

/** A UESIM-capable box: either an integrated Simnovator or a standalone UESIM. */
export function isUesimCapable(type: string): boolean {
  return type === 'SIMNOVATOR' || type === 'UESIM';
}

// ───────────── Topology roles ─────────────

export interface RoleDef {
  /** Key on TopologyProfile. */
  key: 'simnovator' | 'uesim' | 'callbox' | 'enb' | 'gnb' | 'mme' | 'ims' | 'appserver';
  label: string;
  icon: LucideIcon;
  /** System types eligible to fill this slot. */
  types: readonly string[];
  hint: string;
}

/** The union of every role either legacy screen knew about. Order is the
 *  order they appear in the editor: control plane first, then radio, then
 *  core, then services. */
export const ROLES: readonly RoleDef[] = [
  { key: 'simnovator', label: 'Simnovator', icon: ShieldCheck, types: ['SIMNOVATOR'],
    hint: 'Controller VM — also the Build Check install target' },
  { key: 'uesim',      label: 'UESIM',      icon: Cpu,         types: ['SIMNOVATOR', 'UESIM'],
    hint: 'UE simulator. On integrated installs this is the Simnovator itself' },
  { key: 'callbox',    label: 'Callbox',    icon: Server,      types: ['CALLBOX'],
    hint: 'All-in-one RAN + core box' },
  { key: 'enb',        label: 'eNB',        icon: Radio,       types: ['ENB', 'CALLBOX'],
    hint: 'LTE radio, if split out from the callbox' },
  { key: 'gnb',        label: 'gNB',        icon: Radio,       types: ['GNB', 'CALLBOX'],
    hint: '5G NR radio, if split out from the callbox' },
  { key: 'mme',        label: 'MME',        icon: Network,     types: ['MME', 'CALLBOX'],
    hint: 'Core control plane' },
  { key: 'ims',        label: 'IMS',        icon: Globe,       types: ['IMS', 'CALLBOX'],
    hint: 'Voice / IMS services' },
  { key: 'appserver',  label: 'App server', icon: Database,    types: ['APPSERVER', 'CALLBOX'],
    hint: 'Traffic endpoint for data tests' },
] as const;

/**
 * A profile is usable once it names a box that can actually drive UEs —
 * either an integrated Simnovator or a standalone UESIM.
 *
 * This deliberately replaces the old contradiction (one screen demanding
 * `uesim`, the other demanding `simnovator`). Every other role is genuinely
 * optional: customer-style integrated installs have no separate callbox,
 * MME or app server at all.
 */
export function profileIssues(p: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (!p.simnovator && !p.uesim) {
    out.push('Needs a Simnovator or a UESIM — nothing can drive UEs without one');
  }
  if (!String(p.name ?? '').trim()) out.push('Needs a name');
  return out;
}

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

/**
 * Roles a topology can bind, in editor order: control plane, then radio, then
 * core, then services.
 *
 * There is deliberately NO separate "Callbox" role. A callbox IS the eNB and
 * the gNB, so offering all three made you pick the same box three times for
 * one thing. Bind the callbox to eNB and/or gNB instead — both accept a
 * CALLBOX system.
 *
 * Nothing is lost by dropping it: planDeployTargets in lib/runner.ts dedupes
 * by system id, and filesForTarget switches on the system TYPE, so a callbox
 * reached through the eNB slot still receives the full mme/ims/enb/gnb/ue_db
 * cfg set. The `callbox` key stays on TopologyProfile for older inventories.
 */
export const ROLES: readonly RoleDef[] = [
  { key: 'simnovator', label: 'Simnovator', icon: ShieldCheck, types: ['SIMNOVATOR'],
    hint: 'Controller VM — also the Build Check install target' },
  { key: 'uesim',      label: 'UESIM',      icon: Cpu,         types: ['SIMNOVATOR', 'UESIM'],
    hint: 'UE simulator. On integrated installs this is the Simnovator itself' },
  { key: 'enb',        label: 'eNB',        icon: Radio,       types: ['ENB', 'CALLBOX'],
    hint: 'LTE radio — pick the callbox here if it is the all-in-one box' },
  { key: 'gnb',        label: 'gNB',        icon: Radio,       types: ['GNB', 'CALLBOX'],
    hint: '5G NR radio — pick the callbox here if it is the all-in-one box' },
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
/**
 * Fold a legacy `callbox` binding into the eNB / gNB slots.
 *
 * Older inventories bound the same box to callbox AND enb AND gnb. Now that
 * the Callbox role is gone, carry that value into whichever radio slots are
 * empty so nothing is silently orphaned, then drop the key.
 */
export function migrateProfile<T extends Record<string, any>>(p: T): T {
  const legacy = p.callbox;
  if (!legacy) return p;
  const out: any = { ...p };
  if (!out.enb) out.enb = legacy;
  if (!out.gnb) out.gnb = legacy;
  delete out.callbox;
  return out as T;
}

export function profileIssues(p: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (!p.simnovator && !p.uesim) {
    out.push('Needs a Simnovator or a UESIM — nothing can drive UEs without one');
  }
  if (!String(p.name ?? '').trim()) out.push('Needs a name');
  return out;
}

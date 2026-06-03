// Feature criticality table.
//
// This is the single place to (re)classify how important a feature is to
// customers — it drives prioritisation in the coverage matrix and grouping in
// the report. Per the QA-leader thread, @Pankaj owns this list: move a feature
// to 'critical' if customers rely on it, 'non-critical' if they don't (and we
// should then encourage adoption rather than drop coverage).

import type { Criticality } from './types';

export interface FeatureFlag {
  key: string;
  label: string;
  criticality: Criticality;
  /** Where it lives in the input config, for the matrix generator. */
  inputHint?: string;
  notes?: string;
}

export const FEATURE_FLAGS: FeatureFlag[] = [
  // Explicitly raised in the QA thread — defaulting to 'normal' until Pankaj
  // classifies them against real customer usage.
  { key: 'supplementaryUplink', label: 'Supplementary Uplink', criticality: 'normal', inputHint: 'cellConfig.cells[].supplementaryUplink', notes: 'Confirm customer usage; encourage adoption if unused.' },
  { key: 'uac', label: 'Unified Access Control', criticality: 'normal', inputHint: 'subsConfig.subs[].access_control_classes / uac_access_identities' },
  { key: 'networkSlicing', label: 'Network Slicing', criticality: 'normal', inputHint: 'subsConfig.subs[].networkSlicing / nssaiObject' },

  // Core protocol behaviours — treated as critical for coverage.
  { key: 'rrcEstablishment', label: 'RRC Establishment', criticality: 'critical', inputHint: 'subsConfig.subs[].attachType / ueInitiatedEvents' },
  { key: 'mobility', label: 'Mobility', criticality: 'critical', inputHint: 'mobilityConfig' },
  { key: 'handover', label: 'Handover', criticality: 'critical', inputHint: 'mobilityConfig + multi-cell' },
  { key: 'powerCycle', label: 'Power Cycle', criticality: 'normal', inputHint: 'powerCycleConfig' },
  { key: 'carrierAggregation', label: 'Carrier Aggregation', criticality: 'critical', inputHint: 'cellConfig.master.carrierAggregation' },
  { key: 'redCap', label: 'RedCap', criticality: 'normal', inputHint: 'subsConfig.subs[].redCap' },
];

const BY_KEY = new Map(FEATURE_FLAGS.map((f) => [f.key, f]));

export function featureCriticality(key: string): Criticality {
  return BY_KEY.get(key)?.criticality ?? 'normal';
}

export function getFeature(key: string): FeatureFlag | undefined {
  return BY_KEY.get(key);
}

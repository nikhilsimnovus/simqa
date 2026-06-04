// Config-Fidelity validation — shared types.
//
// The feature proves that a Simnovator test (the JSON "intermediate config"
// authored via /tests/*) is faithfully reflected in the Amarisoft `ue.cfg`
// the UE-sim generates at execution time. See docs/CONFIG_FIDELITY.md and the
// approved plan for the full design.

/** Criticality drives prioritisation in the matrix and the report. */
export type Criticality = 'critical' | 'normal' | 'non-critical';

/** Per-parameter verdict. `no-rule` = we have no mapping for this input field
 *  yet, surfaced explicitly so coverage gaps are visible (never silently
 *  counted as a pass). */
export type ParamStatus = 'honoured' | 'missing' | 'mismatch' | 'no-rule';

export interface ParamResult {
  /** Dotted path into the input config, e.g. "cellConfig.cells[0].band". */
  inputPath: string;
  /** Where we looked in ue.cfg, e.g. "cell_groups[0].cells[0].band". */
  ueCfgPath?: string;
  /** Human label for the report. */
  label: string;
  /** Grouping bucket: cell | subscriber | user-plane | mobility | power-cycle
   *  | settings | rrc | handover | feature-flag. */
  feature: string;
  criticality: Criticality;
  status: ParamStatus;
  expected?: unknown;
  actual?: unknown;
  detail?: string;
}

/** A config error detected from the run itself (not a fidelity mismatch). */
export interface ConfigErrorFinding {
  source: 'execution' | 'ue.cfg' | 'ots.log' | 'lteue';
  message: string;
}

export interface FidelityCounts {
  honoured: number;
  missing: number;
  mismatch: number;
  noRule: number;
}

/** Result of diffing one input config against its generated ue.cfg. */
export interface CaseValidation {
  /** True only when there are no mismatches AND no missing critical params. */
  ok: boolean;
  params: ParamResult[];
  counts: FidelityCounts;
}

/** The Simnovator "intermediate config object" (input). Kept loose on purpose:
 *  the box is the source of truth for exact field types (e.g. bandwidth is a
 *  string, startingIMSI a number), and the mapping layer normalises values. */
export interface InputConfig {
  cellConfig?: {
    master?: Record<string, any> & { ratType?: string; product?: string };
    cells?: Array<Record<string, any>>;
  };
  subsConfig?: { subs?: Array<Record<string, any>> };
  userPlaneConfig?: { profiles?: Array<Record<string, any>> };
  mobilityConfig?: { profiles?: Array<Record<string, any>> } | any;
  powerCycleConfig?: { profiles?: Array<Record<string, any>> } | any;
  settings?: Record<string, any>;
}

/** Parsed ue.cfg (Amarisoft UE-sim config — JSON on this product). */
export type UeCfg = Record<string, any>;

// ---------- Matrix / case model ----------

export type Rat = 'lte' | 'nr-sa' | 'nsa' | 'nbiot' | 'multirat' | 'catm';

/** One coverage case = a full input config plus metadata for the report. */
export interface Case {
  /** Stable, human-readable id, e.g. "nr-sa-n78-100mhz-scs30-2x2-udp". */
  id: string;
  rat: Rat;
  description: string;
  /** Bodies for the /tests/* create sequence (already in box wire-format). */
  cells: any;            // POST /tests/cells body  ({ cellConfig })
  subscribers: any;      // POST /tests/{id}/subscribers body ({ subsConfig })
  userPlane?: any;       // ({ userPlaneConfig })
  powerCycle?: any;      // ({ powerCycleConfig })
  mobility?: any;        // ({ mobilityConfig })
  settings?: any;        // ({ settings })
  /** Flat input config (cellConfig/subsConfig/...) used by the validator. */
  input: InputConfig;
  /** Feature tags exercised (for coverage reporting). */
  tags: string[];
}

export type CasePhase =
  | 'pending' | 'creating' | 'executing' | 'retrieving' | 'validating'
  | 'passed' | 'failed' | 'error' | 'skipped';

/** Outcome for one case after the full create→execute→retrieve→validate loop. */
export interface CaseOutcome {
  caseId: string;
  rat: Rat;
  description: string;
  phase: CasePhase;
  /** Overall pass = no config errors AND fidelity ok. */
  pass: boolean;
  testCaseId?: string;
  executionId?: string;
  durationMs?: number;
  configErrors: ConfigErrorFinding[];
  validation?: CaseValidation;
  /** Relative run-file names persisted (input.json, ue.cfg, diff.json). */
  artifacts?: string[];
  error?: string;
}

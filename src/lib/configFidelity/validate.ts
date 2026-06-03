// Config-Fidelity validation engine.
//
// validateConfig(input, ueCfg) runs every checker and rolls the per-parameter
// results into a CaseValidation. detectConfigErrors(...) inspects the run-time
// signals (execution status, ue.cfg presence/parse, ots.log) for config
// errors. The runner combines both into the case PASS verdict:
//   PASS = no config errors AND fidelity ok.

import type {
  InputConfig, UeCfg, CaseValidation, ParamResult, FidelityCounts, ConfigErrorFinding,
} from './types';
import { CHECKERS } from './mapping';

export function validateConfig(input: InputConfig, ueCfg: UeCfg): CaseValidation {
  const params: ParamResult[] = [];
  for (const checker of CHECKERS) {
    try {
      params.push(...checker.run(input, ueCfg));
    } catch (e: any) {
      params.push({
        inputPath: `(${checker.feature})`, label: `${checker.feature} checker threw`,
        feature: checker.feature, criticality: 'normal', status: 'mismatch',
        detail: e?.message ?? String(e),
      });
    }
  }

  const counts: FidelityCounts = {
    honoured: params.filter((p) => p.status === 'honoured').length,
    missing: params.filter((p) => p.status === 'missing').length,
    mismatch: params.filter((p) => p.status === 'mismatch').length,
    noRule: params.filter((p) => p.status === 'no-rule').length,
  };

  // OK = no mismatches AND no missing *critical* params. Missing non-critical
  // params are reported but don't fail the case; mismatches always fail.
  const criticalMissing = params.some((p) => p.status === 'missing' && p.criticality === 'critical');
  const anyMismatch = counts.mismatch > 0;
  const ok = !anyMismatch && !criticalMissing;

  return { ok, params, counts };
}

// ---------- config-error detection (run-time signals) ----------

const CFG_ERROR_PATTERNS = [
  /error.*config/i, /config.*error/i, /cannot (parse|read|open).*cfg/i,
  /unknown (field|key|parameter)/i, /invalid (value|parameter|config)/i,
  /failed to (parse|load|apply)/i, /syntax error/i, /unexpected (token|field)/i,
];

export interface RuntimeSignals {
  /** lastExecution.status / result if discovered (e.g. FAILED, INCOMPLETE). */
  executionStatus?: string;
  executionResult?: string;
  executionDetail?: string;
  /** Did we retrieve a non-empty, parseable ue.cfg? */
  ueCfgPresent: boolean;
  ueCfgParseError?: string;
  /** Tail of ots.log / lteue stderr, if pulled. */
  logTail?: string;
}

export function detectConfigErrors(sig: RuntimeSignals): ConfigErrorFinding[] {
  const out: ConfigErrorFinding[] = [];

  if (!sig.ueCfgPresent) {
    out.push({ source: 'ue.cfg', message: 'ue.cfg was not generated / could not be retrieved after execution' });
  }
  if (sig.ueCfgParseError) {
    out.push({ source: 'ue.cfg', message: `ue.cfg is not valid JSON: ${sig.ueCfgParseError}` });
  }

  const status = (sig.executionStatus ?? '').toUpperCase();
  const result = (sig.executionResult ?? '').toUpperCase();
  if (status === 'FAILED' || result === 'FAIL' || result === 'INCOMPLETE') {
    // Only treat as a *config* error when the detail looks config-related, or
    // when ue.cfg never appeared (covered above). Behavioural failures (no
    // attach because there's no callbox) are expected and NOT config errors.
    const detail = sig.executionDetail ?? '';
    if (!detail || CFG_ERROR_PATTERNS.some((re) => re.test(detail))) {
      if (CFG_ERROR_PATTERNS.some((re) => re.test(detail))) {
        out.push({ source: 'execution', message: `execution ${status || result}: ${detail}`.trim() });
      }
    }
  }

  if (sig.logTail) {
    for (const line of sig.logTail.split('\n')) {
      if (CFG_ERROR_PATTERNS.some((re) => re.test(line))) {
        out.push({ source: 'ots.log', message: line.trim().slice(0, 240) });
      }
    }
  }

  // De-dup.
  const seen = new Set<string>();
  return out.filter((f) => {
    const k = `${f.source}::${f.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

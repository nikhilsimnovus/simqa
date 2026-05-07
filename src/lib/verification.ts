// Run verification: take the artifacts of a finished execution and produce
// a structured verdict across four dimensions.
//
//   lifecycle    -- did the run reach a terminal state cleanly?
//   criteria     -- did the testcase's success criteria evaluate to PASS,
//                   AND were the achieved values plausible (not zero on a
//                   measurement that should have data)?
//   statsSanity  -- are the cell / UE counters in physically valid ranges?
//   cleanup      -- did the simulator return to available afterwards?
//
// Pure verification functions take the already-fetched data and return a
// dimension result. `runRunVerification` is the async orchestrator that
// pulls everything from the API and stitches a report.

import { listSimulators, getSimulatorStatus } from './uesimClient';

interface ApiOpts { host: string; username: string; password: string }

export interface VerificationCheck {
  name: string;
  ok: boolean;
  value?: string | number | boolean;
  expected?: string;
  detail?: string;
}

export interface VerificationDimension {
  name: 'lifecycle' | 'criteria' | 'statsSanity' | 'cleanup';
  ok: boolean;
  warnings: string[];
  checks: VerificationCheck[];
  /** True if a check was marked suspicious but not strictly failing (e.g., PASS with achieved=0). */
  hasWarnings: boolean;
}

export interface VerificationReport {
  generatedAt: string;
  /** pass = every dimension ok AND no warnings. warn = ok but warnings present. fail = any dimension !ok. */
  overall: 'pass' | 'warn' | 'fail';
  dimensions: {
    lifecycle: VerificationDimension;
    criteria: VerificationDimension;
    statsSanity: VerificationDimension;
    cleanup: VerificationDimension;
  };
  /** Raw API responses captured during verification. Helpful when triaging. */
  raw: {
    execution?: any;
    statsGlobal?: any;
    statsCellsSummary?: any;
    statsUes?: any;
    simulators?: any;
    simulatorStatus?: any;
  };
}

// ---------- Pure verifiers ----------

/** Lifecycle: terminal status reached, ran for a non-zero duration. */
export function verifyLifecycle(execution: any): VerificationDimension {
  const checks: VerificationCheck[] = [];
  const warnings: string[] = [];
  const status = String(execution?.status ?? '');
  const result = String(execution?.result ?? '');
  const duration = Number(execution?.durationSeconds ?? 0);

  const terminalStatuses = ['COMPLETED', 'ABORTED', 'STOPPED'];
  const isTerminal = terminalStatuses.includes(status);
  checks.push({
    name: 'reached terminal status',
    ok: isTerminal,
    value: status || '<missing>',
    expected: 'one of COMPLETED, ABORTED, STOPPED',
  });

  checks.push({
    name: 'has non-zero duration',
    ok: duration > 0,
    value: `${duration}s`,
    expected: '> 0 seconds (a zero-duration run did not actually execute)',
  });

  if (status === 'ABORTED' || status === 'STOPPED') {
    warnings.push(`status is ${status} - run did not complete normally`);
  }

  checks.push({
    name: 'has result verdict',
    ok: result === 'PASS' || result === 'FAIL',
    value: result || '<missing>',
    expected: 'PASS or FAIL (anything else means the result was never recorded)',
  });

  const ok = checks.every((c) => c.ok);
  return { name: 'lifecycle', ok, warnings, checks, hasWarnings: warnings.length > 0 };
}

/** Criteria: parse executionResultDetails and verify each rule. Flag PASS-with-zero-achieved. */
export function verifyCriteria(execution: any): VerificationDimension {
  const checks: VerificationCheck[] = [];
  const warnings: string[] = [];

  // executionResultDetails is a JSON-encoded string inside the JSON response.
  let parsed: any;
  const raw = execution?.executionResultDetails;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch { parsed = undefined; }
  } else if (typeof raw === 'object') {
    parsed = raw;
  }

  if (!parsed) {
    checks.push({
      name: 'executionResultDetails present',
      ok: false,
      value: '<missing or unparseable>',
      expected: 'JSON object with criterion categories (bler, throughput, ...) each with { verdict, <rules> }',
    });
    return { name: 'criteria', ok: false, warnings, checks, hasWarnings: false };
  }

  // The shape we've seen on the box:
  //   { bler: { bler: [{ achieved, condition, demand, msgname, verdict }], verdict },
  //     throughput: { throughput: [...], verdict }, ... }
  //
  // Walk every category that has a `verdict`. If it has an array of rules
  // under any sub-key, walk those too.

  const categories = Object.keys(parsed).filter((k) => parsed[k] && typeof parsed[k] === 'object' && 'verdict' in parsed[k]);
  if (categories.length === 0) {
    checks.push({
      name: 'has at least one criterion category',
      ok: false,
      value: '<none>',
      expected: 'one or more categories with a verdict (bler, throughput, attach, ...)',
    });
  }

  for (const cat of categories) {
    const catObj = parsed[cat];
    const catVerdict = catObj.verdict;
    checks.push({
      name: `${cat} category verdict`,
      ok: catVerdict === true || String(catVerdict).toUpperCase() === 'PASS',
      value: String(catVerdict),
      expected: 'true / PASS',
    });

    // Rules: any sub-key whose value is an array of objects each with msgname/achieved/demand/verdict
    for (const sub of Object.keys(catObj)) {
      if (sub === 'verdict') continue;
      const arr = catObj[sub];
      if (!Array.isArray(arr)) continue;
      for (const rule of arr) {
        if (!rule || typeof rule !== 'object') continue;
        const msgname = String(rule.msgname ?? rule.condition ?? sub);
        const achieved = rule.achieved;
        const demand = rule.demand;
        const verdict = rule.verdict;
        const verdictPass = verdict === true || String(verdict).toUpperCase() === 'PASS';

        checks.push({
          name: `${cat}.${msgname}`,
          ok: verdictPass,
          value: `achieved=${JSON.stringify(achieved)} demand=${JSON.stringify(demand)}`,
          expected: String(rule.condition ?? `verdict true`),
        });

        // Suspicious-pass detection: rule passed but achieved is 0 / falsy on a
        // metric that is supposed to measure traffic. The most common sneaky
        // pass is a "<= X%" rule where achieved=0 because nothing happened.
        const measuresTraffic = /throughput|bler|tput|rate|count|dl|ul/i.test(msgname);
        const achievedIsZero = achieved === 0 || achieved === '0' || achieved === null || achieved === undefined;
        if (verdictPass && measuresTraffic && achievedIsZero) {
          warnings.push(`${cat}.${msgname}: PASS but achieved=${JSON.stringify(achieved)} - metric measures traffic; verify data actually flowed`);
        }
      }
    }
  }

  const ok = checks.every((c) => c.ok);
  return { name: 'criteria', ok, warnings, checks, hasWarnings: warnings.length > 0 };
}

/** Stats sanity: range-check every numeric field we know how to bound. */
export function verifyStatsSanity(input: { cellsSummary?: any; ueSummary?: any; global?: any }): VerificationDimension {
  const checks: VerificationCheck[] = [];
  const warnings: string[] = [];

  // Field -> [min, max] (inclusive). `null` means "no bound on that side".
  const RANGES: Record<string, [number | null, number | null]> = {
    bler:               [0, 100],
    blerDl:             [0, 100],
    blerUl:             [0, 100],
    avg_dl_bler:        [0, 100],
    avg_ul_bler:        [0, 100],
    throughput:         [0, null],
    throughputDl:       [0, null],
    throughputUl:       [0, null],
    avg_dl_throughput:  [0, null],
    avg_ul_throughput:  [0, null],
    rsrp:               [-140, -44],
    rsrq:               [-30, 0],
    sinr:               [-30, 50],
    cqi:                [0, 15],
    mcs:                [0, 31],
    rank:               [1, 4],
    attachedUes:        [0, null],
    attached_ues:       [0, null],
  };

  function rangeCheck(prefix: string, obj: any) {
    if (!obj || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'number' && Number.isFinite(v)) {
        const lk = k.toLowerCase();
        const range = RANGES[k] ?? RANGES[lk];
        if (!range) continue;
        const [lo, hi] = range;
        const inRange = (lo === null || v >= lo) && (hi === null || v <= hi);
        checks.push({
          name: `${prefix}.${k}`,
          ok: inRange,
          value: v,
          expected: `${lo === null ? '-inf' : lo} <= value <= ${hi === null ? '+inf' : hi}`,
        });
        if (!inRange) warnings.push(`${prefix}.${k}=${v} outside [${lo ?? '-inf'}, ${hi ?? '+inf'}]`);
      } else if (Array.isArray(v)) {
        v.forEach((item, i) => rangeCheck(`${prefix}.${k}[${i}]`, item));
      } else if (typeof v === 'object' && v !== null) {
        rangeCheck(`${prefix}.${k}`, v);
      }
    }
  }

  rangeCheck('cellsSummary', input.cellsSummary);
  rangeCheck('ueSummary', input.ueSummary);
  rangeCheck('global', input.global);

  if (checks.length === 0) {
    checks.push({
      name: 'stats responses present',
      ok: false,
      value: 'all empty',
      expected: 'at least one of cells-summary / ue-summary / global must return data',
    });
  }

  const ok = checks.every((c) => c.ok);
  return { name: 'statsSanity', ok, warnings, checks, hasWarnings: warnings.length > 0 };
}

/** Cleanup: simulator returned to available, no orphans (best-effort). */
export function verifyCleanup(input: { simulators?: any; simulatorStatus?: any; targetSimulatorId?: string | number }): VerificationDimension {
  const checks: VerificationCheck[] = [];
  const warnings: string[] = [];

  const items: any[] = input.simulators?.items ?? [];
  const target = items.find((s) => String(s.id) === String(input.targetSimulatorId));

  if (target) {
    const avail = String(target.availability ?? '').toLowerCase();
    checks.push({
      name: `simulator ${target.id} availability`,
      ok: avail === 'available' || avail === 'idle',
      value: target.availability ?? '<missing>',
      expected: 'available (the simulator must be free for the next run)',
    });

    const stab = String(target.stability ?? '').toLowerCase();
    checks.push({
      name: `simulator ${target.id} stability`,
      ok: stab === '' || stab === 'stable' || stab === 'unknown',
      value: target.stability ?? '<missing>',
      expected: 'stable (or absent)',
    });

    const conn = String(target.connectivity ?? '').toLowerCase();
    checks.push({
      name: `simulator ${target.id} connectivity`,
      ok: conn === '' || conn === 'connected' || conn === 'online' || conn === 'unknown',
      value: target.connectivity ?? '<missing>',
      expected: 'connected (or absent)',
    });
  } else if (input.targetSimulatorId !== undefined) {
    checks.push({
      name: `simulator ${input.targetSimulatorId} present in /simulators list`,
      ok: false,
      value: '<not found>',
      expected: 'the simulator that ran the testcase must still appear in the list',
    });
  } else {
    checks.push({
      name: 'simulators list reachable',
      ok: items.length > 0,
      value: `${items.length} item(s)`,
      expected: 'at least one simulator registered',
    });
  }

  const ok = checks.every((c) => c.ok);
  return { name: 'cleanup', ok, warnings, checks, hasWarnings: warnings.length > 0 };
}

// ---------- Async orchestrator ----------

async function tryGetJson(opts: ApiOpts, token: string, path: string): Promise<any | undefined> {
  try {
    const res = await fetch(`http://${opts.host}/v2${path}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return undefined;
    return await res.json().catch(() => undefined);
  } catch { return undefined; }
}

/**
 * Pull the four data sources we verify against and produce a report.
 *
 * @param apiOpts        host/user/pass for the box
 * @param token          bearer token (already issued)
 * @param execution      the lastExecution object pulled from /testcases/{id}
 * @param simulatorId    id of the simulator that ran the testcase
 */
export async function runRunVerification(
  apiOpts: ApiOpts,
  token: string,
  execution: any,
  simulatorId?: string | number,
): Promise<VerificationReport> {
  const eid = execution?.executionId ?? execution?.id;

  // Stats endpoints want a time window in **Unix seconds** (not ISO). Use the
  // execution window with a small pad on either side; if anything is missing
  // fall back to a generous range.
  const executedOn = execution?.executedOn ? Math.floor(new Date(execution.executedOn).getTime() / 1000) : 0;
  const duration = Number(execution?.durationSeconds ?? 0);
  const padSec = 60;
  const startSec = executedOn ? executedOn - padSec : Math.floor(Date.now() / 1000) - 24 * 3600;
  const endSec = executedOn && duration ? executedOn + duration + padSec : Math.floor(Date.now() / 1000);
  const q = `?startTime=${startSec}&endTime=${endSec}`;

  // The box wraps stats responses as { code, message, data: {...} }. We
  // unwrap to data so the verifier sees the actual counters.
  const unwrap = (resp: any): any => (resp && typeof resp === 'object' && 'data' in resp ? resp.data : resp);

  const [statsGlobal, statsCellsSummary, statsUes, simulators, simulatorStatus] = await Promise.all([
    eid ? tryGetJson(apiOpts, token, `/testcases/executions/${encodeURIComponent(eid)}/statistics/global${q}`)         : undefined,
    eid ? tryGetJson(apiOpts, token, `/testcases/executions/${encodeURIComponent(eid)}/statistics/cells-summary${q}`)  : undefined,
    eid ? tryGetJson(apiOpts, token, `/testcases/executions/${encodeURIComponent(eid)}/statistics/ues${q}`)            : undefined,
    listSimulators(apiOpts).catch(() => undefined),
    simulatorId !== undefined ? getSimulatorStatus(apiOpts, String(simulatorId)).catch(() => undefined) : undefined,
  ]);

  const lifecycle = verifyLifecycle(execution);
  const criteria = verifyCriteria(execution);
  const statsSanity = verifyStatsSanity({ cellsSummary: unwrap(statsCellsSummary), ueSummary: unwrap(statsUes), global: unwrap(statsGlobal) });
  const cleanup = verifyCleanup({ simulators, simulatorStatus, targetSimulatorId: simulatorId });

  const dims = { lifecycle, criteria, statsSanity, cleanup };
  const allOk = Object.values(dims).every((d) => d.ok);
  const anyWarn = Object.values(dims).some((d) => d.hasWarnings);
  const overall: 'pass' | 'warn' | 'fail' = !allOk ? 'fail' : (anyWarn ? 'warn' : 'pass');

  return {
    generatedAt: new Date().toISOString(),
    overall,
    dimensions: dims,
    raw: { execution, statsGlobal, statsCellsSummary, statsUes, simulators, simulatorStatus },
  };
}

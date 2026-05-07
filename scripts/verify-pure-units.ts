// Smoke-test the pure verifier functions with constructed inputs.

import { verifyLifecycle, verifyCriteria, verifyStatsSanity, verifyCleanup } from '../src/lib/verification';

let failed = 0;
function expect(label: string, cond: boolean, detail?: string) {
  if (cond) { console.log(`  ok   ${label}`); }
  else      { console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`); failed++; }
}

// --- lifecycle ---
console.log('lifecycle');
{
  const good = verifyLifecycle({ status: 'COMPLETED', result: 'PASS', durationSeconds: 120 });
  expect('happy completed/pass/120s -> ok', good.ok && good.warnings.length === 0);
  const aborted = verifyLifecycle({ status: 'ABORTED', result: 'FAIL', durationSeconds: 30 });
  expect('aborted -> warning', aborted.warnings.some((w) => w.includes('ABORTED')));
  const zeroDur = verifyLifecycle({ status: 'COMPLETED', result: 'PASS', durationSeconds: 0 });
  expect('zero duration -> not ok', !zeroDur.ok);
  const noStatus = verifyLifecycle({});
  expect('missing status -> not ok', !noStatus.ok);
}

// --- criteria ---
console.log('criteria');
{
  const passReal = verifyCriteria({ executionResultDetails: JSON.stringify({
    bler: { bler: [{ msgname: 'Avg_DL_BLER', achieved: 1.5, demand: 5, condition: 'Avg_DL_BLER<=5%', verdict: true }], verdict: true },
  }) });
  expect('real pass with achieved=1.5 -> ok, no warnings', passReal.ok && passReal.warnings.length === 0);

  const passZero = verifyCriteria({ executionResultDetails: JSON.stringify({
    throughput: { throughput: [{ msgname: 'Avg_DL_Throughput', achieved: 0, demand: 50, condition: 'Avg_DL_Throughput>=50', verdict: true }], verdict: true },
  }) });
  expect('PASS with achieved=0 on throughput -> warning', passZero.ok && passZero.warnings.some((w) => w.includes('achieved=0')));

  const fail = verifyCriteria({ executionResultDetails: JSON.stringify({
    bler: { bler: [{ msgname: 'Avg_DL_BLER', achieved: 50, demand: 5, condition: 'Avg_DL_BLER<=5%', verdict: false }], verdict: false },
  }) });
  expect('failed verdict -> not ok', !fail.ok);

  const missing = verifyCriteria({});
  expect('no executionResultDetails -> not ok', !missing.ok);

  const ndStr = verifyCriteria({ executionResultDetails: '{not-json' });
  expect('garbage executionResultDetails -> not ok', !ndStr.ok);
}

// --- stats sanity ---
console.log('statsSanity');
{
  const sane = verifyStatsSanity({
    cellsSummary: { cells: [{ bler: 2.5, throughputDl: 100, rsrp: -85 }] },
    ueSummary: { ues: [{ cqi: 9, mcs: 12 }] },
  });
  expect('sane values -> ok', sane.ok && sane.warnings.length === 0);

  const bad = verifyStatsSanity({
    cellsSummary: { cells: [{ bler: 150, rsrp: 50 }] },
    ueSummary: { ues: [{ cqi: 99 }] },
  });
  expect('out-of-range values -> warnings AND not ok', !bad.ok && bad.warnings.length >= 3);

  const empty = verifyStatsSanity({});
  expect('all empty -> not ok', !empty.ok);
}

// --- cleanup ---
console.log('cleanup');
{
  const okSim = verifyCleanup({
    simulators: { items: [{ id: 8, availability: 'available', stability: 'stable', connectivity: 'connected' }] },
    targetSimulatorId: 8,
  });
  expect('available simulator -> ok', okSim.ok);

  const busy = verifyCleanup({
    simulators: { items: [{ id: 8, availability: 'busy', stability: 'stable', connectivity: 'connected' }] },
    targetSimulatorId: 8,
  });
  expect('busy simulator -> not ok', !busy.ok);

  const missing = verifyCleanup({
    simulators: { items: [{ id: 9 }] },
    targetSimulatorId: 8,
  });
  expect('missing simulator -> not ok', !missing.ok);
}

console.log(`\n${failed === 0 ? 'all pure verifier checks PASSED' : `${failed} CHECK(S) FAILED`}`);
process.exit(failed === 0 ? 0 : 1);

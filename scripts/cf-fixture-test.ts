// Offline unit test for the config-fidelity engine. Runs validateConfig against
// the real diag fixture (input intermediate-config <-> generated ue.cfg) — no
// box needed. Run: node node_modules/tsx/dist/cli.mjs scripts/cf-fixture-test.ts
import * as fs from 'fs';
import * as path from 'path';
import { validateConfig } from '../src/lib/configFidelity/validate';
import type { InputConfig } from '../src/lib/configFidelity/types';

const BUNDLE = path.join(process.cwd(), 'diag/unpacked/1CELL-UDP-256_Long-hour_diagnostics_20260531_184552');
const tc = JSON.parse(fs.readFileSync(path.join(BUNDLE, '1CELL-UDP-256_Long-hour.testcase.json'), 'utf8'));
let ico = tc.test_case_details[0].Test_Config_Intermediate_Object;
ico = typeof ico === 'string' ? JSON.parse(ico) : ico;
const input = ico as InputConfig;
const ue = JSON.parse(fs.readFileSync(path.join(BUNDLE, 'ue/config/ue.cfg'), 'utf8'));

const v = validateConfig(input, ue);
console.log('counts:', JSON.stringify(v.counts), 'ok:', v.ok);
console.log('\nparam results:');
for (const p of v.params) {
  const tag = p.status === 'honoured' ? 'OK  ' : p.status === 'mismatch' ? 'MISS' : p.status === 'missing' ? 'GAP ' : '?   ';
  console.log(`  ${tag} [${p.criticality.padEnd(8)}] ${p.label.padEnd(26)} exp=${JSON.stringify(p.expected)} act=${JSON.stringify(p.actual)}`);
}

// Assertions: the fixture's core params MUST be honoured.
const want = ['band', 'bandwidth', 'scs', 'antennas.dl', 'antennas.ul', 'NRARFCN.dl', 'NRARFCN.ssb', 'total UE count', 'sim_algo', 'as_release', 'cipher_algo_bitmap', 'integ_algo_bitmap', 'K', 'ratType → group_type'];
const byLabel = new Map(v.params.map((p) => [p.label, p]));
const fails: string[] = [];
for (const w of want) {
  const p = byLabel.get(w);
  if (!p) fails.push(`${w}: NO RESULT`);
  else if (p.status !== 'honoured') fails.push(`${w}: ${p.status} (exp=${JSON.stringify(p.expected)} act=${JSON.stringify(p.actual)})`);
}
if (fails.length) {
  console.error('\nFAILED assertions:\n  ' + fails.join('\n  '));
  process.exit(1);
}
console.log('\nALL CORE PARAMS HONOURED ✓');

// Drive runRunVerification against a real recently-completed execution on the
// live box. Picks the most recent testcase that has a lastExecution and runs
// the full verifier pipeline.

import { ensureToken, getTestcase, listTestcases, uesimEnvOpts } from '../src/lib/uesimClient';
import { runRunVerification } from '../src/lib/verification';

async function main() {
  const opts = uesimEnvOpts();
  const token = await ensureToken(opts.host, opts.username, opts.password);
  console.log('login ok');

  // Walk the list, find the first testcase with a lastExecution.
  const list = await listTestcases(opts, 50);
  let pick: any;
  for (const tc of list.items) {
    const full = await getTestcase(opts, tc.id);
    const last = (full.metadata as any)?.lastExecution;
    if (last && last.executionId) {
      pick = { id: tc.id, name: tc.name, last };
      break;
    }
  }
  if (!pick) {
    console.log('no testcase with a lastExecution found - run a testcase first, then re-run this script.');
    process.exit(0);
  }

  console.log(`\nseed: ${pick.id}  exec=${pick.last.executionId}  status=${pick.last.status}  result=${pick.last.result}  simulator=${pick.last.simulatorId}\n`);

  const report = await runRunVerification(opts, token, pick.last, pick.last.simulatorId);

  console.log('overall:', report.overall.toUpperCase());
  for (const k of ['lifecycle', 'criteria', 'statsSanity', 'cleanup'] as const) {
    const d = report.dimensions[k];
    const pf = d.checks.filter((c) => c.ok).length;
    console.log(`\n[${d.ok ? ' ok ' : 'FAIL'}] ${k}  ${pf}/${d.checks.length} checks  ${d.warnings.length} warning(s)`);
    for (const c of d.checks) {
      const tag = c.ok ? '   ok ' : '   FAIL';
      console.log(`${tag} ${c.name}  value=${JSON.stringify(c.value)}`);
      if (!c.ok && c.expected) console.log(`        expected: ${c.expected}`);
    }
    for (const w of d.warnings) console.log(`   WARN  ${w}`);
  }

  // Persist for later viewing
  const fs = await import('node:fs');
  const path = await import('node:path');
  const outDir = path.resolve(process.cwd(), 'scripts/.out');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `verification-${pick.last.executionId}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nfull report -> ${outPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

// Does the run detail's Validation panel have what it needs?
//
// Walks the same path the page takes: GET the run (for its box ids), then GET
// the testcase through that login, then find the row's executionId in the
// box's own execution history and read its status, result and checks.
//
// Read-only. Nothing here starts an execution.
//
//   npx tsx scripts/probe-run-validation.ts [baseUrl] [limit]
import { boxExecutionsOf } from '../src/lib/boxExecutions';

const BASE = process.argv[2] ?? 'http://192.168.1.36:4100';
const LIMIT = Number(process.argv[3] ?? 6);

const j = (u: string) => fetch(u, { cache: 'no-store' as RequestCache }).then((r) => r.json());

const hist: any = await j(`${BASE}/api/automation/history?limit=${LIMIT}`);

for (const h of (hist.runs ?? []) as any[]) {
  if (!h.runId) continue;
  const det: any = await j(`${BASE}/api/automation/runs/${h.runId}`);
  if (!det?.ok) { console.log(`\n== ${h.runId}: ${det?.error}`); continue; }
  console.log(`\n== ${det.run.suiteName}  ${det.run.uesimHost}  box=${JSON.stringify(det.box)}`);
  if (!det.box?.systemId) { console.log('   no system resolved — the panel would say so'); continue; }

  for (const st of (det.run.steps ?? []) as any[]) {
    const label = String(st.testcaseId).slice(0, 42).padEnd(44);
    if (!st.executionId || !st.boxTestcaseId) { console.log(`   ${label} no execution to ask about`); continue; }
    const qs = new URLSearchParams({ systemId: det.box.systemId });
    if (det.box.boxUserId) qs.set('boxUserId', det.box.boxUserId);
    const tc: any = await j(`${BASE}/api/testcases/${encodeURIComponent(st.boxTestcaseId)}?${qs}`);
    if (tc?.error) { console.log(`   ${label} box said: ${String(tc.error).slice(0, 70)}`); continue; }
    const exec = boxExecutionsOf(tc?.metadata).find((x) => x.executionId === st.executionId);
    if (!exec) { console.log(`   ${label} execution ${String(st.executionId).slice(0, 8)} not listed by the box`); continue; }
    console.log(`   ${label} status=${String(exec.status ?? '-').padEnd(11)} result=${String(exec.result ?? '-').padEnd(11)}`
      + `checks=${String(exec.checks.length).padStart(2)}  ${exec.running ? '(running)' : ''}${exec.parseError ?? ''}`);
    for (const c of exec.checks.slice(0, 3)) {
      console.log(`        ${c.condition.padEnd(34)} needed=${c.demand ?? '-'} got=${c.achieved ?? '-'} ${c.verdict ? 'PASS' : 'FAIL'}`);
    }
    if (exec.checks.length > 3) console.log(`        … ${exec.checks.length - 3} more`);
  }
}

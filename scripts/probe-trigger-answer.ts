// What does POST /v2/testcases/{id}/executions actually answer?
//
// The runner aborts that POST after 3s and treats the AbortError as 202,
// because the box takes ~26s to answer and starts the run anyway. Which means
// a genuine rejection arriving at 26s is recorded as a successful trigger, and
// the run then waits out its whole window for an execution that never began.
//
// This waits for the real answer and prints it, then reports whether
// lastExecution moved.
//
//   npx tsx scripts/probe-trigger-answer.ts <host> <user> <pass> <testcaseId> [simulatorId]
import { ensureToken, getTestcase, listSimulators, type ApiOpts } from '../src/lib/uesimClient';

const [, , host, username, password, tcId, simArg] = process.argv;
const token = await ensureToken(host, username, password);
const opts = { host, username, password } as ApiOpts;

const sims: any = await listSimulators(opts);
console.log('simulators:');
for (const s of sims.items ?? []) {
  console.log('  id=' + s.id + ' name=' + s.name + ' type=' + s.type
    + ' availability=' + (s.availability ?? '-') + ' connectivity=' + (s.connectivity ?? '-'));
}
const simulatorId = simArg ?? (sims.items ?? [])[0]?.id;

const before: any = await getTestcase(opts, tcId);
const le0 = before?.metadata?.lastExecution;
console.log('\nbefore: lastExecution id=' + (le0?.executionId ?? '(none)') + ' status=' + (le0?.status ?? '-'));
console.log('trigger body: ' + JSON.stringify({ simulatorId }));

const t0 = Date.now();
const resp = await fetch('http://' + host + '/v2/testcases/' + encodeURIComponent(tcId) + '/executions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
  body: JSON.stringify({ simulatorId }),
  signal: AbortSignal.timeout(180000),
});
const text = await resp.text();
console.log('\nanswered after ' + ((Date.now() - t0) / 1000).toFixed(1) + 's: HTTP ' + resp.status);
console.log('body: ' + text.slice(0, 1200));

const after: any = await getTestcase(opts, tcId);
const le1 = after?.metadata?.lastExecution;
console.log('\nafter: lastExecution id=' + (le1?.executionId ?? '(none)') + ' status=' + (le1?.status ?? '-'));
console.log('moved? ' + (le1?.executionId !== le0?.executionId ? 'YES — a new execution exists' : 'NO — nothing started'));

// How long does a SUCCESSFUL trigger take to answer, and what does it say?
//
// The runner aborts the POST after 3s and calls the AbortError a 202, so it
// never learns either. If a successful start answers promptly with an
// execution id, awaiting it is strictly better: the id is the strongest proof
// that a polled record is ours, and an HTTP-200 refusal
// ({"status":"Failure"}) stops being invisible.
//
// Triggers, times the answer, then stops the execution again.
//
//   npx tsx scripts/probe-trigger-timing.ts <host> <user> <pass> <testcaseId> <simulatorId>
import { ensureToken, getTestcase, type ApiOpts } from '../src/lib/uesimClient';

const [, , host, username, password, tcId, simId] = process.argv;
const token = await ensureToken(host, username, password);
const opts = { host, username, password } as ApiOpts;
const H = { 'content-type': 'application/json', authorization: 'Bearer ' + token };

const le0: any = (await getTestcase(opts, tcId))?.metadata?.lastExecution;
console.log('before: ' + (le0?.executionId ?? '(none)') + ' ' + (le0?.status ?? '-'));

const t0 = Date.now();
const resp = await fetch('http://' + host + '/v2/testcases/' + encodeURIComponent(tcId) + '/executions',
  { method: 'POST', headers: H, body: JSON.stringify({ simulatorId: simId }), signal: AbortSignal.timeout(180000) });
const text = await resp.text();
const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log('answered after ' + secs + 's: HTTP ' + resp.status);
console.log('body: ' + text.slice(0, 800));

const le1: any = (await getTestcase(opts, tcId))?.metadata?.lastExecution;
console.log('after: ' + (le1?.executionId ?? '(none)') + ' ' + (le1?.status ?? '-'));
console.log('id in the trigger body? ' + (le1?.executionId && text.includes(le1.executionId) ? 'YES' : 'no'));

if (le1?.executionId && le1.executionId !== le0?.executionId) {
  const s = await fetch('http://' + host + '/v2/testcases/executions/' + le1.executionId + '/stop?simulatorId=' + simId,
    { method: 'POST', headers: H, signal: AbortSignal.timeout(90000) });
  console.log('stop: HTTP ' + s.status + ' ' + (await s.text()).slice(0, 200));
}

// Can a 3-cell testcase run on a simulator that owns only 2 cards?
//
// The box refuses a trigger (HTTP 200, {"status":"Failure"}) when a cell names
// a card the simulator does not own. The definitions in
// /root/automation_configs were captured on boxes with other card
// assignments, so the question is whether remapping the cells onto the cards
// the chosen simulator DOES own is something the box accepts — including two
// cells sharing one card, which is unavoidable when 3 cells meet 2 cards.
//
// Writes the remap to the testcase, triggers, reads the real answer, then puts
// the original cards back.
//
//   npx tsx scripts/probe-rfcard-remap.ts <host> <user> <pass> <testcaseId> <simulatorId>
import { ensureToken, getTestcase, listSimulators, type ApiOpts } from '../src/lib/uesimClient';
import { updateTestcaseInPlace } from '../src/lib/automation/duplicateTestcase';

const [, , host, username, password, tcId, simId] = process.argv;
const token = await ensureToken(host, username, password);
const opts = { host, username, password } as ApiOpts;

const sims: any = await listSimulators(opts);
const sim = (sims.items ?? []).find((s: any) => String(s.id) === String(simId));
const owned: number[] = sim?.nodes?.rfCards ?? [];
console.log('simulator ' + simId + ' owns ' + JSON.stringify(owned));

const d: any = await getTestcase(opts, tcId);
const def = d.testDefinition;
const cells = def?.cellConfig?.cells ?? [];
const before = cells.map((c: any) => c.rfCard);
console.log('cells want ' + JSON.stringify(before));

/** Distinct wanted cards, in first-seen order, onto the owned cards in order,
 *  cycling when there are fewer owned than wanted. */
const wanted = [...new Set(before.map(Number))];
const map = new Map<number, number>();
wanted.forEach((w, i) => map.set(w, owned[i % owned.length]));
const after = before.map((b: number) => map.get(Number(b)));
console.log('remap ' + [...map.entries()].map(([a, b]) => a + '->' + b).join(', ') + '  =>  ' + JSON.stringify(after));

const trigger = async (label: string) => {
  const t0 = Date.now();
  const resp = await fetch('http://' + host + '/v2/testcases/' + encodeURIComponent(tcId) + '/executions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify({ simulatorId: simId }),
    signal: AbortSignal.timeout(180000),
  });
  const text = await resp.text();
  console.log('\n' + label + ': HTTP ' + resp.status + ' after ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
  console.log('  ' + text.slice(0, 600));
  return text;
};

const write = async (cards: any[], label: string) => {
  const next = JSON.parse(JSON.stringify(def));
  next.cellConfig.cells.forEach((c: any, i: number) => { c.rfCard = cards[i]; });
  delete next.settings;   // carries the source name; the box refuses the rename
  const r: any = await updateTestcaseInPlace(opts, tcId, next);
  console.log(label + ': ' + (r.error ? 'FAILED ' + String(r.error).slice(0, 200) : 'wrote ' + (r.updated ?? []).join(', ')));
  return !r.error;
};

try {
  if (await write(after, '\nwrite remapped cards')) {
    const body = await trigger('trigger with remapped cards');
    let parsed: any = {};
    try { parsed = JSON.parse(body); } catch {}
    console.log('\nverdict: ' + (String(parsed.status).toLowerCase() === 'failure'
      ? 'box still refuses — remapping is not enough'
      : 'box ACCEPTED the remapped definition'));
    if (String(parsed.status).toLowerCase() !== 'failure') {
      // leave it running? no — stop it, this is a probe
      const le: any = (await getTestcase(opts, tcId))?.metadata?.lastExecution;
      console.log('lastExecution now ' + (le?.executionId ?? '(none)') + ' status=' + (le?.status ?? '-'));
      if (le?.executionId) {
        const s = await fetch('http://' + host + '/v2/testcases/executions/' + le.executionId + '/stop?simulatorId=' + simId,
          { method: 'POST', headers: { authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(60000) });
        console.log('stopped: HTTP ' + s.status);
      }
    }
  }
} finally {
  await write(before, '\nrestore original cards');
}

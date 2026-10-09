// Every (status, result) pair the boxes have actually recorded, and the two
// words SimQA would show for it.
//
// The maps in outcome.ts are transcribed from the box's SPA bundle; this
// checks that nothing in the lab's real execution history falls outside them
// and ends up as "Unknown" or blank when the Simnovator would have had a word
// for it.
//
//   npx tsx scripts/probe-execution-labels.ts <host> <user> <pass> [max]
import { ensureToken, listTestcases, type ApiOpts } from '../src/lib/uesimClient';
import { statusLabel, verdictLabel } from '../src/lib/automation/outcome';

const [, , host, username, password, maxArg] = process.argv;
const opts: ApiOpts = { host, username, password } as ApiOpts;
await ensureToken(host, username, password);
const page = await listTestcases(opts, 1000, 0);
const items = (page.items ?? []).slice(0, Number(maxArg ?? 1000));

const seen = new Map<string, number>();
for (const t of items as any[]) {
  const le = t?.metadata?.lastExecution;
  const key = `${le?.status ?? '(no execution)'}\t${le?.result ?? '(none)'}`;
  seen.set(key, (seen.get(key) ?? 0) + 1);
}
console.log(`${host} as ${username}: ${items.length} testcases, ${seen.size} distinct status/result pairs\n`);
console.log('count  box status        box result        ->  Status            Verdict');
let unmapped = 0;
for (const [key, n] of [...seen.entries()].sort((a, b) => b[1] - a[1])) {
  const [status, result] = key.split('\t');
  const neverRun = status === '(no execution)';
  const o = neverRun ? { neverRun: true } : { boxStatus: status, boxResult: result === '(none)' ? undefined : result };
  const st = statusLabel(o);
  const vd = verdictLabel(o);
  const bad = st === 'Unknown' || (!neverRun && result !== '(none)' && vd === '');
  if (bad) unmapped++;
  console.log(`${String(n).padStart(5)}  ${status.padEnd(17)} ${result.padEnd(17)} ->  ${st.padEnd(17)} ${vd || '—'}${bad ? '   <<< UNMAPPED' : ''}`);
}
console.log(`\n${unmapped} pair(s) the labels do not cover`);

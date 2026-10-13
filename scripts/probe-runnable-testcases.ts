// Which testcases could actually run on a given simulator: distinct rfCards
// the cells need vs the cards the simulator owns. Cells may NOT share a card
// ("RF Card slot N is already occupied by another cell"), so the count matters
// as much as the values.
//
//   npx tsx scripts/probe-runnable-testcases.ts <host> <user> <pass> <simulatorId> [nameFilter]
import { ensureToken, listTestcases, getTestcase, listSimulators, type ApiOpts } from '../src/lib/uesimClient';

const [, , host, username, password, simId, filter] = process.argv;
await ensureToken(host, username, password);
const opts = { host, username, password } as ApiOpts;
const sims: any = await listSimulators(opts);
const owned: number[] = (sims.items ?? []).find((s: any) => String(s.id) === String(simId))?.nodes?.rfCards ?? [];
console.log('simulator ' + simId + ' owns ' + JSON.stringify(owned) + '\n');

const page: any = await listTestcases(opts, 1000, 0);
let items = page.items ?? [];
if (filter) items = items.filter((t: any) => new RegExp(filter, 'i').test(String(t.name)));
let fit = 0, unfit = 0;
const rows: string[] = [];
for (const t of items) {
  let d: any;
  try { d = await getTestcase(opts, t.id); } catch { continue; }
  const cells = d?.testDefinition?.cellConfig?.cells ?? [];
  const cards = cells.map((c: any) => Number(c.rfCard));
  const want = [...new Set(cards)];
  const dur = d?.testDefinition?.powerCycleConfig?.totalTestDuration ?? '-';
  const ok = want.length <= owned.length;
  const owns = want.every((w) => owned.includes(w));
  if (ok) fit++; else unfit++;
  rows.push([
    (ok ? (owns ? 'runs  ' : 'remap ') : 'NO    '),
    String(cells.length).padStart(2) + ' cells',
    'cards=' + JSON.stringify(cards).padEnd(12),
    'dur=' + String(dur).padEnd(6),
    t.name,
  ].join(' '));
}
rows.sort();
console.log(rows.join('\n'));
console.log('\nfit (<= ' + owned.length + ' distinct cards): ' + fit + ' | cannot fit: ' + unfit);

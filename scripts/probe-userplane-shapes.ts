// What does a user-plane profile actually look like, per data type?
//
// The duration rules have to be written against the real field names — loop,
// number of loops, inter-loop interval, call duration — and those are only
// knowable from the testcases the lab has built. Walks a box's catalogue,
// groups profiles by dataType and prints each distinct key set with a sample.
//
//   npx tsx scripts/probe-userplane-shapes.ts <host> <user> <pass> [max]
import { ensureToken, getTestcase, listTestcases, type ApiOpts } from '../src/lib/uesimClient';

const [, , host, username, password, maxArg] = process.argv;
if (!host || !username || !password) {
  console.error('usage: npx tsx scripts/probe-userplane-shapes.ts <host> <user> <pass> [max]');
  process.exit(2);
}
const max = Number(maxArg ?? 400);
const opts: ApiOpts = { host, username, password } as ApiOpts;
await ensureToken(host, username, password);

const page = await listTestcases(opts, 1000, 0);
const items = (page.items ?? []).slice(0, max);
console.log(`${host} as ${username}: ${page.total} testcases, inspecting ${items.length}`);

/** dataType -> key signature -> { count, sample, names } */
const byType = new Map<string, Map<string, { count: number; sample: any; names: string[] }>>();
const powerKeys = new Map<string, number>();
let read = 0, failed = 0;

for (const t of items) {
  let td: any;
  try { td = await getTestcase(opts, t.id); } catch { failed++; continue; }
  const def = td?.testDefinition ?? td?.definition ?? td;
  read++;
  for (const p of def?.powerCycleConfig?.profiles ?? []) {
    if (p && typeof p === 'object') {
      for (const k of Object.keys(p)) powerKeys.set(k, (powerKeys.get(k) ?? 0) + 1);
    }
  }
  for (const p of def?.userPlaneConfig?.profiles ?? []) {
    if (!p || typeof p !== 'object') continue;
    const type = String(p.dataType ?? '(none)');
    const sig = Object.keys(p).sort().join(',');
    const m = byType.get(type) ?? new Map();
    byType.set(type, m);
    const e = m.get(sig) ?? { count: 0, sample: p, names: [] as string[] };
    e.count++;
    if (e.names.length < 3) e.names.push(String(t.name));
    m.set(sig, e);
  }
}

console.log(`read ${read}, failed ${failed}\n`);
console.log('=== powerCycleConfig profile keys (how often each appears) ===');
console.log([...powerKeys.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}:${n}`).join('  '));

for (const [type, sigs] of [...byType.entries()].sort()) {
  const total = [...sigs.values()].reduce((a, b) => a + b.count, 0);
  console.log(`\n=== dataType "${type}" — ${total} profile(s), ${sigs.size} distinct shape(s) ===`);
  const ranked = [...sigs.entries()].sort((a, b) => b[1].count - a[1].count);
  for (const [, e] of ranked.slice(0, 2)) {
    console.log(`  x${e.count}  e.g. ${e.names.join(', ')}`);
    const keep: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(e.sample)) {
      if (v === null || typeof v !== 'object') keep[k] = v;
      else keep[k] = Array.isArray(v) ? `[${v.length}]` : `{${Object.keys(v).join('|')}}`;
    }
    console.log('  ' + JSON.stringify(keep));
  }
  // Every key seen for this type, so nothing is missed by only showing two shapes.
  const all = new Set<string>();
  for (const sig of sigs.keys()) for (const k of sig.split(',')) all.add(k);
  console.log('  all keys: ' + [...all].sort().join(', '));
}

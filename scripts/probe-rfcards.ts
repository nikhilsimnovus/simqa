// Which radio cards does each simulator own, and which does a testcase ask
// for? The box refuses a trigger with HTTP 200 + {"status":"Failure"} when a
// cell names a card the chosen simulator does not have:
//   "The test uses sdr4, which is not assigned to this simulator"
//
//   npx tsx scripts/probe-rfcards.ts <host> <user> <pass> [testcaseId]
import { ensureToken, listSimulators, getTestcase, type ApiOpts } from '../src/lib/uesimClient';

const [, , host, username, password, tcId] = process.argv;
await ensureToken(host, username, password);
const opts = { host, username, password } as ApiOpts;

const sims: any = await listSimulators(opts);
console.log('as ' + username + ':');
for (const s of sims.items ?? []) {
  console.log('  sim ' + s.id + ' "' + s.name + '" cards=' + JSON.stringify(s.nodes?.rfCards ?? null)
    + ' users=' + JSON.stringify((s.nodes?.assignedUsers ?? []).map((u: any) => u.username)));
}

// and as admin, where nodes is populated
try {
  await ensureToken(host, 'admin', 'admin');
  const a: any = await listSimulators({ host, username: 'admin', password: 'admin' } as ApiOpts);
  console.log('as admin:');
  for (const s of a.items ?? []) {
    console.log('  sim ' + s.id + ' "' + s.name + '" cards=' + JSON.stringify(s.nodes?.rfCards ?? null)
      + ' users=' + JSON.stringify((s.nodes?.assignedUsers ?? []).map((u: any) => u.username)));
  }
} catch (e: any) { console.log('as admin: ' + e.message); }

if (tcId) {
  const d: any = await getTestcase(opts, tcId);
  const cells = d?.testDefinition?.cellConfig?.cells ?? [];
  console.log('\ntestcase cells (' + cells.length + '):');
  for (const c of cells) {
    const keys = Object.keys(c).filter(k => /sdr|card|rf|radio|device/i.test(k));
    console.log('  ' + (c.cellId ?? c.id ?? '?') + ' ' + JSON.stringify(Object.fromEntries(keys.map(k => [k, c[k]]))));
  }
  // anything anywhere in the definition mentioning sdr
  const flat = JSON.stringify(d?.testDefinition ?? {});
  const sdrs = [...new Set(flat.match(/sdr[0-9]+/gi) ?? [])];
  console.log('  sdr mentions anywhere in the definition: ' + JSON.stringify(sdrs));
}

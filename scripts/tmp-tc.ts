import { ensureToken, getTestcase, listTestcases, type ApiOpts } from '../src/lib/uesimClient';
const [, , host, u, p, name, id] = process.argv;
const opts: ApiOpts = { host, username: u, password: p } as ApiOpts;
await ensureToken(host, u, p);
const page = await listTestcases(opts, 1000, 0);
const byName = (page.items ?? []).filter((t: any) => String(t.name) === name);
console.log(`${host} as ${u}: ${page.total} testcases; named "${name}": ${byName.length}`);
for (const t of byName as any[]) {
  const le = t.metadata?.lastExecution ?? {};
  console.log(`   id=${t.id}`);
  console.log(`   lastExecution: id=${le.executionId} status=${le.status} result=${le.result} dur=${le.durationSeconds}s`);
  console.log(`   created=${t.metadata?.createdOn} modified=${t.metadata?.lastModifiedOn}`);
}
if (id) {
  try { const t: any = await getTestcase(opts, id); console.log(`\nby id ${id}: FOUND, name="${t.name}"`); }
  catch (e: any) { console.log(`\nby id ${id}: ${String(e.message).slice(0, 120)}`); }
}

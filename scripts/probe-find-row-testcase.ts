// Which login on a Simnovator actually holds a given testcase, and what its
// last execution says. The catalogue is scoped per login, so "not visible in
// the Simnovator" and "the runner reused it" can both be true at once.
//
//   npx tsx scripts/probe-find-row-testcase.ts <host> <name-fragment>
import { ensureToken, listTestcases, getTestcase, type ApiOpts } from '../src/lib/uesimClient';

const [, , host, frag] = process.argv;
const logins: Array<[string, string]> = [['simuser', 'simuser'], ['sruthi', 'sruthi'], ['admin', 'admin']];

for (const [u, p] of logins) {
  let o: ApiOpts;
  try {
    await ensureToken(host, u, p);
    o = { host, username: u, password: p } as ApiOpts;
  } catch (e: any) {
    console.log('--- ' + u + ': login failed ' + e.message);
    continue;
  }
  let items: any[] = [];
  try {
    const page: any = await listTestcases(o, 1000, 0);
    items = page.items ?? [];
  } catch (e: any) {
    console.log('--- ' + u + ': list failed ' + e.message);
    continue;
  }
  const re = new RegExp(frag, 'i');
  const hits = items.filter((t: any) => re.test(String(t.name)));
  console.log('--- ' + u + ': ' + items.length + ' testcases, ' + hits.length + ' matching ' + frag);
  for (const h of hits) {
    console.log('    ' + String(h.id).slice(0, 8) + '  ' + h.name);
    try {
      const d: any = await getTestcase(o, h.id);
      const le = d?.metadata?.lastExecution ?? d?.lastExecution;
      console.log('      modified: ' + (d?.metadata?.lastModifiedOn ?? h.lastModifiedOn ?? '-'));
      console.log('      lastExecution: ' + (le ? JSON.stringify(le).slice(0, 400) : '(none)'));
    } catch (e: any) {
      console.log('      detail failed ' + e.message);
    }
  }
}

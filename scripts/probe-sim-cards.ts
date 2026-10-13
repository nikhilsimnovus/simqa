// Radio cards per simulator, across the Simnovators in the inventory.
//
// A testcase needs one card per cell and the cells may not share, so a
// 3-cell definition can only run where a simulator owns 3 cards. This says
// where that is.
//
//   npx tsx scripts/probe-sim-cards.ts <host> <user> <pass> [<host> <user> <pass> ...]
import { ensureToken, listSimulators, type ApiOpts } from '../src/lib/uesimClient';

const args = process.argv.slice(2);
for (let i = 0; i + 2 < args.length + 1; i += 3) {
  const [host, username, password] = [args[i], args[i + 1], args[i + 2]];
  if (!host) break;
  try {
    await ensureToken(host, username, password);
    const sims: any = await listSimulators({ host, username, password } as ApiOpts);
    const rows = (sims.items ?? []).map((s: any) => {
      const cards = s?.nodes?.rfCards ?? [];
      return '  sim ' + String(s.id).padEnd(4) + String(s.name ?? '?').padEnd(12)
        + cards.length + ' cards [' + cards.join(', ') + ']'
        + '  ' + (s.availability ?? '-');
    });
    console.log(host + ' as ' + username + ':');
    console.log(rows.length ? rows.join('\n') : '  (no simulators)');
  } catch (e: any) {
    console.log(host + ' as ' + username + ': ' + String(e.message).slice(0, 120));
  }
}

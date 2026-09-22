// Ask a Simnovator what every registered user is doing.
//
// One request pair (simulators + testcases) per box login, in parallel. Each
// operator's token only shows their own simulator and testcases, so this is
// the only way to see sruthi's and mohan's runs without holding admin
// credentials — and the stitching lives in boxActivityCore.ts.

import { listSimulators, listTestcases } from './uesimClient';
import { listBoxUsers, type InventorySystem } from './inventory';
import { attributeBoxActivity, type LoginView } from './boxActivityCore';

export type { BoxExecution, BoxUserState } from './boxActivityCore';

/** Plenty for one operator's catalogue; the box caps a page at 1000. */
const PAGE = 1000;

async function viewAs(host: string, username: string, password: string): Promise<LoginView> {
  const opts = { host, username, password };
  try {
    const [sims, tcs] = await Promise.all([listSimulators(opts), listTestcases(opts, PAGE, 0)]);
    return { username, simulators: (sims.items ?? []) as any[], testcases: (tcs.items ?? []) as any[] };
  } catch (e: any) {
    // Never the password, never a stack.
    const msg = String(e?.message ?? e);
    return {
      username,
      simulators: [],
      testcases: [],
      error: /401|403|login failed/i.test(msg) ? 'the box rejected this login' : 'the box did not answer',
    };
  }
}

/** Every execution on the box, labelled with who ran it, plus each user's
 *  live state. Reads through every login the setup registers. */
export async function collectBoxActivity(sys: Pick<InventorySystem, 'host' | 'uesim' | 'uesimUsers'>) {
  const logins = listBoxUsers(sys as any);
  const views = await Promise.all(logins.map((u) => viewAs(sys.host, u.username, u.password)));
  return attributeBoxActivity(views);
}

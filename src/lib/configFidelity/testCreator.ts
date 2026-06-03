// Create a Simnovator test case from a Case via the /tests/* "test-creator"
// sequence. Order + quirks are mandatory and were validated live against the
// box (see apiTester.ts tc-create-lifecycle):
//   cells -> subscribers -> user-plane -> power-cycle -> mobility -> settings
//   • master.product MUST be "UE-SIM"; cells[].bandwidth is a STRING
//   • subscriber startingIMSI is a NUMBER; opc 32-hex or omitted
//   • sections are order-dependent (each gated on the previous); mobility needs
//     power-cycle and must precede settings; settings finalises/locks the case.

import { ensureToken } from '../uesimClient';
import type { Case } from './types';

export interface ApiOpts { host: string; username: string; password: string }

async function call(opts: ApiOpts, method: 'POST' | 'DELETE', pathStr: string, body?: unknown): Promise<{ status: number; json: any; text: string }> {
  const token = await ensureToken(opts.host, opts.username, opts.password);
  const res = await fetch(`http://${opts.host}/v2${pathStr}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text().catch(() => '');
  let json: any; try { json = text ? JSON.parse(text) : undefined; } catch { /* keep text */ }
  return { status: res.status, json, text };
}

export class CreateError extends Error {
  constructor(public section: string, public status: number, public body: string) {
    super(`create ${section} returned ${status}: ${body.slice(0, 200)}`);
    this.name = 'CreateError';
  }
}

/** Create the test case. Throws CreateError if any section is rejected — a
 *  rejection here is itself a config error (the box refused the config). */
export async function createTestCase(opts: ApiOpts, c: Case): Promise<{ testCaseId: string; testCaseName?: string }> {
  const cells = await call(opts, 'POST', '/tests/cells', c.cells);
  if (cells.status !== 200 || !cells.json?.testCaseId) throw new CreateError('cells', cells.status, cells.text);
  const id: string = cells.json.testCaseId;

  const section = async (slug: string, body: unknown) => {
    if (body === undefined) return;
    const r = await call(opts, 'POST', `/tests/${encodeURIComponent(id)}/${slug}`, body);
    if (r.status !== 200) {
      // Best-effort cleanup so a rejected case doesn't leak.
      await call(opts, 'DELETE', `/testcases/${encodeURIComponent(id)}`).catch(() => {});
      throw new CreateError(slug, r.status, r.text);
    }
  };

  await section('subscribers', c.subscribers);
  await section('user-plane', c.userPlane);
  await section('power-cycle', c.powerCycle);   // must precede mobility
  await section('mobility', c.mobility);         // optional; needs power-cycle
  await section('settings', c.settings);         // finaliser

  return { testCaseId: id, testCaseName: cells.json?.testCaseName };
}

export async function deleteTestCase(opts: ApiOpts, id: string): Promise<number> {
  const r = await call(opts, 'DELETE', `/testcases/${encodeURIComponent(id)}`);
  return r.status;
}

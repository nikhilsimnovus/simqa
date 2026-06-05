// Discovery: probe a Simnovator/UESIM box's /v2/testcases catalogue to
// answer "for each canonical name in our SAMPLE_TESTS catalog, which
// testcase id (if any) lives on the box?".
//
// Matching is intentionally lenient:
//   - exact id match  (Sample-NR-SA-Latency-Ping_)
//   - exact name match (case-insensitive)
//   - prefix match    (handles owner-suffix workarounds like  -admin_)
// First non-empty match wins; an empty result means "not yet authored".

import type { Inventory } from '@/lib/inventory';
import { uesimApiOptsForSystem } from '@/lib/inventory';
import { SAMPLE_TESTS, type SampleTestEntry } from './catalog';

export interface DiscoveredSample extends SampleTestEntry {
  /** Box-side testcase id (if found), else undefined → "not yet authored". */
  boxId?: string;
  /** Box-side display name (informational; differs from canonical when the
   *  team appended a suffix like _admin during the SIM40-1976 workaround). */
  boxName?: string;
  /** True if the testcase has run at least once (metadata.lastExecution set). */
  hasRun?: boolean;
  /** ISO timestamp of the last execution, if any. */
  lastExecutedOn?: string;
  /** Verdict / result of the last execution (PASSED / FAILED / ABORTED). */
  lastResult?: string;
}

export async function discoverSamples(inv: Inventory, systemId: string): Promise<{
  ok: boolean;
  error?: string;
  systemId: string;
  systemHost?: string;
  results: DiscoveredSample[];
}> {
  const target = uesimApiOptsForSystem(inv, systemId);
  if (!target) return { ok: false, error: `system "${systemId}" not UESIM-capable`, systemId, results: [] };

  // Login (5s timeout — fail fast).
  const lr = await fetch(`http://${target.host}/v2/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: target.username, password: target.password }),
  });
  if (!lr.ok) return { ok: false, error: `login: ${lr.status}`, systemId, systemHost: target.host, results: [] };
  const lj: any = await lr.json();
  const token = lj.access_token ?? lj.token;

  // Pull a wide page of testcases — the catalogue typically has <2000 rows
  // and we want to do all 19 name-lookups against ONE list rather than 19
  // separate /search calls.
  const sr = await fetch(`http://${target.host}/v2/testcases/search`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ offset: 0, limit: 2000 }),
  });
  if (!sr.ok) return { ok: false, error: `testcases search: ${sr.status}`, systemId, systemHost: target.host, results: [] };
  const sj: any = await sr.json();
  const items: any[] = sj.items ?? sj.data ?? [];

  // Build a quick lookup map by lowercased name + id.
  const byKey = new Map<string, any>();
  for (const it of items) {
    if (it?.id)   byKey.set(String(it.id).toLowerCase(), it);
    if (it?.name) byKey.set(String(it.name).toLowerCase(), it);
  }

  const results: DiscoveredSample[] = [];
  for (const entry of SAMPLE_TESTS) {
    const want = entry.name.toLowerCase();
    // 1) exact id match (with or without trailing underscore)
    let hit = byKey.get(want) ?? byKey.get(want + '_');
    // 2) prefix match — covers owner-suffix workarounds (e.g. <name>_admin_)
    if (!hit) {
      for (const it of items) {
        const nm = String(it?.name ?? '').toLowerCase();
        const id = String(it?.id ?? '').toLowerCase();
        if (nm === want || id.startsWith(want)) { hit = it; break; }
      }
    }
    const r: DiscoveredSample = { ...entry };
    if (hit) {
      r.boxId   = hit.id;
      r.boxName = hit.name;
      r.lastExecutedOn = hit.metadata?.lastExecution?.executedOn;
      r.lastResult     = hit.metadata?.lastExecution?.result;
      r.hasRun         = !!r.lastExecutedOn;
    }
    results.push(r);
  }
  return { ok: true, systemId, systemHost: target.host, results };
}

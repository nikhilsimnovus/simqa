// testcaseBackup.ts — pull every testcase off a Simnovator system as one
// downloadable JSON file.
//
// Why this exists: the product's bulk-export endpoint (POST /v2/testcases/export)
// silently drops most testcases on large requests (SIM40-2010 — 1048 requested
// → 77 returned). It's also tarball-only. We work around both issues by
// paginating /v2/testcases/search ourselves and serialising the metadata to
// JSON.
//
// Caveat: today the search response contains testcase METADATA only (id,
// name, description, last-execution info). It does NOT include the cfg text
// of each testcase — that requires SIM40-2060 (GET /v2/testcases/{id}/cfg)
// which doesn't exist yet. So this is a metadata-level backup, suitable for
// re-creating the testcase index on a target system but not for transferring
// the cfg payload.

import type { Inventory } from './inventory';
import { uesimApiOptsForSystem } from './inventory';

export interface TestcaseExport {
  manifest: {
    version: 1;
    exportedAt: string;
    source: {
      systemId: string;
      host: string;
      name: string;
    };
    /** Number of testcases pulled. May differ from server's claimed total if
     *  pagination stops early (e.g., the server returns fewer items than
     *  requested before reaching the claimed total). */
    pulled: number;
    /** What the server told us the total was. Useful to detect SIM40-2010-style
     *  silent dropouts when pulled < serverTotal. */
    serverTotal: number;
  };
  testcases: any[];
}

interface ExportOptions {
  /** Page size for /v2/testcases/search. Default 50. */
  pageSize?: number;
  /** Hard cap on pages — defence against runaway loops. Default 200 (= 10,000
   *  testcases). */
  maxPages?: number;
  /** Optional progress callback — fired after each page is fetched. */
  onProgress?: (info: { pulled: number; serverTotal: number; page: number }) => void;
}

export async function exportTestcases(
  inv: Inventory,
  systemId: string,
  opts: ExportOptions = {},
): Promise<TestcaseExport> {
  const target = uesimApiOptsForSystem(inv, systemId);
  if (!target) throw new Error(`system "${systemId}" not found or not UESIM-capable`);

  const pageSize = opts.pageSize ?? 50;
  const maxPages = opts.maxPages ?? 200;

  // 1. Login
  const loginRes = await fetch(`http://${target.host}/v2/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: target.username, password: target.password }),
  });
  if (!loginRes.ok) {
    const body = await loginRes.text().catch(() => '');
    throw new Error(`login to ${target.host} failed: HTTP ${loginRes.status} ${body.slice(0, 200)}`);
  }
  const loginJson: any = await loginRes.json();
  const token = loginJson.access_token ?? loginJson.token ?? loginJson.jwt;
  if (!token) throw new Error('login response did not include a token (looked for access_token / token / jwt)');

  // 2. Paginate /v2/testcases/search
  const all: any[] = [];
  let serverTotal = 0;
  let offset = 0;
  let page = 0;
  while (page < maxPages) {
    const sr = await fetch(`http://${target.host}/v2/testcases/search`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ offset, limit: pageSize }),
    });
    if (!sr.ok) {
      const body = await sr.text().catch(() => '');
      throw new Error(`testcase search failed at offset ${offset}: HTTP ${sr.status} ${body.slice(0, 200)}`);
    }
    const j: any = await sr.json();
    const items = j.items ?? j.testcases ?? j.data ?? [];
    serverTotal = j.total ?? j.totalCount ?? serverTotal;
    if (!Array.isArray(items) || items.length === 0) break;
    all.push(...items);
    page += 1;
    opts.onProgress?.({ pulled: all.length, serverTotal, page });
    // Stop conditions:
    //   • server told us a total and we've hit it
    //   • server returned fewer than we asked for (last page)
    if (serverTotal > 0 && all.length >= serverTotal) break;
    if (items.length < pageSize) break;
    offset += items.length;
  }

  return {
    manifest: {
      version: 1,
      exportedAt: new Date().toISOString(),
      source: { systemId: target.systemId, host: target.host, name: target.name },
      pulled: all.length,
      serverTotal,
    },
    testcases: all,
  };
}

/** Suggested filename for the download (includes system id + timestamp). */
export function testcaseExportFilename(systemId: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safeId = systemId.replace(/[^A-Za-z0-9_.\-]/g, '_');
  return `testcases-${safeId}-${stamp}.json`;
}

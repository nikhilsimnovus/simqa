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
  //
  // The search endpoint pages on pageNumber/pageSize (1-based), NOT
  // offset/limit — and it does not reject the wrong vocabulary, it answers 200
  // with page 1 again. This loop sent {offset, limit} and advanced offset by
  // the row count, so every request after the first re-read page 1 and the
  // backup filled up with the same testcases repeated until it reached
  // serverTotal. The manifest then reported a complete pull. Verified on .95:
  // {offset:50,limit:50} returns byte-identical rows to {offset:0,limit:50},
  // while {pageNumber:2} returns genuinely different ones.
  //
  // Deduping by id is kept as a belt-and-braces guard: this box also returns
  // the same id twice inside a single page (491 unique of 500 on .95), so an
  // archive keyed on id would otherwise contain collisions.
  const all: any[] = [];
  const seenIds = new Set<string>();
  let serverTotal = 0;
  let page = 0;
  while (page < maxPages) {
    const sr = await fetch(`http://${target.host}/v2/testcases/search`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ pageNumber: page + 1, pageSize }),
    });
    if (!sr.ok) {
      const body = await sr.text().catch(() => '');
      throw new Error(`testcase search failed at page ${page + 1}: HTTP ${sr.status} ${body.slice(0, 200)}`);
    }
    const j: any = await sr.json();
    const items = j.items ?? j.testcases ?? j.data ?? [];
    serverTotal = j.total ?? j.totalCount ?? serverTotal;
    if (!Array.isArray(items) || items.length === 0) break;

    let fresh = 0;
    for (const t of items) {
      const id = String(t?.id ?? '');
      if (id && seenIds.has(id)) continue;
      if (id) seenIds.add(id);
      all.push(t);
      fresh += 1;
    }
    page += 1;
    opts.onProgress?.({ pulled: all.length, serverTotal, page });

    // A page that adds nothing new means we are re-reading — stop rather than
    // spin to maxPages. This is the condition that would have caught the
    // offset/limit bug immediately instead of producing a plausible archive.
    if (fresh === 0) break;
    if (items.length < pageSize) break;
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

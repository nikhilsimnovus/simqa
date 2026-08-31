// GET /api/testcases?limit&offset&systemId&refresh
//
// systemId picks WHICH box to list from — without it you always got the first
// UESIM in inventory, so a second box's testcases were unreachable from the UI.
// The response echoes the resolved host so the page can show what it listed.
//
// The box takes ~2.3s to return 500 testcases, which made every visit to the
// Test Cases page feel broken. Results are held in a short-lived in-process
// cache so revisits and box-switching are instant; `refresh=1` bypasses it,
// and the response carries `cached`/`ageMs` so the UI can say what it showed.

import { NextResponse } from 'next/server';
import { listTestcases } from '@/lib/uesimClient';
import { uesimApiOptsForSystem, loadInventory } from '@/lib/inventory';

export const dynamic = 'force-dynamic';

/** Short enough that a testcase you just created shows up on the next visit. */
const TTL_MS = 30_000;
const cache = new Map<string, { at: number; payload: any }>();

/** The box rejects pageSize > 1000 ("Invalid 'pageSize' query parameter"), so
 *  anything larger has to be walked page by page. */
const BOX_MAX_PAGE = 1000;

/** Fetch up to `limit` testcases, paging past the box's per-request cap so a
 *  catalogue bigger than one page still comes back whole.
 *
 *  Deduplicates by id: the box's ordering is not stable across requests (an
 *  in-flight execution keeps rewriting lastExecution), so consecutive offset
 *  windows can overlap. Without this the list returned the same testcase twice
 *  and silently dropped however many it double-counted. */
async function listAll(opts: any, limit: number, startPage: number) {
  const seen = new Set<string>();
  const items: any[] = [];
  const pageSize = Math.min(limit, BOX_MAX_PAGE);
  let total = 0;

  // Bounded loop: a shifting sort order must never spin forever.
  for (let guard = 0; guard < 50; guard++) {
    // PAGE INDEX, not a row cursor — see listTestcases. Advancing this by the
    // returned row count asks the box for a page hundreds past the end and it
    // 400s ("requested page 201 out of range"). Only worked before because a
    // 1000-row page swallowed the whole catalogue in one request.
    const pageIndex = startPage + guard;
    const page = await listTestcases(opts, pageSize, pageIndex);
    total = page.total ?? total;
    const got = page.items ?? [];
    if (!got.length) break;

    for (const it of got) {
      const key = String((it as any)?.id ?? '');
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      if (items.length < limit) items.push(it);
    }
    // A short page is the last page — the box 400s on the one after it.
    if (got.length < pageSize) break;
    if (items.length >= limit) break;
    if (total && (pageIndex + 1) * pageSize >= total) break;
  }
  return { items, total: total || items.length };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const systemId = url.searchParams.get('systemId') ?? undefined;
  const inv = loadInventory();
  const opts = uesimApiOptsForSystem(inv, systemId);
  if (!opts) {
    return NextResponse.json(
      { error: systemId ? `system "${systemId}" is not a testable UESIM` : 'no UESIM in inventory' },
      { status: 400 },
    );
  }
  // Default high enough to cover a whole catalogue; listAll() pages the box.
  const limit  = Number(url.searchParams.get('limit')  ?? 5000);
  const offset = Number(url.searchParams.get('offset') ?? 0);
  const refresh = url.searchParams.get('refresh') === '1';

  const key = `${opts.systemId}|${limit}|${offset}`;
  const hit = cache.get(key);
  if (!refresh && hit && Date.now() - hit.at < TTL_MS) {
    return NextResponse.json({ ...hit.payload, cached: true, ageMs: Date.now() - hit.at });
  }

  try {
    const r = await listAll(opts, limit, offset);
    const payload = { ...r, systemId: opts.systemId, host: opts.host, name: opts.name };
    cache.set(key, { at: Date.now(), payload });
    return NextResponse.json({ ...payload, cached: false, ageMs: 0 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e), systemId: opts.systemId, host: opts.host }, { status: 502 });
  }
}

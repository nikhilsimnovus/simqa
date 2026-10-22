// Fetching a complete execution log, and knowing when it is not complete.
//
// GET /v2/testcases/executions/{eid}/logs, measured on 192.168.1.102. Four
// things about this endpoint decide the whole design, and three of them fail
// SILENTLY — they return 200 with wrong rows rather than an error:
//
//  1. `total` is NOT a total. It echoes the page size: limit=10 gives
//     total 10, limit=5000 gives total 5000. Paging until `fetched >= total`
//     stops after one page, every time.
//
//  2. `layer=RRC` filters and works. `layers=RRC` is ignored and returns
//     every layer. `layer=RRC,NAS` returns ZERO items — a comma list looks
//     like a reasonable thing to send and produces an empty log, which reads
//     as "this execution had no signalling" and would fail every rule for
//     the wrong reason. So: one request series per layer, never a list.
//
//  3. `offset` is a cursor over the RAW stream, not over the filtered rows.
//     With layer=RRC, offset=100 returns records from raw index 103 on. So
//     paging advances by the last record's own index, not by how many rows
//     came back.
//
//  4. `page` is accepted and ignored.
//
// Why this matters beyond tidiness: a partial log is indistinguishable from
// a short one, and a rule counting messages in a partial log produces a
// confident wrong number. Everything here reports whether the log is
// complete, and the evaluator refuses to pass a rule when it is not.

import { type LogRecord, OTA_LAYERS, recordsBelongTo } from './otaParse.ts';

export interface FetchOpts {
  host: string;
  token: string;
  executionId: string;
  /** Which layers to fetch. One request series each — see note 2. */
  layers?: string[];
  /** Rows per request. The box has served 5000 happily. */
  pageSize?: number;
  /** Stop after this many requests per layer, so a box that keeps
   *  answering can never spin forever. */
  maxPages?: number;
  signal?: AbortSignal;
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface FetchResult {
  records: LogRecord[];
  /** False when paging stopped early, a request failed, or records from
   *  another execution came back. The evaluator must not pass a rule when
   *  this is false. */
  complete: boolean;
  /** Said in the report and in every rule's failure when incomplete. */
  problem?: string;
  /** Per layer, how many records came back — for the report's log source. */
  perLayer: Record<string, number>;
  requests: number;
}

const LOGS_PATH = (host: string, eid: string) =>
  `http://${host}/v2/testcases/executions/${encodeURIComponent(eid)}/logs`;

/** One page. Separated so the paging logic can be tested without a network. */
export async function fetchLogPage(opts: FetchOpts, layer: string, offset: number): Promise<{
  items: LogRecord[]; status: number; error?: string;
}> {
  const f = opts.fetchImpl ?? fetch;
  const size = opts.pageSize ?? 2000;
  const url = `${LOGS_PATH(opts.host, opts.executionId)}?limit=${size}&offset=${offset}&layer=${encodeURIComponent(layer)}`;
  try {
    const r = await f(url, {
      headers: { Authorization: `Bearer ${opts.token}` },
      signal: opts.signal ?? AbortSignal.timeout(30_000),
    });
    if (!r.ok) return { items: [], status: r.status, error: `HTTP ${r.status}` };
    const j: any = await r.json();
    const items = Array.isArray(j?.items) ? j.items : Array.isArray(j) ? j : [];
    return { items, status: r.status };
  } catch (e: any) {
    return { items: [], status: 0, error: e?.name === 'TimeoutError' ? 'request timed out' : (e?.message ?? String(e)) };
  }
}

/**
 * Every record of one layer, paged by index cursor.
 *
 * Advances by the last record's `index` + 1 rather than by the row count,
 * because offset is a raw-stream cursor (note 3). Stops when a page is
 * empty, when a page fails to advance the cursor, or at maxPages.
 */
export async function fetchLayer(opts: FetchOpts, layer: string): Promise<{
  records: LogRecord[]; complete: boolean; problem?: string; requests: number;
}> {
  const maxPages = opts.maxPages ?? 50;
  const out: LogRecord[] = [];
  let offset = 0;
  let requests = 0;

  for (let page = 0; page < maxPages; page++) {
    if (opts.signal?.aborted) {
      return { records: out, complete: false, problem: 'log fetch was stopped', requests };
    }
    const r = await fetchLogPage(opts, layer, offset);
    requests += 1;
    if (r.error) {
      return {
        records: out, complete: false, requests,
        problem: `fetching ${layer} logs failed at offset ${offset}: ${r.error}`,
      };
    }
    if (r.items.length === 0) return { records: out, complete: true, requests };
    out.push(...r.items);

    const last = r.items[r.items.length - 1];
    const lastIndex = typeof last?.index === 'number' ? last.index : undefined;
    if (lastIndex === undefined) {
      // Without an index there is no cursor to advance, and repeating the
      // same offset would loop. One page is all this build can give.
      return { records: out, complete: true, requests };
    }
    const next = lastIndex + 1;
    if (next <= offset) {
      return {
        records: out, complete: false, requests,
        problem: `log paging stopped advancing at index ${lastIndex}`,
      };
    }
    offset = next;
  }
  return {
    records: out, complete: false, requests,
    problem: `stopped after ${maxPages} pages of ${layer} logs — the log is longer than this run will read`,
  };
}

/**
 * The complete OTA log for one execution.
 *
 * Only the signalling layers: the mobility execution measured had 1444 PHY
 * records against 54 RRC and 21 NAS, and PHY/MAC/RLC/PDCP carry no OTA
 * messages, so fetching them costs time and proves nothing.
 *
 * Every record is checked against the execution it is supposed to belong to
 * before anything is counted.
 */
export async function fetchExecutionLog(opts: FetchOpts): Promise<FetchResult> {
  const layers = opts.layers ?? OTA_LAYERS;
  const records: LogRecord[] = [];
  const perLayer: Record<string, number> = {};
  const problems: string[] = [];
  let complete = true;
  let requests = 0;

  for (const layer of layers) {
    const r = await fetchLayer(opts, layer);
    requests += r.requests;
    perLayer[layer] = r.records.length;
    records.push(...r.records);
    if (!r.complete) { complete = false; if (r.problem) problems.push(r.problem); }
  }

  // Never process another execution's logs.
  const belong = recordsBelongTo(records, opts.executionId);
  if (!belong.ok) {
    return {
      records: [], complete: false, perLayer, requests,
      problem: `the log contains records from another execution (${belong.foreign.slice(0, 3).join(', ')}) — refusing to process it`,
    };
  }

  return {
    records, complete, perLayer, requests,
    problem: problems.length ? problems.join('; ') : undefined,
  };
}

/**
 * The log, waiting for it to appear if it has not yet.
 *
 * A log is not always there the moment an execution ends — the executor
 * writes it, and asking too early answers 404 ("executor service returned
 * status 404", seen on a real execution). Bounded: a fixed number of tries
 * with a fixed gap, so a log that never arrives fails rather than hanging.
 */
export async function fetchExecutionLogWithRetry(
  opts: FetchOpts & { attempts?: number; gapMs?: number; sleep?: (ms: number) => Promise<void> },
): Promise<FetchResult> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const gap = opts.gapMs ?? 5000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
  let last: FetchResult | undefined;

  for (let i = 0; i < attempts; i++) {
    if (opts.signal?.aborted) break;
    const r = await fetchExecutionLog(opts);
    last = r;
    // Good enough to stop: we have records and nothing went wrong.
    if (r.complete && r.records.length > 0) return r;
    // A foreign log is not going to become ours by waiting.
    if (r.problem?.includes('another execution')) return r;
    if (i < attempts - 1) await sleep(gap);
  }
  const r = last ?? { records: [], complete: false, perLayer: {}, requests: 0 };
  if (r.records.length === 0 && !r.problem) {
    return { ...r, complete: false, problem: `no log records for this execution after ${attempts} attempts` };
  }
  return r;
}

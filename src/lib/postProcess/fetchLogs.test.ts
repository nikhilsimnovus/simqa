import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchLayer, fetchExecutionLog, fetchExecutionLogWithRetry } from './fetchLogs.ts';

const EID = '01a15f34-ba8c-79f3-8682-b5b210b6344c';

/** A stand-in box. `pages` maps "<layer>@<offset>" to the records it serves,
 *  so the test can reproduce the real endpoint's cursor behaviour. */
function box(pages: Record<string, Array<Record<string, unknown>>>, opts: { fail?: string } = {}) {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    const u = new URL(url);
    const layer = u.searchParams.get('layer') ?? '';
    const offset = u.searchParams.get('offset') ?? '0';
    const key = `${layer}@${offset}`;
    calls.push(key);
    if (opts.fail === key) return { ok: false, status: 503 } as unknown as Response;
    const items = pages[key] ?? [];
    return { ok: true, status: 200, json: async () => ({ items, total: items.length }) } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const rec = (index: number, layer: string, executionId = EID) =>
  ({ executionId, testCaseId: 'tc', layer, index, logData: [`${layer}-NR: m${index}`] });

test('paging advances by the record index, not by the row count', () => {
  // The real endpoint's offset is a cursor over the RAW stream: with
  // layer=RRC, offset=100 returns records from raw index 103 on. So after a
  // page ending at index 5058 the next request must ask for 5059.
  const { impl, calls } = box({
    'RRC@0': [rec(4, 'RRC'), rec(5058, 'RRC')],
    'RRC@5059': [],
  });
  return fetchLayer({ host: 'h', token: 't', executionId: EID, fetchImpl: impl }, 'RRC')
    .then((r) => {
      assert.equal(r.complete, true);
      assert.equal(r.records.length, 2);
      assert.deepEqual(calls, ['RRC@0', 'RRC@5059']);
    });
});

test('each layer is fetched on its own — never as a comma list', async () => {
  // layer=RRC,NAS returns ZERO items on the real box, silently. Asking for
  // one layer per series is the only thing that works.
  const { impl, calls } = box({
    'RRC@0': [rec(4, 'RRC')], 'RRC@5': [],
    'NAS@0': [rec(25, 'NAS')], 'NAS@26': [],
  });
  const r = await fetchExecutionLog({ host: 'h', token: 't', executionId: EID, fetchImpl: impl });
  assert.equal(r.complete, true);
  assert.equal(r.records.length, 2);
  assert.deepEqual(r.perLayer, { RRC: 1, NAS: 1 });
  assert.ok(calls.every((c) => !c.includes(',')), calls.join(' '));
});

test('a page that equals the page size does not end the fetch', async () => {
  // `total` echoes the page size, so it can never say whether more remain.
  // Only an empty page does.
  const full = Array.from({ length: 3 }, (_, i) => rec(i + 1, 'RRC'));
  const { impl } = box({
    'RRC@0': full, 'RRC@4': [rec(10, 'RRC')], 'RRC@11': [],
    'NAS@0': [],
  });
  const r = await fetchExecutionLog({ host: 'h', token: 't', executionId: EID, pageSize: 3, fetchImpl: impl });
  assert.equal(r.records.length, 4, 'kept going past a full page');
  assert.equal(r.complete, true);
});

test('a failed request makes the log incomplete and says where', async () => {
  const { impl } = box({ 'RRC@0': [rec(1, 'RRC')] }, { fail: 'RRC@2' });
  const r = await fetchExecutionLog({ host: 'h', token: 't', executionId: EID, fetchImpl: impl });
  assert.equal(r.complete, false);
  assert.match(r.problem!, /fetching RRC logs failed at offset 2: HTTP 503/);
});

test('records from another execution are refused outright', async () => {
  const { impl } = box({
    'RRC@0': [rec(1, 'RRC'), rec(2, 'RRC', 'someone-elses-execution')], 'RRC@3': [],
    'NAS@0': [],
  });
  const r = await fetchExecutionLog({ host: 'h', token: 't', executionId: EID, fetchImpl: impl });
  assert.equal(r.complete, false);
  assert.equal(r.records.length, 0, 'nothing is handed on for counting');
  assert.match(r.problem!, /records from another execution \(someone-elses-execution\)/);
});

test('paging stops rather than looping when the cursor cannot advance', async () => {
  const { impl } = box({ 'RRC@0': [rec(0, 'RRC')] });   // index 0 -> next offset 1
  const r = await fetchLayer({ host: 'h', token: 't', executionId: EID, fetchImpl: impl }, 'RRC');
  // offset 1 is unmapped so it serves [], which ends the fetch cleanly.
  assert.equal(r.complete, true);
  assert.equal(r.records.length, 1);
});

test('a very long log stops at maxPages and admits it is partial', async () => {
  // Every page returns one record one index further on, forever.
  const impl = (async (url: string) => {
    const off = Number(new URL(url).searchParams.get('offset') ?? 0);
    return { ok: true, status: 200, json: async () => ({ items: [rec(off + 1, 'RRC')] }) } as unknown as Response;
  }) as unknown as typeof fetch;
  const r = await fetchLayer({ host: 'h', token: 't', executionId: EID, maxPages: 4, fetchImpl: impl }, 'RRC');
  assert.equal(r.complete, false);
  assert.equal(r.requests, 4);
  assert.match(r.problem!, /stopped after 4 pages/);
});

test('a log that is not ready yet is retried, then succeeds', async () => {
  let call = 0;
  const impl = (async (url: string) => {
    const layer = new URL(url).searchParams.get('layer');
    call += 1;
    // The first whole attempt finds nothing — the executor has not written
    // the log yet, which is what a real 404 right after an execution looks
    // like once it is turned into an empty page.
    if (call <= 2) return { ok: true, status: 200, json: async () => ({ items: [] }) } as unknown as Response;
    if (layer === 'RRC' && !url.includes('offset=5')) {
      return { ok: true, status: 200, json: async () => ({ items: [rec(4, 'RRC')] }) } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => ({ items: [] }) } as unknown as Response;
  }) as unknown as typeof fetch;

  const slept: number[] = [];
  const r = await fetchExecutionLogWithRetry({
    host: 'h', token: 't', executionId: EID, fetchImpl: impl,
    attempts: 3, gapMs: 1000, sleep: async (ms) => { slept.push(ms); },
  });
  assert.equal(r.records.length, 1);
  assert.equal(r.complete, true);
  assert.deepEqual(slept, [1000], 'waited once, then found it');
});

test('a log that never arrives fails rather than hanging or passing', async () => {
  const impl = (async () => ({ ok: true, status: 200, json: async () => ({ items: [] }) } as unknown as Response)) as unknown as typeof fetch;
  const slept: number[] = [];
  const r = await fetchExecutionLogWithRetry({
    host: 'h', token: 't', executionId: EID, fetchImpl: impl,
    attempts: 3, gapMs: 500, sleep: async (ms) => { slept.push(ms); },
  });
  assert.equal(r.complete, false);
  assert.equal(r.records.length, 0);
  assert.match(r.problem!, /no log records for this execution after 3 attempts/);
  assert.deepEqual(slept, [500, 500], 'bounded: two waits for three attempts');
});

test('a foreign log is not retried — waiting will not make it ours', async () => {
  const impl = (async (url: string) => {
    const off = new URL(url).searchParams.get('offset');
    const layer = new URL(url).searchParams.get('layer');
    if (layer === 'RRC' && off === '0') {
      return { ok: true, status: 200, json: async () => ({ items: [rec(1, 'RRC', 'other')] }) } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => ({ items: [] }) } as unknown as Response;
  }) as unknown as typeof fetch;
  const slept: number[] = [];
  const r = await fetchExecutionLogWithRetry({
    host: 'h', token: 't', executionId: EID, fetchImpl: impl,
    attempts: 3, gapMs: 500, sleep: async (ms) => { slept.push(ms); },
  });
  assert.equal(r.complete, false);
  assert.deepEqual(slept, [], 'gave up at once');
});

test('the request carries the execution, the layer and the bearer token', async () => {
  const seen: string[] = [];
  const impl = (async (url: string, init: any) => {
    seen.push(`${url} :: ${init?.headers?.Authorization ?? ''}`);
    return { ok: true, status: 200, json: async () => ({ items: [] }) } as unknown as Response;
  }) as unknown as typeof fetch;
  await fetchExecutionLog({ host: '192.168.1.102', token: 'tok123', executionId: EID, layers: ['RRC'], fetchImpl: impl });
  assert.match(seen[0], /192\.168\.1\.102\/v2\/testcases\/executions\/01a15f34-[^/]+\/logs\?/);
  assert.match(seen[0], /layer=RRC/);
  assert.match(seen[0], /:: Bearer tok123$/);
  assert.ok(!seen[0].includes('layers='), 'never the ignored spelling');
});

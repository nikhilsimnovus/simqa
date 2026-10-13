// Reading one execution's statistics and logs off the Simnovator.
//
// The box serves these per execution id:
//
//   GET  /v2/testcases/executions/{eid}/statistics/global?startTime&endTime
//   GET  /v2/testcases/executions/{eid}/statistics/cells?startTime&endTime
//   GET  /v2/testcases/executions/{eid}/statistics/ues?startTime&endTime
//   POST /v2/testcases/executions/{eid}/statistics/ue-summary   (JSON body)
//   GET  /v2/testcases/executions/{eid}/logs?limit=N
//
// ue-summary is the odd one out — a POST with a body where its siblings are
// GETs with a query string. Calling it as a GET hits no route at all and
// answers the generic 404, which is a trap worth only falling into once.
//
// By EXECUTION ID, which is what makes a historical run readable: the id is on
// the run record, so opening a run from three weeks ago asks the box about
// that execution and not about whatever the test case did most recently.
//
// Nothing here writes. These are reads of a box's own records.

import { ensureToken, type ApiOpts } from '../uesimClient';
// Pure, and tested on its own — see logShape.ts.
import { type StatKind } from './logShape';
export { STAT_KINDS, logLines, type StatKind } from './logShape';

export interface ReadResult {
  ok: boolean;
  /** Whatever the box answered, parsed when it was JSON. */
  data?: unknown;
  /** The box's own words when it refused, for showing verbatim. */
  error?: string;
  status: number;
}

const base = (host: string) => `http://${host}/v2`;

/** A window wide enough to cover any execution we might be asked about.
 *  The box wants explicit bounds on the GET-shaped statistics; it has no
 *  "whole execution" mode, so this asks for a generous span around it. */
function windowFor(startedAt?: string, finishedAt?: string): { startTime: number; endTime: number } {
  const now = Math.floor(Date.now() / 1000);
  const start = startedAt ? Math.floor(Date.parse(startedAt) / 1000) : NaN;
  const end = finishedAt ? Math.floor(Date.parse(finishedAt) / 1000) : NaN;
  return {
    // A minute either side, so a sample taken just before the first poll or
    // just after the last is still inside the window.
    startTime: Number.isFinite(start) ? start - 60 : now - 24 * 3600,
    endTime: Number.isFinite(end) ? end + 60 : now + 60,
  };
}

async function call(
  opts: ApiOpts, method: 'GET' | 'POST', url: string, body?: unknown,
): Promise<ReadResult> {
  let token: string;
  try {
    token = await ensureToken(opts.host, opts.username, opts.password);
  } catch (e: any) {
    return { ok: false, status: 0, error: `could not sign in to ${opts.host}: ${e?.message ?? e}` };
  }
  try {
    const r = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await r.text().catch(() => '');
    let data: unknown;
    try { data = text ? JSON.parse(text) : undefined; } catch { data = text; }
    if (!r.ok) {
      return {
        ok: false, status: r.status,
        error: typeof data === 'string' && data ? data.slice(0, 300)
          : `the Simnovator answered ${r.status}`,
      };
    }
    return { ok: true, status: r.status, data };
  } catch (e: any) {
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    return {
      ok: false, status: 0,
      error: timedOut ? `${opts.host} did not answer within 30s` : (e?.message ?? String(e)),
    };
  }
}

/** One kind of statistics for one execution. */
export async function readStatistics(
  opts: ApiOpts,
  executionId: string,
  kind: StatKind,
  when: { startedAt?: string; finishedAt?: string } = {},
): Promise<ReadResult> {
  const eid = encodeURIComponent(executionId);
  if (kind === 'ue-summary') {
    // POST with a body, not a GET with a query string.
    const w = windowFor(when.startedAt, when.finishedAt);
    return call(opts, 'POST', `${base(opts.host)}/testcases/executions/${eid}/statistics/ue-summary`, w);
  }
  const { startTime, endTime } = windowFor(when.startedAt, when.finishedAt);
  return call(opts, 'GET',
    `${base(opts.host)}/testcases/executions/${eid}/statistics/${kind}?startTime=${startTime}&endTime=${endTime}`);
}

/** The box's own log for one execution. */
export async function readLogs(
  opts: ApiOpts, executionId: string, limit = 500,
): Promise<ReadResult> {
  const n = Math.min(5000, Math.max(1, Math.floor(limit)));
  return call(opts, 'GET',
    `${base(opts.host)}/testcases/executions/${encodeURIComponent(executionId)}/logs?limit=${n}`);
}

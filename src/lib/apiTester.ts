// Comprehensive API tester for the Simnovator REST surface (v2). Tests are
// grouped by category so the UI can run a slice. Each test returns a
// structured result with the HTTP status and a one-line detail.
//
// Safety:
//   - Default category set is read-only.
//   - Mutating tests are gated behind `includeDestructive` and use throwaway
//     resources (e.g. a simqa-tester-<ts> user we create + delete in the
//     same run).
//   - Negative tests intentionally provoke 401/404/400 to verify error paths.

import { ensureToken } from './uesimClient';
import type { Inventory } from './inventory';
import { uesimApiOptsFromInventory, uesimApiOptsForSystem } from './inventory';
import { fetchBoxBuild } from './buildVersion';

export type ApiTestCategory =
  | 'auth' | 'version' | 'users' | 'admin-users' | 'simulators'
  | 'system' | 'tools' | 'testcases' | 'test-creator' | 'executions' | 'statistics'
  | 'logs' | 'jobs' | 'negative' | 'mutating' | 'fuzz'
  // Sample-test matrix categories — generated from src/lib/sampleTests/matrix.ts.
  // RAT-based grouping (matches the box's actually-shipped sample tests; see
  // dist/overnight/bug-report.md → C2 for why we use RAT instead of the
  // wiki's narrative grouping).
  | 'sample-sa' | 'sample-lte' | 'sample-nsa' | 'sample-nbiot';

export type ApiTestSeverity = 'critical' | 'normal' | 'optional';

export interface ApiRequestEvidence {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface ApiResponseEvidence {
  status: number;
  statusText?: string;
  headers: Record<string, string>;
  body?: string;
  bodyTruncated?: boolean;
  contentType?: string;
  durationMs: number;
}

export interface ApiTestResult {
  id: string;
  name: string;
  category: ApiTestCategory;
  method: string;
  endpoint: string;
  severity: ApiTestSeverity;
  destructive: boolean;
  ok: boolean;
  status?: number;
  detail?: string;
  durationMs?: number;
  /** True if the test was skipped (e.g. requires execution context not available). */
  skipped?: boolean;
  skippedReason?: string;
  /** Full request as sent. Authorization is redacted for safe sharing. */
  request?: ApiRequestEvidence;
  /** Response received, with body capped at 8 KB. */
  response?: ApiResponseEvidence;
  /** ISO timestamp when this test ran. */
  ranAt?: string;
  /** Engineering guidance: what the API SHOULD have returned. Populated on failures. */
  expected?: string;
}

export interface ApiTesterRequest {
  /** Categories to run. If omitted, runs the default safe set. `categories`
   *  is the ONLY thing that decides which categories run — there is no
   *  separate per-category override field. (An earlier `includeNegative`
   *  flag used to force-add the 'negative' category regardless of what the
   *  caller asked for; it defaulted to true and nothing ever sent it as
   *  false, so unchecking "Negative tests" in the UI silently did nothing.
   *  Removed rather than fixed — 'negative' is a category like any other
   *  and needs no special-casing.) */
  categories?: ApiTestCategory[];
  /** Allow tests that change state. Off by default. */
  includeDestructive?: boolean;
  /** Allow tests that take >10s. Off by default. */
  includeLongRunning?: boolean;
  /** Inventory system id to test against. If omitted, the first UESIM-capable
   *  system is used (legacy behaviour). Lets two teammates target different
   *  boxes from the same simqa install. */
  targetSystemId?: string;
}

export interface ApiTesterResponse {
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  counts: { total: number; passed: number; failed: number; skipped: number };
  results: ApiTestResult[];
  /** Convenience: pass/fail count grouped by category. */
  byCategory: Record<string, { passed: number; failed: number; skipped: number }>;
  /** Box this sweep ran against, and its build at the time. Recorded so the
   *  Run History row can say which system and build produced these numbers —
   *  comparing two sweeps is meaningless without both. */
  targetHost?: string;
  buildVersion?: string;
}

// Every category EXCEPT the "advanced" ones: negative/mutating/fuzz exercise
// error paths, mutate state, or throw malformed input (noisy for a normal
// first-look run); the sample-* categories trigger REAL testcase executions
// on the box. All are opt-in via `categories`. Keep this in sync with
// src/app/api-tests/page.tsx's DEFAULT_CATEGORIES — same set, same reasoning.
const DEFAULT_CATEGORIES: ApiTestCategory[] = [
  'auth', 'version', 'users', 'admin-users', 'simulators',
  'system', 'tools', 'testcases', 'test-creator', 'executions', 'statistics', 'logs', 'jobs',
];

interface RunCtx {
  host: string;
  username: string;
  password: string;
  token: string;
  /** Most recent execution id discovered from /testcases scan (for stats/logs tests). */
  recentExecutionId?: string;
  recentSimulatorId?: string;
  /** First testcase id from /testcases list. */
  someTestcaseId?: string;
  /** First job id discovered from GET /api/jobs (for jobs/{id} test). */
  someJobId?: string;
  includeDestructive: boolean;
  includeLongRunning: boolean;
  /** Full testcase catalogue (id + name), lazily loaded once and reused by
   *  every sample-matrix test so we don't re-search the box 200+ times in
   *  one sweep. Populated by `ensureTestcaseCatalog(c)`. */
  testcaseCatalog?: Array<{ id: string; name: string }>;
  /** Memoised answer from `userMgmtDisabled()`. Empty string means "checked,
   *  and it is enabled" — distinct from undefined, which means "not checked". */
  userMgmtDisabledReason?: string;
  /** Memoised per-section subject from `findSectionSubject()`. null means
   *  "scanned, and no testcase on this box has that section". */
  sectionSubjects?: Record<string, string | null>;
}

function tBase(host: string) { return `http://${host}/v2`; }

const MAX_BODY_BYTES = 8 * 1024;

function redactHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (k.toLowerCase() === 'authorization') {
      out[k] = v.replace(/Bearer\s+\S+/i, 'Bearer <REDACTED>');
    } else {
      out[k] = v;
    }
  }
  return out;
}

function headersToObject(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => { out[k] = v; });
  return out;
}

function truncate(s: string): { body: string; truncated: boolean } {
  if (s.length <= MAX_BODY_BYTES) return { body: s, truncated: false };
  return { body: s.slice(0, MAX_BODY_BYTES) + '\n... [truncated]', truncated: true };
}

interface RawCallResult {
  status: number;
  ms: number;
  bodyText?: string;
  bodyJson?: any;
  error?: string;
  request: ApiRequestEvidence;
  response?: ApiResponseEvidence;
}

/** Per-request ceiling. Without one, a box that accepts the connection and then
 *  never answers hangs the whole sweep with no result and no error — the page
 *  just sits on "Running…" forever.
 *
 *  Two tiers, because the spread is enormous. Plain reads answer in
 *  milliseconds, but anything that commands the hardware or streams a file does
 *  not: POST /testcases/{id}/executions measured 26.4s on an idle box (verified
 *  live 2026-08-26). Timing those out is worse than waiting — the box starts the
 *  run regardless of whether we are still listening, so an aborted start leaves
 *  an execution going on real hardware with nothing tracking it. */
const CALL_TIMEOUT_MS = 30_000;
const LONG_CALL_TIMEOUT_MS = 180_000;
/** Endpoints that drive hardware or move files, and so get the long tier. */
const SLOW_ENDPOINT = /\/(export|executions|import|stop|restart)(\b|\?|\/|$)/;

async function rawCall(
  ctx: RunCtx | null,
  method: string,
  url: string,
  init: RequestInit & { auth?: 'none' | 'bearer' | 'wrong'; timeoutMs?: number } = {},
): Promise<RawCallResult> {
  const headers: Record<string, string> = { ...(init.headers as any) };
  const auth = init.auth ?? 'bearer';
  if (auth === 'bearer') {
    if (ctx?.token) headers['Authorization'] = `Bearer ${ctx.token}`;
  } else if (auth === 'wrong') {
    headers['Authorization'] = 'Bearer not-a-real-token';
  }
  const reqBody = typeof init.body === 'string' ? init.body : (init.body ? String(init.body) : undefined);
  const request: ApiRequestEvidence = {
    method, url,
    headers: redactHeaders(headers),
    ...(reqBody !== undefined ? { body: truncate(reqBody).body } : {}),
  };
  const t0 = Date.now();
  const timeoutMs = init.timeoutMs ?? (SLOW_ENDPOINT.test(url) ? LONG_CALL_TIMEOUT_MS : CALL_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, method, headers, signal: AbortSignal.timeout(timeoutMs) });
    const ms = Date.now() - t0;
    const ct = res.headers.get('content-type') ?? '';
    const respHeaders = headersToObject(res.headers);
    if (ct.includes('application/json')) {
      const raw = await res.text().catch(() => '');
      let bodyJson: any;
      try { bodyJson = raw ? JSON.parse(raw) : undefined; } catch { bodyJson = undefined; }
      const { body: bodyOut, truncated } = truncate(raw);
      return {
        status: res.status, ms, bodyJson,
        request,
        response: { status: res.status, statusText: res.statusText, headers: respHeaders, body: bodyOut, bodyTruncated: truncated, contentType: ct, durationMs: ms },
      };
    }
    const bodyText = await res.text().catch(() => '');
    const { body: bodyOut, truncated } = truncate(bodyText);
    return {
      status: res.status, ms, bodyText,
      request,
      response: { status: res.status, statusText: res.statusText, headers: respHeaders, body: bodyOut, bodyTruncated: truncated, contentType: ct, durationMs: ms },
    };
  } catch (e: any) {
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    return {
      status: 0, ms: Date.now() - t0,
      error: timedOut ? `no response within ${Math.round(timeoutMs / 1000)}s` : (e?.message ?? String(e)),
      request,
    };
  }
}

type EvidenceCarrier = { request?: ApiRequestEvidence; response?: ApiResponseEvidence; error?: string };

/** The box ships whole feature areas switched off per build/licence and says so
 *  explicitly: 403 with `{"code":"FORBIDDEN","message":"This feature is
 *  disabled."}`. That is a deployment fact, not a defect — a test that demands
 *  a disabled feature work is asking the wrong question, so these SKIP with the
 *  box's own wording rather than reporting a red failure the user cannot act on.
 *  Verified live on 4.0.0 at 192.168.1.102 for POST /v2/simulators, GET /v2/users
 *  and POST /v2/users/search. */
/** Describe what an export actually returned. A bare "status 200" told the user
 *  nothing about whether a real file came back, which is the only thing these
 *  binary-export tests exist to establish. */
function exportEvidence(r: RawCallResult): string {
  const h = r.response?.headers ?? {};
  const bits = [String(r.status), r.response?.contentType ?? 'unknown type'];
  const len = h['content-length'];
  if (len) bits.push(`${Number(len).toLocaleString()} bytes`);
  else if (r.response?.body) bits.push(`${r.response.body.length.toLocaleString()}+ bytes read`);
  if (h['content-disposition']) bits.push(h['content-disposition']);
  bits.push(`${r.ms}ms`);
  return bits.join(' · ');
}

function featureDisabled(r: { status: number; bodyJson?: any; bodyText?: string }): boolean {
  if (r.status !== 403) return false;
  const code = String(r.bodyJson?.code ?? '').toUpperCase();
  const msg = String(r.bodyJson?.message ?? r.bodyText ?? '');
  return code === 'FORBIDDEN' && /feature is disabled/i.test(msg);
}

/** Walks the whole catalogue at a page size the box's real row count can
 *  actually exercise, and asserts every row is reachable exactly once.
 *
 *  `offset` on this API is a PAGE INDEX, not a row offset (see the paging
 *  memo on GET /testcases) — so this pages by index and checks three things
 *  that together prove nothing is stranded: the walk yields `total` distinct
 *  ids, no id appears on two pages (which would mean the walk both duplicates
 *  and skips), and the page one past the end comes back empty rather than
 *  wrapping around to the start. */
async function smallCatalogueReachVerdict(
  c: RunCtx,
  base: { id: string; category: ApiTestCategory; method: string; endpoint: string; severity: ApiTestSeverity; destructive?: boolean },
  total: number,
): Promise<ApiTestResult> {
  const expected = `Paging must reach all ${total} row(s): \`offset\` is a page index, so walking offset=0..n yields every id exactly once, and the page past the end is empty. Rows that no page returns are invisible to backup, audit and sync tooling.`;
  const pageSize = Math.max(10, Math.min(50, Math.ceil(total / 4))); // ≥4 pages to make paging meaningful
  const pages = Math.ceil(total / pageSize);
  const seen = new Map<string, number>();
  let dupes = 0;
  let last: RawCallResult | undefined;
  for (let p = 0; p < pages; p++) {
    const r = await rawCall(c, 'GET', `${tBase(c.host)}/testcases?limit=${pageSize}&offset=${p}`);
    last = r;
    if (r.status !== 200) return bad(base.id, base, r, `page ${p} (limit=${pageSize}&offset=${p}) returned ${r.status}`, expected);
    const items: any[] = r.bodyJson?.items ?? [];
    if (!items.length) return bad(base.id, base, r, `page ${p} of ${pages} is empty while total=${total} — rows from ${p * pageSize} on are unreachable`, expected);
    for (const it of items) {
      const id = String(it?.id ?? '');
      if (!id) continue;
      if (seen.has(id)) dupes++;
      else seen.set(id, p);
    }
  }
  const past = await rawCall(c, 'GET', `${tBase(c.host)}/testcases?limit=${pageSize}&offset=${pages}`);
  const pastRows = (past.bodyJson?.items ?? []).length;
  if (past.status === 200 && pastRows > 0) {
    return bad(base.id, base, past, `the page past the end (offset=${pages}) returned ${pastRows} row(s) instead of none — paging wraps or ignores offset, so a walker never terminates`, expected);
  }
  if (dupes > 0) {
    return bad(base.id, base, last!, `${dupes} id(s) appeared on more than one page — paging overlaps, so the walk both repeats rows and misses others`, expected);
  }
  if (seen.size < total) {
    return bad(base.id, base, last!, `walked ${pages} page(s) of ${pageSize} and saw only ${seen.size} distinct id(s) of total=${total} — ${total - seen.size} row(s) unreachable`, expected);
  }
  return ok(base.id, base, last!, `all ${seen.size} of ${total} row(s) reachable across ${pages} page(s) of ${pageSize}, no duplicates, page past the end empty (>1000 cap not exercisable at this catalogue size)`);
}

/** Shared verdict for the three simulator-provisioning tests when the seeding
 *  create does not succeed. Provisioning is switched off on some builds
 *  (VITE_DISABLE_MULTI_USER_SIM also gates simulator CRUD), which used to skip
 *  all three. A disabled build still owes callers a well-formed refusal, so
 *  that is what gets asserted instead — the lifecycle itself stays unexercised
 *  either way, but the deployment is no longer unmeasured. Any non-403 failure
 *  (a 500, a 404, a malformed 403) is still a real failure. */
function provisioningRefusalVerdict(
  base: { id: string; category: ApiTestCategory; method: string; endpoint: string; severity: ApiTestSeverity; destructive?: boolean },
  create: { status: number; ms: number; bodyJson?: any } & EvidenceCarrier,
  cannot: string,
): ApiTestResult {
  const violation = disabledContractViolation(create);
  if (violation) {
    return bad(base.id, base, create, `simulator provisioning unavailable and the refusal is malformed: ${violation}`,
      'Either 200/201 creating the throwaway simulator, or — when provisioning is disabled for the build — 403 { code: "FORBIDDEN", message: <why> }. A 404 or 5xx here is a defect.');
  }
  return ok(base.id, base, create, `provisioning off; refused cleanly — 403 ${create.bodyJson?.code} "${create.bodyJson?.message}" (${cannot}, but the refusal is correct)`);
}

/** Size of whatever collection a body carries, or -1 if it isn't one. */
function collectionSize(b: any): number {
  for (const k of ['items', 'users', 'data', 'results']) if (Array.isArray(b?.[k])) return b[k].length;
  return Array.isArray(b) ? b.length : -1;
}

/** A switched-off capability still has a contract, and it is worth testing.
 *
 *  The failure mode that matters is 200-with-an-empty-list: a client reading
 *  that concludes "this box has no users" when the truth is "user management
 *  is off". That is the same vacuous green as a box PASS verdict on a run
 *  where nothing ever attached — technically a success response, carrying no
 *  information, and actively misleading. 404 is nearly as bad in the other
 *  direction: it makes a deliberate deployment choice look like a missing
 *  route, sending whoever debugs it after a phantom API-version problem.
 *
 *  So the refusal must be 403, machine-readable, explained, and free of
 *  internals. Returns undefined when well-formed, else why it isn't. */
function disabledContractViolation(r: { status: number; bodyJson?: any; bodyText?: string }): string | undefined {
  if (r.status === 404) return '404 — a disabled feature must still answer 403, or clients cannot tell it apart from a route that was never deployed';
  if (r.status >= 500) return `${r.status} — server error instead of a clean refusal`;
  if (r.status !== 403) return `expected 403, got ${r.status}`;
  const code = String(r.bodyJson?.code ?? '');
  const msg  = String(r.bodyJson?.message ?? '');
  if (!code) return '403 carried no machine-readable `code` — clients would have to string-match the message to branch on it';
  if (code.toUpperCase() !== 'FORBIDDEN') return `403 with code="${code}", expected "FORBIDDEN"`;
  if (!msg.trim()) return '403 with an empty `message` — nothing tells an operator why it refused';
  if (/\bat [A-Za-z$_][\w$.]*\s*\(|\/(usr|home|opt|var)\/|node_modules|Traceback|SELECT .+ FROM /i.test(msg)) {
    return `403 message leaks internals: ${JSON.stringify(msg.slice(0, 120))}`;
  }
  return undefined;
}

/** Resolve the testcase + recent-execution ids the Executions, Statistics, Logs
 *  and Test-creator checks need. These used to be populated purely as a side
 *  effect of `testcases-list`, so selecting any of those categories WITHOUT
 *  also selecting Test cases skipped the whole lot with "no testcase id
 *  available" — a category that silently depends on another ticking is not
 *  something the UI ever communicated. Idempotent; safe to call from anywhere.
 *
 *  The execution id is validated before being handed out. metadata.lastExecution
 *  can name an execution the box has since garbage-collected, and /logs is the
 *  strict probe for that (unlike /statistics/global, which answers 200 with an
 *  empty payload even for an id that never existed). */
async function ensureTestcaseContext(c: RunCtx): Promise<void> {
  if (c.someTestcaseId) return;
  const r = await rawCall(c, 'GET', `${tBase(c.host)}/testcases?limit=50&offset=0`);
  const items: any[] = r.bodyJson?.items ?? [];
  if (!items.length) return;
  c.someTestcaseId = items[0].id;
  if (c.recentExecutionId) return;
  const candidate = items.find((it) => it.metadata?.lastExecution?.executionId)?.metadata?.lastExecution?.executionId;
  if (!candidate) return;
  const probe = await rawCall(c, 'GET', `${tBase(c.host)}/testcases/executions/${encodeURIComponent(candidate)}/logs?limit=1`);
  if (probe.status === 200 || probe.status === 202) c.recentExecutionId = candidate;
}

/** The simulator id the execution endpoints need. It is normally populated as a
 *  side effect of `simulators-list`, but that only runs when the Simulators
 *  category is selected — so running Executions on its own left it undefined,
 *  the stop URL lost its `?simulatorId=`, stop 400'd, and the un-stopped run
 *  then 409'd every later execution test. Fetch it on demand instead of
 *  depending on which categories the user happened to tick. */
async function ensureSimulatorId(c: RunCtx): Promise<string | undefined> {
  if (c.recentSimulatorId) return c.recentSimulatorId;
  const r = await rawCall(c, 'GET', `${tBase(c.host)}/simulators`);
  const id = r.bodyJson?.items?.[0]?.id;
  if (id) c.recentSimulatorId = String(id);
  return c.recentSimulatorId;
}

/** Wait for the simulator to go idle before starting an execution. Consecutive
 *  execution tests otherwise race their predecessor's teardown and 409. */
async function waitForSimulatorFree(c: RunCtx, timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await rawCall(c, 'GET', `${tBase(c.host)}/simulators`);
    const items: any[] = r.bodyJson?.items ?? [];
    if (items.length === 0) return true;
    if (items.some((s) => String(s.availability ?? '').toUpperCase() === 'AVAILABLE')) return true;
    await new Promise((res) => setTimeout(res, 3000));
  }
  return false;
}

/** Start an execution, retrying while the box says it is not ready yet.
 *  `availability: AVAILABLE` is necessary but NOT sufficient — for a while after
 *  a stop the box still answers a start with 503 (or 409), so the check that
 *  runs immediately after another execution test would fail on a transient
 *  state rather than a defect. Retries only the two "come back later" codes;
 *  every other status is returned as-is for the caller to judge. */
async function startExecution(c: RunCtx, testcaseId: string, attempts = 4): Promise<RawCallResult> {
  let last!: RawCallResult;
  for (let i = 0; i < attempts; i++) {
    last = await rawCall(c, 'POST', `${tBase(c.host)}/testcases/${encodeURIComponent(testcaseId)}/executions`, {
      headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    if (last.status !== 503 && last.status !== 409) return last;
    if (i < attempts - 1) {
      await new Promise((res) => setTimeout(res, 10_000));
      await waitForSimulatorFree(c, 30_000);
    }
  }
  return last;
}

/** Find a testcase that actually HAS the given /tests/{id}/{slug} section.
 *  Optional sections — mobility above all — only exist on cases authored with
 *  them, so pinning every section test to one arbitrary testcase made them skip
 *  on a box holding plenty of valid subjects. Bounded scan, memoised per slug;
 *  only ever reached when the primary subject 404s.
 *
 *  The scan depth matters more than it looks. Listings come back newest-first
 *  and this suite's own destructive tests add throwaway cases at the top, so a
 *  real subject drifts deeper every sweep: at scan=25 the mobility case on
 *  sys-4 was found one run and missed the next, purely because the catalogue
 *  had grown by a dozen rows in between. */
async function findSectionSubject(c: RunCtx, slug: string, scan = 100): Promise<string | undefined> {
  c.sectionSubjects = c.sectionSubjects ?? {};
  if (slug in c.sectionSubjects) return c.sectionSubjects[slug] ?? undefined;
  const lst = await rawCall(c, 'GET', `${tBase(c.host)}/testcases?limit=${scan}&offset=0`);
  for (const it of (lst.bodyJson?.items ?? []) as any[]) {
    if (!it?.id) continue;
    const r = await rawCall(c, 'GET', `${tBase(c.host)}/tests/${encodeURIComponent(it.id)}/${slug}`);
    if (r.status === 200) { c.sectionSubjects[slug] = it.id; return it.id; }
  }
  c.sectionSubjects[slug] = null;
  return undefined;
}

/** Whether the user-management surface is reachable at all on this build.
 *  Cached per run: several tests need the answer and it cannot change mid-run. */
async function userMgmtDisabled(c: RunCtx): Promise<string | undefined> {
  if (c.userMgmtDisabledReason !== undefined) {
    return c.userMgmtDisabledReason || undefined;
  }
  const probe = await rawCall(c, 'GET', `${tBase(c.host)}/users`);
  const reason = featureDisabled(probe)
    ? `user management is disabled on this build (GET /v2/users -> 403 "${probe.bodyJson?.message}")`
    : '';
  c.userMgmtDisabledReason = reason;
  return reason || undefined;
}

function ok(name: string, base: { id: string; category: ApiTestCategory; method: string; endpoint: string; severity: ApiTestSeverity; destructive?: boolean }, r: { status: number; ms: number } & EvidenceCarrier, detail: string): ApiTestResult {
  return { ...base, name, ok: true, status: r.status, durationMs: r.ms, detail, destructive: !!base.destructive, request: r.request, response: r.response, ranAt: new Date().toISOString() };
}
function bad(name: string, base: { id: string; category: ApiTestCategory; method: string; endpoint: string; severity: ApiTestSeverity; destructive?: boolean }, r: { status: number; ms: number; error?: string } & EvidenceCarrier, detail: string, expected?: string): ApiTestResult {
  return { ...base, name, ok: false, status: r.status, durationMs: r.ms, detail: r.error ? `${detail} (${r.error})` : detail, destructive: !!base.destructive, request: r.request, response: r.response, ranAt: new Date().toISOString(), expected };
}
function skip(name: string, base: { id: string; category: ApiTestCategory; method: string; endpoint: string; severity: ApiTestSeverity; destructive?: boolean }, reason: string): ApiTestResult {
  return { ...base, name, ok: true, skipped: true, skippedReason: reason, destructive: !!base.destructive, ranAt: new Date().toISOString() };
}

// ---------- Test-creator request bodies ----------
// Known-good payloads for the /tests/* config-builder family. Derived from the
// OpenAPI examples and CORRECTED against the live UE-sim box, where the spec
// examples are wrong:
//   • cellConfig.master.product MUST be "UE-SIM" on a UE-sim box.
//   • cellConfig.cells[].bandwidth is a STRING ("20"), not a number.
//   • subscriber startingIMSI is a NUMBER (uint64), not a quoted string.
//   • subscriber opc must match ^[0-9a-fA-F]{32}$ — omit it when op is supplied
//     (the spec's opc:"" is rejected).
// Section creation is ORDER-DEPENDENT: each section is gated on the previous
// one (cells → subscribers → user-plane → power-cycle → mobility → settings),
// and settings is the finaliser that LOCKS the case.
const TC_CELLS_LTE = {
  cellConfig: {
    master: { product: 'UE-SIM', carrierAggregation: false, channelSim: false, pdcchDecodeOpt: true, pdcchDecodeOptThreshold: 0.1, ratType: 'smartphone', turboIteration: 14 },
    cells: [{
      cellType: '4g', syncId: 0, duplexMode: 'FDD', band: '1', EARFCN: { dl: 300, ul: 18300 },
      bandwidth: '20', prach: 0, antennas: { dl: 1, ul: 1 }, rfCard: 0, rxToTxLatency: 4,
      txGain: [70], rxGain: [0], globalTimingAdvance: -1,
      mobility: { antennaType: 'isotropic', position: [4, 3], referencePower: -25, ulAttenuation: 60 },
    }],
  },
};
const TC_SUBS_LTE = {
  subsConfig: {
    subs: [{
      ueCount: 2, servingCell: 0, startingIMSI: 1010123456789, preferredPLMN: ['011-01', '544-780'],
      nextIMSI: 1, algorithm: 'milenage', sharedKey: '00112233445566778899aabbccddeeff',
      op: '000102030405060708090A0B0C0D0E0F', resLength: 8, securityContext: true, asRelease: 13,
      redCap: false, ueCategoryType: 'combined', ueCategory: '6', imeisv: '4085780000000102',
      powerControl: false, powerMin: 0, powerMax: 0, attachType: 'normal', ueInitiatedEvents: 'tau',
      eventsInLoop: true, triggerTime: [10], pdnType: 'ipv4', defaultApn: '',
      cipherAlgorithm: ['eea0', 'eea1', 'eea2'], integrityAlgorithm: ['eia0', 'eia1', 'eia2'],
      cqi: 'auto', ri: 'auto', pmi: 'auto', preambleIndex: 0,
    }],
  },
};
const TC_UPLANE = { userPlaneConfig: { profiles: [{ subscriberGroup: [0], dataType: 'no_data', pdnType: 'ipv4', apnName: '' }] } };
const TC_PCYCLE = { powerCycleConfig: { profiles: [{ subscriberGroup: [0], loopProfile: 'disable', attachType: 'bursty', attachRate: 1, attachDelay: 0, powerOnTime: 2000, powerOffTime: 10 }] } };
const TC_MOBILITY = { mobilityConfig: { profiles: [{ subscriberGroup: [0], tripType: 'roundTrip', loopProfile: 'time', startDelay: 5, duration: 380, waitTime: 0, uePosition: [0, 0], speed: 1, direction: 0, distance: 50, fadingProfile: { fadingType: 'awgn', frequencyDoppler: 70, mimoCorrelation: 'low' }, noiseSpectralDensity: -174 }] } };
// settings is the finaliser. 4.0.0_260602 tightened validation so a
// non-existent successCriteriaName now 400s with the explicit message:
//   "successCriteriaName 'X' does not exist".
// No public endpoint enumerates valid names (see P1 in the overnight bug
// report), so we self-discover by reading settings.successCriteriaName +
// .loggingProfileName off any existing testcase right before the call.
// Falls back to the historical defaults if the catalogue is empty.
async function tcSettingsBody(c: RunCtx, testCaseName?: string): Promise<any> {
  const fallback = { loggingProfileName: 'debug', successCriteriaName: 'abcd' };
  try {
    const list = await rawCall(c, 'POST', `${tBase(c.host)}/testcases/search`, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ offset: 0, limit: 25 }),
    });
    const items: any[] = list.bodyJson?.items ?? list.bodyJson?.data ?? [];
    for (const it of items) {
      const tc = await rawCall(c, 'GET', `${tBase(c.host)}/testcases/${encodeURIComponent(it.id)}`);
      const s = tc.bodyJson?.testDefinition?.settings;
      if (s?.successCriteriaName && s?.loggingProfileName) {
        return { settings: { ...s, ...(testCaseName ? { testCaseName, test_name: testCaseName } : {}) } };
      }
    }
  } catch { /* fall through to historical defaults */ }
  return { settings: { ...fallback, ...(testCaseName ? { testCaseName, test_name: testCaseName } : {}) } };
}

// ---------- Test definitions ----------

type RunFn = (ctx: RunCtx) => Promise<ApiTestResult>;

interface TestDef {
  id: string;
  name: string;
  category: ApiTestCategory;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  endpoint: string;
  severity: ApiTestSeverity;
  destructive?: boolean;
  longRunning?: boolean;
  run: RunFn;
}

function defs(): TestDef[] {
  const list: TestDef[] = [];

  // ---------- AUTH ----------
  list.push({
    id: 'auth-login', name: 'POST /login (admin/admin)', category: 'auth',
    method: 'POST', endpoint: '/v2/login', severity: 'critical',
    run: async (c) => {
      const base = { id: 'auth-login', category: 'auth' as const, method: 'POST', endpoint: '/v2/login', severity: 'critical' as const };
      const r = await rawCall(null, 'POST', `${tBase(c.host)}/login`, {
        auth: 'none', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: c.username, password: c.password }),
      });
      if (r.status === 200 && r.bodyJson?.access_token) return ok(base.id, base, r, 'token issued');
      return bad(base.id, base, r, `expected 200 with access_token, got ${r.status}`);
    },
  });
  list.push({
    id: 'auth-logout', name: 'POST /logout (uses a fresh token)', category: 'auth',
    method: 'POST', endpoint: '/v2/logout', severity: 'normal',
    run: async (c) => {
      const base = { id: 'auth-logout', category: 'auth' as const, method: 'POST', endpoint: '/v2/logout', severity: 'normal' as const };
      // Use a fresh token so we don't invalidate the shared token mid-run.
      const loginR = await fetch(`${tBase(c.host)}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: c.username, password: c.password }) });
      const body = await loginR.json().catch(() => undefined);
      if (!loginR.ok || !body?.access_token) {
        return bad(base.id, base, { status: loginR.status, ms: 0, request: { method: 'POST', url: `${tBase(c.host)}/login`, headers: { 'Content-Type': 'application/json' }, body: '{...}' } }, 'fresh login failed');
      }
      const url = `${tBase(c.host)}/logout`;
      const reqHeaders = { Authorization: `Bearer ${body.access_token}` };
      const t0 = Date.now();
      const res = await fetch(url, { method: 'POST', headers: reqHeaders });
      const ms = Date.now() - t0;
      const respText = await res.text().catch(() => '');
      const carrier = {
        status: res.status, ms,
        request: { method: 'POST', url, headers: redactHeaders(reqHeaders) },
        response: { status: res.status, statusText: res.statusText, headers: headersToObject(res.headers), body: truncate(respText).body, bodyTruncated: truncate(respText).truncated, contentType: res.headers.get('content-type') ?? undefined, durationMs: ms },
      };
      if (res.status === 204 || res.status === 200) return ok(base.id, base, carrier, `revoked fresh token`);
      return bad(base.id, base, carrier, `expected 204/200, got ${res.status}`);
    },
  });

  // ---------- VERSION ----------
  list.push({
    id: 'version-get', name: 'GET /version', category: 'version',
    method: 'GET', endpoint: '/v2/version', severity: 'normal',
    run: async (c) => {
      const base = { id: 'version-get', category: 'version' as const, method: 'GET', endpoint: '/v2/version', severity: 'normal' as const };
      const r = await rawCall(c, 'GET', `${tBase(c.host)}/version`);
      if (r.status === 200) return ok(base.id, base, r, JSON.stringify(r.bodyJson?.simnovator ?? r.bodyJson).slice(0, 120));
      // The box has a known issue where /version returns 401 even with a valid admin token.
      if (r.status === 401) return bad(base.id, base, r, 'returned 401 for admin token (spec mismatch)',
        '200 with body { simnovator: { version, build }, simulators: [...] } per the OpenAPI spec at lines 14-59. The endpoint is documented as bearer-protected and admin tokens should pass.');
      return bad(base.id, base, r, `unexpected ${r.status}`, '200 with version info per spec');
    },
  });

  // ---------- USERS ----------
  list.push({
    id: 'users-me', name: 'GET /users/me', category: 'users',
    method: 'GET', endpoint: '/v2/users/me', severity: 'critical',
    run: async (c) => {
      const base = { id: 'users-me', category: 'users' as const, method: 'GET', endpoint: '/v2/users/me', severity: 'critical' as const };
      const r = await rawCall(c, 'GET', `${tBase(c.host)}/users/me`);
      if (r.status === 200 && r.bodyJson?.username) return ok(base.id, base, r, `user=${r.bodyJson.username} roles=${(r.bodyJson.roles ?? []).join(',')}`);
      return bad(base.id, base, r, `expected 200 + username, got ${r.status}`);
    },
  });

  // ---------- ADMIN USERS ----------
  // The user list lives at GET /v2/users — the same call the box's own admin UI
  // makes. This test used to hit /v2/admin/users, a path that is registered
  // nowhere on the box (the string appears zero times in its shipped frontend
  // bundle) and so always 404'd. Note the box distinguishes the two cases
  // precisely: 404 "Not Found" = no such route, 403 FORBIDDEN "This feature is
  // disabled." = route exists but multi-user is switched off for this
  // deployment (env-config.js: VITE_DISABLE_MULTI_USER_SIM=true).
  //
  // On a box with multi-user off this used to skip. It no longer does: the
  // disabled state has its own contract (403 + code + message, NOT 200-with-
  // empty-list and NOT 404) and that contract is what gets asserted instead.
  // A skip would have reported nothing about a deployment we can still hold
  // to a standard. Verified 2026-08-26 against .102 (multi-user off).
  list.push({
    id: 'admin-users-list', name: 'GET /users (user list)', category: 'admin-users',
    method: 'GET', endpoint: '/v2/users', severity: 'normal',
    run: async (c) => {
      const base = { id: 'admin-users-list', category: 'admin-users' as const, method: 'GET', endpoint: '/v2/users', severity: 'normal' as const };
      const r = await rawCall(c, 'GET', `${tBase(c.host)}/users`);
      if (r.status === 200) {
        const n = collectionSize(r.bodyJson);
        if (n < 0) return bad(base.id, base, r, '200 but the body carries no user collection (no items/users/data array)',
          '200 with a user collection under items[] or users[].');
        // This request is authenticated as `admin`, so admin is necessarily a
        // user of this box — a 200 listing nobody cannot be a true answer. It
        // is the shape a half-disabled feature produces, and it is worse than
        // a 403 because it reads as the fact "this box has no users" instead
        // of "you may not ask". Caught here rather than in
        // disabledContractViolation, which only ever sees non-200 responses.
        if (n === 0) return bad(base.id, base, r, '200 with an empty user list — impossible while authenticated as admin; a disabled feature must refuse with 403, not answer 200 with nobody in it',
          'Either 200 listing at least the authenticated admin, or 403 { code: "FORBIDDEN", message: <why> } if multi-user is off. 200 with an empty collection is indistinguishable from "this box genuinely has no users".');
        return ok(base.id, base, r, `multi-user enabled — users=${n}`);
      }
      // Multi-user is off on this deployment. That is not a defect, but the
      // way the box announces it is still testable — and worth testing,
      // because the plausible-looking wrong answers (200 + empty list, or a
      // bare 404) are both actively misleading. See disabledContractViolation.
      const violation = disabledContractViolation(r);
      if (violation) {
        return bad(base.id, base, r, `multi-user is off, but the refusal is malformed: ${violation}`,
          'When a capability is disabled the box must answer 403 with { code: "FORBIDDEN", message: <why> } — never 200 with an empty list (indistinguishable from "no users exist"), never 404 (indistinguishable from an undeployed route), never 5xx.');
      }
      return ok(base.id, base, r, `multi-user off; refusal well-formed — 403 ${r.bodyJson?.code} "${r.bodyJson?.message}" (distinguishable from an empty list and from a missing route)`);
    },
  });

  list.push({
    id: 'admin-users-full-lifecycle', name: 'admin users + profile patch + sim assign/revoke (throwaway)', category: 'mutating',
    method: 'POST', endpoint: '/v2/admin/users (combo)', severity: 'normal', destructive: true,
    run: async (c) => {
      const base = { id: 'admin-users-full-lifecycle', category: 'mutating' as const, method: 'POST', endpoint: '/v2/admin/users (combo)', severity: 'normal' as const, destructive: true };
      // The box exposes user management under /v2/users, NOT /v2/admin/users:
      // grepping its shipped frontend bundle for "/v2/admin/" returns zero
      // hits, and POST /v2/admin/users answers 404 "Not Found" while POST
      // /v2/users answers 403 "This feature is disabled." The real verbs are
      // POST /v2/users, PATCH /v2/users/{id}, PUT /v2/users/{id}/role,
      // POST /v2/users/{id}/reset-password, DELETE /v2/users/{id}. This test
      // used to drive the invented /admin/ paths, so on a box WITH multi-user
      // enabled it would have failed at step 1 against a route that does not
      // exist. Corrected 2026-08-26 (same defect class as admin-users-list).
      const disabled = await userMgmtDisabled(c);
      if (disabled) {
        // Cannot create a user, but the refusal is still a contract: creation
        // must be declined with a clean 403, not a 404 (which would read as
        // "this API version has no user management") and not a 200 that
        // pretends to have created something.
        const create = await rawCall(c, 'POST', `${tBase(c.host)}/users`, {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: `simqa-probe-${Date.now().toString(36)}`, role: 'user' }),
        });
        if (create.status === 200 || create.status === 201) {
          return bad(base.id, base, create, `multi-user is off (GET /v2/users refuses) yet POST /v2/users answered ${create.status} — a user may now exist that nothing will clean up`,
            'With multi-user disabled, user creation must be refused with 403, not accepted.');
        }
        const violation = disabledContractViolation(create);
        if (violation) {
          return bad(base.id, base, create, `user creation is off, but the refusal is malformed: ${violation}`,
            'When user management is disabled, POST /v2/users must answer 403 { code: "FORBIDDEN", message: <why> }.');
        }
        return ok(base.id, base, create, `user management off; creation refused cleanly — 403 ${create.bodyJson?.code} "${create.bodyJson?.message}" (lifecycle not exercisable, but the refusal is correct)`);
      }
      const username = `simqa-tester-${Date.now().toString(36)}`;
      const traces: string[] = [];
      const trace = (label: string, r: { status: number }) => traces.push(`${label}=${r.status}`);

      // 1. POST /v2/users
      const create = await rawCall(c, 'POST', `${tBase(c.host)}/users`, {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, first_name: 'simqa', last_name: 'tester', email: `${username}@example.invalid`, role: 'user' }),
      });
      trace('create', create);
      if (create.status !== 201 && create.status !== 200) return bad(base.id, base, create, `create returned ${create.status}`);
      // Subsequent verbs address the user by the id the create returned, falling
      // back to the username when the box echoes no id.
      const uid = String(create.bodyJson?.id ?? create.bodyJson?.userId ?? username);

      // 2. POST /v2/users/{id}/reset-password
      const reset = await rawCall(c, 'POST', `${tBase(c.host)}/users/${encodeURIComponent(uid)}/reset-password`, {
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ new_password: 'TmpSimqa123!' }),
      });
      trace('reset', reset);

      // 3. PUT /v2/users/{id}/role
      const role = await rawCall(c, 'PUT', `${tBase(c.host)}/users/${encodeURIComponent(uid)}/role`, {
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'user' }),
      });
      trace('role', role);

      // 4. PATCH /v2/users/{id}: update first_name on the throwaway.
      const patch = await rawCall(c, 'PATCH', `${tBase(c.host)}/users/${encodeURIComponent(uid)}`, {
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ first_name: 'simqa-renamed' }),
      });
      trace('patch', patch);

      // 5. POST /simulators/{id}/users/{name}: assign throwaway to a known simulator.
      // 6. DELETE /simulators/{id}/users/{name}: revoke. Both gated on having a sim id.
      let assignTrace = 'assign=skipped';
      let revokeTrace = 'revoke=skipped';
      if (c.recentSimulatorId) {
        const assign = await rawCall(c, 'POST', `${tBase(c.host)}/simulators/${encodeURIComponent(c.recentSimulatorId)}/users/${encodeURIComponent(uid)}`);
        assignTrace = `assign=${assign.status}`;
        traces.push(assignTrace);
        const revoke = await rawCall(c, 'DELETE', `${tBase(c.host)}/simulators/${encodeURIComponent(c.recentSimulatorId)}/users/${encodeURIComponent(uid)}`);
        revokeTrace = `revoke=${revoke.status}`;
        traces.push(revokeTrace);
      } else {
        traces.push(assignTrace, revokeTrace);
      }

      // 7. DELETE /v2/users/{id}: cleanup.
      const del = await rawCall(c, 'DELETE', `${tBase(c.host)}/users/${encodeURIComponent(uid)}`);
      trace('delete', del);
      if (del.status !== 204 && del.status !== 200) return bad(base.id, base, del, `delete returned ${del.status} for ${username}`);
      return ok(base.id, base, create, `${username}: ${traces.join(' ')}`);
    },
  });

  // ---------- SIMULATORS ----------
  list.push({
    id: 'simulators-list', name: 'GET /simulators', category: 'simulators',
    method: 'GET', endpoint: '/v2/simulators', severity: 'critical',
    run: async (c) => {
      const base = { id: 'simulators-list', category: 'simulators' as const, method: 'GET', endpoint: '/v2/simulators', severity: 'critical' as const };
      const r = await rawCall(c, 'GET', `${tBase(c.host)}/simulators`);
      if (r.status === 200 && Array.isArray(r.bodyJson?.items)) {
        if (r.bodyJson.items.length > 0) c.recentSimulatorId = r.bodyJson.items[0].id;
        return ok(base.id, base, r, `${r.bodyJson.items.length} registered`);
      }
      return bad(base.id, base, r, `expected 200 with items[], got ${r.status}`);
    },
  });
  list.push({
    id: 'simulators-status', name: 'GET /simulators/{id}/status', category: 'simulators',
    method: 'GET', endpoint: '/v2/simulators/{id}/status', severity: 'normal',
    run: async (c) => {
      const base = { id: 'simulators-status', category: 'simulators' as const, method: 'GET', endpoint: '/v2/simulators/{id}/status', severity: 'normal' as const };
      if (!c.recentSimulatorId) return skip(base.id, base, 'no simulator id available (run simulators-list first)');
      const r = await rawCall(c, 'GET', `${tBase(c.host)}/simulators/${encodeURIComponent(c.recentSimulatorId)}/status`);
      if (r.status === 200) return ok(base.id, base, r, JSON.stringify(r.bodyJson).slice(0, 120));
      return bad(base.id, base, r, `got ${r.status}`);
    },
  });
  // Cross-check: the runtime-side view of a simulator's current execution.
  // Used by the end-to-end preflight to distinguish a real running testcase
  // from a stale BUSY flag (SIM40-2064). Two valid responses:
  //   200 → simulator has a live execution; body carries testcase + eid.
  //   404 with code=NOT_FOUND, message="no active execution found for
  //        simulator" → simulator currently idle.
  // Either response counts as a pass; the catalogue check is "does the
  // endpoint exist and answer coherently". When SIM40-2064 ships its fix,
  // a 404 here MUST coincide with availability=AVAILABLE in /simulators —
  // that cross-endpoint invariant is verified by the end-to-end preflight,
  // not by this catalogue check.
  list.push({
    id: 'executions-current-status', name: 'GET /testcases/executions/current/status?simulatorId={id}', category: 'simulators',
    method: 'GET', endpoint: '/v2/testcases/executions/current/status', severity: 'normal',
    run: async (c) => {
      const base = { id: 'executions-current-status', category: 'simulators' as const, method: 'GET' as const, endpoint: '/v2/testcases/executions/current/status', severity: 'normal' as const };
      if (!c.recentSimulatorId) return skip(base.id, base, 'no simulator id available (run simulators-list first)');
      const r = await rawCall(c, 'GET', `${tBase(c.host)}/testcases/executions/current/status?simulatorId=${encodeURIComponent(c.recentSimulatorId)}`);
      if (r.status === 200) return ok(base.id, base, r, 'simulator currently running an execution');
      // Box returns application/json content type even on 404, so the
      // diagnostic message lands in r.bodyJson.message (not r.bodyText —
      // bodyText is only populated by the non-JSON branch of rawCall).
      const msg = (r.bodyJson?.message as string | undefined) ?? r.bodyText ?? '';
      if (r.status === 404 && /no active execution found/i.test(msg)) {
        return ok(base.id, base, r, 'simulator idle (404 NOT_FOUND with expected NOT_FOUND body, contract-compliant)');
      }
      if (r.status === 400) return bad(base.id, base, r, `400 BAD_REQUEST — simulatorId rejected (likely a build that doesn't expose this endpoint)`);
      return bad(base.id, base, r, `unexpected status ${r.status}${msg ? ` (message: ${msg.slice(0, 120)})` : ''}`);
    },
  });

  // ---------- SYSTEM ----------
  list.push({
    id: 'system-log-settings', name: 'GET /system/log-settings', category: 'system',
    method: 'GET', endpoint: '/v2/system/log-settings', severity: 'optional',
    run: async (c) => {
      const base = { id: 'system-log-settings', category: 'system' as const, method: 'GET', endpoint: '/v2/system/log-settings', severity: 'optional' as const };
      const r = await rawCall(c, 'GET', `${tBase(c.host)}/system/log-settings`);
      if (r.status === 200) return ok(base.id, base, r, `${(r.bodyJson?.items ?? r.bodyJson?.logSettings ?? []).length ?? '?'} setting(s)`);
      return bad(base.id, base, r, `got ${r.status}`);
    },
  });

  // ---------- TOOLS ----------
  list.push({
    id: 'tools-bandinfo-nr', name: 'POST /band-info (NR)', category: 'tools',
    method: 'POST', endpoint: '/v2/band-info', severity: 'normal',
    run: async (c) => {
      const base = { id: 'tools-bandinfo-nr', category: 'tools' as const, method: 'POST', endpoint: '/v2/band-info', severity: 'normal' as const };
      const r = await rawCall(c, 'POST', `${tBase(c.host)}/band-info`, {
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rat: 'NR' }),
      });
      if (r.status === 200 && Array.isArray(r.bodyJson?.data)) return ok(base.id, base, r, `${r.bodyJson.data.length} bands`);
      return bad(base.id, base, r, `got ${r.status}`);
    },
  });
  list.push({
    id: 'tools-bandinfo-lte', name: 'POST /band-info (LTE)', category: 'tools',
    method: 'POST', endpoint: '/v2/band-info', severity: 'normal',
    run: async (c) => {
      const base = { id: 'tools-bandinfo-lte', category: 'tools' as const, method: 'POST', endpoint: '/v2/band-info', severity: 'normal' as const };
      const r = await rawCall(c, 'POST', `${tBase(c.host)}/band-info`, {
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rat: 'LTE' }),
      });
      if (r.status === 200 && Array.isArray(r.bodyJson?.data)) return ok(base.id, base, r, `${r.bodyJson.data.length} bands`);
      return bad(base.id, base, r, `got ${r.status}`);
    },
  });
  list.push({
    id: 'tools-satellite-tracker', name: 'POST /tools/satellite-tracker/metrics', category: 'tools',
    method: 'POST', endpoint: '/v2/tools/satellite-tracker/metrics', severity: 'optional',
    run: async (c) => {
      const base = { id: 'tools-satellite-tracker', category: 'tools' as const, method: 'POST', endpoint: '/v2/tools/satellite-tracker/metrics', severity: 'optional' as const };
      const r = await rawCall(c, 'POST', `${tBase(c.host)}/tools/satellite-tracker/metrics`, {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sLat: 0, sLon: 0, sAlt: 35786, sVel: 3.07, gLat: 0, gLon: 0 }),
      });
      if (r.status === 200) return ok(base.id, base, r, JSON.stringify(r.bodyJson).slice(0, 100));
      return bad(base.id, base, r, `got ${r.status}`);
    },
  });

  // ---------- TESTCASES ----------
  list.push({
    id: 'testcases-list', name: 'GET /testcases', category: 'testcases',
    method: 'GET', endpoint: '/v2/testcases', severity: 'critical',
    run: async (c) => {
      const base = { id: 'testcases-list', category: 'testcases' as const, method: 'GET', endpoint: '/v2/testcases', severity: 'critical' as const };
      const r = await rawCall(c, 'GET', `${tBase(c.host)}/testcases?limit=50&offset=0`);
      if (r.status === 200 && Array.isArray(r.bodyJson?.items)) {
        const items = r.bodyJson.items;
        if (items.length > 0) {
          c.someTestcaseId = items[0].id;
          // Pull a recent execution id from the metadata if available.
          // The metadata field can carry a stale id (execution since GC'd or
          // from a different DB state) — every stats/logs check would then
          // hit a guaranteed 404 and FAIL even though the endpoints work.
          // We validate the discovered id ONCE here by hitting a cheap stats
          // endpoint; if it 404s, drop it so downstream checks SKIP cleanly
          // instead of stacking up false-positive failures.
          let candidate: string | undefined;
          for (const it of items) {
            const last = it.metadata?.lastExecution;
            if (last?.executionId) { candidate = last.executionId; break; }
          }
          if (candidate) {
            // Probe the eid with the /logs endpoint, not /statistics/global.
            // Empirical: /statistics/global is permissive (returns 200 with
            // empty data even when the execution has been GC'd) so it
            // false-passes stale eids. /logs is strict — 404 if the
            // execution doesn't exist. /v2/testcases/executions/{eid}/logs
            // is the same code path the stats/ue-summary endpoint uses for
            // its existence check, so its verdict matches what the other
            // stats endpoints will do.
            try {
              const probe = await rawCall(c, 'GET', `${tBase(c.host)}/testcases/executions/${encodeURIComponent(candidate)}/logs?limit=1`);
              if (probe.status === 200 || probe.status === 202) {
                c.recentExecutionId = candidate;
              }
              // Anything else (404, 500, etc.) → keep recentExecutionId
              // undefined so stats/logs checks SKIP with "no execution id
              // available — this system has no recent execution to validate
              // stats against".
            } catch {
              // Network blip — same fallback as 404.
            }
          }
        }
        return ok(base.id, base, r, `total=${r.bodyJson.total ?? items.length}${c.recentExecutionId ? ` · recentExecutionId=${c.recentExecutionId.slice(0,8)}…` : ' · no live execution available for stats/logs validation'}`);
      }
      return bad(base.id, base, r, `got ${r.status}`);
    },
  });
  list.push({
    id: 'testcases-get-one', name: 'GET /testcases/{id}', category: 'testcases',
    method: 'GET', endpoint: '/v2/testcases/{id}', severity: 'critical',
    run: async (c) => {
      const base = { id: 'testcases-get-one', category: 'testcases' as const, method: 'GET', endpoint: '/v2/testcases/{id}', severity: 'critical' as const };
      await ensureTestcaseContext(c);
      if (!c.someTestcaseId) return skip(base.id, base, 'no testcases exist on this box');
      const r = await rawCall(c, 'GET', `${tBase(c.host)}/testcases/${encodeURIComponent(c.someTestcaseId)}`);
      if (r.status === 200 && r.bodyJson?.testDefinition) return ok(base.id, base, r, `id=${r.bodyJson.id} has testDefinition`);
      return bad(base.id, base, r, `got ${r.status}`);
    },
  });
  list.push({
    id: 'testcases-search', name: 'POST /testcases/search', category: 'testcases',
    method: 'POST', endpoint: '/v2/testcases/search', severity: 'normal',
    run: async (c) => {
      const base = { id: 'testcases-search', category: 'testcases' as const, method: 'POST', endpoint: '/v2/testcases/search', severity: 'normal' as const };
      const r = await rawCall(c, 'POST', `${tBase(c.host)}/testcases/search`, {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pageNumber: 1, pageSize: 10, sortOrder: 'DESC' }),
      });
      if (r.status === 200 && Array.isArray(r.bodyJson?.items)) return ok(base.id, base, r, `items=${r.bodyJson.items.length}`);
      return bad(base.id, base, r, `got ${r.status}`);
    },
  });
  list.push({
    id: 'testcases-export', name: 'POST /testcases/export', category: 'testcases',
    method: 'POST', endpoint: '/v2/testcases/export', severity: 'optional', longRunning: true,
    run: async (c) => {
      const base = { id: 'testcases-export', category: 'testcases' as const, method: 'POST', endpoint: '/v2/testcases/export', severity: 'optional' as const };
      await ensureTestcaseContext(c);
      if (!c.someTestcaseId) return skip(base.id, base, 'no testcases exist on this box');
      const r = await rawCall(c, 'POST', `${tBase(c.host)}/testcases/export`, {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ testCaseIds: [c.someTestcaseId], output: { type: 'json' } }),
      });
      if (r.status === 200 || r.status === 202) return ok(base.id, base, r, exportEvidence(r));
      return bad(base.id, base, r, `got ${r.status}`);
    },
  });

  // Integrity test: when N testcases are requested, exactly N must come back.
  // Discovered: server silently drops most of them — requesting 1048 returns ~77.
  // Counts as a critical data-loss bug (any backup/migration flow is unreliable).
  list.push({
    id: 'testcases-export-count-integrity',
    name: 'POST /testcases/export returns every requested testcase (count integrity)',
    category: 'testcases',
    method: 'POST', endpoint: '/v2/testcases/export', severity: 'critical',
    longRunning: true,
    run: async (c) => {
      const base = { id: 'testcases-export-count-integrity', category: 'testcases' as const, method: 'POST' as const, endpoint: '/v2/testcases/export', severity: 'critical' as const };

      // Fetch a batch of ids to exercise the endpoint with realistic load.
      const list = await rawCall(c, 'GET', `${tBase(c.host)}/testcases?limit=200&offset=0`);
      if (list.status !== 200) return bad(base.id, base, list, `pre-step list returned ${list.status}`);
      const ids: string[] = (list.bodyJson?.items ?? []).map((it: any) => it.id).filter(Boolean);
      if (ids.length === 0) return skip(base.id, base, 'no testcases on the box');

      // Pick a sample size that's both meaningful AND not so big that the test
      // runs forever in CI: min(50, all available). The bug reproduces at any N >= 3.
      const sample = ids.slice(0, Math.min(50, ids.length));
      const r = await rawCall(c, 'POST', `${tBase(c.host)}/testcases/export`, {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ testCaseIds: sample, output: { type: 'json' } }),
      });

      if (r.status !== 200) return bad(base.id, base, r, `export returned ${r.status} — expected 200`,
        '200 OK with the documented response body containing one entry per requested testcase id');

      // Parse and count. Documented shape: { test_case_details: [...] } per
      // observed responses; spec at lines 1111-1170 doesn't pin a name, so we
      // accept either `test_case_details`, `testCases`, or a top-level array.
      const body: any = r.bodyJson;
      const arr: any[] =
        Array.isArray(body) ? body :
        Array.isArray(body?.test_case_details) ? body.test_case_details :
        Array.isArray(body?.testCases) ? body.testCases :
        [];

      const got = arr.length;
      const want = sample.length;
      const exportedIds = new Set(arr.map((x) => x.Test_Id ?? x.id ?? x.testCaseId).filter(Boolean));
      const missing = sample.filter((id) => !exportedIds.has(id));

      if (got === want) {
        return ok(base.id, base, r, `exported ${got}/${want} testcases`);
      }
      const sampleMissing = missing.slice(0, 5).join(', ');
      return bad(base.id, base, r, `export integrity FAILED: requested ${want}, server returned ${got} (${missing.length} missing, e.g. ${sampleMissing})`,
        `200 with a body containing exactly ${want} entries — one per requested id. Server currently drops ${missing.length} of ${want} silently with no error indication, no partial-success metadata, and no warning header. Reproducible at any batch size >= 3 with output.type=json AND output.type=zip.`);
    },
  });

  // ---------- STATISTICS ----------
  // Note: OpenAPI spec puts these under `/v2/api/testcases/...` but the box
  // actually serves them at `/v2/testcases/...` (no /api/ prefix). Verified
  // by probing both forms: A returns 404, B returns 200. Using B.
  list.push({
    id: 'stats-global', name: 'GET /testcases/executions/{eid}/statistics/global', category: 'statistics',
    method: 'GET', endpoint: '/v2/testcases/executions/{eid}/statistics/global', severity: 'normal',
    run: async (c) => {
      const base = { id: 'stats-global', category: 'statistics' as const, method: 'GET', endpoint: '/v2/testcases/executions/{eid}/statistics/global', severity: 'normal' as const };
      await ensureTestcaseContext(c);
      if (!c.recentExecutionId) return skip(base.id, base, 'this box has no recent execution to read statistics from — run a test first');
      const end = Math.floor(Date.now() / 1000);
      const start = end - 24 * 3600;
      const r = await rawCall(c, 'GET', `${tBase(c.host)}/testcases/executions/${encodeURIComponent(c.recentExecutionId)}/statistics/global?startTime=${start}&endTime=${end}`);
      if (r.status === 200) return ok(base.id, base, r, JSON.stringify(r.bodyJson).slice(0, 100));
      if (r.status === 404) return skip(base.id, base, 'execution not found on this system (eid stale — no recent execution to validate against). Run a test and re-try.');
      return bad(base.id, base, r, `got ${r.status}`);
    },
  });
  list.push({
    id: 'stats-cells-summary', name: 'GET /testcases/executions/{eid}/statistics/cells-summary', category: 'statistics',
    method: 'GET', endpoint: '/v2/testcases/executions/{eid}/statistics/cells-summary', severity: 'normal',
    run: async (c) => {
      const base = { id: 'stats-cells-summary', category: 'statistics' as const, method: 'GET', endpoint: '/v2/testcases/executions/{eid}/statistics/cells-summary', severity: 'normal' as const };
      await ensureTestcaseContext(c);
      if (!c.recentExecutionId) return skip(base.id, base, 'this box has no recent execution to read statistics from — run a test first');
      const end = Math.floor(Date.now() / 1000);
      const start = end - 24 * 3600;
      const r = await rawCall(c, 'GET', `${tBase(c.host)}/testcases/executions/${encodeURIComponent(c.recentExecutionId)}/statistics/cells-summary?startTime=${start}&endTime=${end}`);
      if (r.status === 200) return ok(base.id, base, r, JSON.stringify(r.bodyJson).slice(0, 100));
      if (r.status === 404) return skip(base.id, base, 'execution not found on this system (eid stale — no recent execution to validate against). Run a test and re-try.');
      return bad(base.id, base, r, `got ${r.status}`);
    },
  });

  // GET-shaped statistics endpoints (no /api/ prefix). 'ue-summary' is NOT one
  // of these — it is a POST and is tested separately below.
  for (const slug of ['cells', 'ues']) {
    list.push({
      id: `stats-${slug}`, name: `GET /testcases/executions/{eid}/statistics/${slug}`, category: 'statistics',
      method: 'GET', endpoint: `/v2/testcases/executions/{eid}/statistics/${slug}`, severity: 'normal',
      run: async (c) => {
        const base = { id: `stats-${slug}`, category: 'statistics' as const, method: 'GET' as const, endpoint: `/v2/testcases/executions/{eid}/statistics/${slug}`, severity: 'normal' as const };
        await ensureTestcaseContext(c);
        if (!c.recentExecutionId) return skip(base.id, base, 'this box has no recent execution to read statistics from — run a test first');
        const end = Math.floor(Date.now() / 1000);
        const start = end - 24 * 3600;
        const r = await rawCall(c, 'GET', `${tBase(c.host)}/testcases/executions/${encodeURIComponent(c.recentExecutionId)}/statistics/${slug}?startTime=${start}&endTime=${end}`);
        if (r.status === 200) return ok(base.id, base, r, JSON.stringify(r.bodyJson).slice(0, 100));
        if (r.status === 404) {
          // This used to be reported as "eid stale". It cannot be: the box
          // answers a completely nonexistent execution id with 200 and an empty
          // payload (verified live 2026-08-26 against an all-zero uuid), so a
          // 404 never means "no such execution" — it means the ROUTE is absent.
          // Prove it by asking a sibling slug for the SAME execution id.
          const control = slug === 'ues' ? 'cells' : 'ues';
          const sib = await rawCall(c, 'GET', `${tBase(c.host)}/testcases/executions/${encodeURIComponent(c.recentExecutionId!)}/statistics/${control}?startTime=${start}&endTime=${end}`);
          if (sib.status === 200) {
            return skip(base.id, base, `/statistics/${slug} is not served on this build — 404, while /statistics/${control} returns 200 for the same execution id, so the route is missing rather than the execution`);
          }
          return bad(base.id, base, r, `got 404, and the sibling /statistics/${control} also returned ${sib.status} — statistics look unreachable for this execution`,
            `200 with a statistics payload. Both /statistics/${slug} and /statistics/${control} failing points at the execution or the stats service, not one missing route.`);
        }
        return bad(base.id, base, r, `got ${r.status}`);
      },
    });
  }

  // ue-summary is the odd one out: it is a POST with a JSON body, not a GET
  // with a query string like its siblings. Calling it as a GET hits no route
  // and returns the generic 404, which this suite spent a long time
  // misdiagnosing — first as a stale execution id, then as an endpoint missing
  // from the build. It is neither; the box's own UI posts to it. Paging here
  // uses `offset` as a 1-BASED page number (the box's third paging vocabulary).
  list.push({
    id: 'stats-ue-summary', name: 'POST /testcases/executions/{eid}/statistics/ue-summary', category: 'statistics',
    method: 'POST', endpoint: '/v2/testcases/executions/{eid}/statistics/ue-summary', severity: 'normal',
    run: async (c) => {
      const base = { id: 'stats-ue-summary', category: 'statistics' as const, method: 'POST' as const, endpoint: '/v2/testcases/executions/{eid}/statistics/ue-summary', severity: 'normal' as const };
      await ensureTestcaseContext(c);
      if (!c.recentExecutionId) return skip(base.id, base, 'this box has no recent execution to read statistics from — run a test first');
      const end = Math.floor(Date.now() / 1000);
      const start = end - 24 * 3600;
      const r = await rawCall(c, 'POST', `${tBase(c.host)}/testcases/executions/${encodeURIComponent(c.recentExecutionId)}/statistics/ue-summary`, {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ startTime: start, endTime: end, offset: 1, limit: 50 }),
      });
      if (r.status === 200) {
        const rows = Array.isArray(r.bodyJson?.data?.ue_data) ? r.bodyJson.data.ue_data.length : 0;
        return ok(base.id, base, r, `${rows} ue_data row(s) in the last 24h window`);
      }
      if (r.status === 404) return bad(base.id, base, r, 'POST returned 404 — the ue-summary route is not served on this build',
        '200 with { data: { ue_data: [...] } }. This endpoint is a POST with a JSON body ({startTime, endTime, offset, limit}); a GET on the same path legitimately 404s.');
      return bad(base.id, base, r, `expected 200, got ${r.status}`);
    },
  });

  // Statistics + log exports (binary, long-running by default).
  for (const slug of ['cells', 'ues']) {
    list.push({
      id: `stats-${slug}-export`, name: `GET /testcases/executions/{eid}/statistics/${slug}/export`, category: 'statistics',
      method: 'GET', endpoint: `/v2/testcases/executions/{eid}/statistics/${slug}/export`, severity: 'optional', longRunning: true,
      run: async (c) => {
        const base = { id: `stats-${slug}-export`, category: 'statistics' as const, method: 'GET' as const, endpoint: `/v2/testcases/executions/{eid}/statistics/${slug}/export`, severity: 'optional' as const };
        await ensureTestcaseContext(c);
        if (!c.recentExecutionId) return skip(base.id, base, 'this box has no recent execution to read statistics from — run a test first');
        const r = await rawCall(c, 'GET', `${tBase(c.host)}/testcases/executions/${encodeURIComponent(c.recentExecutionId)}/statistics/${slug}/export?format=zip`);
        if (r.status === 200 || r.status === 202) return ok(base.id, base, r, exportEvidence(r));
        if (r.status === 404) return skip(base.id, base, `/statistics/${slug}/export is not served on this build (404) — a nonexistent execution id returns 200 here, so a 404 means the route is missing, not the execution`);
        return bad(base.id, base, r, `got ${r.status}`);
      },
    });
  }

  // ---------- LOGS ----------
  list.push({
    id: 'logs-fetch', name: 'GET /testcases/executions/{eid}/logs', category: 'logs',
    method: 'GET', endpoint: '/v2/testcases/executions/{eid}/logs', severity: 'normal',
    run: async (c) => {
      const base = { id: 'logs-fetch', category: 'logs' as const, method: 'GET', endpoint: '/v2/testcases/executions/{eid}/logs', severity: 'normal' as const };
      await ensureTestcaseContext(c);
      if (!c.recentExecutionId) return skip(base.id, base, 'this box has no recent execution to read statistics from — run a test first');
      const r = await rawCall(c, 'GET', `${tBase(c.host)}/testcases/executions/${encodeURIComponent(c.recentExecutionId)}/logs?limit=10`);
      if (r.status === 200) return ok(base.id, base, r, JSON.stringify(r.bodyJson).slice(0, 100));
      if (r.status === 404) return skip(base.id, base, 'execution not found on this system (eid stale — no recent execution to validate against). Run a test and re-try.');
      return bad(base.id, base, r, `got ${r.status}`);
    },
  });
  list.push({
    id: 'logs-export', name: 'GET /testcases/executions/{eid}/logs/export', category: 'logs',
    method: 'GET', endpoint: '/v2/testcases/executions/{eid}/logs/export', severity: 'optional', longRunning: true,
    run: async (c) => {
      const base = { id: 'logs-export', category: 'logs' as const, method: 'GET' as const, endpoint: '/v2/testcases/executions/{eid}/logs/export', severity: 'optional' as const };
      await ensureTestcaseContext(c);
      if (!c.recentExecutionId) return skip(base.id, base, 'this box has no recent execution to read statistics from — run a test first');
      const r = await rawCall(c, 'GET', `${tBase(c.host)}/testcases/executions/${encodeURIComponent(c.recentExecutionId)}/logs/export?format=zip`);
      if (r.status === 200 || r.status === 202) return ok(base.id, base, r, exportEvidence(r));
      if (r.status === 404) return skip(base.id, base, '/logs/export is not served on this build (404) — a nonexistent execution id returns 200 here, so a 404 means the route is missing, not the execution');
      return bad(base.id, base, r, `got ${r.status}`);
    },
  });

  // ---------- NEGATIVE ----------
  list.push({
    id: 'neg-login-wrong', name: 'POST /login wrong password -> 401', category: 'negative',
    method: 'POST', endpoint: '/v2/login', severity: 'normal',
    run: async (c) => {
      const base = { id: 'neg-login-wrong', category: 'negative' as const, method: 'POST', endpoint: '/v2/login', severity: 'normal' as const };
      const r = await rawCall(null, 'POST', `${tBase(c.host)}/login`, {
        auth: 'none', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: c.username, password: 'definitely-wrong-' + Date.now() }),
      });
      if (r.status === 401) return ok(base.id, base, r, 'rejected wrong password as expected');
      return bad(base.id, base, r, `expected 401, got ${r.status}`);
    },
  });
  list.push({
    id: 'neg-no-token', name: 'GET /testcases without token -> 401', category: 'negative',
    method: 'GET', endpoint: '/v2/testcases', severity: 'normal',
    run: async (c) => {
      const base = { id: 'neg-no-token', category: 'negative' as const, method: 'GET', endpoint: '/v2/testcases', severity: 'normal' as const };
      const r = await rawCall(null, 'GET', `${tBase(c.host)}/testcases`, { auth: 'none' });
      if (r.status === 401) return ok(base.id, base, r, 'rejected unauthenticated as expected');
      return bad(base.id, base, r, `expected 401, got ${r.status}`);
    },
  });
  list.push({
    id: 'neg-bad-token', name: 'GET /testcases with bogus token -> 401', category: 'negative',
    method: 'GET', endpoint: '/v2/testcases', severity: 'normal',
    run: async (c) => {
      const base = { id: 'neg-bad-token', category: 'negative' as const, method: 'GET', endpoint: '/v2/testcases', severity: 'normal' as const };
      const r = await rawCall(c, 'GET', `${tBase(c.host)}/testcases`, { auth: 'wrong' });
      if (r.status === 401) return ok(base.id, base, r, 'rejected bogus token as expected');
      return bad(base.id, base, r, `expected 401, got ${r.status}`);
    },
  });
  list.push({
    id: 'neg-testcase-404', name: 'GET /testcases/<garbage> -> 404', category: 'negative',
    method: 'GET', endpoint: '/v2/testcases/{id}', severity: 'normal',
    run: async (c) => {
      const base = { id: 'neg-testcase-404', category: 'negative' as const, method: 'GET', endpoint: '/v2/testcases/{id}', severity: 'normal' as const };
      const r = await rawCall(c, 'GET', `${tBase(c.host)}/testcases/_simqa_does_not_exist_`);
      if (r.status === 404) return ok(base.id, base, r, '404 as expected');
      return bad(base.id, base, r, `expected 404, got ${r.status}`);
    },
  });
  list.push({
    id: 'neg-bandinfo-bad-rat', name: 'POST /band-info (rat=BOGUS) -> 400', category: 'negative',
    method: 'POST', endpoint: '/v2/band-info', severity: 'normal',
    run: async (c) => {
      const base = { id: 'neg-bandinfo-bad-rat', category: 'negative' as const, method: 'POST', endpoint: '/v2/band-info', severity: 'normal' as const };
      const r = await rawCall(c, 'POST', `${tBase(c.host)}/band-info`, {
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rat: 'BOGUS' }),
      });
      if (r.status === 400) return ok(base.id, base, r, '400 as expected');
      return bad(base.id, base, r, `expected 400, got ${r.status}`);
    },
  });

  // ---------- NEGATIVE-PATH + CONTRACT SWEEP (added 2026-06-11) ----------
  // Read-only / 404-guaranteed probes. None of these can start an execution
  // or mutate state: the only POSTs either target a testcase id that cannot
  // exist (fresh random UUID) or hit the read-only /testcases/search route.

  /** Syntactically-plausible v4-style UUID guaranteed not to exist on the box. */
  const nonexistentUuid = (): string =>
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
      const r = (Math.random() * 16) | 0;
      return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });

  // SIM40-2011: starting an execution on a NONEXISTENT testcase id must be a
  // clean client error (404 preferred, any 4xx tolerated) — never a 5xx. This
  // POST is safe despite the no-mutation rule: the id cannot exist, so nothing
  // can actually start. Body carries simulatorId because 4.0.0_260609 requires
  // it on the start route ("No default simulator found" 500 without it) — we
  // want the verdict to reflect the id lookup, not the missing-field path
  // (that path has its own check below).
  list.push({
    id: 'exec-start-nonexistent-404', name: 'POST /testcases/<nonexistent>/executions -> 404, never 5xx (SIM40-2011)', category: 'negative',
    method: 'POST', endpoint: '/v2/testcases/{id}/executions', severity: 'normal',
    run: async (c) => {
      const base = { id: 'exec-start-nonexistent-404', category: 'negative' as const, method: 'POST' as const, endpoint: '/v2/testcases/{id}/executions', severity: 'normal' as const };
      const ghost = nonexistentUuid();
      const simId = c.recentSimulatorId ?? '1';
      const r = await rawCall(c, 'POST', `${tBase(c.host)}/testcases/${encodeURIComponent(ghost)}/executions`, {
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ simulatorId: simId }),
      });
      const expected = '404 NOT_FOUND naming the unknown testcase id. A 5xx for a client-side identifier mistake masks the real problem and pages on-call for nothing (SIM40-2011).';
      if (r.status === 404) return ok(base.id, base, r, `404 as expected for nonexistent testcase id (simulatorId=${simId})`);
      if (r.status >= 400 && r.status < 500) return ok(base.id, base, r, `${r.status} (4xx — acceptable; 404 preferred; simulatorId=${simId})`);
      if (r.status >= 500) return bad(base.id, base, r, `5xx for a nonexistent testcase id — server error where a 404 belongs (simulatorId=${simId})`, expected);
      if (r.status >= 200 && r.status < 300) {
        // Pathological: the box claims to have started a run for an id that
        // cannot exist. Best-effort cleanup — stop whatever is now running on
        // the simulator we named (mirrors the exec-start-stop pattern).
        const stop = await rawCall(c, 'POST', `${tBase(c.host)}/testcases/executions/current/stop?simulatorId=${encodeURIComponent(simId)}`, {
          headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        return bad(base.id, base, r, `${r.status} — box claims to have started an execution for an id that does not exist (simulatorId=${simId}; cleanup stop returned ${stop.status})`, expected);
      }
      return bad(base.id, base, r, `unexpected ${r.status} (simulatorId=${simId})`, expected);
    },
  });

  // Regression tripwire for the 2026-06-10 finding (SIM40-2011 family,
  // missing-simulatorId variant): on 4.0.0_260609, POST .../executions with
  // an EMPTY body ({}, no simulatorId) against an EXISTING testcase id 500s
  // with "No default simulator found". A missing request field is a client
  // error and deserves 400, never 500.
  // LIMITATION (deliberate): we use a nonexistent UUID instead of a real id —
  // exercising the existing-id form would START a real execution on any build
  // that accepts the request, which simqa's no-mutation rule forbids outside
  // the destructive gate. If the box resolves the simulator BEFORE looking up
  // the testcase (the 260609 behaviour), this form still 500s and the check
  // goes RED exactly as intended; if the box checks the id first, we instead
  // verify the nonexistent-id contract and the existing-id 500 stays
  // documented here rather than reproduced. Expected RED on 260609.
  list.push({
    id: 'exec-start-missing-simulatorid-4xx', name: 'POST /testcases/{id}/executions with empty body -> 4xx, never 5xx', category: 'negative',
    method: 'POST', endpoint: '/v2/testcases/{id}/executions (empty body)', severity: 'normal',
    run: async (c) => {
      const base = { id: 'exec-start-missing-simulatorid-4xx', category: 'negative' as const, method: 'POST' as const, endpoint: '/v2/testcases/{id}/executions (empty body)', severity: 'normal' as const };
      const ghost = nonexistentUuid();
      const r = await rawCall(c, 'POST', `${tBase(c.host)}/testcases/${encodeURIComponent(ghost)}/executions`, {
        headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      const expected = '4xx (400 "simulatorId is required" or 404 for the unknown id). On 4.0.0_260609 an EXISTING id with an empty body returns 500 "No default simulator found" — a missing field is a client error, not a server crash.';
      if (r.status >= 400 && r.status < 500) return ok(base.id, base, r, `${r.status} — client error as required for a request missing simulatorId`);
      if (r.status >= 500) return bad(base.id, base, r, `5xx on an empty start body (known 260609 behaviour: "No default simulator found") — should be 4xx`, expected);
      if (r.status >= 200 && r.status < 300) {
        // Pathological: the box accepted a start with no simulatorId for an id
        // that cannot exist. Best-effort cleanup — stop whatever is now
        // running (mirrors the exec-start-stop pattern; no simulatorId was
        // sent on start, so only pass one if we discovered it).
        const stop = await rawCall(c, 'POST', `${tBase(c.host)}/testcases/executions/current/stop${c.recentSimulatorId ? `?simulatorId=${encodeURIComponent(c.recentSimulatorId)}` : ''}`, {
          headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        return bad(base.id, base, r, `${r.status} — box accepted a start for a nonexistent id with no simulatorId (cleanup stop returned ${stop.status})`, expected);
      }
      return bad(base.id, base, r, `unexpected ${r.status}`, expected);
    },
  });

  // SIM40-2012-class: malformed search filters must be rejected with 400. A
  // 5xx means the filter payload reaches the query layer unvalidated; a 2xx
  // means garbage (unknown fields, $-operators, limit=-5) is silently accepted.
  list.push({
    id: 'search-malformed-filter-400', name: 'POST /testcases/search with garbage filter -> 400, never 5xx (SIM40-2012-class)', category: 'negative',
    method: 'POST', endpoint: '/v2/testcases/search', severity: 'normal',
    run: async (c) => {
      const base = { id: 'search-malformed-filter-400', category: 'negative' as const, method: 'POST' as const, endpoint: '/v2/testcases/search', severity: 'normal' as const };
      const r = await rawCall(c, 'POST', `${tBase(c.host)}/testcases/search`, {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filter: { unknownField: { $bogus: 1 } }, limit: -5 }),
      });
      const expected = '400 BAD_REQUEST with a JSON error envelope naming the offending field. Never 5xx (filter reached the query layer unvalidated, SIM40-2012-class) and never 2xx (garbage silently accepted).';
      if (r.status >= 400 && r.status < 500) return ok(base.id, base, r, `rejected with ${r.status} (good)`);
      if (r.status >= 500) return bad(base.id, base, r, '5xx — search crashed on a malformed filter payload', expected);
      if (r.status >= 200 && r.status < 300) return bad(base.id, base, r, `${r.status} — malformed filter + limit=-5 silently accepted (validation gap)`, expected);
      return bad(base.id, base, r, `unexpected ${r.status}`, expected);
    },
  });

  // SIM40-2022-class (wrong/misleading errors on nonexistent resources). The
  // sweep spec asked for PATCH /simulators/<nonexistent> — but PATCH is a
  // mutation verb and simqa's no-mutation rule is enforced by VERB, not by
  // reachability of the target. So we probe the same id-lookup path with GET:
  // a nonexistent simulator id must yield a clean 404, not a 5xx or a
  // misleading error body.
  list.push({
    id: 'simulators-get-nonexistent-404', name: 'GET /simulators/<nonexistent> -> 404 (SIM40-2022-class)', category: 'negative',
    method: 'GET', endpoint: '/v2/simulators/{id}', severity: 'normal',
    run: async (c) => {
      const base = { id: 'simulators-get-nonexistent-404', category: 'negative' as const, method: 'GET' as const, endpoint: '/v2/simulators/{id}', severity: 'normal' as const };
      const ghost = nonexistentUuid();
      const r = await rawCall(c, 'GET', `${tBase(c.host)}/simulators/${encodeURIComponent(ghost)}`);
      const expected = '404 NOT_FOUND with an error body naming the unknown simulator id (SIM40-2022-class: errors must describe the actual problem).';
      if (r.status === 404) return ok(base.id, base, r, '404 as expected for nonexistent simulator id');
      // Some builds only route /simulators/{id} for PATCH/DELETE — a 405 means
      // the lookup path is not probeable with a read verb on this build.
      if (r.status === 405) return skip(base.id, base, 'GET not routed for /simulators/{id} on this build (405) — lookup path not probeable read-only');
      if (r.status >= 400 && r.status < 500) return ok(base.id, base, r, `${r.status} (4xx — acceptable; 404 preferred)`);
      if (r.status >= 500) return bad(base.id, base, r, '5xx for a nonexistent simulator id — server error where a 404 belongs', expected);
      if (r.status >= 200 && r.status < 300) return bad(base.id, base, r, `${r.status} — box returned success for a simulator id that does not exist`, expected);
      return bad(base.id, base, r, `unexpected ${r.status}`, expected);
    },
  });

  // Enumeration reach: GET /v2/testcases caps a single response at 1000 rows,
  // so a box holding more than that can only be enumerated by paging. This
  // check walks to the LAST page and requires it to come back.
  //
  // Careful with the paging vocabulary — it is not what it looks like. On this
  // firmware `offset` is a ZERO-BASED PAGE INDEX and `limit` is the page size
  // (verified live 2026-08-26: limit=5&offset=10 returns row 50, not row 10;
  // limit=100&offset=1 returns rows 100-199). An out-of-range page returns
  // 400 {"code":"BAD_REQUEST","message":"requested page N out of range"}, not
  // the empty page this check's first version expected. It used to compute a
  // ROW offset (total - 5) and treat a 400 as proof of an enumeration cap —
  // on any box with >1000 testcases that would have reported a product bug
  // that isn't there.
  list.push({
    id: 'testcases-list-cap-documented', name: 'GET /testcases — the last page of a >1000-row catalogue is reachable', category: 'testcases',
    method: 'GET', endpoint: '/v2/testcases?offset=&limit=', severity: 'normal',
    run: async (c) => {
      const base = { id: 'testcases-list-cap-documented', category: 'testcases' as const, method: 'GET' as const, endpoint: '/v2/testcases?offset=&limit=', severity: 'normal' as const };
      const head = await rawCall(c, 'GET', `${tBase(c.host)}/testcases?limit=1&offset=0`);
      if (head.status !== 200) return bad(base.id, base, head, `pre-step list returned ${head.status}`);
      const total = Number(head.bodyJson?.total ?? NaN);
      if (!Number.isFinite(total)) return skip(base.id, base, 'list response carries no numeric total — cannot locate the cap');
      // Below 1000 rows the >1000 reach cannot be exercised — but the paging
      // contract this test exists to protect can be, at whatever scale the box
      // actually holds. The failure this guards against (rows silently
      // unreachable, so backup / audit / sync tooling sees a partial
      // catalogue) shows up identically at 240 rows if paging is broken, so
      // skipping here left the real risk unmeasured on every box we own.
      if (total <= 1000) return smallCatalogueReachVerdict(c, base, total);
      const pageSize = 1000;
      const lastPage = Math.floor((total - 1) / pageSize);
      const wantRows = total - lastPage * pageSize;
      const expected = `200 with ${wantRows} item(s) on the last page (limit=${pageSize}&offset=${lastPage}, total=${total}). \`offset\` is a page index on this API. If the last page cannot be fetched, every testcase beyond row ${pageSize} is unreachable and backup / audit / sync tooling silently sees a partial catalogue.`;
      const tail = await rawCall(c, 'GET', `${tBase(c.host)}/testcases?limit=${pageSize}&offset=${lastPage}`);
      if (tail.status !== 200) return bad(base.id, base, tail, `last page (limit=${pageSize}&offset=${lastPage}) returned ${tail.status}: ${String(tail.bodyJson?.message ?? '').slice(0, 120)}`, expected);
      const rows = Array.isArray(tail.bodyJson?.items) ? tail.bodyJson.items.length : 0;
      if (rows === 0) return bad(base.id, base, tail, `enumeration cap CONFIRMED: total=${total} but the last page (offset=${lastPage}) is empty — rows beyond ${pageSize} are unreachable via the list API`, expected);
      return ok(base.id, base, tail, `last page (offset=${lastPage}) returned ${rows} row(s) of an expected ${wantRows} — the full ${total}-row catalogue is reachable`);
    },
  });

  // Search must be able to reach past its first page, so a caller can walk the
  // whole catalogue when GET /testcases hits its enumeration cap above.
  list.push({
    id: 'search-offset-honoured', name: 'POST /testcases/search can paginate (page 1 vs page 2 differ)', category: 'testcases',
    method: 'POST', endpoint: '/v2/testcases/search (paging)', severity: 'normal',
    run: async (c) => {
      const base = { id: 'search-offset-honoured', category: 'testcases' as const, method: 'POST' as const, endpoint: '/v2/testcases/search (paging)', severity: 'normal' as const };
      const head = await rawCall(c, 'GET', `${tBase(c.host)}/testcases?limit=1&offset=0`);
      if (head.status !== 200) return bad(base.id, base, head, `pre-step list returned ${head.status}`);
      const total = Number(head.bodyJson?.total ?? NaN);
      if (!Number.isFinite(total)) return skip(base.id, base, 'list response carries no numeric total — cannot size the paging probe');
      if (total < 10) return skip(base.id, base, `total=${total} < 10 — not enough testcases to compare two pages`);
      const idsOf = (r: RawCallResult): string[] =>
        ((r.bodyJson?.items ?? r.bodyJson?.data ?? []) as any[]).map((x) => String(x?.id ?? '')).filter(Boolean);
      const search = (body: any) => rawCall(c, 'POST', `${tBase(c.host)}/testcases/search`, {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      // POST /testcases/search pages on pageNumber (1-BASED) + pageSize — NOT
      // offset/limit, which is GET /testcases' vocabulary. This test used to
      // send {offset, limit}; the box ignores unknown fields, served the same
      // default page twice, and the test concluded "search can never page past
      // the first page" and filed it as a product bug. It is not one: asked
      // properly, the box pages correctly. The sibling `testcases-search` test
      // already used pageNumber/pageSize — only this one had it wrong.
      const p1 = await search({ pageNumber: 1, pageSize: 5 });
      const p2 = await search({ pageNumber: 2, pageSize: 5 });
      if (p1.status !== 200 || p2.status !== 200) return bad(base.id, base, p2, `search returned ${p1.status}/${p2.status} for the two pages`);
      const a = idsOf(p1);
      const b = idsOf(p2);
      if (a.length === 0 || b.length === 0) return skip(base.id, base, `search returned ${a.length}/${b.length} ids despite total=${total} — cannot compare pages`);
      const overlap = a.filter((id) => b.includes(id));
      const expected = `{pageNumber:2,pageSize:5} must return the NEXT 5 rows, sharing no ids with {pageNumber:1,pageSize:5}. With total=${total}, a page index that does not advance leaves every row past the first page unreachable through search.`;
      if (overlap.length > 0) return bad(base.id, base, p2, `pageNumber IGNORED: pages 1 and 2 share ${overlap.length}/${a.length} ids (${overlap.slice(0, 3).join(', ')}…)`, expected);
      return ok(base.id, base, p2, `pageNumber honoured: page1 starts ${a[0].slice(0, 13)}…, page2 starts ${b[0].slice(0, 13)}… (no overlap, totalPages=${p2.bodyJson?.totalPages ?? '?'})`);
    },
  });

  // SIM40-(to-be-filed) statistics window-unit contract, found 2026-06-10:
  // /statistics/* startTime/endTime are epoch SECONDS; the SAME window passed
  // in MILLISECONDS returns 200 with an EMPTY payload instead of a 400 — a
  // silent footgun (every client that passes Date.now() sees "no data" and no
  // error). Documentation-grade probe: PASSes with a note when it can
  // demonstrate the contract, SKIPs when the box has no data — never fails.
  list.push({
    id: 'stats-window-seconds-contract', name: '/statistics/ues window units: seconds vs milliseconds (contract probe)', category: 'statistics',
    method: 'GET', endpoint: '/v2/testcases/executions/{eid}/statistics/ues', severity: 'optional',
    run: async (c) => {
      const base = { id: 'stats-window-seconds-contract', category: 'statistics' as const, method: 'GET' as const, endpoint: '/v2/testcases/executions/{eid}/statistics/ues', severity: 'optional' as const };
      // Candidate executions, best-first. c.recentExecutionId is deliberately
      // NOT trusted on its own: during a full sweep the Executions category
      // runs before this one and leaves behind a start/stop execution that
      // never had a UE attach, so anchoring to it found zero rows and the
      // probe skipped — on a box holding 75 historical executions that DO
      // carry ue_data. Collect candidates, then probe until one has data.
      const MARGIN_SEC = 60;
      type Cand = { eid: string; executedOnSec?: number; durationSec?: number };
      const cands: Cand[] = [];
      if (c.recentExecutionId) cands.push({ eid: String(c.recentExecutionId) });
      const lst = await rawCall(c, 'GET', `${tBase(c.host)}/testcases?limit=100&offset=0`);
      for (const it of (lst.bodyJson?.items ?? []) as any[]) {
        const last = it?.metadata?.lastExecution;
        if (!last?.executionId) continue;
        // executedOn may arrive as epoch seconds, epoch millis or an ISO string.
        let executedOnSec: number | undefined;
        const rawOn = last?.executedOn;
        if (rawOn !== undefined && rawOn !== null) {
          const n = typeof rawOn === 'number' ? rawOn : Number(rawOn);
          if (Number.isFinite(n) && n > 0) executedOnSec = n > 1e11 ? Math.floor(n / 1000) : Math.floor(n);
          else {
            const parsed = Date.parse(String(rawOn));
            if (Number.isFinite(parsed)) executedOnSec = Math.floor(parsed / 1000);
          }
        }
        const dur = Number(last?.durationSeconds ?? last?.testDuration ?? NaN);
        cands.push({ eid: String(last.executionId), executedOnSec, durationSec: Number.isFinite(dur) && dur > 0 ? dur : undefined });
      }
      if (!cands.length) return skip(base.id, base, 'no execution id available (no testcase carries metadata.lastExecution)');

      const rowsOf = (r: RawCallResult): number => Array.isArray(r.bodyJson?.data?.ue_data) ? r.bodyJson.data.ue_data.length : 0;
      const windowFor = (k: Cand) => k.executedOnSec !== undefined
        ? { start: k.executedOnSec - MARGIN_SEC, end: k.executedOnSec + (k.durationSec ?? 3600) + MARGIN_SEC, desc: `execution-anchored window (executedOn=${k.executedOnSec}s, duration=${k.durationSec ?? 3600}s, margin=${MARGIN_SEC}s)` }
        : { start: Math.floor(Date.now() / 1000) - 24 * 3600, end: Math.floor(Date.now() / 1000), desc: 'last-24h fallback window (executedOn not available)' };

      // Probe until an execution with retained ue_data turns up. Bounded so a
      // box of stale ids cannot turn this into a hundred-call crawl.
      const MAX_PROBES = 12;
      let probed = 0;
      let lastDesc = '';
      let lastS = 0;
      let lastM = -1;
      for (const k of cands.slice(0, MAX_PROBES)) {
        probed++;
        const { start, end, desc } = windowFor(k);
        lastDesc = desc;
        const statsUrl = `${tBase(c.host)}/testcases/executions/${encodeURIComponent(k.eid)}/statistics/ues`;
        const secs = await rawCall(c, 'GET', `${statsUrl}?startTime=${start}&endTime=${end}`);
        if (secs.status !== 200) continue;           // stale id / not found — try the next
        const sRows = rowsOf(secs);
        lastS = sRows;
        if (sRows === 0) continue;                   // nothing retained for this one
        const millis = await rawCall(c, 'GET', `${statsUrl}?startTime=${start * 1000}&endTime=${end * 1000}`);
        const mRows = millis.status === 200 ? rowsOf(millis) : 0;
        lastM = mRows;
        const via = `eid=${k.eid.slice(0, 8)}… after ${probed} probe(s); ${desc}`;
        if (millis.status >= 400) {
          return ok(base.id, base, millis, `seconds window -> ${sRows} ue_data rows; identical window in milliseconds -> ${millis.status}: box now rejects millisecond windows explicitly (${via})`);
        }
        if (mRows === 0) {
          return ok(base.id, base, millis, `CONTRACT CONFIRMED (silent empty payload): seconds window -> ${sRows} ue_data rows; identical window in milliseconds -> 200 with EMPTY payload (no 400). startTime/endTime are epoch SECONDS; millis fail silently (${via}).`);
        }
        return ok(base.id, base, millis, `lenient parser on this build: seconds (${sRows} rows) AND milliseconds (${mRows} rows) windows both return data (${via})`);
      }
      return skip(base.id, base, `probed ${probed} execution(s) of ${cands.length} candidate(s); none had retained ue_data to compare windows with (last: ${lastDesc}, seconds rows=${lastS}, millis rows=${lastM < 0 ? 'n/a' : lastM}) — statistics retention has aged out`);
    },
  });

  // ---------- EXECUTIONS (live, opt-in destructive + long-running) ----------
  // Triggers a real test run on hardware. Gated on BOTH includeDestructive
  // and includeLongRunning so it never fires by accident.
  list.push({
    id: 'exec-start-stop', name: 'POST /testcases/{id}/executions then POST .stop', category: 'executions',
    method: 'POST', endpoint: '/v2/testcases/{id}/executions', severity: 'optional',
    destructive: true, longRunning: true,
    run: async (c) => {
      const base = { id: 'exec-start-stop', category: 'executions' as const, method: 'POST' as const, endpoint: '/v2/testcases/{id}/executions', severity: 'optional' as const, destructive: true };
      await ensureTestcaseContext(c);
      if (!c.someTestcaseId) return skip(base.id, base, 'no testcases exist on this box');
      await ensureSimulatorId(c);
      if (!await waitForSimulatorFree(c)) return skip(base.id, base, 'simulator still BUSY after 60s — another execution is running, refusing to queue on top of it');
      const start = await startExecution(c, c.someTestcaseId);
      if (start.status !== 200 && start.status !== 201) {
        // status 0 means WE gave up waiting, not that the box declined. The box
        // starts the run anyway, so bailing straight out strands an execution on
        // real hardware with nothing tracking it. Always try to stop first.
        if (start.status === 0) {
          const rescue = await rawCall(c, 'POST', `${tBase(c.host)}/testcases/executions/current/stop${c.recentSimulatorId ? `?simulatorId=${encodeURIComponent(c.recentSimulatorId)}` : ''}`, {
            headers: { 'Content-Type': 'application/json' }, body: '{}',
          });
          return bad(base.id, base, start, `start did not answer (${start.error}); issued a precautionary stop which returned ${rescue.status}`,
            'a start that we stop listening to may still be running on the box — the follow-up stop must land, or the simulator is left busy.');
        }
        return bad(base.id, base, start, `start returned ${start.status}`);
      }
      // Give the box a beat then issue stop with executionId="current" + simulatorId.
      await new Promise((r) => setTimeout(r, 2000));
      const stop = await rawCall(c, 'POST', `${tBase(c.host)}/testcases/executions/current/stop${c.recentSimulatorId ? `?simulatorId=${encodeURIComponent(c.recentSimulatorId)}` : ''}`, {
        headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      if (stop.status !== 200) return bad(base.id, base, stop, `stop returned ${stop.status} (started=${start.status})`);
      return ok(base.id, base, start, `start=${start.status} stop=${stop.status}`);
    },
  });
  list.push({
    id: 'exec-restart', name: 'POST /testcases/executions/{eid}/restart', category: 'executions',
    method: 'POST', endpoint: '/v2/testcases/executions/{eid}/restart', severity: 'optional',
    destructive: true, longRunning: true,
    run: async (c) => {
      const base = { id: 'exec-restart', category: 'executions' as const, method: 'POST' as const, endpoint: '/v2/testcases/executions/{eid}/restart', severity: 'optional' as const, destructive: true };
      // Restart only applies to a LIVE execution: the box rejects a finished one
      // with 400 "Execution is not in a restartable state (current status:
      // Completed)". Pointing this at c.recentExecutionId — which is whatever
      // historical execution the catalogue scan happened to surface, long since
      // Completed — asserted 200 against a state the box is right to refuse, so
      // it failed on correct behaviour. Start our own execution, restart THAT,
      // then stop it. Same start/stop calls exec-start-stop already proves.
      await ensureTestcaseContext(c);
      if (!c.someTestcaseId) return skip(base.id, base, 'no testcases exist on this box to start a restartable execution');
      await ensureSimulatorId(c);
      if (!await waitForSimulatorFree(c)) return skip(base.id, base, 'simulator still BUSY after 60s — cannot start the execution this check needs to restart');
      const start = await startExecution(c, c.someTestcaseId);
      if (start.status !== 200 && start.status !== 201) {
        return bad(base.id, base, start, `could not start an execution to restart (${start.status})`,
          '200/201 from POST /v2/testcases/{id}/executions — restart cannot be exercised without a live execution.');
      }
      const eid = start.bodyJson?.executionId ?? c.recentExecutionId;
      const stopAll = async () => rawCall(c, 'POST', `${tBase(c.host)}/testcases/executions/current/stop${c.recentSimulatorId ? `?simulatorId=${encodeURIComponent(c.recentSimulatorId)}` : ''}`, {
        headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      if (!eid) { await stopAll(); return bad(base.id, base, start, 'start succeeded but returned no executionId to restart'); }
      await new Promise((r) => setTimeout(r, 3000));
      const r = await rawCall(c, 'POST', `${tBase(c.host)}/testcases/executions/${encodeURIComponent(eid)}/restart`, {
        headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      // Always tear the run back down, whatever restart answered.
      const stop = await stopAll();
      if (r.status === 200 || r.status === 202) return ok(base.id, base, r, `restart=${r.status} on live eid=${eid.slice(0, 8)}… (stopped after: ${stop.status})`);
      return bad(base.id, base, r, `expected 200/202 restarting a RUNNING execution, got ${r.status}: ${String(r.bodyJson?.message ?? '').slice(0, 120)}`,
        '200/202 — the execution was started moments earlier and is live, so restart must be accepted.');
    },
  });

  // Stop-by-explicit-eid path (Dell's integration uses this form). The
  // exec-start-stop check above already validates the `current` alias which
  // shares the same server-side handler, but customers like Dell wire their
  // automation to the {executionId} variant — so we exercise that codepath
  // too. Starts a fresh execution, polls the testcase metadata briefly to
  // pick up the new executionId, then stops via the explicit id.
  list.push({
    id: 'exec-stop-by-eid', name: 'POST /testcases/{id}/executions then POST /executions/{eid}/stop',
    category: 'executions',
    method: 'POST', endpoint: '/v2/testcases/executions/{eid}/stop', severity: 'optional',
    destructive: true, longRunning: true,
    run: async (c) => {
      const base = { id: 'exec-stop-by-eid', category: 'executions' as const, method: 'POST' as const, endpoint: '/v2/testcases/executions/{eid}/stop', severity: 'optional' as const, destructive: true };
      await ensureTestcaseContext(c);
      if (!c.someTestcaseId) return skip(base.id, base, 'no testcases exist on this box');
      await ensureSimulatorId(c);
      if (!await waitForSimulatorFree(c)) return skip(base.id, base, 'simulator still BUSY after 60s — another execution is running, refusing to queue on top of it');

      // 1. Start a fresh execution.
      const start = await startExecution(c, c.someTestcaseId);
      if (start.status !== 200 && start.status !== 201) {
        // Same rescue as exec-start-stop: a start we stopped waiting on may
        // still be running on the box, so never leave without trying to stop.
        if (start.status === 0) {
          const rescue = await rawCall(c, 'POST', `${tBase(c.host)}/testcases/executions/current/stop${c.recentSimulatorId ? `?simulatorId=${encodeURIComponent(c.recentSimulatorId)}` : ''}`, {
            headers: { 'Content-Type': 'application/json' }, body: '{}',
          });
          return bad(base.id, base, start, `start did not answer (${start.error}); issued a precautionary stop which returned ${rescue.status}`);
        }
        return bad(base.id, base, start, `start returned ${start.status} (system likely busy)`);
      }

      // 2. Poll the testcase metadata briefly to discover the new eid.
      let eid: string | undefined;
      for (let i = 0; i < 8 && !eid; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        const f = await rawCall(c, 'GET', `${tBase(c.host)}/testcases/${encodeURIComponent(c.someTestcaseId)}`);
        const last = f.bodyJson?.metadata?.lastExecution;
        // Treat as newly-discovered when the id differs from anything we
        // had before this check, OR when its status looks running/pending.
        if (last?.executionId && last.executionId !== c.recentExecutionId) eid = last.executionId;
        else if (last?.executionId && /running|in_progress|pending|started/i.test(last.status ?? '')) eid = last.executionId;
      }
      if (!eid) {
        // Cleanup attempt via "current" so we don't leak a live execution.
        await rawCall(c, 'POST', `${tBase(c.host)}/testcases/executions/current/stop${c.recentSimulatorId ? `?simulatorId=${encodeURIComponent(c.recentSimulatorId)}` : ''}`, {
          headers: { 'Content-Type': 'application/json' }, body: '{}',
        }).catch(() => null);
        return bad(base.id, base, start, 'could not discover new executionId within 12s of trigger');
      }

      // 3. Stop using the explicit eid path.
      const stop = await rawCall(c, 'POST', `${tBase(c.host)}/testcases/executions/${encodeURIComponent(eid)}/stop${c.recentSimulatorId ? `?simulatorId=${encodeURIComponent(c.recentSimulatorId)}` : ''}`, {
        headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      if (stop.status !== 200) return bad(base.id, base, stop, `stop-by-eid returned ${stop.status} (started ok=${start.status}, eid=${eid.slice(0,8)}…)`);
      return ok(base.id, base, stop, `start=${start.status} eid=${eid.slice(0,8)}… stop=${stop.status}`);
    },
  });

  // ---------- ENDPOINTS THAT CANNOT BE DRIVEN TO SUCCESS ----------
  // These used to be hardcoded skip rows — permanent placeholders that
  // reported nothing on any box. The constraint that made each unsafe to
  // drive to SUCCESS is real and still respected; what changed is that each
  // now asserts the part of its contract that IS reachable (rejection paths,
  // auth gates, catalogue discovery) instead of asserting nothing at all.
  // The `skipDef` factory that produced the placeholders is gone with them.

  // Password rotation used to be an unconditional skip: rotating the admin
  // password has no safe rollback, and getting it wrong locks everyone out of
  // a shared lab box. That constraint is real, so the happy path stays
  // untested deliberately — but the endpoint's REJECTION path can be exercised
  // with zero risk, and that is where the interesting bugs live anyway.
  //
  // Every probe below names a user that does not exist. Even if the box had a
  // validation gap as bad as the one this suite already found on Test_Id
  // (empty value silently accepted), the worst outcome is a password change on
  // a nonexistent account. The admin credential is never a parameter, so it
  // cannot be rotated by this test under any failure mode.
  list.push({
    id: 'update-password-rejects-bad-input', name: 'POST /users/update-password rejects bad credentials (admin never touched)', category: 'mutating',
    method: 'POST', endpoint: '/v2/users/update-password', severity: 'normal', destructive: true,
    run: async (c) => {
      const base = { id: 'update-password-rejects-bad-input', category: 'mutating' as const, method: 'POST', endpoint: '/v2/users/update-password', severity: 'normal' as const, destructive: true };
      const ghost = `simqa-nonexistent-${Date.now().toString(36)}`;
      const post = (body: any) => rawCall(c, 'POST', `${tBase(c.host)}/users/update-password`, {
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const expected = 'A 4xx refusal with a JSON envelope { code, message }. A 200 would mean the endpoint rotates passwords without verifying the current one — full account takeover for anyone who can reach the API. A 5xx means it crashed on input it should simply reject.';

      // 1. Unknown user + wrong current password.
      const unknown = await post({ username: ghost, current_password: 'not-the-password', new_password: 'Simqa!Tmp123' });
      if (unknown.status === 200) {
        return bad(base.id, base, unknown, `200 for user "${ghost}" that does not exist — the endpoint does not verify the account or the current password`, expected);
      }
      if (unknown.status >= 500) return bad(base.id, base, unknown, `${unknown.status} — crashed instead of rejecting an unknown user`, expected);
      if (unknown.status < 400) return bad(base.id, base, unknown, `expected a 4xx refusal, got ${unknown.status}`, expected);
      const code = String(unknown.bodyJson?.code ?? '');
      const msg  = String(unknown.bodyJson?.message ?? '');
      if (!code || !msg) return bad(base.id, base, unknown, `${unknown.status} but the body carries no { code, message } envelope`, expected);

      // 2. Missing new_password entirely — must be a validation error, and
      //    must NOT be treated as "set the password to empty".
      const noNew = await post({ username: ghost, current_password: 'not-the-password' });
      if (noNew.status === 200) return bad(base.id, base, noNew, '200 with no new_password supplied — the endpoint accepts an incomplete rotation', expected);
      if (noNew.status >= 500) return bad(base.id, base, noNew, `${noNew.status} — crashed on a payload missing new_password`, expected);

      // 3. Unauthenticated — the endpoint must not be reachable without a token.
      const anon = await rawCall(c, 'POST', `${tBase(c.host)}/users/update-password`, {
        auth: 'none', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: ghost, current_password: 'x', new_password: 'Simqa!Tmp123' }),
      });
      if (anon.status === 200) return bad(base.id, base, anon, '200 WITHOUT a bearer token — password rotation is unauthenticated', 'A 401/403 without credentials. A 200 here is a critical auth bypass.');

      return ok(base.id, base, unknown, `unknown user -> ${unknown.status} ${code} "${msg}"; missing new_password -> ${noNew.status}; unauthenticated -> ${anon.status} (admin credential never sent)`);
    },
  });

  // Assigning a log-settings profile to a simulator used to skip for want of a
  // settings id. The ids are discoverable — GET /v2/system/log-settings lists
  // them — so discovery is now asserted for real. The PUT itself is still not
  // driven to success on purpose: there is no GET /v2/simulators/{id}/log-settings
  // (verified 404 on build 4.0.0_2608181819), so the current profile cannot be
  // read back, and a successful PUT would be an unrestorable change to shared
  // lab configuration. What IS safe is the rejection path — a syntactically
  // valid but nonexistent settings id must be refused, and if the box wrongly
  // accepts it the test repairs the simulator by pointing it at a real profile.
  list.push({
    id: 'sim-log-settings-contract', name: 'PUT /simulators/{id}/log-settings — catalogue discoverable, bad id refused', category: 'mutating',
    method: 'PUT', endpoint: '/v2/simulators/{id}/log-settings', severity: 'normal', destructive: true,
    run: async (c) => {
      const base = { id: 'sim-log-settings-contract', category: 'mutating' as const, method: 'PUT', endpoint: '/v2/simulators/{id}/log-settings', severity: 'normal' as const, destructive: true };
      const cat = await rawCall(c, 'GET', `${tBase(c.host)}/system/log-settings`);
      if (cat.status !== 200) return bad(base.id, base, cat, `GET /v2/system/log-settings returned ${cat.status} — the profile catalogue the PUT references is unreachable`,
        '200 listing the log-settings profiles. Without it, nothing can assign a profile to a simulator.');
      const profiles: any[] = cat.bodyJson?.items ?? [];
      if (!profiles.length) return bad(base.id, base, cat, 'log-settings catalogue is empty — there is no profile any simulator could be pointed at',
        'At least one profile (the box ships system presets such as debug / error / disable).');
      const known = profiles.find((p) => p?.id);
      if (!known) return bad(base.id, base, cat, `catalogue returned ${profiles.length} profile(s) but none carries an id`, 'Each profile exposes an id usable as logSettingsId.');

      // Resolve on demand — c.recentSimulatorId is only populated by the
      // Simulators category, so reading it directly made this test fail
      // whenever Mutating was run without Simulators ticked.
      const simId = await ensureSimulatorId(c);
      if (!simId) return bad(base.id, base, cat, 'GET /v2/simulators returned no simulator to address the PUT', 'At least one simulator, so a log-settings profile has something to be assigned to.');
      const put = (logSettingsId: string) => rawCall(c, 'PUT', `${tBase(c.host)}/simulators/${encodeURIComponent(simId)}/log-settings`, {
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ logSettingsId }),
      });

      // Well-formed UUID that names no profile. Correct behaviour: refuse.
      const ghostId = '00000000-0000-4000-8000-0000000ffake';
      const r = await put(ghostId);
      if (r.status === 200 || r.status === 204) {
        // Wrongly accepted — the simulator now references a profile that does
        // not exist. Repair it immediately rather than leaving the lab box in
        // that state, then report the validation gap.
        const repair = await put(String(known.id));
        return bad(base.id, base, r, `${r.status} — a nonexistent logSettingsId was accepted (validation gap); simulator repaired by reassigning profile "${known.name ?? known.id}" (repair=${repair.status})`,
          'A logSettingsId that matches no profile must be refused with 400/404. Accepting it leaves the simulator pointing at nothing, and there is no GET on this path to notice.');
      }
      if (r.status >= 500) return bad(base.id, base, r, `${r.status} — crashed on an unknown logSettingsId instead of refusing it`,
        'A 400/404 naming the unknown profile.');
      return ok(base.id, base, r, `catalogue lists ${profiles.length} profile(s) (e.g. "${known.name ?? known.id}"); unknown logSettingsId refused with ${r.status} — active profile left untouched`);
    },
  });

  // Simulator full lifecycle: POST + GET status + PATCH + DELETE.
  // (Spec doesn't document DELETE /v2/simulators/{id} but the box implements it.)
  list.push({
    id: 'simulators-full-lifecycle', name: 'POST /simulators + PATCH + DELETE (throwaway)', category: 'mutating',
    method: 'POST', endpoint: '/v2/simulators (combo)', severity: 'normal', destructive: true,
    run: async (c) => {
      const base = { id: 'simulators-full-lifecycle', category: 'mutating' as const, method: 'POST' as const, endpoint: '/v2/simulators (combo)', severity: 'normal' as const, destructive: true };
      const simName = `simqa-tester-${Date.now().toString(36)}`;
      const traces: string[] = [];

      // 1. POST /v2/simulators
      const create = await rawCall(c, 'POST', `${tBase(c.host)}/simulators`, {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ simulatorName: simName, ipAddress: '10.255.255.254', type: 'UE' }),
      });
      traces.push(`create=${create.status}`);
      if (create.status !== 200 && create.status !== 201) return provisioningRefusalVerdict(base, create, 'nothing to create, patch or delete');

      // Extract the new id (response shape: { success, data: { id, ... } } per spec)
      const newId = create.bodyJson?.data?.id ?? create.bodyJson?.id;
      if (!newId) return bad(base.id, base, create, 'create succeeded but no id in response');

      // 2. GET /v2/simulators/{id}/status to confirm it exists
      const status = await rawCall(c, 'GET', `${tBase(c.host)}/simulators/${encodeURIComponent(newId)}/status`);
      traces.push(`status=${status.status}`);

      // 3. PATCH /v2/simulators/{id} - rename
      const patch = await rawCall(c, 'PATCH', `${tBase(c.host)}/simulators/${encodeURIComponent(newId)}`, {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ simulatorName: simName + '-renamed' }),
      });
      traces.push(`patch=${patch.status}`);

      // 4. DELETE /v2/simulators/{id} - cleanup. Always attempt regardless of upstream failures.
      const del = await rawCall(c, 'DELETE', `${tBase(c.host)}/simulators/${encodeURIComponent(newId)}`);
      traces.push(`delete=${del.status}`);
      if (del.status !== 204 && del.status !== 200) return bad(base.id, base, del, `delete returned ${del.status} for id=${newId}; ${traces.join(' ')}`,
        '204 NO CONTENT (resource removed) or 200 with confirmation. The DELETE endpoint should be implemented per REST conventions; the box currently 404s. Without DELETE, every POST /simulators leaks an inventory entry that has no API to remove it.');

      return ok(base.id, base, create, `id=${newId} ${traces.join(' ')}`);
    },
  });

  // ---------- SIM40-2048: block duplicate-IP simulator on create + update ----------
  // The fix: POST /v2/simulators and PATCH /v2/simulators/{id} must both
  // reject an IP that's already in use by another simulator, with 4xx
  // (suggested 409 CONFLICT). Previously: silent success → duplicate rows.
  list.push({
    id: 'sim40-2048-block-duplicate-simulator-ip',
    name: 'SIM40-2048: POST /simulators with duplicate ipAddress is rejected with 4xx',
    category: 'mutating', method: 'POST', endpoint: '/v2/simulators (duplicate-ip)', severity: 'normal', destructive: true,
    run: async (c) => {
      const base = { id: 'sim40-2048-block-duplicate-simulator-ip', category: 'mutating' as const, method: 'POST' as const, endpoint: '/v2/simulators (duplicate-ip)', severity: 'normal' as const, destructive: true };
      const sharedIp = '10.255.255.253';
      const name1 = `simqa-dup-a-${Date.now().toString(36)}`;
      const name2 = `simqa-dup-b-${Date.now().toString(36)}`;
      const create1 = await rawCall(c, 'POST', `${tBase(c.host)}/simulators`, {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ simulatorName: name1, ipAddress: sharedIp, type: 'UE' }),
      });
      if (create1.status !== 200 && create1.status !== 201) return provisioningRefusalVerdict(base, create1, 'duplicate-IP rejection cannot be exercised');
      const id1 = create1.bodyJson?.data?.id ?? create1.bodyJson?.id;
      // Now attempt a second create with the SAME IP — must be rejected.
      const create2 = await rawCall(c, 'POST', `${tBase(c.host)}/simulators`, {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ simulatorName: name2, ipAddress: sharedIp, type: 'UE' }),
      });
      // Cleanup the second one if it landed (unexpected), and the first.
      const id2Maybe = create2.bodyJson?.data?.id ?? create2.bodyJson?.id;
      if (id2Maybe) await rawCall(c, 'DELETE', `${tBase(c.host)}/simulators/${encodeURIComponent(id2Maybe)}`);
      if (id1) await rawCall(c, 'DELETE', `${tBase(c.host)}/simulators/${encodeURIComponent(id1)}`);
      const status = create2.status;
      const isReject = status >= 400 && status < 500;
      const detailMsg = `first-create=${create1.status} dup-create=${status} (${isReject ? 'rejected, as required' : 'ACCEPTED — duplicate-IP block missing'})`;
      if (isReject) return ok(base.id, base, create2, detailMsg);
      return bad(base.id, base, create2, detailMsg, 'a second POST with an already-used ipAddress must be rejected with 4xx (409 CONFLICT preferred).');
    },
  });

  // ---------- SIM40-2049: DELETE /v2/simulators/{id} is the canonical endpoint ----------
  // The fix: the simulator-delete API is now exclusively under /v2 (the
  // /v1 path is gone). Verify that /v2 delete returns 200/204 on a real
  // sim, and that calling /v1 returns 404 (i.e. the legacy route is gone).
  list.push({
    id: 'sim40-2049-delete-v2-simulators-canonical',
    name: 'SIM40-2049: DELETE /v2/simulators/{id} works AND legacy /v1 path is gone',
    category: 'mutating', method: 'DELETE', endpoint: '/v2/simulators/{id} (v1 vs v2)', severity: 'normal', destructive: true,
    run: async (c) => {
      const base = { id: 'sim40-2049-delete-v2-simulators-canonical', category: 'mutating' as const, method: 'DELETE' as const, endpoint: '/v2/simulators/{id} (v1 vs v2)', severity: 'normal' as const, destructive: true };
      const name = `simqa-v2del-${Date.now().toString(36)}`;
      const create = await rawCall(c, 'POST', `${tBase(c.host)}/simulators`, {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ simulatorName: name, ipAddress: '10.255.255.252', type: 'UE' }),
      });
      if (create.status !== 200 && create.status !== 201) return provisioningRefusalVerdict(base, create, 'no throwaway sim can be seeded to delete');
      const id = create.bodyJson?.data?.id ?? create.bodyJson?.id;
      if (!id) return bad(base.id, base, create, 'seed create succeeded but no id in response');

      // 1) DELETE /v2/simulators/{id} should work.
      const delV2 = await rawCall(c, 'DELETE', `${tBase(c.host)}/simulators/${encodeURIComponent(id)}`);
      const v2Ok = delV2.status === 200 || delV2.status === 204;

      // 2) Probe /v1/simulators/{id} — should be 404 (route removed).
      // Recreate a temp sim for the v1 probe so we have a target id.
      const create2 = await rawCall(c, 'POST', `${tBase(c.host)}/simulators`, {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ simulatorName: name + '-v1probe', ipAddress: '10.255.255.251', type: 'UE' }),
      });
      const id2 = create2.bodyJson?.data?.id ?? create2.bodyJson?.id;
      let v1Status: number | undefined;
      if (id2) {
        // Replace `/v2/` with `/v1/` in the base URL.
        const v1Url = `${tBase(c.host).replace('/v2', '/v1')}/simulators/${encodeURIComponent(id2)}`;
        const delV1 = await rawCall(c, 'DELETE', v1Url);
        v1Status = delV1.status;
        // Cleanup id2 via v2.
        await rawCall(c, 'DELETE', `${tBase(c.host)}/simulators/${encodeURIComponent(id2)}`);
      }
      const v1Gone = v1Status === undefined || v1Status === 404 || v1Status === 405;
      const summary = `v2-delete=${delV2.status} v1-probe=${v1Status ?? 'skipped'} (${v2Ok && v1Gone ? 'v2 canonical, v1 gone' : 'unexpected'})`;
      if (v2Ok && v1Gone) return ok(base.id, base, delV2, summary);
      return bad(base.id, base, delV2, summary, 'DELETE /v2/simulators/{id} must return 2xx; /v1/simulators/{id} must be removed (404/405).');
    },
  });

  // ---------- TESTCASE IMPORT / ROUND-TRIP / VALIDATION ----------
  //
  // The /testcases/import wire format (confirmed by /testcases/export) is:
  //
  //   { test_case_details: [{
  //       Test_Id, Test_Name, Log_Settings_Id, Creator_Id, Modifier_Id, State,
  //       Test_Config_Intermediate_Object, Config_File: { config }, Type, ...
  //   }] }
  //
  // GET /testcases/{id} returns a different shape ({ id, name, testDefinition })
  // and is NOT a valid import payload. So a round-trip must use export -> import.
  //
  // Shared helpers used by the tests below.

  /** Pull a real testcase via /testcases/export to use as the seed pack. */
  async function fetchSeedExport(c: RunCtx): Promise<{ pack?: any; seedId?: string; seedName?: string; err?: string; status?: number }> {
    let seed = c.someTestcaseId;
    if (!seed) {
      const lst = await rawCall(c, 'GET', `${tBase(c.host)}/testcases?limit=1&offset=0`);
      seed = lst.bodyJson?.items?.[0]?.id;
      if (!seed) return { err: 'no testcases on the box to seed from' };
      c.someTestcaseId = seed;
    }
    const exp = await rawCall(c, 'POST', `${tBase(c.host)}/testcases/export`, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ testCaseIds: [seed], output: { type: 'json' } }),
    });
    const detail = exp.bodyJson?.test_case_details?.[0];
    if (exp.status !== 200 || !detail) return { err: `seed export returned ${exp.status}`, status: exp.status };
    return { pack: exp.bodyJson, seedId: seed, seedName: detail.Test_Name };
  }

  /** Clone an export pack and apply Test_Id / Test_Name overrides (or deletes). */
  function makePack(seed: any, overrides: Record<string, any> = {}, deletes: string[] = []): any {
    const cloned = JSON.parse(JSON.stringify(seed));
    const detail = cloned.test_case_details[0];
    delete detail.Created_Date;
    delete detail.Modified_Date;
    delete detail.Deleted_Date;
    for (const [k, v] of Object.entries(overrides)) detail[k] = v;
    for (const k of deletes) delete detail[k];
    return cloned;
  }

  /** POST /testcases/import as multipart/form-data. Returns evidence + parsed body. */
  async function postImport(host: string, token: string, pack: any, packLabel: string): Promise<{ status: number; ms: number; bodyJson: any; bodyText: string; landedIds: string[]; request: ApiRequestEvidence; response: ApiResponseEvidence }> {
    const blob = new Blob([JSON.stringify(pack)], { type: 'application/json' });
    const form = new FormData();
    form.append('file', blob, 'pack.json');
    const url = `${tBase(host)}/testcases/import`;
    const t0 = Date.now();
    const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
    const ms = Date.now() - t0;
    const bodyText = await res.text().catch(() => '');
    let bodyJson: any;
    try { bodyJson = bodyText ? JSON.parse(bodyText) : undefined; } catch { /* keep text */ }
    const arr: any[] = bodyJson?.testCases ?? bodyJson?.imported ?? bodyJson?.test_case_details ?? [];
    const landedIds: string[] = arr.map((x: any) => x?.id ?? x?.Test_Id ?? x?.testCaseId).filter(Boolean);
    const truncResp = truncate(bodyText);
    return {
      status: res.status, ms, bodyJson, bodyText, landedIds,
      request: { method: 'POST', url, headers: { Authorization: 'Bearer <REDACTED>', 'Content-Type': 'multipart/form-data; boundary=...' }, body: `<JSON pack: ${packLabel}>` },
      response: { status: res.status, statusText: res.statusText, headers: headersToObject(res.headers), body: truncResp.body, bodyTruncated: truncResp.truncated, contentType: res.headers.get('content-type') ?? undefined, durationMs: ms },
    };
  }

  /** Deep diff helper for round-trip equality. */
  function deepDiff(a: any, b: any, p = ''): string[] {
    const d: string[] = [];
    if (a === b) return d;
    if (typeof a !== typeof b) { d.push(`${p}: type ${typeof a}->${typeof b}`); return d; }
    if (a === null || b === null || typeof a !== 'object') { if (a !== b) d.push(`${p}: ${JSON.stringify(a)?.slice(0, 60)} -> ${JSON.stringify(b)?.slice(0, 60)}`); return d; }
    if (Array.isArray(a) !== Array.isArray(b)) { d.push(`${p}: array<->object`); return d; }
    if (Array.isArray(a)) {
      if (a.length !== b.length) d.push(`${p}: array len ${a.length}->${b.length}`);
      for (let i = 0; i < Math.max(a.length, b.length); i++) d.push(...deepDiff(a[i], b[i], `${p}[${i}]`));
      return d;
    }
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      if (!(k in a)) { d.push(`${p}.${k}: <missing> -> ${JSON.stringify(b[k]).slice(0, 60)}`); continue; }
      if (!(k in b)) { d.push(`${p}.${k}: ${JSON.stringify(a[k]).slice(0, 60)} -> <missing>`); continue; }
      d.push(...deepDiff(a[k], b[k], `${p}.${k}`));
    }
    return d;
  }

  // ---------- testcases-import-delete (fixed wire format) ----------
  // Imports a tweaked-id copy of a real testcase using the export-shape wire
  // format, then attempts DELETE. Currently fails on DELETE (SIM40-2016) and
  // leaks an inventory entry every run.
  list.push({
    id: 'testcases-import-delete', name: 'POST /testcases/import + DELETE (throwaway copy)', category: 'mutating',
    method: 'POST', endpoint: '/v2/testcases/import (combo)', severity: 'normal', destructive: true, longRunning: true,
    run: async (c) => {
      const base = { id: 'testcases-import-delete', category: 'mutating' as const, method: 'POST' as const, endpoint: '/v2/testcases/import (combo)', severity: 'normal' as const, destructive: true };
      const traces: string[] = [];

      const seedR = await fetchSeedExport(c);
      if (!seedR.pack) return seedR.err === 'no testcases on the box to seed from'
        ? skip(base.id, base, seedR.err)
        : bad(base.id, base, { status: seedR.status ?? 0, ms: 0, request: { method: 'POST', url: `${tBase(c.host)}/testcases/export`, headers: {} } }, seedR.err ?? 'seed export failed');
      traces.push(`seed-export=200`);

      const newId = `simqa-import-${Date.now().toString(36)}`;
      const pack = makePack(seedR.pack, { Test_Id: newId, Test_Name: newId });
      const imp = await postImport(c.host, c.token, pack, `Test_Id=${newId}`);
      traces.push(`import=${imp.status}`);
      if (imp.status < 200 || imp.status >= 300) return bad(base.id, base, imp, `import returned ${imp.status}: ${imp.bodyText.slice(0, 200)}`,
        '200 with importedCount and a testCases array reflecting the imported records');

      const landedId = imp.landedIds[0] ?? newId;

      const verify = await rawCall(c, 'GET', `${tBase(c.host)}/testcases/${encodeURIComponent(landedId)}`);
      traces.push(`verify=${verify.status}`);

      const del = await rawCall(c, 'DELETE', `${tBase(c.host)}/testcases/${encodeURIComponent(landedId)}`);
      traces.push(`delete=${del.status}`);
      if (del.status !== 204 && del.status !== 200) {
        return bad(base.id, base, del, `delete returned ${del.status} for id=${landedId}; ${traces.join(' ')}`,
          '204 NO CONTENT (resource removed) per REST conventions. The DELETE endpoint is currently not implemented (SIM40-2016) — every import leaks a testcase row.');
      }
      return ok(base.id, base, imp, `${landedId}: ${traces.join(' ')}`);
    },
  });

  // ---------- testcases-roundtrip-rename ----------
  // Full round-trip: export a real testcase, change Test_Id/Test_Name, import,
  // GET, re-export, deep-equal Test_Config_Intermediate_Object. Catches any
  // silent mutation of the testDefinition payload.
  list.push({
    id: 'testcases-roundtrip-rename', name: 'export -> rename -> import -> GET -> re-export -> deep-equal', category: 'mutating',
    method: 'POST', endpoint: '/v2/testcases/import (round-trip)', severity: 'critical', destructive: true, longRunning: true,
    run: async (c) => {
      const base = { id: 'testcases-roundtrip-rename', category: 'mutating' as const, method: 'POST' as const, endpoint: '/v2/testcases/import (round-trip)', severity: 'critical' as const, destructive: true };
      const traces: string[] = [];

      const seedR = await fetchSeedExport(c);
      if (!seedR.pack) return seedR.err === 'no testcases on the box to seed from'
        ? skip(base.id, base, seedR.err)
        : bad(base.id, base, { status: seedR.status ?? 0, ms: 0, request: { method: 'POST', url: `${tBase(c.host)}/testcases/export`, headers: {} } }, seedR.err ?? 'seed export failed');
      traces.push(`seed-export=200`);

      const newId = `simqa-rt-${Date.now().toString(36)}`;
      const newName = `${newId}_renamed`;
      const pack = makePack(seedR.pack, { Test_Id: newId, Test_Name: newName });
      const imp = await postImport(c.host, c.token, pack, `Test_Id=${newId}`);
      traces.push(`import=${imp.status}`);
      if (imp.status < 200 || imp.status >= 300) return bad(base.id, base, imp, `import returned ${imp.status}: ${imp.bodyText.slice(0, 200)}`,
        '200 with importedCount and the renamed testcase in testCases[]');

      const landedId = imp.landedIds[0] ?? newId;

      const get = await rawCall(c, 'GET', `${tBase(c.host)}/testcases/${encodeURIComponent(landedId)}`);
      traces.push(`get=${get.status}`);
      if (get.status !== 200) return bad(base.id, base, get, `GET returned ${get.status} for ${landedId}; ${traces.join(' ')}`,
        '200 (imported testcase retrievable by reported id). 404 here means the import response lied about success — see SIM40-2021.');

      if (get.bodyJson?.name !== newName) return bad(base.id, base, get, `name mismatch: sent "${newName}" got "${get.bodyJson?.name}"; ${traces.join(' ')}`,
        `the GET response .name field must equal the Test_Name we sent on import ("${newName}")`);

      const expBack = await rawCall(c, 'POST', `${tBase(c.host)}/testcases/export`, {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ testCaseIds: [landedId], output: { type: 'json' } }),
      });
      traces.push(`re-export=${expBack.status}`);
      const detailBack = expBack.bodyJson?.test_case_details?.[0];
      if (!detailBack) return bad(base.id, base, expBack, `re-export found no detail for ${landedId}; ${traces.join(' ')}`,
        'export must return the testcase we just imported (one entry in test_case_details)');

      const detailSent = (pack as any).test_case_details[0];
      // The pack we uploaded carries the SEED's name in settings.test_name /
      // .testCaseName — makePack only overrides the top-level Test_Name. The box
      // then syncs those nested fields to the new name on import, which is
      // correct: the nested settings name is what the box surfaces as the
      // testcase's own name. Diffing raw would report that propagation as
      // "silent mutation" and fail a rename test *for renaming*. So expect the
      // propagation explicitly — everything else must still be byte-identical.
      const expectSent = JSON.parse(JSON.stringify(detailSent.Test_Config_Intermediate_Object ?? {}));
      const nameSynced: string[] = [];
      if (expectSent?.settings && typeof expectSent.settings === 'object') {
        for (const k of ['test_name', 'testCaseName']) {
          if (k in expectSent.settings) { expectSent.settings[k] = newName; nameSynced.push(`settings.${k}`); }
        }
      }
      const tdDiffs = deepDiff(expectSent, detailBack.Test_Config_Intermediate_Object, 'Test_Config_Intermediate_Object');
      if (tdDiffs.length > 0) return bad(base.id, base, expBack, `Test_Config_Intermediate_Object diverged across round-trip: ${tdDiffs.slice(0, 3).join(' | ')}`,
        `every field of Test_Config_Intermediate_Object that we uploaded comes back byte-identical when re-exported, except the name fields (${nameSynced.join(', ') || 'none present'}) which must track the renamed Test_Name ("${newName}")`);

      return ok(base.id, base, imp, `${landedId}: ${traces.join(' ')}, deep-equal OK${nameSynced.length ? ` (${nameSynced.join('+')} correctly tracked the rename)` : ''}`);
    },
  });

  // ---------- testcases-delete-frees-name (SIM40-2293) ----------
  // Soft-delete keeps the name reserved: create -> delete -> recreate the SAME
  // name must store the exact name again, not auto-suffix "_copy". Customers
  // automate create/delete/recreate cycles and then look the case up by name.
  list.push({
    id: 'testcases-delete-frees-name', name: 'DELETE frees the testcase name for reuse (create -> delete -> recreate)', category: 'mutating',
    method: 'POST', endpoint: '/v2/testcases/import (delete/recreate)', severity: 'normal', destructive: true, longRunning: true,
    run: async (c) => {
      const base = { id: 'testcases-delete-frees-name', category: 'mutating' as const, method: 'POST' as const, endpoint: '/v2/testcases/import (delete/recreate)', severity: 'normal' as const, destructive: true };
      const traces: string[] = [];
      const seedR = await fetchSeedExport(c);
      if (!seedR.pack) return skip(base.id, base, seedR.err ?? 'no seed');

      const name = `simqa-delfree-${Date.now().toString(36)}`;
      const expected = `after DELETE, re-importing the same name stores it verbatim ("${name}"), not an auto-suffixed "_copy". Soft-deleted rows must not reserve names (SIM40-2293).`;

      // 1. create
      const imp1 = await postImport(c.host, c.token, makePack(seedR.pack, { Test_Id: name, Test_Name: name }), `Test_Name=${name}`);
      traces.push(`create=${imp1.status}`);
      if (imp1.status < 200 || imp1.status >= 300) return bad(base.id, base, imp1, `initial import returned ${imp1.status}`, expected);
      const id1 = imp1.landedIds[0] ?? name;

      // 2. delete
      const del1 = await rawCall(c, 'DELETE', `${tBase(c.host)}/testcases/${encodeURIComponent(id1)}`);
      traces.push(`delete=${del1.status}`);
      if (del1.status !== 200 && del1.status !== 204) return bad(base.id, base, del1, `DELETE returned ${del1.status}; ${traces.join(' ')}`, expected);

      // 3. recreate same name + verify the stored name
      const imp2 = await postImport(c.host, c.token, makePack(seedR.pack, { Test_Id: name, Test_Name: name }), `Test_Name=${name} (recreate)`);
      traces.push(`recreate=${imp2.status}`);
      const id2 = imp2.landedIds[0];
      let storedName: string | undefined;
      if (id2) {
        const g = await rawCall(c, 'GET', `${tBase(c.host)}/testcases/${encodeURIComponent(id2)}`);
        storedName = g.bodyJson?.name;
        traces.push(`get=${g.status} name="${storedName}"`);
        // best-effort cleanup of the recreate (the original is already deleted)
        await rawCall(c, 'DELETE', `${tBase(c.host)}/testcases/${encodeURIComponent(id2)}`).catch(() => null);
      }
      if (imp2.status < 200 || imp2.status >= 300) return bad(base.id, base, imp2, `recreate import returned ${imp2.status}; ${traces.join(' ')}`, expected);
      if (storedName !== name) return bad(base.id, base, imp2, `name NOT freed by delete: recreate stored as "${storedName}" instead of "${name}" (soft-deleted row still reserves it); ${traces.join(' ')}`, expected);
      return ok(base.id, base, imp2, `${traces.join(' ')} — name reused verbatim`);
    },
  });

  // ---------- testcases-nbiot-definition-completeness (SIM40-2311/2312) ----------
  // NB-IoT definitions must carry the fields the UE config generator needs:
  // a ueCategory (nb1/nb2) per subscriber group and a deployment/operation
  // mode (standalone / in-band / guard-band). The GUI currently loses the
  // deployment mode entirely (SIM40-2312), which downstream produces
  // unbootable NB-IoT configs (SIM40-2311).
  list.push({
    id: 'testcases-nbiot-definition-completeness', name: 'NB-IoT testcase definitions carry ueCategory + deployment mode', category: 'testcases',
    method: 'GET', endpoint: '/v2/testcases/{id} (nbiot)', severity: 'normal', longRunning: true,
    run: async (c) => {
      const base = { id: 'testcases-nbiot-definition-completeness', category: 'testcases' as const, method: 'GET' as const, endpoint: '/v2/testcases/{id} (nbiot)', severity: 'normal' as const };
      const listR = await rawCall(c, 'GET', `${tBase(c.host)}/testcases?limit=1000`);
      if (listR.status !== 200) return bad(base.id, base, listR, `testcase list returned ${listR.status}`);
      const items: any[] = listR.bodyJson?.items ?? [];
      // Prefer name-matched candidates; fall back to probing a few definitions.
      const byName = items.filter((x) => /nb-?iot|nbiot|nb[12]\b/i.test(String(x?.name ?? '')));
      const probeList = (byName.length ? byName : items).slice(0, byName.length ? 5 : 12);
      const nbiot: Array<{ name: string; td: any }> = [];
      for (const it of probeList) {
        const g = await rawCall(c, 'GET', `${tBase(c.host)}/testcases/${encodeURIComponent(it.id)}`);
        const td = g.bodyJson?.testDefinition;
        if (String(td?.cellConfig?.master?.ratType ?? '').toLowerCase() === 'nbiot') nbiot.push({ name: it.name, td });
        if (nbiot.length >= 3) break;
      }
      if (!nbiot.length) return skip(base.id, base, 'no NB-IoT testcase on the box to inspect');
      const expected = 'every NB-IoT definition carries subsConfig.subs[].ueCategory (nb1/nb2) and a cell deployment/operation mode (standalone / in-band / guard-band). Missing mode = SIM40-2312; it downstream yields unbootable UE configs (SIM40-2311).';
      const problems: string[] = [];
      for (const { name, td } of nbiot) {
        const subs: any[] = td?.subsConfig?.subs ?? [];
        const missingCat = subs.length === 0 || subs.some((s) => !/nb/i.test(String(s?.ueCategory ?? '')));
        if (missingCat) problems.push(`"${name}": ueCategory missing/non-NB on at least one subscriber group`);
        const cells: any[] = td?.cellConfig?.cells ?? [];
        const master = td?.cellConfig?.master ?? {};
        const hasMode = [master, ...cells].some((o) => Object.entries(o ?? {}).some(([k, v]) =>
          (/operation|deployment/i.test(k) && v) ||
          (/^cellType$/i.test(k) && /standalone|in.?band|guard/i.test(String(v)))));
        if (!hasMode) problems.push(`"${name}": no deployment/operation mode field (standalone/in-band/guard-band) anywhere in the definition`);
      }
      if (problems.length) return bad(base.id, base, listR, `${problems.length} NB-IoT definition gap(s): ${problems.slice(0, 4).join('; ')}`, expected);
      return ok(base.id, base, listR, `${nbiot.length} NB-IoT definition(s) carry ueCategory + deployment mode`);
    },
  });

  // Distinguish a validation 400 ("Test_Name is required") from a collision
  // 400 ("name already exists") for the validation tests below. A collision
  // 400 means the bad name was previously accepted on this box - which itself
  // is evidence the validation rule is missing - so it should not be treated
  // as a pass.
  function isCollisionMessage(msg: any): boolean {
    return typeof msg === 'string' && msg.toLowerCase().includes('already exists');
  }

  // ---------- testcases-import-empty-name (SIM40-2021) ----------
  // The validator should reject Test_Name="". Currently returns 200, then GET
  // 404s - the record becomes a ghost.
  list.push({
    id: 'testcases-import-empty-name', name: 'POST /testcases/import with Test_Name="" must be rejected (SIM40-2021)', category: 'mutating',
    method: 'POST', endpoint: '/v2/testcases/import (validation)', severity: 'critical', destructive: true,
    run: async (c) => {
      const base = { id: 'testcases-import-empty-name', category: 'mutating' as const, method: 'POST' as const, endpoint: '/v2/testcases/import (validation)', severity: 'critical' as const, destructive: true };
      const seedR = await fetchSeedExport(c);
      if (!seedR.pack) return skip(base.id, base, seedR.err ?? 'no seed');
      const newId = `simqa-empty-name-${Date.now().toString(36)}`;
      const pack = makePack(seedR.pack, { Test_Id: newId, Test_Name: '' });
      const imp = await postImport(c.host, c.token, pack, `Test_Id=${newId} Test_Name=""`);
      const expected = '400 BAD_REQUEST {"code":"INVALID_REQUEST","message":"Test_Name is required and must be non-empty after trimming"}. Currently returns 200 + ghost record (SIM40-2021).';
      if (imp.status >= 200 && imp.status < 300) return bad(base.id, base, imp, `200 - empty Test_Name accepted (validation gap, ghost record on box)`, expected);
      if (imp.status >= 500) return bad(base.id, base, imp, `5xx - server crashed on empty Test_Name`, expected);
      if (imp.status === 400 && isCollisionMessage(imp.bodyJson?.message)) return bad(base.id, base, imp, `400 but reason is "already exists" - proves a prior import did accept Test_Name="". Validation gap still real (SIM40-2021).`, expected);
      if (imp.status >= 400 && imp.status < 500) return ok(base.id, base, imp, `rejected with ${imp.status}: ${imp.bodyJson?.message ?? ''}`);
      return bad(base.id, base, imp, `unexpected ${imp.status}`, expected);
    },
  });

  // ---------- testcases-import-empty-id (SIM40-2021) ----------
  list.push({
    id: 'testcases-import-empty-id', name: 'POST /testcases/import with Test_Id="" must be rejected (SIM40-2021)', category: 'mutating',
    method: 'POST', endpoint: '/v2/testcases/import (validation)', severity: 'critical', destructive: true,
    run: async (c) => {
      const base = { id: 'testcases-import-empty-id', category: 'mutating' as const, method: 'POST' as const, endpoint: '/v2/testcases/import (validation)', severity: 'critical' as const, destructive: true };
      const seedR = await fetchSeedExport(c);
      if (!seedR.pack) return skip(base.id, base, seedR.err ?? 'no seed');
      const pack = makePack(seedR.pack, { Test_Id: '', Test_Name: `simqa-empty-id-${Date.now().toString(36)}` });
      const imp = await postImport(c.host, c.token, pack, `Test_Id="" Test_Name=...`);
      const expected = '400 BAD_REQUEST {"code":"INVALID_REQUEST","message":"Test_Id is required and must be non-empty after trimming"}. Currently returns 200 with a record stored under id="" - collisions and unaddressable rows ahead (SIM40-2021).';
      if (imp.status >= 200 && imp.status < 300) return bad(base.id, base, imp, `200 - empty Test_Id accepted (validation gap)`, expected);
      if (imp.status >= 500) return bad(base.id, base, imp, `5xx - server crashed on empty Test_Id`, expected);
      if (imp.status === 400 && isCollisionMessage(imp.bodyJson?.message)) return bad(base.id, base, imp, `400 but reason is "already exists" - the empty-id row from a prior accepted import is what's blocking this. Validation gap still real (SIM40-2021).`, expected);
      if (imp.status >= 400 && imp.status < 500) return ok(base.id, base, imp, `rejected with ${imp.status}: ${imp.bodyJson?.message ?? ''}`);
      return bad(base.id, base, imp, `unexpected ${imp.status}`, expected);
    },
  });

  // ---------- testcases-import-whitespace-name (SIM40-2021) ----------
  list.push({
    id: 'testcases-import-whitespace-name', name: 'POST /testcases/import with Test_Name="   " must be rejected (SIM40-2021)', category: 'mutating',
    method: 'POST', endpoint: '/v2/testcases/import (validation)', severity: 'normal', destructive: true,
    run: async (c) => {
      const base = { id: 'testcases-import-whitespace-name', category: 'mutating' as const, method: 'POST' as const, endpoint: '/v2/testcases/import (validation)', severity: 'normal' as const, destructive: true };
      const seedR = await fetchSeedExport(c);
      if (!seedR.pack) return skip(base.id, base, seedR.err ?? 'no seed');
      const newId = `simqa-ws-name-${Date.now().toString(36)}`;
      const pack = makePack(seedR.pack, { Test_Id: newId, Test_Name: '   ' });
      const imp = await postImport(c.host, c.token, pack, `Test_Id=${newId} Test_Name="   "`);
      const expected = '400 BAD_REQUEST: Test_Name must be non-empty after trimming whitespace. Currently returns 200; log_filename ends up as "/tmp/   .log" (SIM40-2021).';
      if (imp.status >= 200 && imp.status < 300) return bad(base.id, base, imp, `200 - whitespace-only Test_Name accepted`, expected);
      if (imp.status === 400 && isCollisionMessage(imp.bodyJson?.message)) return bad(base.id, base, imp, `400 but reason is "already exists" - prior import accepted Test_Name="   ". Validation gap still real (SIM40-2021).`, expected);
      if (imp.status >= 400 && imp.status < 500) return ok(base.id, base, imp, `rejected with ${imp.status}: ${imp.bodyJson?.message ?? ''}`);
      return bad(base.id, base, imp, `unexpected ${imp.status}`, expected);
    },
  });

  // ---------- testcases-import-xss-name (SIM40-2020) ----------
  // The Test_Name field accepts arbitrary HTML/script and stores it verbatim;
  // a UI rendering the name without escaping is XSS-vulnerable. Test passes
  // when the API rejects unsafe characters with 400 (and not because of a
  // prior collision).
  list.push({
    id: 'testcases-import-xss-name', name: 'POST /testcases/import with <script> in Test_Name must be rejected (SIM40-2020)', category: 'mutating',
    method: 'POST', endpoint: '/v2/testcases/import (security)', severity: 'critical', destructive: true,
    run: async (c) => {
      const base = { id: 'testcases-import-xss-name', category: 'mutating' as const, method: 'POST' as const, endpoint: '/v2/testcases/import (security)', severity: 'critical' as const, destructive: true };
      const seedR = await fetchSeedExport(c);
      if (!seedR.pack) return skip(base.id, base, seedR.err ?? 'no seed');
      const newId = `simqa-xss-${Date.now().toString(36)}`;
      const xssName = '../../etc/passwd<script>alert(1)</script>';
      const pack = makePack(seedR.pack, { Test_Id: newId, Test_Name: xssName });
      const imp = await postImport(c.host, c.token, pack, `Test_Id=${newId} Test_Name=<XSS>`);
      const expected = '400 BAD_REQUEST: Test_Name contains illegal characters. Currently 200 - the script tag is stored verbatim and returned unescaped on GET, exposing any web UI rendering the name to stored XSS (SIM40-2020).';
      if (imp.status >= 200 && imp.status < 300) return bad(base.id, base, imp, `200 - <script> in Test_Name accepted (stored XSS vector)`, expected);
      if (imp.status === 400 && isCollisionMessage(imp.bodyJson?.message)) return bad(base.id, base, imp, `400 but reason is "already exists" - the script-tag name is already in the database, meaning a prior import accepted it. Stored XSS confirmed (SIM40-2020).`, expected);
      if (imp.status >= 400 && imp.status < 500) return ok(base.id, base, imp, `rejected with ${imp.status} (good): ${imp.bodyJson?.message ?? ''}`);
      return bad(base.id, base, imp, `unexpected ${imp.status}`, expected);
    },
  });

  // ---------- testcases-import-missing-name-error (SIM40-2022) ----------
  // When Test_Name is omitted the server returns 400 but with the wrong error
  // message ("Test case already exists"). Test passes when the message names
  // the actual problem (a missing field).
  list.push({
    id: 'testcases-import-missing-name-error', name: 'POST /testcases/import without Test_Name must return a "field required" error (SIM40-2022)', category: 'mutating',
    method: 'POST', endpoint: '/v2/testcases/import (diagnostics)', severity: 'normal', destructive: true,
    run: async (c) => {
      const base = { id: 'testcases-import-missing-name-error', category: 'mutating' as const, method: 'POST' as const, endpoint: '/v2/testcases/import (diagnostics)', severity: 'normal' as const, destructive: true };
      const seedR = await fetchSeedExport(c);
      if (!seedR.pack) return skip(base.id, base, seedR.err ?? 'no seed');
      const newId = `simqa-no-name-${Date.now().toString(36)}`;
      const pack = makePack(seedR.pack, { Test_Id: newId }, ['Test_Name']);
      const imp = await postImport(c.host, c.token, pack, `Test_Id=${newId} Test_Name=<omitted>`);
      const expected = '400 with code=INVALID_REQUEST and a message naming Test_Name as the missing field. Must NOT contain "already exists" — that message is misleading (SIM40-2022).';
      if (imp.status !== 400) return bad(base.id, base, imp, `expected 400, got ${imp.status}`, expected);
      const msg = String(imp.bodyJson?.message ?? '').toLowerCase();
      if (msg.includes('already exists')) return bad(base.id, base, imp, `400 but message claims the testcase "already exists" — the real problem is the missing Test_Name field`, expected);
      if (!msg.includes('test_name') && !msg.includes('name is required') && !msg.includes('name must')) return bad(base.id, base, imp, `400 but message does not mention Test_Name; got: ${imp.bodyJson?.message}`, expected);
      return ok(base.id, base, imp, `400 with helpful message: ${imp.bodyJson?.message}`);
    },
  });

  // ---------- testcases-import-collision-status (SIM40-2022) ----------
  // Importing with a Test_Id that already exists should return 409 CONFLICT,
  // not 400. Currently 400.
  list.push({
    id: 'testcases-import-collision-status', name: 'POST /testcases/import with existing Test_Id must return 409 CONFLICT (SIM40-2022)', category: 'mutating',
    method: 'POST', endpoint: '/v2/testcases/import (http-semantics)', severity: 'optional', destructive: true,
    run: async (c) => {
      const base = { id: 'testcases-import-collision-status', category: 'mutating' as const, method: 'POST' as const, endpoint: '/v2/testcases/import (http-semantics)', severity: 'optional' as const, destructive: true };
      const seedR = await fetchSeedExport(c);
      if (!seedR.pack || !seedR.seedId) return skip(base.id, base, seedR.err ?? 'no seed');
      const pack = makePack(seedR.pack, { Test_Id: seedR.seedId, Test_Name: `simqa-collide-${Date.now().toString(36)}` });
      const imp = await postImport(c.host, c.token, pack, `Test_Id=${seedR.seedId} (collision)`);
      const expected = '409 CONFLICT — REST convention for "request well-formed but resource state prevents it". Currently returns 400 (SIM40-2022).';
      if (imp.status === 409) return ok(base.id, base, imp, `409 CONFLICT (good)`);
      if (imp.status === 400) return bad(base.id, base, imp, `400 — should be 409 for resource collision`, expected);
      if (imp.status >= 200 && imp.status < 300) return bad(base.id, base, imp, `${imp.status} — collision should not succeed; check seed wasn't overwritten`, expected);
      return bad(base.id, base, imp, `unexpected ${imp.status}`, expected);
    },
  });

  // ---------- TEST-CREATOR (/tests/* config builder) ----------
  // How a test case is actually authored: POST /tests/cells initialises a case
  // and returns its testCaseId, then each section is bound in dependency order.
  // These read-only checks GET the sections of an existing case; the full
  // create → configure → delete flow is `tc-create-lifecycle` below.
  list.push({
    id: 'tc-cells-get', name: 'GET /tests/{id}/cells', category: 'test-creator',
    method: 'GET', endpoint: '/v2/tests/{id}/cells', severity: 'normal',
    run: async (c) => {
      const base = { id: 'tc-cells-get', category: 'test-creator' as const, method: 'GET' as const, endpoint: '/v2/tests/{id}/cells', severity: 'normal' as const };
      await ensureTestcaseContext(c);
      if (!c.someTestcaseId) return skip(base.id, base, 'no testcases exist on this box');
      const r = await rawCall(c, 'GET', `${tBase(c.host)}/tests/${encodeURIComponent(c.someTestcaseId)}/cells`);
      if (r.status === 200 && r.bodyJson?.cellConfig) return ok(base.id, base, r, `cellConfig present (${r.bodyJson.cellConfig?.cells?.length ?? '?'} cell(s))`);
      return bad(base.id, base, r, `expected 200 with cellConfig, got ${r.status}`);
    },
  });
  for (const slug of ['subscribers', 'user-plane', 'power-cycle', 'mobility', 'settings']) {
    list.push({
      id: `tc-${slug}-get`, name: `GET /tests/{id}/${slug}`, category: 'test-creator',
      method: 'GET', endpoint: `/v2/tests/{id}/${slug}`, severity: 'optional',
      run: async (c) => {
        const base = { id: `tc-${slug}-get`, category: 'test-creator' as const, method: 'GET' as const, endpoint: `/v2/tests/{id}/${slug}`, severity: 'optional' as const };
        await ensureTestcaseContext(c);
        if (!c.someTestcaseId) return skip(base.id, base, 'no testcases exist on this box');
        const r = await rawCall(c, 'GET', `${tBase(c.host)}/tests/${encodeURIComponent(c.someTestcaseId)}/${slug}`);
        if (r.status === 200) return ok(base.id, base, r, JSON.stringify(r.bodyJson).slice(0, 100));
        if (r.status === 404) {
          // 404 means THIS case was authored without the optional section, not
          // that the endpoint is broken. Look for a case that does have it
          // rather than skipping — the box holds hundreds, and skipping on the
          // first arbitrary subject left the endpoint untested.
          const alt = await findSectionSubject(c, slug);
          if (alt) {
            const r2 = await rawCall(c, 'GET', `${tBase(c.host)}/tests/${encodeURIComponent(alt)}/${slug}`);
            if (r2.status === 200) return ok(base.id, base, r2, `via testcase ${alt.slice(0, 8)}… (the default subject has no '${slug}' section): ${JSON.stringify(r2.bodyJson).slice(0, 80)}`);
          }
          return skip(base.id, base, `no testcase on this box carries a '${slug}' section — nothing to read it from`);
        }
        return bad(base.id, base, r, `expected 200 or 404, got ${r.status}`);
      },
    });
  }

  // Full create → configure → finalise → tag → purge-history → delete.
  // Validated end-to-end against the live UE-sim box. Section order is
  // mandatory and settings is the finaliser that LOCKS the case; mobility
  // intentionally gets no PUT (the server rejects it with "section
  // 'mobilityConfig' cannot be updated"). Cleans up after itself via DELETE.
  list.push({
    id: 'tc-create-lifecycle',
    name: 'POST /tests/cells → subscribers → user-plane → power-cycle → mobility → settings (full create), PUT tags, purge history, DELETE',
    category: 'test-creator',
    method: 'POST', endpoint: '/v2/tests/cells (full lifecycle)', severity: 'critical',
    destructive: true, longRunning: true,
    run: async (c) => {
      const base = { id: 'tc-create-lifecycle', category: 'test-creator' as const, method: 'POST' as const, endpoint: '/v2/tests/cells (full lifecycle)', severity: 'critical' as const, destructive: true };
      const J = { 'Content-Type': 'application/json' };
      const traces: string[] = [];

      // 1. Initialise the case via cells → returns testCaseId.
      const cells = await rawCall(c, 'POST', `${tBase(c.host)}/tests/cells`, { headers: J, body: JSON.stringify(TC_CELLS_LTE) });
      traces.push(`cells=${cells.status}`);
      const id: string | undefined = cells.bodyJson?.testCaseId;
      if (cells.status !== 200 || !id) return bad(base.id, base, cells, `create cells returned ${cells.status}`, '200 with { success, testCaseId, testCaseName } per createCellConfig (master.product must be "UE-SIM", cells[].bandwidth must be a string)');

      const cleanup = async () => { try { await rawCall(c, 'DELETE', `${tBase(c.host)}/testcases/${encodeURIComponent(id)}`); } catch { /* best effort */ } };
      try {
        // 2–5. Sections in dependency order; each is gated on the previous one.
        const order: Array<[string, any]> = [['subscribers', TC_SUBS_LTE], ['user-plane', TC_UPLANE], ['power-cycle', TC_PCYCLE], ['mobility', TC_MOBILITY]];
        for (const [slug, body] of order) {
          const r = await rawCall(c, 'POST', `${tBase(c.host)}/tests/${encodeURIComponent(id)}/${slug}`, { headers: J, body: JSON.stringify(body) });
          traces.push(`${slug}=${r.status}`);
          if (r.status !== 200) { await cleanup(); return bad(base.id, base, r, `POST ${slug} returned ${r.status}: ${JSON.stringify(r.bodyJson)?.slice(0, 140)}; ${traces.join(' ')}`, '200; section creation is order-dependent (cells→subscribers→user-plane→power-cycle→mobility→settings)'); }
        }
        // 6. Update an existing section (cells supports PUT; mobility does not).
        const putCells = await rawCall(c, 'PUT', `${tBase(c.host)}/tests/${encodeURIComponent(id)}/cells`, { headers: J, body: JSON.stringify(TC_CELLS_LTE) });
        traces.push(`put-cells=${putCells.status}`);
        // 7. Finalise — settings locks the case and sets the final name.
        // Self-discovers valid loggingProfileName + successCriteriaName on
        // each run (4.0.0_260602+ now validates these against an internal
        // list; the names that worked on older builds may not exist on
        // every install).
        const settingsBody = await tcSettingsBody(c, `simqa-create-lifecycle-${Date.now().toString(36)}`);
        const settings = await rawCall(c, 'POST', `${tBase(c.host)}/tests/${encodeURIComponent(id)}/settings`, { headers: J, body: JSON.stringify(settingsBody) });
        traces.push(`settings=${settings.status}`);
        if (settings.status !== 200) { await cleanup(); return bad(base.id, base, settings, `settings (finalise) returned ${settings.status}: ${JSON.stringify(settings.bodyJson)?.slice(0, 160)}; ${traces.join(' ')}`, '200 "testcase creation completed". On 4.0.0_260602 settings now validates loggingProfileName and successCriteriaName against the box catalogue — the simqa test self-discovers these from an existing testcase.'); }
        // 8. Tag it (PUT /testcases/{id}).
        const tags = await rawCall(c, 'PUT', `${tBase(c.host)}/testcases/${encodeURIComponent(id)}`, { headers: J, body: JSON.stringify({ user_tags: ['simqa', 'smoke'] }) });
        traces.push(`tags=${tags.status}`);
        // 9. Purge history (async job) and 10. track it via /api/jobs/{id}.
        const purge = await rawCall(c, 'DELETE', `${tBase(c.host)}/testcases/${encodeURIComponent(id)}/history`);
        traces.push(`purge=${purge.status}`);
        const jobId: string | undefined = purge.bodyJson?.jobId;
        if (jobId) { const job = await rawCall(c, 'GET', `${tBase(c.host)}/api/jobs/${encodeURIComponent(jobId)}`); traces.push(`job=${job.status}`); }
        // 11. Confirm retrievable, then 12. delete + 13. confirm gone.
        const verify = await rawCall(c, 'GET', `${tBase(c.host)}/testcases/${encodeURIComponent(id)}`);
        traces.push(`verify=${verify.status}`);
        const del = await rawCall(c, 'DELETE', `${tBase(c.host)}/testcases/${encodeURIComponent(id)}`);
        traces.push(`delete=${del.status}`);
        if (del.status !== 200 && del.status !== 204) return bad(base.id, base, del, `DELETE testcase returned ${del.status} (leaked ${id}); ${traces.join(' ')}`, '200/204 — the case must be removable so a create smoke-test does not leak inventory');
        return ok(base.id, base, cells, `${id}: ${traces.join(' ')}`);
      } catch (e: any) {
        await cleanup();
        return bad(base.id, base, { status: 0, ms: 0, error: e?.message ?? String(e), request: { method: 'POST', url: `${tBase(c.host)}/tests/cells`, headers: {} } }, `lifecycle threw: ${e?.message ?? e}; ${traces.join(' ')}`);
      }
    },
  });

  // ---------- JOBS (async job tracking) ----------
  list.push({
    id: 'jobs-list', name: 'GET /api/jobs', category: 'jobs',
    method: 'GET', endpoint: '/v2/api/jobs', severity: 'normal',
    run: async (c) => {
      const base = { id: 'jobs-list', category: 'jobs' as const, method: 'GET' as const, endpoint: '/v2/api/jobs', severity: 'normal' as const };
      const r = await rawCall(c, 'GET', `${tBase(c.host)}/api/jobs`);
      if (r.status === 200) {
        const arr = Array.isArray(r.bodyJson) ? r.bodyJson : (r.bodyJson?.items ?? r.bodyJson?.jobs ?? []);
        if (Array.isArray(arr) && arr.length > 0) c.someJobId = arr[0]?.id ?? arr[0]?.jobId;
        return ok(base.id, base, r, `${Array.isArray(arr) ? arr.length : '?'} job(s)`);
      }
      return bad(base.id, base, r, `expected 200, got ${r.status}`);
    },
  });
  list.push({
    id: 'jobs-get-one', name: 'GET /api/jobs/{id}', category: 'jobs',
    method: 'GET', endpoint: '/v2/api/jobs/{id}', severity: 'normal',
    run: async (c) => {
      const base = { id: 'jobs-get-one', category: 'jobs' as const, method: 'GET' as const, endpoint: '/v2/api/jobs/{id}', severity: 'normal' as const };
      if (!c.someJobId) return skip(base.id, base, 'no job id available (run jobs-list first; box may have no jobs)');
      const r = await rawCall(c, 'GET', `${tBase(c.host)}/api/jobs/${encodeURIComponent(c.someJobId)}`);
      if (r.status === 200) return ok(base.id, base, r, JSON.stringify(r.bodyJson).slice(0, 100));
      return bad(base.id, base, r, `expected 200, got ${r.status}`);
    },
  });

  // ---------- USERS SEARCH ----------
  // Spec documents POST /users/search. On this box the route is registered but
  // answers 403 FORBIDDEN "This feature is disabled." — multi-user is switched
  // off for the deployment (env-config.js: VITE_DISABLE_MULTI_USER_SIM=true),
  // NOT a role-mapping problem as this comment used to claim. The distinction
  // matters: 403 proves the route exists (an unregistered path under /v2/users
  // returns 404), so a disabled feature is a deployment fact rather than a
  // defect; a 404 would mean the route is genuinely missing.
  //
  // Rather than skip on a disabled box, this asserts two things that still
  // hold there: the refusal is well-formed, and it AGREES with GET /v2/users.
  // The agreement half is the part neither endpoint can check alone.
  list.push({
    id: 'users-search', name: 'POST /users/search', category: 'admin-users',
    method: 'POST', endpoint: '/v2/users/search', severity: 'optional',
    run: async (c) => {
      const base = { id: 'users-search', category: 'admin-users' as const, method: 'POST' as const, endpoint: '/v2/users/search', severity: 'optional' as const };
      // Ask the deployment's state first (memoised probe of GET /v2/users), so
      // the two user endpoints can be held to the SAME answer. A box that
      // refuses the list while search quietly serves rows — or vice versa — is
      // a real bug that neither endpoint reveals when tested on its own.
      const disabled = await userMgmtDisabled(c);
      const r = await rawCall(c, 'POST', `${tBase(c.host)}/users/search`, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pageNumber: 1, pageSize: 10 }) });

      if (!disabled) {
        if (r.status === 200) {
          // Unfiltered search (page 1, no criteria) must at minimum return the
          // admin we are authenticated as. Zero rows here means the search
          // path is broken even though the list endpoint works.
          const n = collectionSize(r.bodyJson);
          if (n <= 0) return bad(base.id, base, r, `multi-user is enabled but an unfiltered search returned ${n < 0 ? 'no collection' : '0 rows'}`,
            'An unfiltered POST /v2/users/search returns at least the authenticated admin.');
          return ok(base.id, base, r, `multi-user enabled — items=${n}`);
        }
        return bad(base.id, base, r, `multi-user is enabled (GET /v2/users answered 200) but search returned ${r.status}`,
          'With multi-user on, POST /v2/users/search returns 200 with a paged user list.');
      }

      if (r.status === 200) {
        return bad(base.id, base, r, `inconsistent: GET /v2/users refuses as disabled, yet search answered 200 with ${collectionSize(r.bodyJson)} row(s)`,
          'Both user endpoints must agree on whether multi-user is enabled. One refusing while the other serves data means a client sees a different answer depending on which it calls.');
      }
      const violation = disabledContractViolation(r);
      if (violation) {
        return bad(base.id, base, r, `multi-user is off, but search's refusal is malformed: ${violation}`,
          'When a capability is disabled the box must answer 403 with { code: "FORBIDDEN", message: <why> } — never 404, never 5xx.');
      }
      return ok(base.id, base, r, `multi-user off; search refuses consistently with GET /v2/users — 403 ${r.bodyJson?.code} "${r.bodyJson?.message}"`);
    },
  });

  // ---------- FUZZ ----------
  // Schema fuzzing: send malformed payloads and assert the API rejects with
  // 4xx (not 5xx, not 200). The point is to surface input validation gaps.
  // Each test passes if the response is a 4xx; a 200 means the server didn't
  // validate, a 5xx means it crashed.
  const fuzz = (id: string, name: string, ep: string, method: 'POST'|'PUT'|'PATCH'|'GET'|'DELETE', urlSuffix: string, body: any, opts: { headers?: Record<string,string>; auth?: 'bearer'|'none'; expected?: string } = {}): TestDef => ({
    id, name, category: 'fuzz', method, endpoint: ep, severity: 'optional',
    run: async (c) => {
      const base = { id, category: 'fuzz' as const, method, endpoint: ep, severity: 'optional' as const };
      const init: any = {
        auth: opts.auth ?? 'bearer',
        headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
      };
      if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
      const r = await rawCall(c, method, `${tBase(c.host)}${urlSuffix}`, init);
      const defaultExpected = opts.expected ?? '4xx with a JSON error envelope { code, message }; never 5xx (crash) or 2xx (silent acceptance of invalid input)';
      if (r.status >= 400 && r.status < 500) return ok(base.id, base, r, `rejected with ${r.status} (good)`);
      if (r.status >= 500)                   return bad(base.id, base, r, `5xx — server crashed on bad input`, defaultExpected);
      if (r.status >= 200 && r.status < 300) return bad(base.id, base, r, `200 — input validation gap`, defaultExpected);
      return bad(base.id, base, r, `unexpected ${r.status}`, defaultExpected);
    },
  });

  list.push(fuzz('fuzz-login-no-body',          'POST /login no body',                          '/v2/login',     'POST', '/login',     undefined,                       { auth: 'none', expected: '400 BAD_REQUEST {"code":"INVALID_REQUEST","message":"username and password are required"}' }));
  list.push(fuzz('fuzz-login-empty-obj',        'POST /login empty {}',                         '/v2/login',     'POST', '/login',     {},                              { auth: 'none', expected: '400 BAD_REQUEST with a message naming the missing fields' }));
  list.push(fuzz('fuzz-login-wrong-types',      'POST /login wrong types (numbers)',            '/v2/login',     'POST', '/login',     { username: 123, password: true }, { auth: 'none', expected: '400 BAD_REQUEST: username/password must be strings' }));
  list.push(fuzz('fuzz-login-malformed-json',   'POST /login malformed JSON',                   '/v2/login',     'POST', '/login',     '{"username":"admin", "password":', { auth: 'none', expected: '400 BAD_REQUEST {"code":"INVALID_JSON","message":"could not parse request body"} - MUST NOT 5xx; an unauthenticated DoS is critical' }));
  list.push(fuzz('fuzz-login-oversize',         'POST /login 1MB username',                     '/v2/login',     'POST', '/login',     { username: 'a'.repeat(1024*1024), password: 'x' }, { auth: 'none', expected: '413 PAYLOAD_TOO_LARGE or 400 - reject before fully buffering. Cap request body at 64 KB.' }));
  list.push(fuzz('fuzz-bandinfo-missing-rat',   'POST /band-info missing rat',                  '/v2/band-info', 'POST', '/band-info', { search: 'n7' },                { expected: '400 BAD_REQUEST: rat is required and must be one of [NR, LTE]' }));
  list.push(fuzz('fuzz-bandinfo-array-rat',     'POST /band-info rat as array',                 '/v2/band-info', 'POST', '/band-info', { rat: ['NR'] },                  { expected: '400 BAD_REQUEST: rat must be a string, not an array' }));
  list.push(fuzz('fuzz-search-bad-pageNumber',  'POST /testcases/search pageNumber=-1',         '/v2/testcases/search', 'POST', '/testcases/search', { pageNumber: -1, pageSize: 10 }, { expected: '400 BAD_REQUEST: pageNumber must be >= 1' }));
  list.push(fuzz('fuzz-search-huge-pageSize',   'POST /testcases/search pageSize=1e9',          '/v2/testcases/search', 'POST', '/testcases/search', { pageNumber: 1, pageSize: 1_000_000_000 }, { expected: '400 BAD_REQUEST: pageSize must be <= 1000 (or whatever max). Server-side cap to prevent memory exhaustion / DoS.' }));
  list.push(fuzz('fuzz-tc-list-negative-limit', 'GET /testcases?limit=-5',                      '/v2/testcases', 'GET',  '/testcases?limit=-5&offset=0', undefined, { expected: '400 BAD_REQUEST: limit must be a positive integer' }));
  list.push(fuzz('fuzz-tc-list-string-limit',   'GET /testcases?limit=abc',                     '/v2/testcases', 'GET',  '/testcases?limit=abc',         undefined, { expected: '400 BAD_REQUEST: limit must be an integer' }));
  list.push(fuzz('fuzz-tc-id-traversal',        'GET /testcases/../../etc/passwd',              '/v2/testcases/{id}', 'GET', '/testcases/' + encodeURIComponent('../../etc/passwd'), undefined, { expected: '404 (id contains illegal characters) or 400. Validate testcase id pattern: ^[A-Za-z0-9_-]+$' }));
  list.push(fuzz('fuzz-admin-user-no-fields',   'POST /admin/users empty body',                 '/v2/admin/users', 'POST', '/admin/users', {}, { expected: '400 BAD_REQUEST: username and first_name are required' }));
  list.push(fuzz('fuzz-admin-user-bad-role',    'POST /admin/users role=superduper',            '/v2/admin/users', 'POST', '/admin/users', { username: 'simqa-fuzz-' + Date.now(), first_name: 'x', role: 'superduper' }, { expected: '400 BAD_REQUEST: role must be one of [admin, user]' }));
  list.push(fuzz('fuzz-satellite-out-of-range', 'POST /tools/satellite-tracker sLat=999',       '/v2/tools/satellite-tracker/metrics', 'POST', '/tools/satellite-tracker/metrics', { sLat: 999, sLon: 0, sAlt: 35786, sVel: 3.07, gLat: 0, gLon: 0 }, { expected: '400 BAD_REQUEST: sLat must be in range [-90, 90] per OpenAPI spec lines 1781-1801' }));
  list.push(fuzz('fuzz-content-type-text',      'POST /login Content-Type: text/plain',         '/v2/login',     'POST', '/login',     'username=admin&password=admin', { auth: 'none', headers: { 'Content-Type': 'text/plain' }, expected: '415 UNSUPPORTED_MEDIA_TYPE - reject before parsing. MUST NOT 5xx; another unauthenticated DoS vector.' }));

  // ---------- SAMPLE-MATRIX (per-sample × variation) ----------
  // Every variant produced by src/lib/sampleTests/matrix.ts becomes one
  // ApiTest entry. The test:
  //   1. Looks up the base testcase by name in the box catalogue (cached
  //      per-sweep so we don't re-search 200+ times).
  //   2. If absent on this build  → SKIP with "not yet authored on box".
  //   3. If present + the box currently has NO active execution → trigger
  //      `POST /v2/testcases/{id}/executions`, accept 200/201/202/204 as a
  //      PASS (we don't poll for verdict — that's the end-to-end runner's
  //      job; this catalog only validates the create-and-trigger contract).
  //   4. If present but box is busy → SKIP with "box busy — cannot trigger"
  //      so the matrix doesn't fight existing runs.
  for (const variant of buildSampleMatrixEntries()) {
    list.push(variant);
  }

  return list;
}

/** Lazy-load the testcase catalog once per sweep and cache on the ctx. */
async function ensureTestcaseCatalog(c: RunCtx): Promise<Array<{ id: string; name: string }>> {
  if (c.testcaseCatalog) return c.testcaseCatalog;
  // Pull both user testcases (via search) AND sample-tagged testcases (which
  // the box exposes via a separate `?tags=sample` filter — confirmed during
  // the Chrome QA walk). Otherwise sample-matrix variants always SKIP because
  // the catalog only sees user-authored entries.
  const seen = new Map<string, { id: string; name: string }>();
  const userR = await rawCall(c, 'POST', `${tBase(c.host)}/testcases/search`, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ offset: 0, limit: 5000 }),
  });
  const userItems: any[] = userR.bodyJson?.items ?? userR.bodyJson?.data ?? [];
  for (const x of userItems) {
    if (!x || typeof x !== 'object') continue;
    const id = String(x.id ?? ''); if (!id) continue;
    seen.set(id, { id, name: String(x.name ?? '') });
  }
  // Sample-tagged testcases (system_tags=["sample"]) — separate listing.
  const sampleR = await rawCall(c, 'GET', `${tBase(c.host)}/testcases?limit=1000&tags=sample`);
  const sampleItems: any[] = sampleR.bodyJson?.items ?? sampleR.bodyJson?.data ?? [];
  for (const x of sampleItems) {
    if (!x || typeof x !== 'object') continue;
    const id = String(x.id ?? ''); if (!id) continue;
    if (!seen.has(id)) seen.set(id, { id, name: String(x.name ?? '') });
  }
  c.testcaseCatalog = [...seen.values()];
  return c.testcaseCatalog;
}

/** Build one TestDef per matrix variant. Each variant maps to one of the
 *  three sample-* categories so the report dashboards group cleanly. */
function buildSampleMatrixEntries(): TestDef[] {
  // Imported lazily-here (inside the function) to keep the file's top-level
  // imports tidy and avoid a circular-import risk if the matrix module
  // grows to depend on apiTester types.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { generateMatrix } = require('./sampleTests/matrix') as typeof import('./sampleTests/matrix');
  const matrix = generateMatrix();
  const out: TestDef[] = [];
  for (const v of matrix) {
    const category: ApiTestCategory = v.category === 'sa'
      ? 'sample-sa'
      : v.category === 'lte'
      ? 'sample-lte'
      : v.category === 'nsa'
      ? 'sample-nsa'
      : 'sample-nbiot';
    out.push({
      id: v.id,
      name: v.name,
      category,
      method: 'POST',
      endpoint: '/v2/testcases/{id}/executions',
      severity: 'normal',
      destructive: true,
      longRunning: true,
      run: async (c) => {
        const base = { id: v.id, category, method: 'POST' as const, endpoint: '/v2/testcases/{id}/executions', severity: 'normal' as const, destructive: true };
        const catalog = await ensureTestcaseCatalog(c);
        // Match strictly by the catalog's on-box id first (post-Chrome-QA we
        // know each sample testcase's exact id ends in `_` per SIM40-2015).
        // Fall back to name match for older builds that don't yet expose the
        // canonical id.
        const wantId   = v.baseId.toLowerCase();
        const wantName = v.baseName.toLowerCase();
        const hit = catalog.find((t) =>
          (t.id   || '').toLowerCase() === wantId ||
          (t.name || '').toLowerCase() === wantName,
        );
        if (!hit) return skip(base.id, base, `base testcase "${v.baseName}" (id=${v.baseId}) not yet authored on box (owner: ${v.owner})`);

        // Don't fire if the box is already busy — leaves other people's runs alone.
        const sims = await rawCall(c, 'GET', `${tBase(c.host)}/simulators`);
        const anyBusy = (sims.bodyJson?.items ?? []).some((s: any) => String(s?.availability ?? '').toUpperCase() === 'BUSY');
        if (anyBusy) return skip(base.id, base, 'box has a BUSY simulator — declining to trigger ' + v.baseName + ' variant ' + shortLabelOf(v.params));

        const trig = await rawCall(c, 'POST', `${tBase(c.host)}/testcases/${encodeURIComponent(hit.id)}/executions`, {
          headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        if (trig.status >= 200 && trig.status < 300) {
          return ok(base.id, base, trig, `${v.baseName} [${shortLabelOf(v.params)}] trigger ${trig.status} on box id=${hit.id}`);
        }
        // 409 = busy. Treat as SKIP (correct system-wide-mutex behaviour, not a regression).
        if (trig.status === 409) return skip(base.id, base, `box returned 409 BUSY when triggering ${v.baseName}`);
        return bad(base.id, base, trig, `trigger ${trig.status} for ${hit.id}`, '200/201/202 accepting the execution start');
      },
    });
  }
  return out;
}

function shortLabelOf(p: any): string {
  const bits: string[] = [];
  if (p.band) bits.push(p.band);
  if (p.traffic) bits.push(p.traffic);
  if (p.direction) bits.push(p.direction);
  if (p.ueCount) bits.push(`${p.ueCount}ue`);
  if (p.mobility) bits.push(p.mobility);
  if (p.channel) bits.push(p.channel);
  if (p.powerCycle) bits.push(p.powerCycle);
  if (p.hoMode) bits.push(p.hoMode);
  return bits.join('-') || 'default';
}

// ---------- Driver ----------

export async function runApiTests(inv: Inventory, req: ApiTesterRequest): Promise<ApiTesterResponse> {
  const startedAt = new Date().toISOString();
  // Resolve the target system. If a specific id was passed, use it; otherwise
  // fall back to the first UESIM-capable system in inventory (legacy
  // behaviour). This lets the UI offer a target dropdown the same way
  // /ui-tests does, so two teammates can test different boxes in parallel.
  const apiOpts = req.targetSystemId
    ? uesimApiOptsForSystem(inv, req.targetSystemId)
    : uesimApiOptsFromInventory(inv);
  if (!apiOpts) {
    return {
      startedAt, finishedAt: new Date().toISOString(),
      ok: false,
      counts: { total: 0, passed: 0, failed: 0, skipped: 0 },
      results: [{
        id: 'preflight', name: 'inventory has UESIM', category: 'auth',
        method: '-', endpoint: '-', severity: 'critical', destructive: false, ok: false,
        detail: req.targetSystemId
          ? `system "${req.targetSystemId}" not found or not UESIM-capable in inventory.yaml`
          : 'no UESIM system in inventory.yaml',
      }],
      byCategory: {},
    };
  }

  const wanted = new Set<ApiTestCategory>(req.categories ?? DEFAULT_CATEGORIES);
  // 'mutating' is entirely destructive tests, so opting into destructive
  // tests implies wanting this category even if its checkbox wasn't ticked
  // separately — unlike 'negative' (see ApiTesterRequest doc), there's no
  // conflicting UI control this could override: nothing lets a caller ask
  // for includeDestructive=true while deliberately excluding 'mutating'.
  if (req.includeDestructive) wanted.add('mutating');

  // Preflight: log in once.
  let token = '';
  try { token = await ensureToken(apiOpts.host, apiOpts.username, apiOpts.password); }
  catch (e: any) {
    return {
      startedAt, finishedAt: new Date().toISOString(),
      ok: false,
      counts: { total: 0, passed: 0, failed: 1, skipped: 0 },
      results: [{ id: 'preflight-login', name: 'preflight login', category: 'auth', method: 'POST', endpoint: '/v2/login', severity: 'critical', destructive: false, ok: false, detail: e?.message ?? String(e) }],
      byCategory: {},
    };
  }

  const ctx: RunCtx = {
    host: apiOpts.host,
    username: apiOpts.username,
    password: apiOpts.password,
    token,
    includeDestructive: !!req.includeDestructive,
    includeLongRunning: !!req.includeLongRunning,
  };

  const results: ApiTestResult[] = [];
  for (const def of defs()) {
    if (!wanted.has(def.category)) continue;
    const row = { id: def.id, name: def.name, category: def.category, method: def.method, endpoint: def.endpoint, severity: def.severity, destructive: !!def.destructive };
    // Both gates are evaluated together and reported together. Previously the
    // destructive gate returned first, so every test that is BOTH destructive
    // and long-running claimed it only needed "Include destructive tests" —
    // most long-running tests are in that set, so ticking "Include
    // long-running" alone appeared to do nothing at all.
    const needDestructive = def.destructive && !req.includeDestructive;
    const needLongRunning = def.longRunning && !req.includeLongRunning;
    if (needDestructive || needLongRunning) {
      const parts = [needDestructive ? 'Include destructive tests' : '', needLongRunning ? 'Include long-running' : ''].filter(Boolean);
      results.push({ ...row, ok: true, skipped: true, skippedReason: `requires ${parts.join(' AND ')}` });
      continue;
    }
    // Hard per-test deadline so one stalled export cannot swallow the whole
    // sweep: without it a hung call returns nothing at all to the page, which
    // reads as "I pressed Run and nothing came back".
    const deadlineMs = def.longRunning ? 300_000 : 60_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timedOut = Symbol('timeout');
      const result = await Promise.race([
        def.run(ctx),
        new Promise<typeof timedOut>((res) => { timer = setTimeout(() => res(timedOut), deadlineMs); }),
      ]);
      if (result === timedOut) {
        results.push({ ...row, ok: false, detail: `timed out after ${Math.round(deadlineMs / 1000)}s`, ranAt: new Date().toISOString() });
      } else {
        results.push(result as ApiTestResult);
      }
    } catch (e: any) {
      results.push({ ...row, ok: false, detail: `threw: ${e?.message ?? String(e)}`, ranAt: new Date().toISOString() });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  const counts = {
    total:   results.length,
    passed:  results.filter((r) => r.ok && !r.skipped).length,
    failed:  results.filter((r) => !r.ok).length,
    skipped: results.filter((r) => r.skipped).length,
  };
  const byCategory: Record<string, { passed: number; failed: number; skipped: number }> = {};
  for (const r of results) {
    const k = r.category;
    if (!byCategory[k]) byCategory[k] = { passed: 0, failed: 0, skipped: 0 };
    if (r.skipped) byCategory[k].skipped++;
    else if (r.ok) byCategory[k].passed++;
    else           byCategory[k].failed++;
  }

  // Stamp which box and which build this sweep actually ran against, so the
  // Run History row can be attributed. Done here rather than in the route
  // because the token is already in hand — the route would have to log in a
  // second time. Best-effort: a missing build never affects the sweep result.
  const boxBuild = await fetchBoxBuild(apiOpts.host, token);

  return {
    startedAt, finishedAt: new Date().toISOString(),
    ok: counts.failed === 0,
    counts, results, byCategory,
    targetHost: apiOpts.host,
    buildVersion: boxBuild?.version,
  };
}

export function listAllCategories(): ApiTestCategory[] {
  return [
    'auth', 'version', 'users', 'admin-users', 'simulators', 'system', 'tools', 'testcases',
    'test-creator', 'executions', 'statistics', 'logs', 'jobs', 'negative', 'mutating', 'fuzz',
    'sample-sa', 'sample-lte', 'sample-nsa', 'sample-nbiot',
  ];
}

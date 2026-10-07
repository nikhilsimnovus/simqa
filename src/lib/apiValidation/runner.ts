// Runs the selected APIs against a Simnovator server and checks every
// exchange against openapi.yaml.
//
// Ported from runner.py. The rules it enforces are the ones the README
// describes and are kept exactly:
//   • a negative test must get the code the document gives for the reason the
//     test provokes — any other code fails, even one the API documents;
//   • a positive test passes on 2xx, or on another documented code with a
//     note, unless strict status codes are on;
//   • bodies are compared by keys, never by values;
//   • PUT/PATCH/DELETE only touch what this run created, unless the safety
//     check is off or the section has no create API;
//   • what one API creates feeds the APIs that need it, and an API whose ID
//     is unavailable is skipped saying which API would have created it.
//
// httpx becomes fetch, and Python's threads become one async run; everything
// else follows the original closely enough to compare side by side.

import { fill, type Json, type Spec, type SpecOp } from './spec.ts';
import * as testplan from './testplan.ts';
import * as negative from './negative.ts';
import type { Case } from './negative.ts';

/** A server sending application/zip where the document says octet-stream
 *  delivers the same thing, so these count as a match. */
const BINARY_TYPES = new Set([
  'application/octet-stream', 'application/zip', 'application/x-zip-compressed',
  'application/gzip', 'application/x-gzip', 'application/x-tar',
]);
const SECRET_KEYS = new Set(['password', 'current_password', 'new_password', 'access_token', 'loginPassword']);
const MAX_BODY_CHARS = 30_000;

export function mask(value: Json): Json {
  if (value instanceof Uint8Array) return `<file, ${value.length} bytes>`;
  if (Array.isArray(value)) return value.map(mask);
  if (value && typeof value === 'object') {
    const out: Json = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEYS.has(k) && typeof v === 'string'
        ? (k === 'access_token' ? `${v.slice(0, 12)}…(masked)` : '••••••')
        : mask(v);
    }
    return out;
  }
  return value;
}

export function pretty(value: Json): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const s = text ?? String(value);
  return s.length <= MAX_BODY_CHARS ? s : `${s.slice(0, MAX_BODY_CHARS)}\n… (truncated, ${s.length} chars total)`;
}

export interface RunConfig {
  host: string;
  username: string;
  password: string;
  token?: string;
  roles?: string[];
  timeout?: number;
  insecure?: boolean;
  negative?: boolean;
  safety?: boolean;
  strictStatus?: boolean;
  selected: string[];
  overrides?: Record<string, { params?: Record<string, string>; body?: Json; example?: string; file?: { name: string; content: string } }>;
  variables?: Record<string, Json>;
  suite?: boolean;
  suiteUser?: { username: string; password: string };
  suiteUeIp?: string;
  runAs?: string;
}

export interface Entry {
  n: number;
  section: string;
  opId: string;
  method: string;
  path: string;
  summary: string;
  case: string;
  kind: string;
  expect: string[];
  status: number | null;
  verdict: string | null;
  reason: string;
  note: string;
  info: string;
  issues: Array<{ label: string; detail: string }>;
  warnings: Array<{ label: string; detail: string }>;
  ms: number | null;
  request: Json;
  response: Json;
  documented: Record<string, string>;
  as: string;
}

interface Reply {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  bytes: Uint8Array;
  text: string;
  json: () => Json;       // throws when the body is not JSON
  url: string;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export class Run {
  spec: Spec;
  cfg: RunConfig;
  started = new Date();
  finished: Date | null = null;
  id: string;
  dir = '';
  status: 'running' | 'done' | 'error' = 'running';
  error: string | null = null;
  current = '';
  results: Entry[] = [];
  notes: string[] = [];
  baseUrl: string;
  vars: Record<string, Json>;
  created = new Set<string>();
  limitedUser: string | null = null;
  limitedToken: string | null = null;
  execTestcase: Json = null;
  execSimulator: Json = null;
  running: Json = null;
  runningSince = 0;
  channelSim: Json = null;
  cellsBody: Json = null;
  roles: Set<string> | null = null;
  suite: boolean;
  logins: Record<string, Json> = {};
  ops: SpecOp[];
  createSections: Set<string>;
  doneOps = 0;
  signal?: AbortSignal;

  constructor(spec: Spec, cfg: RunConfig) {
    this.spec = spec;
    this.cfg = cfg;
    // 20261007-094737-9a21, the same shape the Python tool wrote, so run
    // folders from either sort together and the id stays URL-safe.
    const iso = this.started.toISOString().replace(/[-:T]/g, '');
    const stamp = `${iso.slice(0, 8)}-${iso.slice(8, 14)}`;
    this.id = `${stamp}-${randomHex(4)}`;
    const host = String(cfg.host ?? '').trim().replace(/\/$/, '');
    this.baseUrl = (host.includes('://') ? host : `http://${host}`) + spec.basePath;
    this.vars = {
      run: randomHex(6),
      nowMs: Date.now(),
      loginUsername: cfg.username,
      loginPassword: cfg.password,
    };
    for (const [k, v] of Object.entries(cfg.variables ?? {})) {
      if (String(v ?? '').trim()) this.vars[k] = v;
    }
    this.suite = !!cfg.suite;
    this.ops = cfg.selected
      .map(id => spec.byId[id])
      .filter(Boolean)
      .sort((a, b) => testplan.compareOrder(testplan.orderKey(a, this.suite), testplan.orderKey(b, this.suite)));
    this.createSections = testplan.sectionsWithCreate(spec);
  }

  // ---------- main flow ----------

  async run(): Promise<void> {
    try {
      try {
        await this.login();
        if (this.cfg.negative && this.ops.some(o => o.adminOnly && '403' in o.responses)) {
          await this.createLimitedUser();
        }
        const flowOps = this.ops.filter(o => o.id in testplan.FLOW);
        const lastFlow = flowOps.length ? flowOps[flowOps.length - 1].id : null;
        for (const op of this.ops) {
          if (this.signal?.aborted) { this.notes.push('The run was stopped.'); break; }
          // logout ends the admin token, which the clean-up still needs.
          if (op.id === 'logoutUser') await this.removeLimitedUser();
          this.current = `${op.method.toUpperCase()} ${op.path}`;
          try {
            await this.runOp(op);
          } catch (ex: Json) {
            // A tool bug in one API must not stop the run and its clean-up deletes.
            const e = this.entry(op);
            e.verdict = 'ERROR';
            e.reason = `tool error, the run went on: ${ex?.name ?? 'Error'}: ${ex?.message ?? String(ex)}`;
            this.results.push(e);
          }
          this.doneOps += 1;
          if (op.id === lastFlow && this.running) await this.stopRunning();
        }
      } finally {
        this.current = 'clean-up';
        await this.removeLimitedUser();
      }
      this.status = 'done';
    } catch (e: Json) {
      this.status = 'error';
      this.error = `${e?.name ?? 'Error'}: ${e?.message ?? String(e)}`;
    } finally {
      this.finished = new Date();
      this.current = '';
    }
  }

  private async login(): Promise<void> {
    if (this.cfg.token) {
      this.vars.accessToken = this.cfg.token;
      this.roles = this.cfg.roles?.length ? new Set(this.cfg.roles) : null;
      return;
    }
    const op = this.spec.byId.loginUser;
    const r = await this.exec(op, this.makeCase(op, 'Setup: log in', 'setup', {
      body: { username: this.cfg.username, password: this.cfg.password },
    }));
    if (!r || r.status !== 200) {
      throw new Error(`login failed (${r ? r.status : 'no response'}) — check the IP address, username and password`);
    }
    const data = r.json();
    this.vars.accessToken = data.access_token;
    this.roles = data.roles?.length ? new Set<string>(data.roles) : null;
  }

  private async runOp(op: SpecOp): Promise<void> {
    const ov = (this.cfg.overrides ?? {})[op.id] ?? {};
    const d = testplan.defaults(this.spec, op, this.suite);
    const texts: Record<string, string> = { ...d.params };
    for (const [k, v] of Object.entries(ov.params ?? {})) {
      if (String(v ?? '').trim()) texts[k] = v;
    }
    const missing = new Set<string>();
    const path: Record<string, Json> = {};
    const query: Record<string, Json> = {};
    const warnings: Array<[string, string]> = [];
    const normalDelete = this.isNormalDelete(op);

    for (const p of op.params) {
      const text = String(texts[p.name] ?? '').trim();
      if (!text) continue;
      const need = new Set<string>();
      let value: Json;
      try {
        value = fill(this.spec.coerce(p.schema, text), this.vars, need);
      } catch (e: Json) {
        return this.skip(op, `parameter '${p.name}' = '${text}' is invalid: ${e?.message ?? e}`);
      }
      if (need.size && normalDelete) {
        // Rule 2: no ID from this run or Shared values → the document's value.
        value = this.spec.paramDefault(p);
        warnings.push(['DOCUMENT_VALUE_USED', `${p.in} parameter ${p.name} · no ${[...need].join(', ')} from this run or Shared values, so the documented value ${JSON.stringify(value)} was sent`]);
      }
      if (!normalDelete) for (const n of need) missing.add(n);
      (p.in === 'path' ? path : query)[p.name] = value;
    }

    let body: Json = null;
    let files: Json = null;
    if (op.body) {
      if (ov.body !== undefined && ov.body !== null) {
        body = ov.body;
      } else if (Object.keys(d.bodies).length) {
        const pick = ov.example || this.sameRatExample(op);
        body = (pick && d.bodies[pick]) ?? Object.values(d.bodies)[0];
      }
      if (op.id === 'importTestCases') {
        files = this.importFile(ov, missing);
        body = null;
      } else {
        const need = new Set<string>();
        let filled = fill(body, this.vars, need);
        if (need.size && normalDelete && (ov.body === undefined || ov.body === null)) {
          filled = structuredClone(Object.values(op.body.examples)[0]);
          warnings.push(['DOCUMENT_VALUE_USED', `request body · no ${[...need].sort().join(', ')} from this run or Shared values, so the documented example body was sent`]);
        } else {
          for (const n of need) missing.add(n);
        }
        body = filled;
      }
    }

    if (missing.size) {
      const hints: string[] = [];
      for (const v of [...missing].sort()) {
        if (this.suite && testplan.SUITE_NEEDS[v]) { hints.push(testplan.SUITE_NEEDS[v]); continue; }
        const producerId = testplan.producerOf(v);
        const producer = producerId ? this.spec.byId[producerId] : undefined;
        hints.push(producer
          ? `${v} (select “${producer.method.toUpperCase()} ${producer.path}” or set it under Shared values)`
          : v);
      }
      return this.skip(op, `needs ${hints.join('; ')}`);
    }

    if (this.suite && (op.id === 'createSimulator' || op.id === 'updateSimulator') && isPlainObject(body)) {
      body = { ...body, ipAddress: this.cfg.suiteUeIp };
    }
    if (this.suite && op.id === 'updateLogSetting' && isPlainObject(body)) {
      // PUT the top profile back with its own values, unchanged.
      const current = (this.vars.firstLogSetting ?? {}) as Json;
      const next: Json = {};
      for (const k of Object.keys(body)) if (k in current) next[k] = structuredClone(current[k]);
      body = next;
    }
    let cellsChanges: string[] | null = null;
    if (op.id === 'updateCellConfig' && !Object.keys(ov).length && this.cellsBody !== null) {
      // The document's update example switches channelSim on (which needs a
      // mobility configuration) and the server refuses it, so this updates
      // the cells configuration this run created instead.
      const m = this.modifiedCells();
      body = m.body;
      cellsChanges = m.changes;
    }

    // What we send vs the document: warnings, never failures, so the verdict
    // reflects the server's behaviour only.
    const typed = testplan.TYPED_SECTIONS.has(op.section);
    if ((isPlainObject(body) || Array.isArray(body)) && op.body?.contentType.includes('json')) {
      for (const [label, msg] of this.spec.shapeErrors(op.body.schema, body, typed)) {
        warnings.push([label, `request body · ${msg}`]);
      }
    }
    if (typed) {
      for (const p of op.params) {
        const v = path[p.name] ?? query[p.name];
        if (v === undefined || v === null) continue;
        for (const [label, msg] of this.spec.shapeErrors(p.schema, v, true)) {
          warnings.push([label, `${p.in} parameter ${p.name} · ${msg}`]);
        }
      }
    }

    let name = (ov.params && Object.keys(ov.params).length) || (ov.body !== undefined && ov.body !== null)
      ? 'Positive — custom input'
      : 'Positive — documented defaults';
    if (cellsChanges !== null) {
      name = `Positive — the cells created in this run, changed: ${cellsChanges.join(', ') || 'nothing'}`;
    }
    const pos = this.makeCase(op, name, 'positive', { path, query, body, files });
    let negatives = this.cfg.negative
      ? negative.cases(this.spec, op, pos, !!this.limitedToken, testplan.TYPED_SECTIONS.has(op.section))
      : [];

    if (testplan.USER_ONLY.has(op.id) && this.roleOf(op) === 'admin' && (await this.rolesOf()).has('admin')) {
      return this.skip(op, `user-only API (a user changes their own password); the run is logged in as '${this.cfg.username}', an admin, so it is not performed.`);
    }
    if (testplan.MOBILITY_OPS.has(op.id) && !Object.keys(ov).length && this.channelSim === false) {
      return this.skip(op, 'the cells configuration this run created has channelSim false, so mobility is not configured. Choose a cells body with "channelSim": true (Inputs of POST /tests/cells) to test mobility.');
    }

    // Creates run the real request first so the ID is captured before an
    // invalid variant the server wrongly accepts can take the same name.
    const creates = (testplan.CREATORS.has(op.id) && !testplan.NEGATIVES_FIRST.has(op.id))
      || testplan.POSITIVE_FIRST.has(op.id);

    if (op.id === 'restartTestExecution' && this.running) await this.pauseBeforeRestart();
    if (op.id === 'startTestExecution') {
      this.execTestcase = path.testCaseId;
      this.execSimulator = isPlainObject(body) ? body.simulatorId : null;
    }
    if (this.suite && op.id === 'updateLogSetting') {
      // Never send a different body to a profile we did not create.
      negatives = negatives.filter(c => JSON.stringify(c.path) !== JSON.stringify(pos.path)
        || (JSON.stringify(c.body) === JSON.stringify(pos.body) && c.rawBody === undefined));
    }

    if (!creates) for (const c of negatives) await this.execNegative(op, c);
    const r = await this.exec(op, pos, warnings);
    if (r && r.status >= 200 && r.status < 300) {
      this.capture(op, pos, r);
      if (op.id === 'createCellConfig' && isPlainObject(pos.body)) {
        this.channelSim = ((pos.body.cellConfig ?? {}).master ?? {}).channelSim;
        this.cellsBody = structuredClone(pos.body);
      }
      if (op.id === 'startTestExecution' || op.id === 'restartTestExecution') {
        this.running = this.vars.executionId;
        this.runningSince = Date.now();
        if (this.suite && op.id === 'startTestExecution' && this.running) await this.resolveExecSimulator();
      } else if (op.id === 'stopTestExecution') {
        this.running = null;
      }
      if (this.cfg.negative && op.method === 'post' && '409' in op.responses && !testplan.NO_DUPLICATE_CHECK.has(op.id)) {
        await this.execNegative(op, negative.duplicate(pos));
      }
    }
    if (creates) for (const c of negatives) await this.execNegative(op, c);
  }

  /** A negative test; if the server wrongly accepts a create, remove what it made. */
  private async execNegative(op: SpecOp, c: Case): Promise<void> {
    const r = await this.exec(op, c);
    if (!r || !(r.status >= 200 && r.status < 300) || !testplan.CREATORS.has(op.id)) return;
    const label = `${op.method.toUpperCase()} ${op.path}`;
    const remover = this.spec.byId[testplan.CLEANUP_FOR[op.id]];
    if (!remover) {
      this.notes.push(`${label}: “${c.name}” was accepted and may have created something this tool cannot remove automatically; please check the server.`);
      return;
    }
    let data: Json = null;
    try { data = r.json(); } catch { data = null; }
    const removerDefaults = testplan.defaults(this.spec, remover).params;
    for (const [v, fn] of Object.entries(testplan.CAPTURES[op.id] ?? {})) {
      if (!testplan.RESOURCE_VARS.has(v)) continue;
      let value: Json = null;
      try { value = fn(c.body, data, this.vars); } catch { value = null; }
      if (value === null || value === undefined) {
        this.notes.push(`${label}: “${c.name}” was accepted, but the response does not say what was created, so it could not be deleted; please check the server.`);
      } else if (value !== this.vars[v]) {
        this.created.add(String(value));
        const p: Record<string, Json> = {};
        const q: Record<string, Json> = {};
        for (const param of remover.params) {
          if (removerDefaults[param.name] === `{{${v}}}`) (param.in === 'path' ? p : q)[param.name] = value;
        }
        await this.exec(remover, this.makeCase(remover,
          `Clean-up: remove ${v} ${value} created by the accepted “${c.name}”`, 'setup', { path: p, query: q }));
      }
    }
  }

  // ---------- execution flow ----------

  private async getJson(path: string): Promise<Json> {
    try {
      const r = await this.send('get', path, {}, { Authorization: `Bearer ${this.vars.accessToken}` }, undefined, 15);
      if (r.status !== 200) return null;
      return r.json();
    } catch {
      return null;
    }
  }

  /** The simulator the started execution runs on — the start answer does not say. */
  private async resolveExecSimulator(): Promise<void> {
    const tcRaw = this.execTestcase ? await this.getJson(`/testcases/${encodeURIComponent(String(this.execTestcase))}`) : null;
    const tc = isPlainObject(tcRaw) ? tcRaw : {};
    const sim = ((tc.metadata ?? {}).lastExecution ?? {}).simulatorId ?? this.execSimulator;
    if (sim !== null && sim !== undefined) this.vars.execSimulatorId = sim;
    else this.notes.push('Full API suite: could not tell which simulator the execution runs on, so PUT /simulators/{simulatorId}/log-settings was skipped.');
  }

  /** Poll until the executed test case is idle and its simulator AVAILABLE. */
  private async waitReady(before: string): Promise<void> {
    const started = Date.now();
    let ready = false;
    let waited = 0;
    let state = '';
    let availability = '';
    let sim: Json = null;
    for (;;) {
      const tcRaw = this.execTestcase ? await this.getJson(`/testcases/${encodeURIComponent(String(this.execTestcase))}`) : null;
      const tc = isPlainObject(tcRaw) ? tcRaw : {};
      const last = (tc.metadata ?? {}).lastExecution ?? {};
      state = String(tc.status ?? last.status ?? '');
      sim = last.simulatorId ?? this.execSimulator ?? this.vars.simulatorId;
      const simStatus = sim ? await this.getJson(`/simulators/${encodeURIComponent(String(sim))}/status`) : null;
      availability = isPlainObject(simStatus) ? String(simStatus.availability ?? '') : '';
      ready = !testplan.BUSY_STATES.has(state.toUpperCase().replace(/ /g, '_'))
        && (availability === '' || availability.toUpperCase() === 'AVAILABLE');
      waited = (Date.now() - started) / 1000;
      if (ready || waited >= testplan.READY_TIMEOUT || this.signal?.aborted) break;
      this.current = `waiting for the simulator before ${before} (${Math.round(waited)} s)`;
      await sleep(testplan.READY_POLL * 1000);
    }
    if (waited >= 1 || !ready) {
      const e = this.entry(this.spec.byId.restartTestExecution, { name: `Wait before ${before}`, kind: 'setup', expect: [] } as Json);
      e.section = 'test-executions';
      e.method = 'WAIT';
      e.path = 'test case / simulator status';
      e.verdict = ready ? 'PASS' : 'FAIL';
      e.ms = Math.round(waited * 1000);
      e.reason = `${ready ? 'Ready' : 'Still busy'} after ${Math.round(waited)} s: test case ${this.execTestcase ?? '(unknown)'} status ${state || 'not reported'}, simulator ${sim ?? '(unknown)'} availability ${availability || 'not reported'}.`;
      this.results.push(e);
    }
  }

  /** The created cells body with valid changes: iteration count and the PDCCH
   *  decode option, keeping channelSim as it was. */
  private modifiedCells(): { body: Json; changes: string[] } {
    const body = structuredClone(this.cellsBody);
    const master = (body?.cellConfig ?? {}).master;
    const changes: string[] = [];
    if (!isPlainObject(master)) return { body, changes };
    for (const key of ['ldpcIteration', 'turboIteration']) {
      if (typeof master[key] === 'number' && Number.isInteger(master[key])) {
        const next = master[key] !== 12 ? 12 : 8;
        changes.push(`${key} ${master[key]}→${next}`);
        master[key] = next;
      }
    }
    if (typeof master.pdcchDecodeOpt === 'boolean') {
      const next = !master.pdcchDecodeOpt;
      changes.push(`pdcchDecodeOpt ${String(master.pdcchDecodeOpt)}→${String(next)}`);
      master.pdcchDecodeOpt = next;
      if (next && !('pdcchDecodeOptThreshold' in master)) {
        master.pdcchDecodeOptThreshold = 0.1;
        changes.push('pdcchDecodeOptThreshold 0.1');
      }
    }
    return { body, changes };
  }

  // ---------- suite: logins per role ----------

  private roleOf(op: SpecOp): string {
    return this.suite ? testplan.suiteRole(op) : 'admin';
  }

  private async tokenFor(role: string): Promise<Json> {
    if (role === 'user') return this.suiteUserToken();
    if (role === 'temp') return this.tempUserToken();
    return null;
  }

  private async loginAs(label: string, name: Json, pw: Json): Promise<Reply | null> {
    const login = this.spec.byId.loginUser;
    return this.exec(login, this.makeCase(login, `Suite: log in as ${label} ${name}`, 'setup', {
      expect: ['200', '403'], body: { username: name, password: pw },
    }));
  }

  private async suiteUserToken(): Promise<Json> {
    if (!('user' in this.logins)) {
      const creds = this.cfg.suiteUser ?? { username: '', password: '' };
      const r = await this.loginAs('the suite user', creds.username, creds.password);
      const ok = !!r && r.status === 200;
      this.logins.user = ok ? r!.json().access_token : null;
      this.logins.user_roles = ok ? new Set<string>(r!.json().roles ?? []) : new Set<string>();
      if (this.logins.user === null) {
        this.notes.push(`Full API suite: could not log in as ${creds.username}, so the “as user” sections ran as the admin.`);
      }
    }
    return this.logins.user;
  }

  private async tempUserToken(): Promise<Json> {
    if (!('temp' in this.logins)) {
      this.logins.temp = null;
      const name = this.vars.username;
      const pw = this.vars.userPassword;
      if (!name || !pw) {
        this.notes.push('Full API suite: the temporary user was not created, so update-password ran as admin.');
        return null;
      }
      let r = await this.loginAs('the temporary user', name, pw);
      if (r && r.status === 403) {
        // The first login after a create or reset demands a new password.
        const upd = this.spec.byId.updateUserPassword;
        const next = `Sat@${this.vars.run}Su1`;
        const done = await this.exec(upd, this.makeCase(upd, `Suite: set a new password for ${name} (first login)`, 'setup', {
          body: { username: name, current_password: pw, new_password: next },
        }));
        if (done && done.status >= 200 && done.status < 300) {
          this.vars.userPassword = next;
          r = await this.loginAs('the temporary user', name, next);
        }
      }
      if (r && r.status === 200) this.logins.temp = r.json().access_token;
    }
    return this.logins.temp;
  }

  /** Suite rule: bulk delete only on test cases this run created. */
  private suiteTestcaseRule(op: SpecOp, body: Json): string | undefined {
    if (op.id !== 'deleteTestCases') return undefined;
    const b = isPlainObject(body) ? body : {};
    const ids = b.testCaseIds ?? [];
    if (!['single', 'multiple'].includes(b.scope) || !ids.length) {
      return 'suite: bulk delete runs only with scope single/multiple on test cases this run created';
    }
    return undefined;
  }

  private async rolesOf(): Promise<Set<string>> {
    if (this.roles === null) {
      const me = await this.getJson('/users/me');
      this.roles = new Set<string>(isPlainObject(me) ? me.roles ?? [] : []);
    }
    return this.roles;
  }

  /** Keep one RAT across the test case. */
  private sameRatExample(op: SpecOp): string | undefined {
    if (!testplan.FOLLOWS_CELLS.has(op.id)) return undefined;
    const cells = (this.cfg.overrides ?? {}).createCellConfig?.example
      || testplan.PREFERRED_EXAMPLE.createCellConfig;
    return op.id === 'updateCellConfig' ? cells : testplan.SUBSCRIBERS_FOR_CELLS[cells];
  }

  private async pauseBeforeRestart(): Promise<void> {
    const pause = Math.max(0, testplan.RESTART_DELAY - (Date.now() - this.runningSince) / 1000);
    this.current = `letting execution ${this.running} run ${Math.round(pause)} s before restart`;
    await sleep(pause * 1000);
    const e = this.entry(this.spec.byId.restartTestExecution, {
      name: 'Wait before POST /testcases/executions/{executionId}/restart', kind: 'setup', expect: [],
    } as Json);
    e.method = 'WAIT';
    e.path = 'running execution';
    e.verdict = 'PASS';
    e.ms = Math.round(pause * 1000);
    e.reason = `Let execution ${this.running} run ${testplan.RESTART_DELAY} s after start, then restart it while it is still running.`;
    this.results.push(e);
  }

  private async stopRunning(): Promise<void> {
    const op = this.spec.byId.stopTestExecution;
    const r = await this.exec(op, this.makeCase(op, `Clean-up: stop execution ${this.running} this run left running`, 'setup', {
      path: { executionId: this.running },
    }));
    if (r && r.status >= 200 && r.status < 300) this.running = null;
    else this.notes.push(`Execution ${this.running} may still be running on the simulator; please stop it.`);
  }

  /** Runs on whatever ID is given and is never skipped for a missing or
   *  foreign ID: every API with the safety check off, otherwise a DELETE in a
   *  section without a create API. */
  private isNormalDelete(op: SpecOp): boolean {
    if (this.suite && (op.section === 'test-cases' || testplan.SUITE_OWN_ONLY.has(op.id))) return false;
    if (this.cfg.safety === false) return true;
    return op.method === 'delete' && !this.createSections.has(op.section) && !testplan.PROTECTED.has(op.id);
  }

  private importFile(ov: Json, missing: Set<string>): Json {
    if (ov.file) return { file: [ov.file.name, Buffer.from(ov.file.content, 'utf8')] };
    if (!('exportFile' in this.vars)) {
      missing.add('exportFile');
      return null;
    }
    return { file: [`sat_export_${this.vars.run}.json`, this.vars.exportFile] };
  }

  private capture(op: SpecOp, c: Case, r: Reply): void {
    const caps = testplan.CAPTURES[op.id];
    if (!caps) return;
    let data: Json;
    try {
      data = (r.headers['content-type'] ?? '').includes('json') ? r.json() : r.bytes;
    } catch {
      data = r.bytes;
    }
    for (const [v, fn] of Object.entries(caps)) {
      let value: Json;
      try {
        value = fn(c.body, data, this.vars);
      } catch {
        this.notes.push(`${op.method.toUpperCase()} ${op.path}: could not read '${v}' from the response, so APIs that need it will be skipped.`);
        continue;
      }
      if (value === null || value === undefined) continue;
      this.vars[v] = value;
      if (testplan.RESOURCE_VARS.has(v)) this.created.add(String(value));
    }
  }

  // ---------- non-admin user for 403 checks ----------

  private async createLimitedUser(): Promise<void> {
    if (this.suite) {
      // The suite's own non-admin login does the 403 checks: no extra user,
      // because licences cap how many exist.
      const token = await this.suiteUserToken();
      if (token && !(this.logins.user_roles as Set<string>)?.has('admin')) {
        this.limitedToken = token;
        return;
      }
    }
    const run = this.vars.run;
    const name = `sat_ro_${run}`;
    const pw = `Sat@${run}Ro1`;
    const create = this.spec.byId.createUser;
    const login = this.spec.byId.loginUser;
    let r = await this.exec(create, this.makeCase(create, 'Setup: create non-admin user for 403 checks', 'setup', {
      body: { username: name, password: pw, first_name: 'SAT', last_name: 'ReadOnly', role: 'user' },
    }));
    if (!r || r.status >= 300) {
      this.notes.push('403 checks skipped: could not create a non-admin user.');
      return;
    }
    this.limitedUser = name;
    this.created.add(name);
    r = await this.exec(login, this.makeCase(login, 'Setup: log in as non-admin user', 'setup', {
      expect: ['200', '403'], body: { username: name, password: pw },
    }));
    if (r && r.status === 403) {
      const upd = this.spec.byId.updateUserPassword;
      await this.exec(upd, this.makeCase(upd, 'Setup: set non-admin password', 'setup', {
        body: { username: name, current_password: pw, new_password: `${pw}x` },
      }));
      r = await this.exec(login, this.makeCase(login, 'Setup: log in as non-admin user', 'setup', {
        body: { username: name, password: `${pw}x` },
      }));
    }
    if (r && r.status === 200) this.limitedToken = r.json().access_token;
    else this.notes.push('403 checks skipped: the non-admin user could not log in.');
  }

  private async removeLimitedUser(): Promise<void> {
    if (!this.limitedUser) return;
    const op = this.spec.byId.deleteUser;
    await this.exec(op, this.makeCase(op, 'Setup: delete non-admin user', 'setup', { path: { username: this.limitedUser } }));
    this.limitedUser = null;
  }

  // ---------- one HTTP exchange ----------

  /** Public so the self-check can build the same cases the runner does. */
  makeCase(op: SpecOp, name: string, kind: string, over: Partial<Case> = {}): Case {
    const twos = Object.keys(op.responses).filter(c => c.startsWith('2'));
    return {
      name,
      kind: kind as Case['kind'],
      auth: undefined,
      expect: over.expect ?? (twos.length ? twos : ['200']),
      path: over.path ?? {},
      query: over.query ?? {},
      body: over.body ?? null,
      rawBody: over.rawBody,
      files: over.files ?? null,
    } as Case;
  }

  private entry(op: SpecOp, c?: Json): Entry {
    const documented: Record<string, string> = {};
    for (const [code, r] of Object.entries(op.responses)) documented[code] = r.description;
    return {
      n: this.results.length + 1,
      section: op.section,
      opId: op.id,
      method: op.method.toUpperCase(),
      path: op.path,
      summary: op.summary,
      case: c ? c.name : 'Positive',
      kind: c ? c.kind : 'positive',
      expect: c ? c.expect ?? [] : [],
      status: null,
      verdict: null,
      reason: '',
      note: '',
      info: '',
      issues: [],
      warnings: [],
      ms: null,
      request: null,
      response: null,
      documented,
      as: '',
    };
  }

  private skip(op: SpecOp, reason: string, c?: Json): void {
    const e = this.entry(op, c);
    e.verdict = 'SKIP';
    e.reason = reason;
    this.results.push(e);
  }

  private async exec(op: SpecOp, c: Case, warnings: Array<[string, string]> = []): Promise<Reply | null> {
    const trusted = this.suite && testplan.SUITE_TRUSTED.has(op.id);
    const allowed = new Set([...this.created, ...negative.SENTINELS]);
    let reason = testplan.guard(op, c.path, c.query, c.body, allowed, !(this.isNormalDelete(op) || trusted));
    if (!reason && this.suite && c.kind !== 'setup') reason = this.suiteTestcaseRule(op, c.body);
    if (!reason && testplan.WAIT_READY.has(op.id)) {
      await this.waitReady(`${op.method.toUpperCase()} ${op.path} (${c.name})`);
    }
    if (reason) {
      this.skip(op, reason, c);
      return null;
    }

    let role = c.kind !== 'setup' ? this.roleOf(op) : 'admin';
    const roleToken = await this.tokenFor(role);   // may log in first, before this entry is numbered
    if (roleToken === null || roleToken === undefined) role = 'admin';

    const e = this.entry(op, c);
    let url = op.path;
    for (const [k, v] of Object.entries(c.path)) {
      url = url.replace(`{${k}}`, encodeURIComponent(String(v)));
    }
    const headers: Record<string, string> = { Accept: 'application/json, */*' };
    if (this.suite) {
      e.as = role === 'user' ? (this.cfg.suiteUser?.username ?? 'user')
        : role === 'temp' ? `temporary user ${this.vars.username}`
        : 'admin';
    }
    const token = c.auth === 'limited' ? this.limitedToken
      : c.auth === 'bad' ? 'sat.invalid.token'
      : c.auth === 'none' ? null
      : (roleToken ?? this.vars.accessToken);
    if (op.secured && token) headers.Authorization = `Bearer ${token}`;

    const timeout = testplan.SLOW_OPS.has(op.id)
      ? Math.max(Number(this.cfg.timeout || 30), testplan.SLOW_TIMEOUT)
      : Number(this.cfg.timeout || 30);

    const reqView: Json = {
      method: op.method.toUpperCase(),
      url: this.baseUrl + url,
      headers: maskHeaders(headers),
      body: requestBodyView(c),
    };
    const startedAt = Date.now();
    let r: Reply;
    try {
      r = await this.send(op.method, url, c.query, headers, c, timeout);
    } catch (ex: Json) {
      e.verdict = 'ERROR';
      e.reason = `${ex?.name ?? 'Error'}: ${ex?.message ?? String(ex)}`;
      e.request = reqView;
      this.results.push(e);
      return null;
    }
    reqView.url = r.url;
    reqView.curl = curlOf(reqView, c);
    const { issues, note, info } = this.check(op, c, r);
    e.status = r.status;
    e.ms = Date.now() - startedAt;
    e.note = note;
    e.info = info;
    e.verdict = issues.length ? 'FAIL' : 'PASS';
    e.issues = issues.map(([label, detail]) => ({ label, detail }));
    e.warnings = warnings.map(([label, detail]) => ({ label, detail }));
    e.request = reqView;
    e.response = responseView(r);
    this.results.push(e);
    return r;
  }

  /** The HTTP call itself. */
  private async send(
    method: string,
    path: string,
    query: Record<string, Json>,
    headers: Record<string, string>,
    c: Case | undefined,
    timeoutSec: number,
  ): Promise<Reply> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined || v === null || v === '') continue;
      url.searchParams.set(k, String(v));
    }
    const init: RequestInit = { method: method.toUpperCase(), headers: { ...headers } };
    if (c?.files) {
      const form = new FormData();
      for (const [field, pair] of Object.entries<Json>(c.files)) {
        const [filename, content] = pair;
        const bytes = content instanceof Uint8Array ? content : Buffer.from(String(content), 'utf8');
        const copy = new Uint8Array(bytes.byteLength);
        copy.set(bytes);
        form.append(field, new Blob([copy.buffer]), filename);
      }
      init.body = form;   // fetch sets the multipart boundary itself
    } else if (c?.rawBody !== undefined && c?.rawBody !== null) {
      init.body = c.rawBody;
      (init.headers as Json)['Content-Type'] = 'application/json';
    } else if (c?.body !== undefined && c?.body !== null) {
      init.body = JSON.stringify(c.body);
      (init.headers as Json)['Content-Type'] = 'application/json';
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), Math.max(1, timeoutSec) * 1000);
    if (this.signal) this.signal.addEventListener('abort', () => ac.abort(), { once: true });
    try {
      const res = await fetch(url, { ...init, signal: ac.signal });
      const buf = new Uint8Array(await res.arrayBuffer());
      const text = new TextDecoder().decode(buf);
      const headerMap: Record<string, string> = {};
      res.headers.forEach((v, k) => { headerMap[k.toLowerCase()] = v; });
      return {
        status: res.status,
        statusText: res.statusText,
        headers: headerMap,
        bytes: buf,
        text,
        url: url.toString(),
        json: () => JSON.parse(text),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Every way the response can disagree with the document. Public so the
   *  self-check can put a known reply in front of it. */
  check(op: SpecOp, c: Case, r: Reply): { issues: Array<[string, string]>; note: string; info: string } {
    const issues: Array<[string, string]> = [];
    let note = '';
    let info = '';
    const code = String(r.status);
    const docs = op.responses;
    const doc = docs[code] ?? docs[`${code[0]}XX`] ?? docs.default;
    if (!doc) {
      issues.push(['UNDOCUMENTED_STATUS', `${code} is not documented for this API (documented: ${Object.keys(docs).join(', ')})`]);
      return { issues, note, info };
    }
    if (!(c.expect ?? []).includes(code)) {
      const got = `${code} (${doc.description || 'no description'})`;
      const want = (c.expect ?? []).map(x => (docs[x] ? `${x} (${docs[x].description})` : x)).join(' or ');
      if (c.kind === 'negative') {
        const why = code.startsWith('2')
          ? 'the server accepted input the test made invalid'
          : 'a documented code, but not the one the document gives for this reason';
        issues.push(['WRONG_STATUS', `“${c.name}” should return ${want}; got ${got}: ${why}`]);
      } else if (this.cfg.strictStatus) {
        issues.push(['WRONG_STATUS', `expected ${want}; got ${got} (strict status codes are on)`]);
      } else {
        note = `Documented ${code} response: ${doc.description || 'error'}`;
      }
    }
    const ctype = (r.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    const content = doc.content ?? {};
    const documentedTypes = Object.keys(content);
    if (documentedTypes.length && !r.bytes.length) {
      issues.push(['CONTENT_TYPE_MISMATCH', `documented a ${documentedTypes.join('/')} body, but the response is empty`]);
    } else if (documentedTypes.length && !(ctype in content)
      && !(BINARY_TYPES.has(ctype) && documentedTypes.some(t => BINARY_TYPES.has(t)))) {
      issues.push(['CONTENT_TYPE_MISMATCH', `got '${ctype || 'none'}', documented ${documentedTypes.join(', ')}`]);
    } else if (!documentedTypes.length && r.bytes.length) {
      issues.push(['CONTENT_TYPE_MISMATCH', `no body is documented, but got ${r.bytes.length} bytes (${ctype})`]);
    }
    const schema = content[ctype];
    if (schema && ctype.includes('json') && r.bytes.length) {
      let data: Json;
      try {
        data = r.json();
      } catch {
        issues.push(['INVALID_JSON', 'the response body is not valid JSON']);
        return { issues, note, info };
      }
      const typed = testplan.TYPED_SECTIONS.has(op.section);
      if (testplan.TESTCASE_LISTS.has(op.id) && isPlainObject(data) && Array.isArray(data.items)) {
        const res = this.checkTestcaseList(schema, data, typed);
        issues.push(...res.issues);
        info = res.info;
      } else {
        const res = this.compareBody(schema, data, typed);
        issues.push(...res.issues);
        info = res.info;
      }
    }
    return { issues, note, info };
  }

  /** Key comparison, tolerating a {code, message, data:{…}} envelope the
   *  document does not describe. */
  private compareBody(schema: Json, data: Json, typed: boolean): { issues: Array<[string, string]>; info: string } {
    const found = this.spec.shapeErrors(schema, data, typed);
    const inner = isPlainObject(data) ? data.data : null;
    const documented = this.spec.mergedSchema(schema);
    const keys = new Set(Object.keys(documented.properties ?? {}));
    if (!found.length || !(isPlainObject(inner) || Array.isArray(inner)) || keys.has('data')) {
      return { issues: found, info: '' };
    }
    const shared = (v: Json) => (isPlainObject(v) ? Object.keys(v).filter(k => keys.has(k)).length : 0);
    if (!(shared(inner) > shared(data) || (Array.isArray(inner) && documented.type === 'array'))) {
      return { issues: found, info: '' };
    }
    const inside = this.spec.shapeErrors(schema, inner, typed);
    const rebased = inside.map(([label, msg]) =>
      [label, msg.startsWith('(root)') ? `data${msg.slice('(root)'.length)}` : `data/${msg}`] as [string, string]);
    const wrapper = Object.keys(data).filter(k => k !== 'data').join(', ');
    return {
      issues: rebased,
      info: `The response wraps the documented body in an envelope (${wrapper}, data) that the document does not show; the documented keys were compared with the content of 'data'.`,
    };
  }

  /** GET /testcases lists hundreds of test cases: the list itself, the first
   *  executed one (compared both ways) and the first not-executed one. */
  private checkTestcaseList(schema: Json, data: Json, typed: boolean): { issues: Array<[string, string]>; info: string } {
    const issues: Array<[string, string]> = this.spec.shapeErrors(schema, { ...data, items: [] }, typed);
    const merged = (sch: Json) => this.spec.mergedSchema(sch);
    const itemSchema = merged(merged(schema).properties?.items ?? {}).items ?? {};

    const executionId = (t: Json) => {
      const meta = isPlainObject(t) ? t.metadata : null;
      return isPlainObject(meta) ? (meta.lastExecution ?? {}).executionId : undefined;
    };
    let executed = data.items.find((t: Json) => executionId(t));
    if (this.suite) executed = testplan.completedPass(data.items)[0];
    const fresh = data.items.find((t: Json) => isPlainObject(t) && !executionId(t));
    const info: string[] = [];
    if (executed) {
      const tag = `${this.suite ? 'Completed + PASS' : 'executed'} test case “${executed.name}” (${executed.id})`;
      for (const [label, msg] of this.spec.shapeErrors(itemSchema, executed, typed, true)) {
        issues.push([label, `${tag} · ${msg}`]);
      }
      const history = (executed.metadata ?? {}).executionHistory ?? [];
      const iterations = history.filter(isPlainObject).map((h: Json) => h.iterationId);
      if (!iterations.includes(executionId(executed))) {
        issues.push(['INCONSISTENT_DATA', `${tag} · lastExecution.executionId ${executionId(executed)} is not one of the ${iterations.length} iterationIds in executionHistory`]);
      }
      info.push(`Checked the ${tag}: executionId ${executionId(executed)} with ${iterations.length} iteration(s) in executionHistory; keys compared both ways (missing in the document / missing in the response).`);
    } else if (this.suite) {
      info.push('No test case in the response has an execution with status “Completed” and execution_result “PASS”, so the execution fields were not checked and the APIs that use it are skipped.');
    } else {
      info.push('No executed test case in the response, so the execution fields (lastExecution, executionHistory) could not be checked.');
    }
    if (fresh) {
      const tag = `not-executed test case “${fresh.name}” (${fresh.id})`;
      for (const [label, msg] of this.spec.shapeErrors(itemSchema, fresh, typed)) {
        issues.push([label, `${tag} · ${msg}`]);
      }
      info.push(`Checked the ${tag}: no execution fields are expected.`);
    } else {
      info.push('Every test case in the response has been executed; no not-executed test case to check.');
    }
    const checked = (executed ? 1 : 0) + (fresh ? 1 : 0);
    info.push(`The other ${data.items.length - checked} test case(s) in this page were not checked one by one.`);
    return { issues, info: info.join(' ') };
  }

  /** Live progress for the page. */
  progress(since = 0): Json {
    return {
      id: this.id,
      status: this.status,
      error: this.error,
      current: this.current,
      done: this.doneOps,
      total: this.ops.length,
      results: this.results.slice(since).map(e => ({
        n: e.n, section: e.section, method: e.method, path: e.path, case: e.case, kind: e.kind,
        expect: e.expect, status: e.status, verdict: e.verdict, reason: e.reason, note: e.note,
        ms: e.ms, as: e.as, issues: e.issues.length, warnings: e.warnings.length,
      })),
      report: this.finished ? `/api/api-validation/runs/${this.id}/report` : null,
    };
  }
}

// ---------------------------------------------------------------- helpers --

function isPlainObject(v: Json): boolean {
  return !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Uint8Array);
}

function randomHex(n: number): string {
  let s = '';
  while (s.length < n) s += Math.random().toString(16).slice(2);
  return s.slice(0, n);
}

function maskHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = k === 'Authorization' ? `${v.slice(0, 19)}…(masked)` : v;
  }
  return out;
}

function requestBodyView(c: Case): Json {
  if (c.files) {
    return Object.values<Json>(c.files)
      .map(([name, content]) => `<multipart file “${name}”, ${content?.length ?? 0} bytes>`)
      .join('\n');
  }
  if (c.rawBody !== undefined && c.rawBody !== null) return c.rawBody;
  return c.body === null || c.body === undefined ? null : pretty(mask(c.body));
}

function shellQuote(s: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'"'"'`)}'`;
}

function curlOf(view: Json, c: Case): string {
  const parts = ['curl', '-X', view.method, shellQuote(view.url)];
  for (const [k, v] of Object.entries<string>(view.headers)) parts.push('-H', shellQuote(`${k}: ${v}`));
  if (c.files) {
    parts.push('-F', shellQuote('file=@<file>'));
  } else if ((c.rawBody !== undefined && c.rawBody !== null) || (c.body !== null && c.body !== undefined)) {
    if (!('Content-Type' in view.headers)) parts.push('-H', shellQuote('Content-Type: application/json'));
    const raw = c.rawBody ?? JSON.stringify(mask(c.body));
    parts.push('-d', shellQuote(raw));
  }
  return parts.join(' ');
}

function responseView(r: Reply): Json {
  const ctype = r.headers['content-type'] ?? '';
  let body: string;
  if (!r.bytes.length) {
    body = '';
  } else if (ctype.includes('json')) {
    try {
      body = pretty(mask(r.json()));
    } catch {
      body = pretty(r.text);
    }
  } else if (ctype.startsWith('text/') || ctype.includes('xml')) {
    body = pretty(r.text);
  } else {
    body = `<binary content, ${r.bytes.length} bytes, ${ctype || 'unknown type'}>`;
  }
  return { status: r.status, reason: r.statusText, headers: r.headers, body };
}

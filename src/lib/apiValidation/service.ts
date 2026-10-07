// What the page talks to: the catalogue of APIs with their defaults, input
// checking, and the registry of runs in flight.
//
// Ported from app.py's handlers. The Flask app kept runs in a module-level
// dict and ran each in a thread; here they are kept the same way and run as a
// promise, which is the Node equivalent — a run outlives the request that
// started it, and the page polls it.

import { placeholders, type Json, type Spec, type SpecOp } from './spec.ts';
import * as testplan from './testplan.ts';
import { Run, type RunConfig } from './runner.ts';
import { write as writeReport } from './report.ts';
import { activeSpec, ensureDirs } from './store.ts';

export const TOOL_NAME = 'API Validation';
export const RUN_AS = /^[\p{L}][\p{L} .'-]{1,59}$/u;

// Runs in flight, shared across module copies.
//
// Next can hand each route handler its own instance of a module, so a plain
// module-level Map left /run and /runs/<id> looking at different registries:
// the run started, and the page polling it was told "unknown run". Hanging it
// off globalThis is the standard way to keep exactly one of something in this
// runtime, in development and in the built server alike.
const RUNS: Map<string, Run> = ((globalThis as any).__simqaApiValidationRuns ??= new Map<string, Run>());
/** Runs are kept for the page to poll; old ones are dropped so a long-lived
 *  server does not hold every run it has ever done in memory. */
const MAX_RUNS_IN_MEMORY = 20;

export function getRun(id: string): Run | undefined {
  return RUNS.get(id);
}

export function runInProgress(): boolean {
  return [...RUNS.values()].some(r => r.status === 'running');
}

/** Top-level body fields the tool sets differently from the document. */
function changedFields(op: SpecOp): Json[] {
  const first = Object.values(op.body?.examples ?? {})[0];
  const doc = first && typeof first === 'object' && !Array.isArray(first) ? first : {};
  const out: Json[] = [];
  for (const [k, v] of Object.entries(testplan.BODY_DEFAULTS[op.id] ?? {})) {
    if (JSON.stringify(doc[k]) !== JSON.stringify(v) && (k in doc || v !== null)) {
      out.push({ key: k, document: doc[k], tool: v });
    }
  }
  return out;
}

/** The whole catalogue the page renders: sections, APIs, their defaults and
 *  what each one needs or produces. */
export function specView(spec: Spec = activeSpec()): Json {
  const withCreate = testplan.sectionsWithCreate(spec);
  const sections = spec.sections.map(name => {
    const ops = spec.ops.filter(o => o.section === name).map(op => {
      const d = testplan.defaults(spec, op);
      const normalDelete = op.method === 'delete' && !withCreate.has(op.section) && !testplan.PROTECTED.has(op.id);
      return {
        id: op.id,
        method: op.method.toUpperCase(),
        path: op.path,
        summary: op.summary,
        description: op.description,
        admin_only: op.adminOnly,
        secured: op.secured,
        params: op.params.map(p => ({
          name: p.name, in: p.in, required: p.required, description: p.description,
          type: p.schema?.type ?? 'string', format: p.schema?.format, enum: p.schema?.enum,
          minimum: p.schema?.minimum, maximum: p.schema?.maximum,
          doc_default: p.schema?.default ?? p.example,
          default: d.params[p.name],
        })),
        body: op.body
          ? { content_type: op.body.contentType, required: op.body.required, examples: d.bodies, changed: changedFields(op) }
          : null,
        responses: Object.fromEntries(Object.entries(op.responses).map(([c, r]) => [c, r.description])),
        // Rule-2 deletes never wait for an ID: they fall back to the document's value.
        needs: normalDelete
          ? []
          : [...placeholders([d.params, d.bodies])].filter(v => !testplan.BUILTIN_VARS.has(v)).sort(),
        normal_delete: normalDelete,
        produces: Object.keys(testplan.CAPTURES[op.id] ?? {}),
        follows_cells: testplan.FOLLOWS_CELLS.has(op.id),
        spec_issue: op.id in spec.exampleIssues,
        destructive: op.method === 'delete',
      };
    });
    return { name, ops };
  });
  const shared = testplan.SHARED_VARS.map(v => {
    const producerId = testplan.producerOf(v);
    const producer = producerId ? spec.byId[producerId] : undefined;
    return { name: v, producer: producer ? `${producer.method.toUpperCase()} ${producer.path}` : null };
  });
  return {
    tool: TOOL_NAME,
    title: spec.title,
    version: spec.version,
    base_path: spec.basePath,
    fingerprint: spec.fingerprint,
    suite: testplan.SUITE,
    suite_logins: Object.fromEntries(Object.entries(testplan.SUITE_DEFAULT_LOGINS).map(([role, [name]]) => [role, name])),
    sections,
    shared_vars: shared,
  };
}

/** Enforce the document on operator-edited inputs. */
export function checkInputs(
  spec: Spec,
  op: SpecOp,
  params: Record<string, string> | undefined,
  bodyText: string | undefined | null,
): { errors: string[]; warnings: string[]; body: Json } {
  const errors: string[] = [];
  const warnings: string[] = [];
  let body: Json = null;
  const byName = new Map(op.params.map(p => [p.name, p]));
  for (const [name, raw] of Object.entries(params ?? {})) {
    const text = String(raw ?? '').trim();
    const p = byName.get(name);
    if (!text || !p) continue;
    let value: Json;
    try {
      value = spec.coerce(p.schema, text);
    } catch (e: Json) {
      errors.push(`${name}: ${e?.message ?? e}`);
      continue;
    }
    for (const e of spec.validate(p.schema, value, 'request')) errors.push(`${name}: ${e}`);
  }
  if (bodyText !== undefined && bodyText !== null && op.body?.contentType.includes('json')) {
    try {
      body = JSON.parse(bodyText);
    } catch (e: Json) {
      errors.push(`body is not valid JSON: ${e?.message ?? e}`);
      return { errors, warnings, body: null };
    }
    const errs = spec.validate(op.body.schema, body, 'request').map(e => `body: ${e}`);
    // The document's own example fails its schema for this API, so edits are
    // held to the same bar: warn, do not block.
    if (op.id in spec.exampleIssues) warnings.push(...errs);
    else errors.push(...errs);
  }
  return { errors, warnings, body };
}

export interface StartResult {
  ok: boolean;
  id?: string;
  total?: number;
  errors?: string[];
}

/** Validate a run request, start it, and hand back its id. */
export function startRun(body: Json): StartResult {
  ensureDirs();
  const spec = activeSpec();
  const errors: string[] = [];
  const runAs = String(body.run_as ?? '').split(/\s+/).filter(Boolean).join(' ');
  if (!RUN_AS.test(runAs)) {
    errors.push('enter your name in “Run As” (letters, spaces, . \' - only; 2–60 characters)');
  }
  if (!String(body.host ?? '').trim()) errors.push('enter the server IP address / host');
  if (!body.token && !(body.username && body.password)) {
    errors.push('enter the username and password (or log in first)');
  }

  const suite = !!body.suite;
  let cfgIn = body;
  let suiteUser: { username: string; password: string } | undefined;
  if (suite) {
    // The full suite runs every API with predefined inputs only: Inputs edits
    // and Shared values are not used.
    const logins: Record<string, { username: string; password: string }> = {};
    for (const [role, [name, pw]] of Object.entries(testplan.SUITE_DEFAULT_LOGINS)) {
      const given = body[`suite_${role}`] ?? {};
      logins[role] = {
        username: String(given.username || name).trim(),
        password: given.password || pw,
      };
    }
    if (!String(body.suite_ue_ip ?? '').trim()) {
      errors.push('enter the UE IP address the suite creates its simulator on');
    }
    suiteUser = logins.user;
    cfgIn = {
      ...body,
      selected: spec.ops.map(o => o.id),
      overrides: {},
      variables: {},
      token: null,
      roles: [],
      username: logins.admin.username,
      password: logins.admin.password,
    };
  }

  const selected: string[] = (cfgIn.selected ?? []).filter((i: string) => i in spec.byId);
  if (!selected.length) errors.push('select at least one API');

  const overrides: RunConfig['overrides'] = {};
  for (const [opId, ovRaw] of Object.entries<Json>(cfgIn.overrides ?? {})) {
    const op = spec.byId[opId];
    if (!op || !selected.includes(opId)) continue;
    const label = `${op.method.toUpperCase()} ${op.path}`;
    const { errors: errs, body: parsed } = checkInputs(spec, op, ovRaw.params, ovRaw.body);
    for (const e of errs) errors.push(`${label} — ${e}`);
    const clean: Json = { params: ovRaw.params ?? {}, example: ovRaw.example };
    if (ovRaw.body !== undefined && ovRaw.body !== null && !errs.length) clean.body = parsed;
    if (ovRaw.file) {
      try {
        clean.file = { name: ovRaw.file.name, content: Buffer.from(ovRaw.file.b64, 'base64').toString('utf8') };
      } catch {
        errors.push(`${label} — the uploaded file could not be read`);
      }
    }
    overrides[opId] = clean;
  }

  if (errors.length) return { ok: false, errors };

  const run = new Run(spec, {
    runAs,
    host: String(cfgIn.host),
    username: String(cfgIn.username ?? ''),
    password: String(cfgIn.password ?? ''),
    token: cfgIn.token ?? undefined,
    roles: cfgIn.roles ?? [],
    selected,
    overrides,
    variables: cfgIn.variables ?? {},
    negative: !!cfgIn.negative,
    suite,
    suiteUser,
    suiteUeIp: String(body.suite_ue_ip ?? '').trim() || undefined,
    strictStatus: !!cfgIn.strict_status,
    safety: cfgIn.safety !== false,
    timeout: Number(cfgIn.timeout) || 30,
    insecure: !!cfgIn.insecure,
  });

  RUNS.set(run.id, run);
  // Drop the oldest once there are too many; the reports on disk stay.
  if (RUNS.size > MAX_RUNS_IN_MEMORY) {
    for (const [id, r] of RUNS) {
      if (r.status === 'running') continue;
      RUNS.delete(id);
      if (RUNS.size <= MAX_RUNS_IN_MEMORY) break;
    }
  }

  // Deliberately not awaited: the run outlives this request and the page
  // polls it, exactly as the Python tool's background thread did.
  void run.run()
    .catch(() => { /* run() records its own error */ })
    .finally(() => {
      try {
        writeReport(run);
      } catch { /* a report that cannot be written must not lose the results */ }
    });

  return { ok: true, id: run.id, total: run.ops.length };
}

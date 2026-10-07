// openapi.yaml → a flat list of operations, default inputs, and the
// comparison engine that decides whether a response matches the document.
//
// Ported from spec.py of the API Automation and Validation tool, keeping its
// behaviour: the same labels (MISSING_KEY, UNDOCUMENTED_KEY, WRONG_STRUCTURE,
// WRONG_TYPE, NOT_IN_RESPONSE), the same oneOf variant scoring, the same
// "report a repeated array problem once with a count", and the same rule that
// values — enums, formats, ranges, text — are never judged. Only shape is.
//
// The one deliberate difference is the full-schema validator used for live
// checking of edits in the UI: Python used openapi-schema-validator, here it
// is ajv with OAS 3.0's `nullable` normalised to a nullable JSON Schema type,
// because that is the one OAS extension ajv does not understand.

import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';

export const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
export const PLACEHOLDER = /\{\{(\w+)\}\}/;
/** Internal marker used while scoring oneOf variants. Never shown. */
const HINT = '_variant_hint';

export type Json = any;

export interface SpecParam {
  name: string;
  in: string;
  required: boolean;
  schema: Json;
  description: string;
  example?: Json;
}

export interface SpecBody {
  contentType: string;
  required: boolean;
  schema: Json;
  examples: Record<string, Json>;
}

export interface SpecOp {
  id: string;
  section: string;
  method: string;
  path: string;
  index: number;
  summary: string;
  description: string;
  secured: boolean;
  adminOnly: boolean;
  params: SpecParam[];
  body: SpecBody | null;
  responses: Record<string, { description: string; content: Record<string, Json> }>;
}

/** A finding from the shape comparison: a label and a human-readable line. */
export type ShapeIssue = [label: string, message: string];

type RawIssue = [label: string, message: string, example?: string];

export function jsonType(value: Json): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'string') return 'string';
  return 'object';
}

export function preview(value: Json, limit = 60): string {
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text === undefined || text === null) text = String(value);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** Replace {{name}} with the captured value. Unknown names are collected into
 *  `missing` so the caller can skip the API and say which one would create it. */
export function fill(value: Json, variables: Record<string, Json>, missing: Set<string>): Json {
  if (typeof value === 'string') {
    const whole = new RegExp(`^${PLACEHOLDER.source}$`).exec(value);
    if (whole) {
      const name = whole[1];
      if (name in variables) return variables[name];
      missing.add(name);
      return value;
    }
    return value.replace(new RegExp(PLACEHOLDER.source, 'g'), (m, name: string) => {
      if (name in variables) return String(variables[name]);
      missing.add(name);
      return m;
    });
  }
  if (Array.isArray(value)) return value.map(v => fill(v, variables, missing));
  if (value && typeof value === 'object') {
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(value)) out[k] = fill(v, variables, missing);
    return out;
  }
  return value;
}

/** Every {{name}} inside a value. */
export function placeholders(value: Json): Set<string> {
  const found = new Set<string>();
  const walk = (v: Json): void => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(new RegExp(PLACEHOLDER.source, 'g'))) found.add(m[1]);
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (v && typeof v === 'object') {
      Object.values(v).forEach(walk);
    }
  };
  walk(value);
  return found;
}

export class Spec {
  raw: Json;
  fingerprint: string;
  components: Json;
  title: string;
  version: string;
  basePath: string;
  ops: SpecOp[] = [];
  byId: Record<string, SpecOp> = {};
  sections: string[] = [];
  /** Every documented example, for the document self-check. */
  examples: Array<{ opId: string; label: string; schema: Json; example: Json; direction: 'request' | 'response' }> = [];
  /** Request examples that fail their own schema: edits for those APIs warn
   *  rather than block, because the document is the thing that is wrong. */
  exampleIssues: Record<string, string[]> = {};

  private ajv: Ajv;
  private validators = new Map<string, ValidateFunction>();

  constructor(text: string) {
    this.raw = parseYaml(text, { maxAliasCount: -1 });
    this.fingerprint = createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12);
    this.components = this.raw.components ?? {};
    this.title = this.raw.info?.title ?? 'API document';
    this.version = this.raw.info?.version ?? '';
    const serverUrl: string = this.raw.servers?.[0]?.url ?? '';
    this.basePath = pathOf(serverUrl.replace('{host}', 'host')).replace(/\/$/, '');

    this.ajv = new Ajv({ strict: false, allErrors: true, validateFormats: true, allowUnionTypes: true });
    addFormats(this.ajv);

    for (const [path, item] of Object.entries<Json>(this.raw.paths ?? {})) {
      const shared = item.parameters ?? [];
      for (const method of METHODS) {
        if (item[method]) this.ops.push(this.buildOp(path, method, item[method], shared));
      }
    }
    for (const o of this.ops) this.byId[o.id] = o;
    this.sections = [...new Set(this.ops.map(o => o.section))];

    for (const o of this.ops) {
      if (o.body && o.body.contentType.includes('json')) {
        for (const [name, ex] of Object.entries(o.body.examples)) {
          this.examples.push({ opId: o.id, label: `request example “${name}”`, schema: o.body.schema, example: ex, direction: 'request' });
        }
      }
      const responses = this.raw.paths[o.path][o.method]?.responses ?? {};
      for (const [code, r] of Object.entries<Json>(responses)) {
        for (const [ctype, media] of Object.entries<Json>(this.resolve(r)?.content ?? {})) {
          if (!ctype.includes('json') || !media?.schema) continue;
          const examples: Record<string, Json> = {};
          for (const [k, v] of Object.entries<Json>(media.examples ?? {})) examples[k] = this.resolve(v)?.value;
          if ('example' in media) examples.example = media.example;
          for (const [name, ex] of Object.entries(examples)) {
            this.examples.push({ opId: o.id, label: `${code} response example “${name}”`, schema: media.schema, example: ex, direction: 'response' });
          }
        }
      }
    }
    for (const e of this.examples) {
      if (e.direction !== 'request') continue;
      for (const err of this.validate(e.schema, e.example, 'request')) {
        (this.exampleIssues[e.opId] ??= []).push(`${e.label} → ${err}`);
      }
    }
  }

  // ---------- parsing ----------

  /** Follow local $refs until a real node is reached. */
  resolve(node: Json): Json {
    let seen = 0;
    while (node && typeof node === 'object' && '$ref' in node && seen++ < 50) {
      node = this.lookup(node.$ref);
    }
    return node;
  }

  private lookup(ref: string): Json {
    let node = this.raw;
    for (const part of ref.replace(/^#\//, '').split('/')) {
      node = node?.[decodeURIComponent(part.replace(/~1/g, '/').replace(/~0/g, '~'))];
    }
    return node;
  }

  private buildOp(path: string, method: string, op: Json, shared: Json[]): SpecOp {
    const params: SpecParam[] = [];
    for (const raw of [...shared, ...(op.parameters ?? [])]) {
      const p = this.resolve(raw);
      params.push({
        name: p.name,
        in: p.in,
        required: !!p.required,
        schema: this.resolve(p.schema ?? { type: 'string' }),
        description: p.description ?? '',
        example: p.example,
      });
    }
    let body: SpecBody | null = null;
    if (op.requestBody) {
      const rb = this.resolve(op.requestBody);
      const [ctype, media] = Object.entries<Json>(rb.content)[0];
      let examples: Record<string, Json>;
      if (media.examples) {
        examples = {};
        for (const [k, v] of Object.entries<Json>(media.examples)) examples[k] = this.resolve(v)?.value;
      } else if ('example' in media) {
        examples = { 'Documented example': media.example };
      } else {
        examples = { 'Generated from schema': this.sample(media.schema ?? {}) };
      }
      body = { contentType: ctype, required: !!rb.required, schema: media.schema ?? {}, examples };
    }
    const responses: SpecOp['responses'] = {};
    for (const [code, rawR] of Object.entries<Json>(op.responses ?? {})) {
      const r = this.resolve(rawR);
      const content: Record<string, Json> = {};
      for (const [ct, m] of Object.entries<Json>(r.content ?? {})) content[ct] = m?.schema;
      responses[String(code)] = { description: r.description ?? '', content };
    }
    return {
      id: op.operationId || `${method.toUpperCase()} ${path}`,
      section: (op.tags ?? ['other'])[0],
      method,
      path,
      index: this.ops.length,
      summary: op.summary ?? '',
      description: op.description ?? '',
      // An empty security array means the API is open; anything else needs a token.
      secured: JSON.stringify(op.security ?? this.raw.security) !== '[]',
      adminOnly: !!op['x-admin-only'],
      params,
      body,
      responses,
    };
  }

  // ---------- default values ----------

  /** A value that satisfies `schema`, preferring the documented example,
   *  default or first enum. */
  sample(schema: Json, depth = 0): Json {
    const s = this.resolve(schema) ?? {};
    for (const key of ['example', 'default']) {
      if (key in s) return structuredClone(s[key]);
    }
    if (s.enum?.length) return s.enum[0];
    if (depth > 10) return null;
    if (s.oneOf || s.anyOf) return this.sample((s.oneOf ?? s.anyOf)[0], depth + 1);
    if (s.allOf) {
      const merged: Record<string, Json> = {};
      for (const part of s.allOf) {
        const v = this.sample(part, depth + 1);
        if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(merged, v);
      }
      return merged;
    }
    const t = s.type ?? (s.properties ? 'object' : 'string');
    if (t === 'object') {
      // Every property, as the documentation viewer shows them; read-only
      // ones are set by the server and are left out.
      const out: Record<string, Json> = {};
      for (const [k, v] of Object.entries<Json>(s.properties ?? {})) {
        if ((this.resolve(v) ?? {}).readOnly) continue;
        out[k] = this.sample(v, depth + 1);
      }
      return out;
    }
    if (t === 'array') {
      const n = Math.max(1, s.minItems ?? 1);
      return Array.from({ length: n }, () => this.sample(s.items ?? {}, depth + 1));
    }
    if (t === 'integer' || t === 'number') {
      const v = s.minimum ?? 0;
      return t === 'integer' ? Math.trunc(v) : Number(v);
    }
    if (t === 'boolean') return false;
    const now = new Date();
    const iso = now.toISOString().replace(/\.\d+Z$/, 'Z');
    const byFormat: Record<string, string> = {
      uuid: crypto.randomUUID(),
      'date-time': iso,
      date: iso.slice(0, 10),
      email: 'user@example.com',
      binary: '',
    };
    const v = byFormat[s.format as string] ?? 'string';
    return s.maxLength !== undefined ? v.slice(0, s.maxLength) : v;
  }

  paramDefault(param: SpecParam): Json {
    if (param.example !== undefined && param.example !== null) return param.example;
    return this.sample(param.schema);
  }

  /** Schema with $refs inlined, for display. */
  expand(schema: Json, depth = 0): Json {
    if (depth > 12) return '…';
    const s = this.resolve(schema);
    if (Array.isArray(s)) return s.map(v => this.expand(v, depth + 1));
    if (s && typeof s === 'object') {
      const out: Record<string, Json> = {};
      for (const [k, v] of Object.entries(s)) {
        if (k === 'example' || k === 'examples') continue;
        out[k] = this.expand(v, depth + 1);
      }
      return out;
    }
    return s;
  }

  // ---------- validation ----------

  /** Full-schema validation, for checking edits made in the UI and for the
   *  document self-check. `{{placeholders}}` are tolerated: they are filled in
   *  at run time. Returns 'path: message' lines. */
  validate(schema: Json, instance: Json, direction: 'request' | 'response' = 'response'): string[] {
    let validator: ValidateFunction;
    const key = `${direction}:${hashOf(schema)}`;
    const cached = this.validators.get(key);
    if (cached) {
      validator = cached;
    } else {
      try {
        const root = {
          ...oasToJsonSchema(this.resolveDeep(schema), direction),
          $schema: 'http://json-schema.org/draft-07/schema#',
        };
        validator = this.ajv.compile(root);
      } catch {
        // A schema ajv cannot compile is not a reason to block an edit.
        validator = (() => true) as unknown as ValidateFunction;
      }
      this.validators.set(key, validator);
    }
    if (validator(instance)) return [];
    const errors: string[] = [];
    for (const e of validator.errors ?? []) {
      const where = (e.instancePath || '').replace(/^\//, '') || '(root)';
      // A value that is still a placeholder is filled in at run time.
      const at = valueAt(instance, e.instancePath);
      if (typeof at === 'string' && new RegExp(`^${PLACEHOLDER.source}$`).test(at)) continue;
      const msg = `${e.message ?? 'is invalid'}${e.params?.allowedValues ? ` (${(e.params.allowedValues as Json[]).join(', ')})` : ''}`;
      errors.push(`${where}: ${msg.length < 300 ? msg : `${msg.slice(0, 300)}…`}`);
    }
    return [...new Set(errors)].sort();
  }

  /** $refs inlined, for handing a self-contained schema to ajv. */
  private resolveDeep(schema: Json, depth = 0): Json {
    if (depth > 25) return {};
    const s = this.resolve(schema);
    if (Array.isArray(s)) return s.map(v => this.resolveDeep(v, depth + 1));
    if (s && typeof s === 'object') {
      const out: Record<string, Json> = {};
      for (const [k, v] of Object.entries(s)) out[k] = this.resolveDeep(v, depth + 1);
      return out;
    }
    return s;
  }

  /** Compare the STRUCTURE of `value` with `schema`, never its values.
   *
   *  Always: required keys that are missing, keys the document does not list,
   *  and object/array/scalar mix-ups. With `types`, each field's JSON type as
   *  well. With `absent`, also documented optional keys the value lacks — the
   *  two-way comparison used on the two sampled test cases.
   *
   *  oneOf/anyOf pick the closest documented variant, and the same problem in
   *  every item of an array is reported once with a count. */
  shapeErrors(schema: Json, value: Json, types = false, absent = false): ShapeIssue[] {
    const found: RawIssue[] = [];
    this.shape(schema, value, types, '', found, 0, absent);
    const merged = new Map<string, { label: string; msg: string; n: number; example?: string }>();
    for (const [label, msg, example] of found) {
      if (label === HINT) continue;
      const k = `${label}\u0000${msg}`;
      const entry = merged.get(k);
      if (entry) entry.n += 1;
      else merged.set(k, { label, msg, n: 1, example });
    }
    return [...merged.values()].map(e => [
      e.label,
      e.msg + (e.example !== undefined ? ` (e.g. ${e.example})` : '') + (e.n > 1 ? ` (×${e.n})` : ''),
    ] as ShapeIssue);
  }

  /** Resolve $ref and fold allOf parts into one schema. Public because the
   *  runner needs it to tell a documented envelope from the real body. */
  mergedSchema(schema: Json): Json {
    const s = this.resolve(schema) ?? {};
    if (!s.allOf) return s;
    const out: Json = {};
    for (const [k, v] of Object.entries(s)) if (k !== 'allOf') out[k] = v;
    for (const part of s.allOf) {
      const p = this.mergedSchema(part);
      out.properties = { ...(out.properties ?? {}), ...(p.properties ?? {}) };
      out.required = [...(out.required ?? []), ...(p.required ?? [])];
      for (const k of ['type', 'items', 'additionalProperties', 'nullable', 'oneOf', 'anyOf']) {
        if (k in p && !(k in out)) out[k] = p[k];
      }
    }
    return out;
  }

  private shape(schema: Json, value: Json, types: boolean, path: string, out: RawIssue[], depth: number, absent = false): void {
    if (depth > 40) return;
    const s = this.mergedSchema(schema);
    const where = path || '(root)';
    const variants: Json[] | undefined = s.oneOf ?? s.anyOf;
    if (variants) {
      let best: { score: [number, number, number]; variant: Json; errs: RawIssue[] } | undefined;
      for (const variant of variants) {
        const errs: RawIssue[] = [];
        this.shape(variant, value, types, path, errs, depth + 1, absent);
        if (errs.length === 0) return;
        // Closest = no clash with the variant's fixed values (e.g. ratType
        // 'sa'), then documents the most of the value's own keys, then has
        // the fewest problems.
        const shared = value && typeof value === 'object' && !Array.isArray(value)
          ? Object.keys(value).filter(k => k in (this.mergedSchema(variant).properties ?? {})).length
          : 0;
        const hints = errs.filter(e => e[0] === HINT).length;
        const score: [number, number, number] = [hints, -shared, errs.length - hints];
        if (!best || lessThan(score, best.score)) best = { score, variant, errs };
      }
      if (!best) return;
      const name = String(best.variant.$ref ?? '').split('/').pop() || 'variant';
      for (const e of best.errs) {
        out.push(e[0] === HINT ? e : [e[0], `${e[1]} [closest documented variant: ${name}]`, e[2]]);
      }
      return;
    }
    if ((s.enum?.length ?? 0) === 1 && value !== s.enum[0]) {
      out.push([HINT, where]);   // a fixed value that differs: only scores variants, never reported
    }
    if (value === null || value === undefined) {
      if (types && s.type && !s.nullable) out.push(['WRONG_TYPE', `${where}: is null, documented as ${s.type}`]);
      return;
    }
    const t: string | undefined = s.type ?? (s.properties ? 'object' : undefined);
    const got = jsonType(value);
    if ((t === 'object' || t === 'array') && got !== t || (t && (got === 'object' || got === 'array') && got !== t)) {
      out.push(['WRONG_STRUCTURE', `${where}: documented as ${t}, got ${got}`, preview(value)]);
      return;
    }
    if (types && t && !(got === t || (t === 'number' && got === 'integer'))) {
      out.push(['WRONG_TYPE', `${where}: documented as ${t}, got ${got}`, preview(value)]);
      return;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const props: Json = s.properties ?? {};
      const extra = s.additionalProperties;
      if (absent) {
        for (const key of Object.keys(props)) {
          if (!(key in value) && !(s.required ?? []).includes(key)) {
            out.push(['NOT_IN_RESPONSE', `${where}: documented key '${key}' is not in the response`]);
          }
        }
      }
      for (const key of s.required ?? []) {
        if (!(key in value)) out.push(['MISSING_KEY', `${where}: documented key '${key}' is missing`]);
      }
      for (const [key, v] of Object.entries(value)) {
        const sub = path ? `${path}/${key}` : key;
        if (key in props) {
          this.shape(props[key], v, types, sub, out, depth + 1, absent);
        } else if (extra && typeof extra === 'object') {
          this.shape(extra, v, types, sub, out, depth + 1, absent);
        } else if (Object.keys(props).length && !extra) {
          // An object documented without a key list accepts any key.
          out.push(['UNDOCUMENTED_KEY', `${where}: key '${key}' is not in the document`, preview(v)]);
        }
      }
    } else if (Array.isArray(value) && s.items) {
      for (const v of value) this.shape(s.items, v, types, `${path}[]`, out, depth + 1, absent);
    }
  }

  /** The UI sends every parameter as text; convert it to the documented type.
   *  Throws with the reason when it does not fit. */
  coerce(schema: Json, text: string): Json {
    if (new RegExp(`^${PLACEHOLDER.source}$`).test(text)) return text;
    const t = (this.resolve(schema) ?? {}).type ?? 'string';
    if (t === 'integer') {
      if (!/^-?\d+$/.test(text.trim())) throw new Error('must be an integer');
      return Number(text);
    }
    if (t === 'number') {
      const n = Number(text);
      if (text.trim() === '' || Number.isNaN(n)) throw new Error('must be a number');
      return n;
    }
    if (t === 'boolean') {
      const l = text.toLowerCase();
      if (l !== 'true' && l !== 'false') throw new Error('must be true or false');
      return l === 'true';
    }
    return text;
  }
}

// ---------------------------------------------------------------- helpers --

function lessThan(a: [number, number, number], b: [number, number, number]): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    const m = /^[a-z]+:\/\/[^/]+(\/.*)$/i.exec(url);
    if (m) return m[1];
    return url.startsWith('/') ? url : '';
  }
}

function hashOf(schema: Json): string {
  try {
    return createHash('sha1').update(JSON.stringify(schema) ?? '').digest('hex').slice(0, 16);
  } catch {
    return 'unhashable';
  }
}

function valueAt(instance: Json, pointer: string): Json {
  if (!pointer) return instance;
  let node = instance;
  for (const part of pointer.replace(/^\//, '').split('/')) {
    if (node === null || node === undefined) return undefined;
    node = node[part.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return node;
}

/** OAS 3.0 is JSON Schema with one incompatibility that matters here:
 *  `nullable: true` rather than a null type. Also drops the annotations ajv
 *  has no use for, and honours readOnly/writeOnly by direction the way the
 *  OAS validators do. */
function oasToJsonSchema(schema: Json, direction: 'request' | 'response', depth = 0): Json {
  if (depth > 30 || schema === null || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(s => oasToJsonSchema(s, direction, depth + 1));
  const out: Json = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'nullable' || k === 'example' || k === 'examples' || k === 'xml' || k === 'discriminator' || k === 'externalDocs') continue;
    if (k === 'properties') {
      const props: Json = {};
      for (const [pk, pv] of Object.entries<Json>(v as Json)) {
        const resolved = pv ?? {};
        // A read-only property is server-set, so it is not required of a
        // request; a write-only one is not expected in a response.
        if (direction === 'request' && resolved.readOnly) continue;
        if (direction === 'response' && resolved.writeOnly) continue;
        props[pk] = oasToJsonSchema(resolved, direction, depth + 1);
      }
      out[k] = props;
      continue;
    }
    out[k] = oasToJsonSchema(v, direction, depth + 1);
  }
  if (schema.nullable && out.type) {
    out.type = Array.isArray(out.type) ? [...out.type, 'null'] : [out.type, 'null'];
  }
  if (direction === 'request' && Array.isArray(out.required) && schema.properties) {
    out.required = out.required.filter((r: string) => !(schema.properties[r] ?? {}).readOnly);
  }
  return out;
}
